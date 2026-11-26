// Command handlers: what each entry in `commands.mjs` actually does.
//
// These are pure functions of (args, state) on purpose — the daemon, the card channel and any
// future MCP bridge all call the same function, so "works in the CLI" and "works from a card"
// cannot diverge. Adapter work is queued, never awaited here: an HTTP request that waits 20
// minutes for an upload is a timeout, not a feature.

import { chmodSync, existsSync, statSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { basename, extname } from "node:path";
import { open, transitionPublish, enqueue, emit, paths, DEFAULT_LANGUAGE } from "./index.mjs";
import { ping, pullOnce } from "../../relay/src/index.mjs";
import { deliveryFileKey, isVersionedDelivery, looksLikeLocalPath } from "../../relay/src/delivery-v1.mjs";
import { queuePublish, queueCollect, MAX_ATTEMPTS } from "./runner.mjs";
import { assetSetOf, ASSET_KIND_LABEL, MAX_IMAGE_NOTE } from "./asset-kind.mjs";
import * as store from "./store.mjs";
import { assertPlanSlot, planRules, takenTimes, nearestAvailable, describeRules, dayUsage } from "./schedule-rules.mjs";
import { createDeliveryHandlers, deliveryWorkPlan } from "./maker-handlers.mjs";
import { checkWorkPlan, copyFor, copyViolations } from "./plan-rules.mjs";
import * as planModel from "./plan.mjs";
import { nextCollectAt } from "./collect-plan.mjs";
import { setupStatus } from "./setup.mjs";
import { readConfig, updateConfig } from "./config.mjs";
import { listSchedule, moveSchedule, cancelSchedule } from "./schedule.mjs";
import * as overview from "./overview.mjs";
import { checkAccount, notifyLogin } from "./adapters.mjs";
import * as updates from "./update.mjs";
import * as egress from "./egress.mjs";
import { installComponent, listComponents, removeComponent } from "./components.mjs";
import { LOGIN_TRACKED, loginCheckTime, normaliseClock, queueLoginChecks, rearmLoginChecker, DEFAULT_LOGIN_CHECK_TIME } from "./scheduler.mjs";

/** 设备名：config.json 的 device.name；没起名叫「发布机」。主机名（xxx.local）不是给人看的。 */
const deviceName = () => {
  const n = readConfig().device?.name;
  return typeof n === "string" && n.trim() ? n.trim() : "发布机";
};

/** 报错的文字是给页面看的人话；命令提示放 hint，只给命令行（页面收到的错误体不带 hint）。 */
const fail = (message, hint) => {
  throw Object.assign(new Error(message), hint ? { hint } : {});
};

const requireGroup = (ref) => store.findGroup(ref) ?? fail(`没有这个账号组：${ref}（在系统页的账号组里看有哪些）`, "vk group list");

const titleOf = (asset) => basename(asset, extname(asset)) || "未命名";

/** `--to tiktok,bilibili` arrives as an array; tolerate a comma string from a card button. */
const platformList = (to) => {
  const list = Array.isArray(to) ? to : String(to ?? "").split(",");
  const clean = [...new Set(list.map((p) => String(p).trim()).filter(Boolean))];
  if (!clean.length) fail("至少要选一个要发到的平台，如 tiktok、bilibili", "--to tiktok,bilibili");
  return clean;
};

/** 侧栏要的出口位置一行：位置用哪条线路写哪条（两条一样只写一条），暂停几个账号。 */
const egressSummary = (groupId) => {
  const v = egress.view({ groupId });
  const shown = v.lines.filter((l) => !l.error);
  const first = shown[0] ?? null;
  return {
    probedAt: v.probedAt,
    place: first ? first.place : null,
    ip: first?.ip ?? null,
    lines: v.lines.map((l) => ({ key: l.key, label: l.label, place: l.place, ip: l.ip, datacenter: l.datacenter ?? null, error: l.error ?? null })),
    split: v.split,
    pausedCount: v.pausedCount,
    waitingCount: v.waitingCount,
    note: v.notes[0] ?? null,
  };
};

/** 守护进程每 30 秒写一次心跳；超过这个时间没动静就当发布机不在线。 */
const HEARTBEAT_STALE_MS = 90e3;

const RETRYABLE_STATES = new Set(["failed", "blocked", "expired", "notify_pending", "draft_pending"]);

const platformLabel = (platform) =>
  overview.MATRIX_COLUMNS.find((column) => column.platform === platform || column.aliases.includes(platform))?.label ?? overview.loginPlatformLabel(platform);

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
  fail(`${detail}，选的是${label}素材「${basename(asset)}」：换成${alternative}，或把 ${excluded} 从要发的平台里去掉（这条没有创建）`);
}

/**
 * 「今天还能发几条」：生效的 daily_cap（plan-rules，平台覆盖 > 默认）减去这个账号今天已发和已排的条数。
 * 口径与确认时的规则检查是同一份（takenTimes + 本机时区的自然日），不是写死的数字。
 */
export function quotaToday(account, now = Date.now()) {
  const { dailyCap } = planRules(account.platform);
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const used = takenTimes(account.id, "").filter((t) => t >= from && t < to).length;
  return { cap: dailyCap, used, left: Math.max(0, dailyCap - used) };
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
    ...(stale ? { checkHint: "超过 24 小时没有检查登录，在系统页重新检查一次" } : {}),
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
  if (platform === "shipinhao") {
    return `下一步：vk account login ${accountId} --qr（用开通视频号的微信扫码，不弹窗口；也可以在系统页账号那一行扫）`;
  }
  if (platform === "tiktok-api") {
    return `下一步：vk account connect ${accountId}（在电脑前点开授权链接，用 TikTok 登录并同意）`;
  }
  if (platform === "youtube") {
    return `下一步：vk account connect ${accountId}（在电脑前点开授权链接，用你的 Google 账号登录并同意）`;
  }
  if (platform === "douyin") {
    return `下一步：到系统页点「在发布机上打开登录窗口」，在窗口里登录抖音一次（需要验证码、滑块时在窗口里手动过；命令行：vk account reauth ${accountId}）`;
  }
  return `下一步：vk account reauth ${accountId}（在电脑前完成扫码）`;
}

/**
 * `updater`：{ apply({ now }) } 由 CLI 那一层给（更新要动服务和程序目录，不在内核里）；
 * `loginsOpen()`：守护进程里还开着的登录窗口数。
 */
