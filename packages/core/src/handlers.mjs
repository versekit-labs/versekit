// Command handlers: what each entry in `commands.mjs` actually does.
//
// These are pure functions of (args, state) on purpose — the daemon, the card channel and any
// future MCP bridge all call the same function, so "works in the CLI" and "works from a card"
// cannot diverge. Adapter work is queued, never awaited here: an HTTP request that waits 20
// minutes for an upload is a timeout, not a feature.

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { basename, extname } from "node:path";
import { open, transitionPublish, enqueue, emit, DEFAULT_LANGUAGE } from "./index.mjs";
import { queuePublish, queueCollect, MAX_ATTEMPTS } from "./runner.mjs";
import { assetSetOf, ASSET_KIND_LABEL, MAX_IMAGE_NOTE } from "./asset-kind.mjs";
import * as store from "./store.mjs";
import { assertPlanSlot } from "./plan-rules.mjs";
import { nextCollectAt } from "./collect-plan.mjs";
import { setupStatus } from "./setup.mjs";
import { listSchedule, moveSchedule, cancelSchedule } from "./schedule.mjs";
import * as overview from "./overview.mjs";
import { checkAccount } from "./adapters.mjs";

const fail = (message) => {
  throw new Error(message);
};

const requireGroup = (ref) => store.findGroup(ref) ?? fail(`没有这个账号组：${ref}（先 vk group list 看看有哪些）`);

const titleOf = (asset) => basename(asset, extname(asset)) || "未命名";

/** `--to tiktok,bilibili` arrives as an array; tolerate a comma string from a card button. */
const platformList = (to) => {
  const list = Array.isArray(to) ? to : String(to ?? "").split(",");
  const clean = [...new Set(list.map((p) => String(p).trim()).filter(Boolean))];
  if (!clean.length) fail("至少要指定一个平台：--to tiktok,bilibili");
  return clean;
};

const RETRYABLE_STATES = new Set(["failed", "blocked", "expired", "notify_pending", "draft_pending"]);

const platformLabel = (platform) =>
  overview.MATRIX_COLUMNS.find((column) => column.platform === platform || column.aliases.includes(platform))?.label ?? platform;

/**
 * 素材类型 × 平台能力的创建前校验（ACC-publish-04、ACC-publish-06）。
 *
 * 放在写 work / publish 之前：图片素材发小红书时，用户拿到的是一句能照做的话，而不是一条
 * 8 分钟后仍然 auto_running 的发布。只拦适配器**明确声明过**的能力（capabilities.assetTypes）；
 * 没声明的旧适配器照旧交给它自己判断，不在这里猜。
 *
 * 多图的模型口径：一个作品只有一个 asset 字段，**目录就是图集**（目录里按文件名自然排序的
 * 1–18 张图片）。所以「同一个作品里图片与视频混选」在数据层面就是目录里混装了两种文件——
 * 在创建 publish 之前拦下，不把混装目录交给适配器去发现。
 */
function assertAssetSupported(asset, platforms, byPlatform) {
  const set = assetSetOf(asset);
  if (!set.files.length) {
    fail(`素材目录是空的：${asset}（图集是一个目录里放 1–${MAX_IMAGE_NOTE} 张图片，按文件名顺序上传）`);
  }
  if (set.mixed) {
    fail(
      `同一个作品不能把图片和视频混在一起：「${basename(asset)}」里同时有图片和视频（共 ${set.files.length} 个文件）。` +
        `图文发一组图片，视频发一个文件——请拆成两个作品再发（这条没有创建）`,
    );
  }
  if (set.kind === "video" && set.files.length > 1) {
    fail(`视频作品只能放一个视频文件：「${basename(asset)}」里有 ${set.files.length} 个文件（这条没有创建）`);
  }
  if (set.kind === "image" && set.files.length > MAX_IMAGE_NOTE) {
    fail(`图集最多 ${MAX_IMAGE_NOTE} 张图片，现在是 ${set.files.length} 张：删掉多余的再发（这条没有创建）`);
  }
  const kind = set.kind;
  if (!kind) return; // 判不出来（未知扩展名）：交给适配器在 dry-run / 上传时给判断
  const refused = platforms
    .map((platform) => ({ platform, types: byPlatform.get(platform)?.assetTypes }))
    .filter(({ types }) => Array.isArray(types) && !types.includes(kind));
  if (!refused.length) return;

  const label = ASSET_KIND_LABEL[kind];
  const alternative = ASSET_KIND_LABEL[kind === "image" ? "video" : "image"];
  const detail = refused
    .map(({ platform, types }) => `${platformLabel(platform)}目前只能发${types.map((t) => ASSET_KIND_LABEL[t]).join("、")}`)
    .join("；");
  const excluded = refused.map(({ platform }) => platform).join("、");
  fail(`${detail}，选的是${label}素材「${basename(asset)}」：换成${alternative}，或从 --to 里去掉 ${excluded}（这条没有创建）`);
}

