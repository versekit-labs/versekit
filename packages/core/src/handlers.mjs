// Command handlers: what each entry in `commands.mjs` actually does.
//
// These are pure functions of (args, state) on purpose — the daemon, the card channel and any
// future MCP bridge all call the same function, so "works in the CLI" and "works from a card"
// cannot diverge. Adapter work is queued, never awaited here: an HTTP request that waits 20
// minutes for an upload is a timeout, not a feature.

import { existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { open, transitionPublish, enqueue } from "./index.mjs";
import { queuePublish, queueCollect, MAX_ATTEMPTS } from "./runner.mjs";
import * as store from "./store.mjs";
import { nextCollectAt } from "./collect-plan.mjs";
import { setupStatus } from "./setup.mjs";
import { listSchedule, moveSchedule, cancelSchedule } from "./schedule.mjs";

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

export function createCoreHandlers({ adapters = [], log = () => {}, doctor = null } = {}) {
  const byPlatform = new Map(adapters.map((a) => [a.platform, a]));

  return {
    now: () => ({ ...store.statusSnapshot() }),

    "account.list": ({ group } = {}) => {
      if (!group) return { accounts: store.listAccounts() };
      const g = requireGroup(group);
      return { group: { id: g.id, name: g.name }, accounts: store.listAccounts({ groupId: g.id }) };
    },

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

    "group.use": ({ group }) => {
      const g = store.useGroup(group);
      return { current: { id: g.id, name: g.name } };
    },

    "channel.bind": ({ openId }) => store.bindChannel("feishu", openId),

    "setup.status": async () => {
      const binding = store.getBinding("feishu");
      return setupStatus({
        doctor: doctor ? await doctor() : null,
        accounts: store.listAccounts(),
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
        ready: a.adapter.ready(),
      })),
    }),

    "account.add": ({ platform, name, handle, credentialRef, group }) => {
      const groupId = group ? requireGroup(group).id : null;
      const result = store.addAccount({ platform, handle: handle ?? name, displayName: name, credentialRef: credentialRef ?? null, groupId });
      return { ...result, next: result.existed ? null : `下一步：vk account reauth ${result.id}（在电脑前完成扫码）` };
    },

    "account.mode": ({ accountId, mode }) => store.setAccountMode(accountId, mode),

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
      return { accountId, started: false, next: `打开本机浏览器登录 ${account.platform} @${account.handle}，完成后运行 vk account mode ${accountId} auto` };
    },

    "publish.create": ({ asset, to, schedule, visibility = "public", dryRun = false, title, body, tags, group }) => {
      const platforms = platformList(to);
      if (!existsSync(asset)) fail(`找不到素材：${asset}（路径要在本机，且是文件）`);

      // 默认作用域是 group.use 记录的当前组：发布台打开时看到的是哪一组，就只发哪一组。
      // 没选组（首次使用、旧数据）才退回「全部账号」，与引入账号组之前一致。
      const selectedGroup = group ? requireGroup(group) : store.currentGroup();
      const groupId = selectedGroup?.id ?? null;
      const scope = selectedGroup ? `账号组「${selectedGroup.name}」里` : "";

      const { accounts, missing, unusable, blocked } = store.accountsForPlatforms(platforms, { groupId });
      if (missing.length) {
        fail(`${scope}没有 ${missing.join("、")} 账号：先 vk account add ${missing[0]} --name 主号${selectedGroup ? ` --group ${selectedGroup.name}` : ""}`);
      }
      // 已失效的账号不可选，而且必须说清为什么：静默跳过等于「以为发了，其实没发」。
      // 只有「这个平台一个可用号都没有」才拦下整单；同平台还有可用号时，失效号只是不选它。
      if (blocked.length) {
        const reasons = unusable.filter((u) => blocked.includes(u.platform)).map((u) => u.reason);
        fail(`这些账号已失效，不能选：${reasons.join("；")}。换可用账号，或从 --to 里去掉这些平台`);
      }
      const noAdapter = platforms.filter((p) => !byPlatform.has(p));
      if (noAdapter.length) fail(`没有 ${noAdapter.join("、")} 适配器：装 packages/adapter-${noAdapter[0]}`);

      // 快失效的仍然可选，但提前告诉人：不是阻塞，不应该等到发布当天才在任务页发现。
      const warnings = accounts
        .filter((a) => a.state === "expiring")
        .map((a) => ({ platform: a.platform, accountId: a.id, handle: a.handle, state: a.state, reason: `${a.platform} ${store.handleLabel(a.handle)} 登录即将失效：发布前确认或重登` }));

      const planned = accounts.map((a) => ({ platform: a.platform, accountId: a.id, handle: a.handle, visibility }));
      const workTitle = title ?? titleOf(asset);
      const base = { group: selectedGroup ? { id: selectedGroup.id, name: selectedGroup.name } : null, ...(warnings.length ? { warnings } : {}) };

      // Dry-run answers "what would happen" without writing rows or touching a network.
      if (dryRun) {
        return { ...base, dryRun: true, work: { title: workTitle, asset }, publishes: planned, queued: false };
      }

      // 正文/话题是平台相关的素材（小红书用），放进 work.meta，不塞进 publish 的通用列。
      const meta = body || tags?.length ? { ...(body ? { body } : {}), ...(tags?.length ? { tags } : {}) } : null;
      const work = store.createWork({ title: workTitle, assetPath: asset, meta });
      const created = [];
      for (const account of accounts) {
        const { id } = store.createPublish({
          workId: work.id,
          accountId: account.id,
          visibility,
          scheduledAt: schedule ?? null,
        });
        created.push({ publishId: id, platform: account.platform, handle: account.handle });
      }
      log(`[handlers] 创建 ${created.length} 条发布：${created.map((c) => c.platform).join(", ")}`);
      return { ...base, workId: work.id, publishes: created };
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
      const g = group ? requireGroup(group) : null;
      return {
        group: g ? { id: g.id, name: g.name } : null,
        rows: store.listStats({ range, publishId, groupId: g?.id ?? null }),
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