export function createCoreHandlers({ adapters = [], log = () => {}, doctor = null, updater = null, loginsOpen = () => 0, uploadQueue = null, machineRelay = () => null, offline = false } = {}) {
  const byPlatform = new Map(adapters.map((a) => [a.platform, a]));

  async function changeComponent(name, action) {
    try {
      return action === "install" ? await installComponent(name, { offline }) : await removeComponent(name);
    } catch (err) {
      emit({
        type: "component.failed", severity: "warn",
        payload: { component: name, action, error_code: err.code, message: err.message },
      });
      throw err;
    }
  }
  /** 方案里能选的平台：已安装的适配器；离线模式不装适配器，退回矩阵里的平台名，方案照样能看能改。 */
  const knownPlatforms = () => (byPlatform.size ? [...byPlatform.keys()] : overview.MATRIX_COLUMNS.map((c) => c.platform));

  /** 发布方案的读模型：存过的行，或默认行；平台名展开成「组里已接入的平台」。 */
  function planView(scope) {
    const saved = scope ? store.getGroupPlan(scope.id) : null;
    const rows = planModel.normalizeRows(saved ?? [planModel.DEFAULT_ROW]);
    const accounts = scope ? store.listAccounts({ groupId: scope.id }) : [];
    const connected = [...new Set(accounts.map((a) => a.platform))];
    const platformsOfRow = (r) => (r.platforms == null ? connected : r.platforms);
    const config = readConfig();
    return {
      group: scope ? { id: scope.id, name: scope.name } : null,
      isDefault: !saved,
      rows: rows.map((r) => ({
        kind: r.kind,
        language: r.language,
        label: planModel.rowLabel(r),
        platformList: r.platforms,
        platforms: platformsOfRow(r).map((p) => ({ platform: p, name: platformLabel(p), connected: connected.includes(p) })),
        delayDays: r.delayDays,
        rhythm: saved ? planModel.rhythmLabel(r.delayDays) : "每支成片发到所有接入的平台（默认方案）",
      })),
      groupPlatforms: connected.map((p) => ({ platform: p, name: platformLabel(p) })),
      installedPlatforms: knownPlatforms().map((p) => ({ platform: p, name: platformLabel(p) })),
      rules: [...new Set([...(connected.length ? connected : knownPlatforms())])].map((p) => ({ ...describeRules(p, config), name: platformLabel(p) })),
    };
  }
  /**
   * 平台自己能按时公开的（YouTube：上传时带 publishAt，到点由平台公开）：确认后立刻开始上传，而不是等到
   * 预约时间才开始传。store 按预约时间排的 run 在这里改成马上跑；适配器看到平稿的预约时间在未来，
   * 就私享上传并带 publishAt。其余平台不受影响。
   */
  function releaseNativeSchedule(result) {
    for (const item of result?.approved ?? []) {
      if (!item?.runId || !item.runAfter || item.state !== "queued") continue;
      if (byPlatform.get(item.platform)?.adapter?.nativeSchedule !== true) continue;
      open().prepare("UPDATE run SET run_after = NULL WHERE id = ? AND state = 'queued'").run(item.runId);
    }
    return result;
  }

  /**
   * 确认之前把适配器能判的事先判了（视频号：短标题超 16 字、有不允许的标点、描述超 950 字）：
   * 在人点确认的这一刻拦下并说清楚，不等到发布那天失败。适配器没有 preflight 就什么都不做。
   */
  function preflightDrafts({ cutId, publishId }) {
    const rows = publishId
      ? open().prepare("SELECT p.id, a.platform, a.handle FROM publish p JOIN account a ON a.id = p.account_id WHERE p.id = ?").all(publishId)
      : open()
          .prepare("SELECT p.id, a.platform, a.handle FROM publish p JOIN account a ON a.id = p.account_id WHERE p.cut_id = ? AND p.state IN ('pending_confirm', 'skipped')")
          .all(cutId);
    const problems = [];
    for (const r of rows) {
      const adapter = byPlatform.get(r.platform)?.adapter;
      if (typeof adapter?.preflight !== "function") continue;
      try {
        adapter.preflight({ publishId: r.id });
      } catch (err) {
        problems.push(`${platformLabel(r.platform)}：${String(err.message).split("\n")[0]}`);
      }
    }
    if (problems.length) fail(`还不能确认：${problems.join("；")}。改好之后再确认，这次没有确认任何一条`);
  }

  /** 人确认了视频号平台稿：这一刻查一次登录（过期了马上提醒，不等发布那天）；并让时钟重新对准「发布前 2 小时」。 */
  function checkLoginOnConfirm(result) {
    const ids = (result?.approved ?? []).map((a) => a?.publishId).filter(Boolean);
    if (!ids.length) return;
    const accounts = open()
      .prepare(`SELECT DISTINCT p.account_id AS id FROM publish p JOIN account a ON a.id = p.account_id WHERE p.id IN (${ids.map(() => "?").join(",")}) AND a.platform IN (${[...LOGIN_TRACKED].map(() => "?").join(",")})`)
      .all(...ids, ...LOGIN_TRACKED)
      .map((r) => r.id);
    if (accounts.length) {
      queueLoginChecks({ trigger: "confirm", accountIds: accounts });
      rearmLoginChecker();
    }
  }

  /** 进行中的授权会话（TikTok 官方接口、YouTube），按账号。 */
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
        fail(`${scope}没有 ${missing.join("、")} 账号：先到系统页接入这个平台的账号`, `vk account add ${missing[0]} --name 主号 --group ${selectedGroup ? selectedGroup.name : "<组>"}`);
      }
      // 已失效的账号不可选，而且必须说清为什么：静默跳过等于「以为发了，其实没发」。
      // 只有「这个平台一个可用号都没有」才拦下整单；同平台还有可用号时，失效号只是不选它。
      if (blocked.length) {
        const reasons = unusable.filter((u) => blocked.includes(u.platform)).map((u) => u.reason);
        fail(`这些账号已失效，不能选：${reasons.join("；")}。换可用账号，或把这些平台去掉`, `vk account reauth ${unusable.find((u) => blocked.includes(u.platform))?.accountId ?? "<账号 id>"}`);
      }
      const noAdapter = platforms.filter((p) => !byPlatform.has(p));
      if (noAdapter.length) fail(`没有 ${noAdapter.join("、")} 适配器：这个平台的组件没装好`, `packages/adapter-${noAdapter[0]}`);

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
        const result = { ...base, dryRun: true, work: { title: workTitle, asset }, publishes: planned, queued: false };
        // 适配器声明了 dryRunPreview 的，真的调它的彩排：输出这条真发会提交的元数据。彩排不联网、不写库。
        const previewers = accounts.filter((a) => byPlatform.get(a.platform)?.adapter?.dryRunPreview === true);
        if (!previewers.length) return { accounts, result };
        return {
          accounts,
          result: Promise.all(
            previewers.map(async (a) => {
              const entry = planned.find((p) => p.accountId === a.id);
              try {
                const out = await byPlatform.get(a.platform).adapter.publish({
                  publishId: null,
                  asset,
                  dryRun: true,
                  preview: { accountId: a.id, visibility, scheduledAt: schedule ?? null },
                  copy: { title: workTitle, body: body ?? "", tags: tags ?? [], language: null, metaJson: null },
                });
                entry.preview = out?.request ?? out ?? null;
              } catch (err) {
                // 彩排里就发现发不出去（标题超长、文件不对……）：照实写进这条的预览，不吞掉。
                entry.preview = { error: { code: err?.code ?? "unknown", message: String(err?.message ?? err) } };
              }
            }),
          ).then(() => result),
        };
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
      fail(`发布前检查发现账号已掉线，不能发布：${reasons.join("；")}。请先到系统页重新登录，这条没有创建`, "vk account reauth <账号 id>");
    }
    return unconfirmed.length ? { unconfirmed } : {};
  }


  // ---------------------------------------------------------------- 云端中转（ACC-relay-02/03/04）
  //
  // 制作机 work.push 只管上传；发布机后台拉取入库。云端只是文件和投递清单，这里不连任何平台。
  const RELAY_WEEK_MS = 7 * 864e5;
  const relayConfig = () => {
    const r = readConfig().relay ?? {};
    const mins = Number(r.interval_minutes);
    const machine = machineRelay();
    return {
      url: machine ? machine.url : typeof r.url === "string" && r.url ? r.url.replace(/\/+$/, "") : null,
      pushToken: machine ? (machine.role === "maker" ? machine.token : null) : r.push_token || null,
      pullToken: machine ? (machine.role === "executor" ? machine.token : null) : r.pull_token || null,
      accountId: machine?.accountId,
      defaultGroup: r.default_group || null,
      intervalMinutes: Number.isFinite(mins) && mins > 0 ? mins : 5,
    };
  };
  let relayDownloading = null;
  let relayPulling = null;
  // 这一轮（或刚结束的一轮）的逐个投递进展，给 vk relay pull 和 relay.status 看（ACC-relay-06）
  let relayRound = null;
  let relayRoundAccount;
  const makerConnection = () => {
    const cfg = relayConfig();
    if (!cfg.url || !cfg.pushToken) {
      if (cfg.accountId) fail("这台机器没有制作机的传片连接。请核对 Hifabu 机器角色和中转地址。");
      fail("还没有配置中转：先到系统页的设备里接入", "vk relay connect <地址> --token <推送 token> --push");
    }
    return { ...cfg, token: cfg.pushToken };
  };
  /** 把一个已下载好的投递入库：先验后写，不合格就一行都不写；平台稿一律待确认（plan.apply）。 */
  function ingestDelivery(delivery, filePaths, inboxDir, accountId) {
    const m = delivery.manifest ?? {};
    const deliveryV1 = isVersionedDelivery(m);
    const group = deliveryV1 ? store.listGroups().find(({ name }) => name === delivery.group) : store.findGroup(delivery.group);
    const g = group ?? fail("这台发布机上没有账号组「" + delivery.group + "」：先到系统页建同名的账号组并接入账号，再让制作机重新送一次", "vk group add " + delivery.group);
    if (!store.listAccounts({ groupId: g.id }).length) fail(`账号组「${g.name}」里还没有账号，平台稿没地方放：先接入账号，再让制作机重新 push`);
    let work;
    if (deliveryV1) {
      const plan = deliveryWorkPlan(m, (file) => filePaths[deliveryFileKey(file)], DEFAULT_LANGUAGE);
      work = store.showWork(store.upsertWork(plan, { relay: true, deliveryKey: m.work.key, relayScope: accountId }).id);
    } else {
      const blobPath = (ref) => {
        const sha = /^blob:([0-9a-f]{64})$/.exec(String(ref ?? ""))?.[1];
        const local = sha ? filePaths[sha] : null;
        if (!local) fail("清单引用了没有上传的文件：" + (ref ?? "（空）"));
        return resolvePath(local);
      };
      const coverOf = (o) => o?.cover ? { cover: blobPath(o.cover) } : {};
      const cuts = (Array.isArray(m.cuts) ? m.cuts : []).map((c) => ({
        ...c,
        ...coverOf(c),
        versions: (Array.isArray(c?.versions) ? c.versions : []).map((v) => ({ ...v, ...coverOf(v), asset: blobPath(v?.asset) })),
      }));
      const plan = { title: m.title, source: m.source ?? joinPath(inboxDir, delivery.id), cuts };
      // 0.1.0 按制作机路径匹配；更早没有来源的清单沿用投递号。
      work = m.source == null ? handlers["work.add"](plan).work : store.showWork(store.upsertWork(plan, { relay: true }).id);
    }
    const created = [];
    const draftIds = [];
    const rejected = [];
    for (const cut of work.cuts) {
      const r = handlers["plan.apply"]({ cutId: cut.id, group: g.id, fromRelay: true });
      created.push(...(r.created ?? []));
      draftIds.push(...[...r.created, ...r.skipped].filter((p) => p.state === "pending_confirm").map((p) => p.publishId));
      rejected.push(...r.rejected);
    }
    if (!created.length && !work.cuts.some((c) => c.publishes?.length)) {
      const notes = rejected.map((x) => `${x.platform}：${x.reason}`);
      fail(`作品「${work.title}」已入库，但一条平台稿都没生成：${notes.join("；") || "账号组里没有能发的账号"}`);
    }
    const drafts = draftIds.map((id) => {
      const row = store.getPublish(id);
      return { platform: row.platform, accountId: row.account_id, account: row.account_name, handle: row.handle, suggestedAt: row.scheduled_at };
    });
    const published = work.cuts.flatMap((cut) => cut.publishes
      .filter((p) => p.state === "published" || p.state === "published_limited")
      .map((p) => `${platformLabel(p.platform)} ${store.handleLabel(p.handle)}「${cut.title}」`));
    const reason = published.length ? `以下平台稿已发布，保留原发布：${published.join("、")}` : null;
    log(`[relay] 投递 ${delivery.id} 已入库为作品 ${work.id}，${created.length} 条新平台稿待确认`);
    return { workId: work.id, drafts: created.length, summary: { workId: work.id, drafts, rejected }, ...(reason ? { reason } : {}) };
  }

  function emitDeliveryFailure(id, { errorCode, reason, nextStep }, key = id) {
    emit({ type: "delivery.failed", severity: "warn", payload: { id, errorCode, message: reason, nextStep }, dedupeKey: `delivery:${key}:failed` });
  }

  const deliveryKey = (accountId, id) => accountId ? `${accountId}.${id}` : id;
  const safeLabel = (value) => typeof value === "string" && value.trim() && value.length <= 255 && !looksLikeLocalPath(value);
  const groupAccounts = (groupId) => store.listAccounts({ groupId }).filter((account) => safeLabel(account.platform)).map((account) => ({
    platform: store.copyPlatformOf(account.platform),
    name: safeLabel(account.display_name) ? account.display_name : platformLabel(account.platform),
  }));
  const defaultGroupId = (ref) => ref ? store.findGroup(ref)?.id : null;

  function publisherGroupSnapshot(defaultGroup) {
    const name = deviceName();
    const defaultId = defaultGroupId(defaultGroup);
    return {
      device: { id: store.relayDeviceId(), name: safeLabel(name) ? name : "发布机" },
      reportedAt: Date.now(),
      groups: store.listGroups().filter((group) => safeLabel(group.name)).map((group) => ({
        name: group.name,
        ...(group.id === defaultId ? { default: true } : {}),
        accounts: groupAccounts(group.id),
      })),
    };
  }
  const pullState = (accountId) => {
    const st = store.getRelayState();
    return accountId ? st.pull_accounts?.[accountId] ?? {} : st;
  };
  const patchPullState = (accountId, patch) => {
    if (!accountId) return store.patchRelayState(patch);
    const accounts = store.getRelayState().pull_accounts ?? {};
    return store.patchRelayState({ pull_accounts: { ...accounts, [accountId]: { ...accounts[accountId], ...patch } } });
  };

  function recordRelay(id, rec, accountId) {
    const key = deliveryKey(accountId, id);
    store.setRelayDelivery(key, rec);
    if (rec.state === "failed") emitDeliveryFailure(id, rec, key);
    const st = pullState(accountId);
    const recent = [{ id, state: rec.state, title: rec.title ?? null, at: rec.at }, ...(st.recent ?? []).filter((r) => r.id !== id)].slice(0, 5);
    const failures = rec.state === "failed" ? [{ id, at: rec.at, title: rec.title ?? null, message: rec.reason }, ...(st.failures ?? []).filter((f) => f.id !== id)].slice(0, 20) : st.failures ?? [];
    patchPullState(accountId, { recent, failures });
  }

  async function pullRound() {
    const cfg = relayConfig();
    const { accountId } = cfg;
    if (!cfg.url || !cfg.pullToken) {
      if (accountId) fail("这台机器没有发布机的传片连接。请核对 Hifabu 机器角色和中转地址。");
      fail("还没有连中转：先到系统页的设备里接入", "vk relay connect <地址> --token <拉取 token>");
    }
    if (relayPulling) {
      if (relayRoundAccount === accountId) return relayPulling;
      fail("上一轮拉取正在结束，请稍后重试。");
    }
    const inboxDir = joinPath(paths().state, "relay-inbox", accountId ?? "");
    const groupSnapshot = publisherGroupSnapshot(cfg.defaultGroup);
    relayRoundAccount = accountId;
    relayRound = { startedAt: Date.now(), finishedAt: null, total: 0, items: [] };
    relayPulling = (async () => {
      try {
        const r = await pullOnce({
          url: cfg.url,
          token: cfg.pullToken,
          inboxDir,
          groupSnapshot,
          log,
          getRecord: (id) => store.getRelayDelivery(deliveryKey(accountId, id)),
          record: (id, rec) => recordRelay(id, rec, accountId),
          ingest: (d, filePaths) => ingestDelivery(d, filePaths, inboxDir, accountId),
          onEvent: (e) => {
            const rd = relayRound;
            if (!rd) return;
            if (e.type === "round") rd.total = e.total;
            else {
              const prev = rd.items.find((i) => i.id === e.id);
              const item = prev ?? { id: e.id, index: e.index, title: e.title ?? null, size: e.size ?? null };
              if (!prev) rd.items.push(item);
              item.state = { begin: "downloading", ingested: "ingested", failed: "failed", pending: "pending" }[e.type];
              if (e.type === "ingested") item.drafts = e.drafts;
              if (e.reason) item.reason = e.reason;
            }
          },
          onProgress: (p) => {
            relayDownloading = p ? { ...p, title: p.title ?? null } : null;
          },
        });
        const at = Date.now();
        patchPullState(accountId, { last_ok_at: at, last_error: null, pending: r.pending.length });
        if (r.ingested.length || r.failed.length) log(`[relay] 本轮：入库 ${r.ingested.length}，失败 ${r.failed.length}，没下完 ${r.pending.length}`);
        return { ...r, at };
      } catch (err) {
        const errorCode = err.code ?? "pull_failed";
        patchPullState(accountId, { last_error: { at: Date.now(), message: err.message, errorCode } });
        log(`[relay] 拉取没成功（${errorCode}）：${err.message}`);
        throw err;
      } finally {
        relayDownloading = null;
        relayPulling = null;
        if (relayRound) relayRound.finishedAt = Date.now();
      }
    })();
    return relayPulling;
  }

  function relayStatusView({ now = Date.now() } = {}) {
    const cfg = relayConfig();
    const st = pullState(cfg.accountId);
    const configured = Boolean(cfg.url && cfg.pullToken);
    const errAt = st.last_error?.at ?? 0;
    const connection = !configured ? "not_configured" : st.last_error && errAt >= (st.last_ok_at ?? 0) ? "error" : st.last_ok_at ? "ok" : "never";
    const ownRound = cfg.accountId === relayRoundAccount;
    const d = ownRound ? relayDownloading : null;
    return {
      configured,
      pushConfigured: Boolean(cfg.url && cfg.pushToken),
      url: cfg.url,
      intervalMinutes: cfg.intervalMinutes,
      connection,
      lastPullAt: st.last_ok_at ?? null,
      lastPullAgeMs: st.last_ok_at ? Math.max(0, now - st.last_ok_at) : null,
      lastError: st.last_error ?? null,
      pulling: ownRound && Boolean(relayPulling),
      round: ownRound ? relayRound : null,
      downloading: d ? [{ id: d.id, name: d.name, title: d.title ?? null, received: d.received, total: d.total, percent: d.total ? Math.floor((d.received / d.total) * 100) : 0 }] : [],
      pending: st.pending ?? 0,
      recent: st.recent ?? [],
      failures: (st.failures ?? []).filter((f) => now - f.at < RELAY_WEEK_MS),
    };
  }

  const handlers = {
    now: () => ({ ...store.statusSnapshot() }),

    "bootstrap": () => overview.buildBootstrap(),

    // 程序版本与后台自动更新（#217）。
    ...createDeliveryHandlers({ makerConnection, state: store.uploadState, uploadQueue, onFailure: emitDeliveryFailure, log }),

    "relay.status": () => relayStatusView(),

    "relay.connect": async ({ url, token, push = false, group }) => {
      const clean = String(url ?? "").trim().replace(/\/+$/, "");
      if (!/^https?:\/\/[^\s/]+/.test(clean)) fail("中转地址要以 https:// 开头（本机测试可以用 http://127.0.0.1:端口）");
      const t = String(token ?? "").trim();
      if (!t) fail("缺令牌：把中转给你的令牌填上", "--token <token>");
      const defaultGroup = group?.trim();
      if (group != null && !defaultGroup) fail("默认账号组名不能为空");
      const want = push ? "push" : "pull";
      let warning = null;
      try {
        const r = await ping({ url: clean, token: t });
        if (r.role !== want) fail(`这是${r.role === "push" ? "推送" : "拉取"}令牌，${push ? "制作机要用推送令牌" : "发布机要用拉取令牌"}`);
      } catch (err) {
        if (err.code === "unauthorized" || err.message.startsWith("这是")) fail(err.message);
        warning = `暂时没连上中转（${err.message}），配置已写入，网络通了会自动连`;
      }
      updateConfig({ relay: { url: clean, [push ? "push_token" : "pull_token"]: t, ...(defaultGroup ? { default_group: defaultGroup } : {}) } });
      try {
        chmodSync(paths().configFile, 0o600); // 里面有 token
      } catch {
        /* 非 POSIX */
      }
      log(`[relay] 已连接 ${clean}（${push ? "推送" : "拉取"}）`);
      return { url: clean, role: want, connected: !warning, ...(defaultGroup ? { defaultGroup } : {}), ...(warning ? { warning } : {}), message: warning ?? (push ? "已连接中转，可以送作品了" : "已连接中转，后台会自动拉取（也可以在系统页立刻拉一轮）；成片大的话下载要几分钟，进度在系统页能看到") };
    },

    "relay.disconnect": () => {
      const cfg = readConfig().relay ?? {};
      if (!cfg.url) fail("本来就没有连中转");
      // 只清「怎么连」：地址和两个令牌；拉取间隔等偏好留着，下次接入不用重填。
      updateConfig({ relay: { url: null, pull_token: null, push_token: null } });
      store.patchRelayState({ pending: 0 });
      log(`[relay] 已断开 ${cfg.url}`);
      return { disconnected: true, message: "已断开中转，已经入库的作品不受影响" };
    },

    "relay.pull": () => pullRound(),

    "update.status": () => updates.statusView(),

    "component.list": () => listComponents(),
    "component.install": ({ name }) => changeComponent(name, "install"),
    "component.remove": ({ name }) => changeComponent(name, "remove"),

    update: async ({ check = false, auto = null, now = false } = {}) => {
      if (auto != null && auto !== "") {
        if (!["on", "off"].includes(String(auto))) fail("自动更新只能是开或关");
        const cfg = updates.setAuto(auto === "on");
        log(`[update] 后台自动更新已${cfg.auto ? "打开" : "关闭"}`);
        return { auto: cfg.auto, intervalHours: cfg.intervalHours, message: cfg.auto ? "后台自动更新：开（空闲时更新，失败自动退回）" : "后台自动更新：关（想更新时在系统页点「现在更新」）" };
      }
      if (check) {
        try {
          return await updates.recordCheck();
        } catch (err) {
          fail(`没能查到最新版本：${err.message}（网络问题，稍后再试）`);
        }
      }
      if (!updater) fail("这份程序不能自己更新：它不是用安装包装出来的");
      const idle = updates.idleState({ loginsOpen: loginsOpen() });
      if (!idle.idle && !now) fail(`现在不适合更新：${idle.reason}。等忙完再试`);
      return updater.apply({ now });
    },

    "account.list": ({ group } = {}) => {
      // 账号页与总览新鲜度面板共用 overview.listAccountViews 的同一份对象（ACC-overview-02）。
      // TikTok 官方接口的账号带上头像（授权时从 user.info.basic 取得，界面要显示）。
      const stamp = (list) =>
        list.map((a) => {
          const conflict = store.getIdentityConflict(a.id);
          const clock = overview.loginClockOf(a);
          const view = { ...withCheckStatus(a), quota: quotaToday(a), ...(clock ? { loginClock: clock } : {}), ...(conflict ? { identityConflict: conflict.message } : {}) };
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

    /** 一个账号的详情；视频号带登录时长（这次登录已多久、最近几次平均撑多久），数字和系统页同一份。 */
    "account.show": ({ accountId }) => {
      const account = store.getAccount(accountId);
      if (!account) fail(`没有这个账号：${accountId}`, "vk account list");
      const view = { ...withCheckStatus(account), ...(overview.loginClockOf(account) ? { loginClock: overview.loginClockOf(account) } : {}) };
      return { account: view, ...(view.loginClock ? { loginClock: view.loginClock } : {}) };
    },

    /** 视频号每天检查登录的钟点（系统页设置）。 */
    "login.checktime.show": () => ({ time: loginCheckTime(), default: DEFAULT_LOGIN_CHECK_TIME, platforms: [...LOGIN_TRACKED] }),

    "login.checktime.set": ({ time }) => {
      const clock = normaliseClock(time);
      if (!clock) fail(`检查时间要写成 时:分，比如 08:00（收到：${time}）`);
      updateConfig({ login_check: { time: clock } });
      rearmLoginChecker(); // 新的钟点马上生效，不等下一次醒来
      return { time: clock, note: `视频号每天 ${clock} 查一次登录` };
    },

    "work.add": ({ asset, title, source, cuts }) => {
      // 两种形式：<一个文件> = 1 作品 1 成片 1 版本；cuts 数组 = 多支成片、多语言。
      let plan;
      if (cuts) {
        if (asset) fail("work.add：给了 cuts 就不要再给单个素材路径");
        if (!title) fail("多支成片的作品必须有标题");
        plan = { title, source, cuts };
      } else {
        if (!asset) fail("work.add 要么给一个素材路径，要么给 cuts 清单");
        plan = { title: title ?? titleOf(asset), source, cuts: [{ title: title ?? titleOf(asset), versions: [{ language: DEFAULT_LANGUAGE, asset }] }] };
      }
      // 素材必须真在本机：入库一个不存在的路径，到发布那天才报错就晚了。
      const assets = plan.cuts.flatMap((c) => (c?.versions ?? []).map((v) => v?.asset).filter(Boolean));
      const missing = assets.filter((a) => !existsSync(a));
      if (missing.length) fail(`找不到素材：${missing.join("、")}（路径要在本机，可以是视频文件或图片目录）`);
      // 封面（ACC-v3-fid-10）：路径要在本机且是文件；先过清单规则（必须是图片）再查文件在不在。
      const absCover = (o) => (typeof o?.cover === "string" && o.cover ? { cover: resolvePath(o.cover) } : {});
      plan.cuts = plan.cuts.map((c) => ({ ...c, ...absCover(c), versions: (c?.versions ?? []).map((v) => ({ ...v, ...absCover(v), asset: resolvePath(v.asset) })) }));
      checkWorkPlan({ title: plan.title, source: plan.source, cuts: plan.cuts });
      const noCover = [...new Set(plan.cuts.flatMap((c) => [c.cover, ...c.versions.map((v) => v.cover)]).filter(Boolean))].filter((a) => !existsSync(a) || !statSync(a).isFile());
      if (noCover.length) fail(`找不到封面图片：${noCover.join("、")}（路径要在本机）`);
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
      const defaultId = defaultGroupId(readConfig().relay?.default_group);
      const groups = store.listGroups().map((group) => ({
        ...group,
        ...(group.id === defaultId ? { default: true } : {}),
        accounts: groupAccounts(group.id),
      }));
      return { groups, current: current ? { id: current.id, name: current.name } : null, reportedAt: Date.now() };
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

    // 往飞书发哪几类。不带参数只返回现在的设置；关掉一类后那一类不再发卡片，确认只能在网页上做。
    "channel.settings": ({ confirm, issue, daily } = {}) => {
      const patch = {};
      for (const [k, v] of Object.entries({ confirm, issue, daily })) if (v !== undefined && v !== null) patch[k] = Boolean(v);
      if (!Object.keys(patch).length) return { kinds: store.getFeishuSettings().kinds };
      const before = store.getFeishuSettings().kinds;
      const next = store.patchFeishuSettings({ kinds: patch });
      emit({ type: "channel.settings_changed", payload: { channel: "feishu", from: before, to: next.kinds }, dedupeKey: `channel.settings_changed:${Date.now()}` });
      return {
        kinds: next.kinds,
        next: next.kinds.confirm ? null : "「要你确认的」不再发飞书：确认只能在网页的「今天」里做，没有人确认，一条都不会发",
      };
    },

    // 断开：删配对，并记成「不用飞书」。飞书里的机器人不动，用户自己决定删不删。
    "channel.unbind": () => {
      const removed = store.unbindChannel("feishu");
      store.patchFeishuSettings({ off: true, testSentAt: null });
      store.patchFeishuDelivery({ failure: null });
      emit({ type: "channel.disconnected", payload: { channel: "feishu", removed: removed.removed }, dedupeKey: `channel.disconnected:${Date.now()}` });
      return { ...removed, next: "已断开；要你确认的只出现在网页的「今天」里" };
    },

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
        // 需要应用凭证的平台（TikTok 官方接口、YouTube）：页面据此决定先填凭证还是直接授权。不含 secret。
        credentials: a.adapter.credentials?.status?.() ?? null,
      })),
    }),

    "account.credentials": ({ platform, clientKey, clientSecret }) => {
      const adapter = byPlatform.get(platform)?.adapter;
      if (typeof adapter?.credentials?.save !== "function") fail(`${store.platformLabelOf(platform)} 不需要应用凭证：账号直接登录即可`);
      let status;
      try {
        status = adapter.credentials.save({ clientKey, clientSecret });
      } catch (err) {
        // 错误信息里不带凭证本身。
        fail(err.message);
      }
      // 事件与日志只记「谁的凭证被保存了、从哪来」，不记 key / secret。
      emit({ type: "account.credentials_saved", payload: { platform, source: status.source } });
      log(`[credentials] ${platform} 应用凭证已保存`);
      return { platform, ...status };
    },

    "account.add": ({ platform, name, handle, credentialRef, group }) => {
      // 命令层 args 已把 group 标成必填；这里再挡一次，直接调 handler 的调用方也不能绕过。
      if (!group) fail("接入账号要先选账号组：先建一个账号组，或在已有的组里接入", "vk group add <名字>");
      const g = requireGroup(group);
      const shown = store.accountName(name);
      const result = store.addAccount({
        platform,
        handle: handle ?? shown,
        displayName: shown,
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

    "account.rename": ({ accountId, name }) => {
      const result = store.renameAccount(accountId, name);
      if (result.changed) emit({ type: "account.renamed", payload: { accountId, from: result.previous, to: result.name } });
      return result;
    },

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
        fail(`${store.platformLabelOf(account.platform)} 账号不需要这种授权，在系统页点「重新登录」`, `vk account reauth ${accountId}`);
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
        await notifyLogin(accountId);
        log(`[connect] ${account.platform} ${accountId} 授权完成`);
        return { accountId, state: "connected", displayName: r.displayName, avatarUrl: r.avatarUrl };
      }
      return {
        accountId,
        state: "waiting",
        url: session.url,
        next: account.platform === "youtube"
          ? "在浏览器里打开这个链接，用你的 Google 账号登录并同意；完成后这条命令会显示频道名"
          : "在浏览器里打开这个链接，用 TikTok 登录并同意；完成后这条命令会显示头像和昵称",
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
      if (!adapter) fail(`没有 ${account.platform} 适配器：这个平台的组件没装好`, `packages/adapter-${account.platform}`);
      if (account.platform === "bilibili") {
        return { accountId, started: false, next: `在电脑上运行：biliup -u ${account.credential_ref ?? "<cookies.json>"} login，选「浏览器登录」` };
      }
      if (account.platform === "xiaohongshu" || account.platform === "shipinhao") {
        return { accountId, started: false, next: loginHint(account.platform, accountId) };
      }
      if (account.platform === "tiktok-api" || account.platform === "youtube") {
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

    /**
     * 按成片生成平台稿（发布方案的最小形式，ACC-v2-plan-01/02/03、ACC-v2-copy-02）。
     * 不给 --accounts：当前账号组（或 --group）里所有已接入平台的账号各一条，状态一律待确认。
     * 每条要么建出来，要么跳过（已有）、要么拒绝（说明原因）——没有静默丢掉的账号。
     */
    "plan.apply": ({ cutId, accounts = null, group = null, fromRelay = false }) => {
      const conn = open();
      const cut = conn.prepare("SELECT * FROM cut WHERE id = ?").get(cutId);
      if (!cut) fail(`没有这支成片：${cutId}（到作品页看有哪些成片）`);
      const versions = conn.prepare("SELECT * FROM cut_version WHERE cut_id = ? ORDER BY rowid").all(cut.id);
      if (!versions.length) fail(`成片「${cut.title}」没有语言版本，没有素材可发：先把素材补进作品`);
      const version = versions.find((v) => v.language === "zh") ?? versions[0];
      const scope = group ? requireGroup(group) : store.currentGroup();
      const planKind = assetSetOf(version.asset_path).kind;
      const savedPlan = scope ? store.getGroupPlan(scope.id) : null;
      const planRow = savedPlan
        ? planModel.matchRow(planModel.normalizeRows(savedPlan), { kind: planKind, language: version.language }) ??
          fail(`发布方案里没有「${planModel.KIND_LABEL[planKind] ?? "成片"} · ${planModel.languageLabel(version.language)}」这一行，不知道发到哪些平台：到系统页的发布方案里加上这一行，或恢复默认方案`)
        : null;

      let targets;
      if (accounts != null) {
        const refs = [...new Set((Array.isArray(accounts) ? accounts : String(accounts).split(",")).map((x) => String(x).trim()).filter(Boolean))];
        if (!refs.length) fail("没有选账号：写账号 id，或这个组里的平台名（如 bilibili）");
        const pool = store.listAccounts({ groupId: scope?.id ?? null });
        targets = refs.map(
          (ref) =>
            pool.find((a) => a.id === ref) ??
            pool.find((a) => store.copyPlatformOf(a.platform) === store.copyPlatformOf(ref)) ??
            fail(`${scope ? `账号组「${scope.name}」里` : ""}没有账号「${ref}」（写账号 id，或这个组里的平台名；账号列表在系统页）`),
        );
        targets = [...new Map(targets.map((a) => [a.id, a])).values()];
      } else {
        targets = store.listAccounts({ groupId: scope?.id ?? null });
        if (!targets.length) fail(`${scope ? `账号组「${scope.name}」里` : ""}还没有账号：先到系统页接入账号`);
        // 发布方案（ACC-v2-sys-08）：存过方案的组按方案挑平台；没存过就是默认方案（所有账号）。
        if (planRow) {
          targets = targets.filter((a) => planModel.rowCovers(planRow, a));
          if (!targets.length) fail(`发布方案「${planModel.rowLabel(planRow)}」发到 ${planRow.platforms.join("、")}，但${scope ? `账号组「${scope.name}」里` : "这里"}还没有这些平台的账号：到系统页改发布方案，或先接入账号`);
        }
      }

      const versionCopy = (() => {
        try {
          return JSON.parse(version.meta_json ?? "null")?.copy ?? null;
        } catch {
          return null;
        }
      })();
      const kind = assetSetOf(version.asset_path).kind;
      const now = Date.now();
      const language = version.language;
      const view = { cutId: cut.id, cutTitle: cut.title, workId: cut.work_id, language, group: scope ? { id: scope.id, name: scope.name } : null };
      const created = [];
      const skipped = [];
      const rejected = [];
      const who = (a) => ({ accountId: a.id, platform: a.platform, handle: a.handle });

      for (const account of targets) {
        const existing = conn.prepare("SELECT id, state FROM publish WHERE cut_id = ? AND account_id = ?").get(cut.id, account.id);
        if (existing) {
          skipped.push({ ...who(account), publishId: existing.id, state: existing.state, reason: "已经有这支成片的平台稿" });
          continue;
        }
        const reject = (reason) => rejected.push({ ...who(account), reason });
        if (store.UNUSABLE_ACCOUNT_STATES.includes(account.state)) {
          reject(store.accountUnusableReason(account));
          continue;
        }
        const adapter = byPlatform.get(account.platform);
        if (!adapter) {
          reject(`没有 ${account.platform} 适配器，发不出去`);
          continue;
        }
        if (kind && Array.isArray(adapter.assetTypes) && !adapter.assetTypes.includes(kind)) {
          reject(`${platformLabel(account.platform)}目前只能发${adapter.assetTypes.map((t) => ASSET_KIND_LABEL[t]).join("、")}，这支成片是${ASSET_KIND_LABEL[kind]}`);
          continue;
        }
        // 通用文案留在语言版本上，平台稿只存入库时给这个平台「单独写的」字段（ACC-v3-edit-01）：
        // 之后改通用，跟通用的平台稿发出去的就是新的。限制按合并后的生效文案判。
        const entry = copyFor(versionCopy, account.platform);
        const own = versionCopy?.[store.copyPlatformOf(account.platform)] ?? {};
        const copy = { title: entry.title ?? cut.title, ...(entry.body ? { body: entry.body } : {}), ...(entry.tags?.length ? { tags: entry.tags } : {}) };
        const ownCopy = { ...(own.title ? { title: own.title } : {}), ...(own.body ? { body: own.body } : {}), ...(own.tags?.length ? { tags: own.tags } : {}) };
        const bad = copyViolations(account.platform, copy);
        if (bad.length) {
          reject(`文案超限：${bad.join("；")}。入库时给 ${platformLabel(account.platform)} 单独写一份更短的文案（超限不会自动截断）`);
          continue;
        }
        // 建议时间：从现在起离「一分钟后」最近、守平台规则（每日上限、最小间隔）的时间。
        const rules = planRules(account.platform);
        const wanted = now + 60e3 + (accounts == null && planRow ? planRow.delayDays * 86400e3 : 0);
        const suggestedAt = nearestAvailable(wanted, takenTimes(account.id, ""), rules, now);
        if (suggestedAt == null) {
          reject(`近期排不进去：${account.platform} 这个账号已排满（每日上限 ${rules.dailyCap} 条，最小间隔 ${rules.minGapMinutes} 分钟）`);
          continue;
        }
        const overrides = Object.keys(ownCopy).length ? { copy: ownCopy } : null;
        const made = store.createPublish({ workId: cut.work_id, accountId: account.id, cutId: cut.id, versionId: version.id, scheduledAt: suggestedAt, overrides, fromRelay });
        const shown = store.effectiveCopy({ overrides: overrides ? JSON.stringify(overrides) : null, versionMeta: version.meta_json, cutTitle: cut.title });
        created.push({
          ...who(account),
          publishId: made.id,
          state: made.state,
          suggestedAt,
          title: shown.title,
          body: shown.body,
          tags: shown.tags,
          empty: [...(shown.body ? [] : ["body"]), ...(shown.tags.length ? [] : ["tags"])],
        });
      }
      log(`[handlers] plan.apply ${cut.id}：建 ${created.length}、跳过 ${skipped.length}、拒绝 ${rejected.length}`);
      return {
        ...view,
        created,
        skipped,
        rejected,
        next: created.length ? `确认后才会发：vk publish approve --cut ${cut.id}（小红书逐条：vk publish approve --publish <id>）` : null,
      };
    },

    /** 发布方案（ACC-v2-sys-08）：当前账号组的方案行 + 组里已接入的平台 + 生效的平台规则。 */
    "plan.show": ({ group = null } = {}) => planView(group ? requireGroup(group) : store.currentGroup()),

    "plan.set": ({ kind = "*", language = "*", platforms = null, delayDays = 0, remove = false, group = null }) => {
      const scope = group ? requireGroup(group) : (store.currentGroup() ?? fail("还没有账号组：先到系统页建一个", "vk group add <名字>"));
      if (!planModel.PLAN_KINDS.includes(kind)) fail(`成片类型只能是 video、image 或 *，收到：${kind}`);
      const lang = String(language).trim() || "*";
      const current = planModel.normalizeRows(store.getGroupPlan(scope.id) ?? [planModel.DEFAULT_ROW]);
      const same = (r) => r.kind === kind && r.language === lang;
      if (remove) {
        if (!current.some(same)) fail(`发布方案里没有「${planModel.rowLabel({ kind, language: lang })}」这一行`);
        const next = current.filter((r) => !same(r));
        if (!next.length) fail("方案至少要留一行：不想要自定义方案就恢复默认方案", "vk plan reset");
        store.setGroupPlan(scope.id, next);
        return planView(scope);
      }
      const list = [...new Set((Array.isArray(platforms) ? platforms : String(platforms ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean))];
      if (!list.length) fail("要发到哪些平台？写平台名，如 bilibili、xiaohongshu（系统页能看到已安装的）");
      for (const p of list) if (!knownPlatforms().includes(p)) fail(`没有 ${p} 适配器（已安装：${knownPlatforms().join("、")}）`);
      if (!Number.isInteger(delayDays) || delayDays < 0 || delayDays > planModel.MAX_DELAY_DAYS) fail(`节奏的天数要是 0 到 ${planModel.MAX_DELAY_DAYS} 的整数`);
      const row = { kind, language: lang, platforms: list, delayDays };
      const at = current.findIndex(same);
      store.setGroupPlan(scope.id, at < 0 ? [...current, row] : current.map((r, i) => (i === at ? row : r)));
      log(`[handlers] plan.set ${scope.name}：${planModel.rowLabel(row)} → ${list.join(",")}`);
      return planView(scope);
    },

    "plan.reset": ({ group = null } = {}) => {
      const scope = group ? requireGroup(group) : (store.currentGroup() ?? fail("还没有账号组：先到系统页建一个"));
      store.setGroupPlan(scope.id, null);
      return planView(scope);
    },

    /** 发布机：心跳 + 排着要发 / 正在发 / 等你确认，数字与「今天」同源（buildToday）。 */
    "machine.status": ({ group = null } = {}) => {
      const g = group ? requireGroup(group) : store.currentGroup();
      const today = overview.buildToday({ groupId: g?.id ?? null });
      const running = today.scheduled.filter((r) => r.state !== "queued");
      const queued = today.scheduled.filter((r) => r.state === "queued");
      const heartbeatAt = store.lastHeartbeat();
      const now = Date.now();
      return {
        group: g ? { id: g.id, name: g.name } : null,
        // 设备名：用户起的名字（config.json 的 device.name）；没起名就叫「发布机」，不把主机名 xxx.local 露给人看（ACC-v3-fid-11）。
        name: deviceName(),
        heartbeatAt,
        heartbeatAgeMs: heartbeatAt ? Math.max(0, now - heartbeatAt) : null,
        online: heartbeatAt != null && now - heartbeatAt < HEARTBEAT_STALE_MS,
        queued: { count: queued.length, nextAt: queued.find((r) => r.scheduledAt != null)?.scheduledAt ?? null },
        running: { count: running.length },
        awaiting: { count: today.awaiting.reduce((n, w) => n + w.cuts.reduce((m, c) => m + c.publishes.length, 0), 0) },
        // 出口位置（侧栏底部一行读它）：国家城市 + IP；暂停的账号数。
        egress: egressSummary(g?.id ?? null),
      };
    },

    /** 出口位置：线路、IP 库状态、每个账号的判断（系统页「设备」和 vk egress 读同一份）。 */
    "egress.status": ({ group = null } = {}) => egress.view({ groupId: (group ? requireGroup(group) : store.currentGroup())?.id ?? null }),

    "egress.recheck": async ({ group = null } = {}) => {
      try {
        await egress.probeNow();
      } catch (err) {
        emit({ type: "egress.probe_failed", severity: "warn", payload: { code: "egress_probe_failed", message: err.message }, dedupeKey: `egress.probe_failed:manual:${Date.now()}` });
        fail(`没能探测出口位置：${err.message}`);
      }
      return egress.view({ groupId: (group ? requireGroup(group) : store.currentGroup())?.id ?? null });
    },

    "egress.geodb": ({ group = null } = {}) => {
      const started = egress.startGeoDbDownload({ log: (m) => console.error(m) });
      return { started, alreadyRunning: !started, ...egress.view({ groupId: (group ? requireGroup(group) : store.currentGroup())?.id ?? null }) };
    },

    "egress.accept": ({ group = null, accountId = null, confirm = false } = {}) => {
      const g = group ? requireGroup(group) : store.currentGroup();
      if (confirm !== true) fail("继续用新位置要再确认一次：如果这台电脑其实开着代理，平台会看到这些账号突然换了国家，有被处罚的风险", "加 --yes");
      const done = egress.acceptNewPlace({ groupId: g?.id ?? null, accountId });
      return { ...done, ...egress.view({ groupId: g?.id ?? null }) };
    },

    "egress.wait": ({ group = null, accountId = null } = {}) => {
      const g = group ? requireGroup(group) : store.currentGroup();
      const done = egress.waitForRecheck({ groupId: g?.id ?? null, accountId });
      return { ...done, ...egress.view({ groupId: g?.id ?? null }) };
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
    "publish.approve": ({ cutId = null, publishId = null, when = "scheduled" }) => {
      preflightDrafts({ cutId, publishId });
      const result = releaseNativeSchedule(store.approvePublishes({ cutId, publishId, when }));
      checkLoginOnConfirm(result);
      return result;
    },

    // 改内容（ACC-v3-edit-*）：通用文案、各平台单独写的字段、按时间发的时间，一次提交、带 rev。
    "cut.edit": ({ cutId, rev, language = null, generic = null, platforms = null }) => store.editCut({ cutId, rev, language, generic, platforms }),

    "publish.now": ({ publishId }) => {
      preflightDrafts({ publishId });
      const result = store.publishNow({ publishId });
      checkLoginOnConfirm({ approved: [result] });
      return result;
    },

    "publish.manual": ({ publishId }) => store.publishManual({ publishId }),

    "publish.skip": ({ cutId }) => store.skipCut({ cutId }),

    "publish.edit": ({ publishId, title = null, at = null, privacy = null, comment = null, duet = null, stitch = null, caption = null, draft = null, body = null, tags = null }) => {
      // 时间要先过平台规则（每日上限、最小间隔）。状态不对、过去的时间等错误仍由 store 报，保持原来的措辞。
      if (at != null && Number.isInteger(at) && at > Date.now()) {
        const row = store.getPublish(publishId);
        if (row && store.CONFIRMABLE_STATES.includes(row.state)) assertPlanSlot(row, at);
      }
      return store.editPublish({ publishId, title, at, privacy, comment, duet, stitch, caption, draft, body, tags });
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
      const rows = overview.statsWithBaseline(store.listStats({ range, publishId, groupId: g?.id ?? null }));
      const sole = store.soleCutTitles(rows.filter((r) => !r.cutTitle).map((r) => r.workId));
      return { group: g, rows: rows.map((r) => (r.cutTitle || !sole.has(r.workId) ? r : { ...r, cutTitle: sole.get(r.workId) })) };
    },

    "stats.series": ({ publishId }) => ({ publishId, points: store.seriesFor({ publishId }) }),

    // 给了 from / to 就是日历的取数（ACC-v3-cal-08）：只取可见范围、只限当前组，
    // 连同「天 × 平台」额度一起返回，额度的上限与排期用同一条 planRules。
    "publish.list": ({ state = null, platform = null, limit = 100, from = null, to = null, group = null }) => {
      if (from == null && to == null) return { rows: store.listPublishes({ state, platform, limit }) };
      if (from == null || to == null) fail("看日历要同时给开始和结束日期", "vk publish list --from <日期> --to <日期>");
      const g = group ? requireGroup(group) : store.currentGroup();
      const groupId = g?.id ?? null;
      const rows = store.listCalendarPublishes({ from, to, groupId }).filter((r) => (!state || r.state === state) && (!platform || r.platform === platform));
      return { group: g ? { id: g.id, name: g.name } : null, from, to, rows, quota: dayUsage({ from, to, groupId }) };
    },

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
  return handlers;
}