/** 「正常」只在最近 24 小时内真实检查过才成立；更久没查就是「待确认」（ACC-account-09）。 */
export const CHECK_STALE_AFTER_MS = 24 * 3600e3;

/**
 * 给账号视图补「上次检查时间」和对人展示的状态。
 * 只改 ok：expired/banned/expiring 本来就是明确的坏消息，不能被「待确认」盖住。
 */
export function withCheckStatus(account, now = Date.now()) {
  const lastCheckedAt = account.last_checked_at ?? null;
  const stale = account.state === "ok" && (lastCheckedAt == null || now - lastCheckedAt > CHECK_STALE_AFTER_MS);
  return {
    ...account,
    lastCheckedAt,
    checkStaleAfterMs: CHECK_STALE_AFTER_MS,
    displayState: stale ? "unconfirmed" : account.state,
    displayStateLabel: stale ? "待确认" : null,
    ...(stale ? { checkHint: `超过 24 小时没有检查登录：vk account check ${account.id}` } : {}),
  };
}

/**
 * 「下一步怎么登录」的统一说法。小红书默认扫码（后台无头取二维码，不弹窗口，#101）；
 * 短信与登录窗口是备用入口。其他平台照旧走 reauth。
 */
export function loginHint(platform, accountId) {
  if (platform === "xiaohongshu") {
    return `下一步：vk account login ${accountId} --qr（手机小红书扫码，不弹窗口；遇到风控改用 --phone <手机号> 短信登录或 --open 打开登录窗口）`;
  }
  if (platform === "tiktok-api") {
    return `下一步：vk account connect ${accountId}（在电脑前点开授权链接，用 TikTok 登录并同意）`;
  }
  return `下一步：vk account reauth ${accountId}（在电脑前完成扫码）`;
}

export function createCoreHandlers({ adapters = [], log = () => {}, doctor = null } = {}) {
  const byPlatform = new Map(adapters.map((a) => [a.platform, a]));
  /** 进行中的 TikTok 授权会话，按账号。 */
  const connectSessions = new Map();

  /** 创建发布的本地校验：不写任何行、不碰网络。 */
  function planPublish({ asset, to, schedule, visibility = "public", dryRun = false, title, body, tags, group }) {
    const platforms = platformList(to);
      if (!existsSync(asset)) fail(`找不到素材：${asset}（路径要在本机，可以是视频文件或图片目录）`);

      // 默认作用域是 group.use 记录的当前组：发布台打开时看到的是哪一组，就只发哪一组。
      // 没选组（首次使用、旧数据）才退回「全部账号」，与引入账号组之前一致。
      const selectedGroup = group ? requireGroup(group) : store.currentGroup();
      const groupId = selectedGroup?.id ?? null;
      const scope = selectedGroup ? `账号组「${selectedGroup.name}」里` : "";

      // account.add 在 #21 起要求必填 --group，所以缺号提示也带上组名；没有当前组时退回通用提示。
      const { accounts, missing, unusable, blocked } = store.accountsForPlatforms(platforms, { groupId });
      if (missing.length) {
        fail(`${scope}没有 ${missing.join("、")} 账号：先 vk account add ${missing[0]} --name 主号${selectedGroup ? ` --group ${selectedGroup.name}` : " --group <组>"}`);
      }
      // 已失效的账号不可选，而且必须说清为什么：静默跳过等于「以为发了，其实没发」。
      // 只有「这个平台一个可用号都没有」才拦下整单；同平台还有可用号时，失效号只是不选它。
      if (blocked.length) {
        const reasons = unusable.filter((u) => blocked.includes(u.platform)).map((u) => u.reason);
        fail(`这些账号已失效，不能选：${reasons.join("；")}。换可用账号，或从 --to 里去掉这些平台`);
      }
      const noAdapter = platforms.filter((p) => !byPlatform.has(p));
      if (noAdapter.length) fail(`没有 ${noAdapter.join("、")} 适配器：装 packages/adapter-${noAdapter[0]}`);

      // 素材类型 × 平台能力在写任何行之前就拦下（ACC-publish-04）；dry-run 同样适用——
      // 预演的意义就是提前看到「这条真发会怎样」。
      assertAssetSupported(asset, platforms, byPlatform);

      // 快失效的仍然可选，但提前告诉人：不是阻塞，不应该等到发布当天才在任务页发现。
      const warnings = accounts
        .filter((a) => a.state === "expiring")
        .map((a) => ({ platform: a.platform, accountId: a.id, handle: a.handle, state: a.state, reason: `${a.platform} ${store.handleLabel(a.handle)} 登录即将失效：发布前确认或重登` }));

      const planned = accounts.map((a) => ({ platform: a.platform, accountId: a.id, handle: a.handle, visibility }));
      const workTitle = title ?? titleOf(asset);
      const base = { group: selectedGroup ? { id: selectedGroup.id, name: selectedGroup.name } : null, ...(warnings.length ? { warnings } : {}) };

      // Dry-run answers "what would happen" without writing rows or touching a network.
      if (dryRun) {
        return { accounts, result: { ...base, dryRun: true, work: { title: workTitle, asset }, publishes: planned, queued: false } };
      }

    const commit = (extra) => {
      // 正文/话题是平台相关的素材（小红书用），放进 work.meta，不塞进 publish 的通用列。
      const meta = body || tags?.length ? { ...(body ? { body } : {}), ...(tags?.length ? { tags } : {}) } : null;
      const work = store.createWork({ title: workTitle, assetPath: asset, meta });
      const created = [];
      for (const account of accounts) {
        const { id, cutId, state } = store.createPublish({
          workId: work.id,
          accountId: account.id,
          visibility,
          scheduledAt: schedule ?? null,
        });
        created.push({ publishId: id, cutId, platform: account.platform, handle: account.handle, state });
      }
      log(`[handlers] 创建 ${created.length} 条发布（待确认）：${created.map((c) => c.platform).join(", ")}`);
      // 平台稿先停在待确认（#146）：不经人确认不会发。回执里直接给出确认的下一步。
      const cutId = created[0]?.cutId ?? null;
      return { ...base, ...(extra ?? {}), workId: work.id, cutId, publishes: created, queued: false, next: cutId ? `确认后才会发：vk publish approve --cut ${cutId}（小红书逐条：vk publish approve --publish <id>）` : null };
    };
    return { accounts, commit };
  }

  /**
   * 发布前对目标账号做一次真实检查（ACC-account-09）：掉线就在创建阶段拦下，
   * 不要等到执行时才失败。check() 自己出错（网络、浏览器没起）不等于掉线，放行但说明没确认。
   */
  async function verifyLogins(accounts) {
    const unconfirmed = [];
    for (const account of accounts) {
      try {
        await checkAccount(adapters, account.id);
      } catch (err) {
        if (err?.code !== "auth") {
          unconfirmed.push({ platform: account.platform, accountId: account.id, handle: account.handle, reason: `${account.platform} ${store.handleLabel(account.handle)} 发布前检查没能完成（${String(err?.message ?? err).slice(0, 120)}），登录状态未确认` });
        }
      }
    }
    const dead = accounts
      .map((a) => store.getAccount(a.id))
      .filter((a) => a && store.UNUSABLE_ACCOUNT_STATES.includes(a.state));
    if (dead.length) {
      const reasons = dead.map((a) => store.accountUnusableReason(a));
      fail(`发布前检查发现账号已掉线，不能发布：${reasons.join("；")}。请先重新登录（vk account reauth <id>），这条没有创建`);
    }
    return unconfirmed.length ? { unconfirmed } : {};
  }

  return {
    now: () => ({ ...store.statusSnapshot() }),

    "bootstrap": () => overview.buildBootstrap(),

    "account.list": ({ group } = {}) => {
      // 账号页与总览新鲜度面板共用 overview.listAccountViews 的同一份对象（ACC-overview-02）。
      // TikTok 官方接口的账号带上头像（授权时从 user.info.basic 取得，界面要显示）。
      const stamp = (list) =>
        list.map((a) => {
          const view = withCheckStatus(a);
          const profile = store.accountProfile(a);
          return profile ? { ...view, avatar_url: profile.avatarUrl } : view;
        });
      if (!group) return { accounts: stamp(overview.listAccountViews()) };
      const g = requireGroup(group);
      const accounts = stamp(overview.listAccountViews({ groupId: g.id }));
      // 添加账号页据此灰掉已接入平台并写出「被谁占用」；同组同平台唯一，所以一个平台最多一人。
      const occupants = Object.fromEntries(
        accounts.map((a) => [a.platform, { accountId: a.id, handle: a.handle, name: a.display_name ?? a.handle }]),
      );
      return { group: { id: g.id, name: g.name }, accounts, occupants };
    },

    "work.add": ({ asset, title, source, cuts }) => {
      // 两种形式：<一个文件> = 1 作品 1 成片 1 版本；cuts 数组 = 多支成片、多语言。
      let plan;
      if (cuts) {
        if (asset) fail("work.add：给了 cuts 就不要再给单个素材路径");
        if (!title) fail("work.add：多支成片的作品必须有标题（--title 或清单里的 title）");
        plan = { title, source, cuts };
      } else {
        if (!asset) fail("work.add 要么给一个素材路径，要么给 cuts 清单");
        plan = { title: title ?? titleOf(asset), source, cuts: [{ title: title ?? titleOf(asset), versions: [{ language: DEFAULT_LANGUAGE, asset }] }] };
      }
      // 素材必须真在本机：入库一个不存在的路径，到发布那天才报错就晚了。
      const assets = plan.cuts.flatMap((c) => (c?.versions ?? []).map((v) => v?.asset).filter(Boolean));
      const missing = assets.filter((a) => !existsSync(a));
      if (missing.length) fail(`找不到素材：${missing.join("、")}（路径要在本机，可以是视频文件或图片目录）`);
      plan.cuts = plan.cuts.map((c) => ({ ...c, versions: (c?.versions ?? []).map((v) => ({ ...v, asset: resolvePath(v.asset) })) }));
      const result = store.upsertWork(plan);
      return { ...result, work: store.showWork(result.id) };
    },

    // work / today / stats 默认只看当前账号组，--group 指定别的组（ACC-v2-group-01）。
    "work.list": ({ group = null } = {}) => {
      const scope = overview.resolveScope(group);
      return { group: scope, works: overview.listWorksInScope(store.listWorks(), scope?.id ?? null) };
    },

    "work.show": ({ workId, group = null }) => {
      const scope = overview.resolveScope(group);
      return { group: scope, work: overview.showWorkInScope(workId, scope?.id ?? null) };
    },

    "today": ({ group = null } = {}) => overview.buildToday({ groupId: overview.resolveScope(group)?.id ?? null }),

    "group.list": () => {
      const current = store.currentGroup();
      return { groups: store.listGroups(), current: current ? { id: current.id, name: current.name } : null };
    },

    "group.add": ({ name }) => {
      const result = store.addGroup({ name });
      // 「创建并进入」（ACC-groups-02）：新建组必须同时成为当前组，否则页面建完仍停留在
      // “无当前组”，还得再发一次 group.use 才能看到空组——那正是验收要排除的多余一步。
      store.useGroup(result.id);
      const current = { id: result.id, name: result.name };
      return { ...result, current, next: `下一步：vk account add <platform> --name <名字> --group ${result.name}` };
    },

    "group.rename": ({ group, name }) => {
      const target = requireGroup(group);
      const result = store.renameGroup({ id: target.id, name });
      emit({ type: "group.renamed", payload: { groupId: target.id, from: result.previous ?? target.name, to: result.name } });
      return result;
    },
    "group.use": ({ group }) => {
      const g = store.useGroup(group);
      return { current: { id: g.id, name: g.name } };
    },

    "channel.bind": ({ openId }) => store.bindChannel("feishu", openId),

    "setup.status": async () => {
      const binding = store.getBinding("feishu");
      // 接入进度是「当前账号组」的进度：账号步骤只数本组账号，否则空组会借用别组的账号显示完成。
      const current = store.currentGroup();
      return setupStatus({
        doctor: doctor ? await doctor() : null,
        accounts: store.listAccounts({ groupId: current?.id ?? null }),
        channel: { bound: Boolean(binding), who: binding?.external_user_id ?? null },
        publishedCount: store.countPublished(),
      });
    },

    "platform.list": () => ({
      platforms: adapters.map((a) => ({
        platform: a.platform,
        publish: a.publish,
        collect: a.collect,
        draft: a.draft,
        visibility: a.visibility,
        requiresQualification: a.requiresQualification,
        // 发布台据此在选素材时提前提示；null = 适配器没声明，页面不猜。
        assetTypes: a.assetTypes ?? null,
        ready: a.adapter.ready(),
      })),
    }),

    "account.add": ({ platform, name, handle, credentialRef, group }) => {
      // 命令层 args 已把 group 标成必填；这里再挡一次，直接调 handler 的调用方也不能绕过。
      if (!group) fail("account.add 必须带 --group：先 vk group add <名字> 建组，或 vk group list 看已有的组");
      const g = requireGroup(group);
      const result = store.addAccount({
        platform,
        handle: handle ?? name,
        displayName: name,
        credentialRef: credentialRef ?? null,
        groupId: g.id,
      });
      return {
        ...result,
        group: { id: g.id, name: g.name },
        next: result.existed ? null : loginHint(platform, result.id),
      };
    },

    "account.remove": ({ accountId }) => store.removeAccount(accountId),

    "account.mode": ({ accountId, mode }) => store.setAccountMode(accountId, mode),

    /**
     * TikTok 官方接口授权（Login Kit for Desktop）。授权要在本机起临时端口、等人在浏览器里点同意，
     * 一次 HTTP 请求等不了那么久，所以分两段：
     *   · 第一次调用：起授权会话，立刻返回 { state: "waiting", url }，由 CLI 打开/打印链接；
     *   · 之后再调（同一账号）：最多等 timeoutMs，等到完成返回 { state: "connected", 昵称, 头像 }。
     * 会话、PKCE、state、端口都在适配器里；这里只负责把结果落到账号行（credential_ref + 昵称）。
     */
    "account.connect": async ({ accountId, timeoutMs = null }) => {
      const account = store.getAccount(accountId);
      if (!account) fail(`没有这个账号：${accountId}`);
      const adapter = byPlatform.get(account.platform)?.adapter;
      if (typeof adapter?.connect !== "function") {
        fail(`${store.platformLabelOf(account.platform)} 账号不需要这种授权；请用 vk account reauth ${accountId}`);
      }
      let session = connectSessions.get(accountId);
      const fresh = !session;
      if (fresh) {
        session = { startedAt: Date.now(), url: null, result: null, error: null };
        const urlReady = new Promise((resolve) => (session.resolveUrl = resolve));
        session.done = Promise.resolve()
          .then(() => adapter.connect({ accountId, onUrl: (url) => { session.url = url; session.resolveUrl(); } }))
          .then(
            (result) => { session.result = result; },
            (error) => { session.error = error; },
          )
          .finally(() => session.resolveUrl());
        connectSessions.set(accountId, session);
        await urlReady; // 拿到链接（或这次授权在起步就失败）再返回
      } else if (timeoutMs !== 0) {
        await Promise.race([session.done, new Promise((r) => setTimeout(r, Math.min(Math.max(timeoutMs ?? 20000, 0), 60000)))]);
      }
      if (session.error) {
        connectSessions.delete(accountId);
        throw session.error;
      }
      if (session.result) {
        connectSessions.delete(accountId);
        const r = session.result;
        store.applyAccountConnection({ accountId, credentialRef: r.credentialRef, displayName: r.displayName, expiresAt: r.expiresAt });
        log(`[connect] ${account.platform} ${accountId} 授权完成`);
        return { accountId, state: "connected", displayName: r.displayName, avatarUrl: r.avatarUrl };
      }
      return {
        accountId,
        state: "waiting",
        url: session.url,
        next: "在浏览器里打开这个链接，用 TikTok 登录并同意；完成后这条命令会显示头像和昵称",
      };
    },

    /** creator_info：账号现在能选的隐私级别、三个开关是否允许、最长时长。选项只来自 TikTok，不在代码里写死。 */
    "account.creator": async ({ accountId }) => {
      const account = store.getAccount(accountId);
      if (!account) fail(`没有这个账号：${accountId}`);
      const adapter = byPlatform.get(account.platform)?.adapter;
      if (typeof adapter?.creatorInfo !== "function") fail("这个账号不是 TikTok 官方接口账号，没有创作者设置可查");
      return { accountId, ...(await adapter.creatorInfo({ accountId })) };
    },

    /**
     * Reauth cannot be completed from a phone — a scan needs a screen. So this command starts the
     * flow where it can start, and otherwise says plainly where the person has to go.
     */
    "account.reauth": ({ accountId }) => {
      const account = store.getAccount(accountId);
      if (!account) fail(`没有这个账号：${accountId}`);
      const adapter = byPlatform.get(account.platform);
      if (!adapter) fail(`没有 ${account.platform} 适配器，先安装 packages/adapter-${account.platform}`);
      if (account.platform === "bilibili") {
        return { accountId, started: false, next: `在电脑上运行：biliup -u ${account.credential_ref ?? "<cookies.json>"} login，选「浏览器登录」` };
      }
      if (account.platform === "xiaohongshu") {
        return { accountId, started: false, next: loginHint(account.platform, accountId) };
      }
      if (account.platform === "tiktok-api") {
        return { accountId, started: false, next: loginHint(account.platform, accountId) };
      }
      return { accountId, started: false, next: `打开本机浏览器登录 ${account.platform} @${account.handle}，完成后运行 vk account mode ${accountId} auto` };
    },

    /**
     * 创建发布：先做全部本地校验，再（有 check() 的账号）真实检查一次登录，最后才写行。
     * 没有任何适配器带 check() 时保持同步返回；否则返回 Promise（daemon / CLI 都会 await）。
     */
    "publish.create": (args) => {
      const plan = planPublish(args);
      if (plan.result) return plan.result;
      const checkable = plan.accounts.filter((a) => typeof byPlatform.get(a.platform)?.adapter?.check === "function");
      if (!checkable.length) return plan.commit();
      return verifyLogins(checkable).then((extra) => plan.commit(extra));
    },

    "approval.link": ({ publishId }) => {
      const row = store.getPublish(publishId);
      if (!row) fail(`没有这条发布：${publishId}`);
      return { publishId, url: approvalLink(publishId), path: approvalPath(publishId), state: row.state };
    },

    "approval.apply": ({ token, decision }) => applyApproval(token, decision, { actor: "cli" }),

    "publish.retry": ({ publishId }) => {
      const row = store.getPublish(publishId);
      if (!row) fail(`没有这条发布：${publishId}`);
      if (row.state === "published" || row.state === "published_limited") fail("这条已经发布成功，不需要重试");
      if (row.state === "queued") return { publishId, already: true, state: "queued" };
      if (!RETRYABLE_STATES.has(row.state)) fail(`当前状态 ${row.state} 不能重试`);
      transitionPublish(publishId, "queued", { reason: "manual_retry" });
      queuePublish({ id: publishId, account_id: row.account_id });
      return { publishId, state: "queued" };
    },

    /**
     * private_then_public 的放行动作。v0.1 只改本地状态并留痕；适配器侧改可见性在
     * followup 核实器落地后接上（ARCHITECTURE §4.2），这里不假装已经改到平台。
     */
    "publish.release": ({ publishId }) => {
      const row = store.getPublish(publishId);
      if (!row) fail(`没有这条发布：${publishId}`);
      if (row.state !== "published_limited") fail(`只有 published_limited 可以放行，当前是 ${row.state}`);
      transitionPublish(publishId, "published", { reason: "released_by_operator", patch: { visibility: "public" } });
      open().prepare("UPDATE followup SET state='waived', done_at=? WHERE publish_id=? AND kind='set_visibility_public' AND state='open'").run(Date.now(), publishId);
      return { publishId, state: "published", note: "本地状态已放行；平台侧可见性核实待 followup 核实器" };
    },

    "publish.confirm": ({ publishId }) => {
      const row = store.getPublish(publishId);
      if (!row) fail(`没有这条发布：${publishId}`);
      if (!["notify_pending", "draft_pending"].includes(row.state)) fail(`当前状态 ${row.state} 不需要确认`);
      const publishedAt = row.published_at ?? Date.now();
      transitionPublish(publishId, "published", {
        reason: "confirmed_by_operator",
        patch: row.published_at ? {} : { published_at: publishedAt },
      });
      // 人工确认的发布也要进采集节奏，否则 notify 模式的作品永远没有数据。
      const next = nextCollectAt(publishedAt);
      if (next) enqueue({ kind: "collect", targetType: "publish", targetId: publishId, lane: row.account_id, priority: 200, runAfter: next });
      return { publishId, state: "published" };
    },

    // 发布前人确认（#146）：写库都在 store.mjs，这里只是把命令接上。
    "publish.approve": ({ cutId = null, publishId = null }) => store.approvePublishes({ cutId, publishId }),

    "publish.now": ({ publishId }) => store.publishNow({ publishId }),

    "publish.manual": ({ publishId }) => store.publishManual({ publishId }),

    "publish.skip": ({ cutId }) => store.skipCut({ cutId }),

    "publish.edit": ({ publishId, title = null, at = null, privacy = null, comment = null, duet = null, stitch = null, caption = null, draft = null }) => {
      // 时间要先过平台规则（每日上限、最小间隔）。状态不对、过去的时间等错误仍由 store 报，保持原来的措辞。
      if (at != null && Number.isInteger(at) && at > Date.now()) {
        const row = store.getPublish(publishId);
        if (row && store.CONFIRMABLE_STATES.includes(row.state)) assertPlanSlot(row, at);
      }
      return store.editPublish({ publishId, title, at, privacy, comment, duet, stitch, caption, draft });
    },

    "collect.now": ({ publishId = null, platform = null }) => {
      const conn = open();
      const rows = publishId
        ? [conn.prepare("SELECT p.id, p.account_id, a.platform, p.state FROM publish p JOIN account a ON a.id=p.account_id WHERE p.id=?").get(publishId)]
        : conn
            .prepare(
              `SELECT p.id, p.account_id, a.platform, p.state FROM publish p JOIN account a ON a.id=p.account_id
                WHERE (? IS NULL OR a.platform = ?) AND p.state IN ('published','published_limited')
                ORDER BY p.updated_at DESC LIMIT 200`,
            )
            .all(platform, platform);

      const target = rows.filter(Boolean);
      if (!target.length) fail(publishId ? `没有这条发布：${publishId}` : "没有已发布的作品可以采集");

      const targets = target.map((r) => {
        if (!["published", "published_limited"].includes(r.state)) fail(`这条发布还没成功（${r.state}），没有指标可采`);
        return { publishId: r.id, runId: queueCollect(r.id, r.account_id) };
      });
      return { queued: targets.length, targets };
    },

    "stats.works": ({ range = "all", publishId = null, group = null }) => {
      const g = overview.resolveScope(group);
      return {
        group: g,
        rows: overview.statsWithBaseline(store.listStats({ range, publishId, groupId: g?.id ?? null })),
      };
    },

    "stats.series": ({ publishId }) => ({ publishId, points: store.seriesFor({ publishId }) }),

    "publish.list": ({ state = null, platform = null, limit = 100 }) => ({
      rows: store.listPublishes({ state, platform, limit }),
    }),

    // 排期投影与撞车都在 core 里算（schedule.mjs），Web 与 CLI 只读结果。
    "schedule.list": ({ group = null, from = null, to = null }) => listSchedule({ group, from, to }),

    "schedule.move": ({ workId, at, force = false }) => moveSchedule({ workId, at, force }),

    "schedule.cancel": ({ workId }) => cancelSchedule({ workId }),

    "run.list": ({ state = null, limit = 100, group = null }) => {
      const g = group ? requireGroup(group) : null;
      const rows = store.listRuns({ state, limit, groupId: g?.id ?? null }).map((r) => ({
        ...r,
        // 重试上限是队列策略，不是每行另存一份；放在响应里，页面才能显示「2 / 3」而不是猜。
        max_attempts: MAX_ATTEMPTS,
        attempts_left: Math.max(0, MAX_ATTEMPTS - r.attempts),
      }));
      return { group: g ? { id: g.id, name: g.name } : null, retry_limit: MAX_ATTEMPTS, rows };
    },

    "event.list": ({ since = 0, limit = 100 }) => ({ rows: store.listEvents({ since, limit }) }),
  };
}
