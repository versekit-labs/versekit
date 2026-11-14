// Writes that the CLI, the web console and the card handlers all share.
//
// Nothing above the core touches SQL directly: this module is where "create a publish" means the
// same five things everywhere (work row, publish row, queue entry, validation, readable error).

import { open, newId } from "./index.mjs";
import { queuePublish } from "./runner.mjs";

export const PUBLISH_MODES = ["auto", "draft", "notify", "manual"];
/**
 * 账号发布模式。不动 schema：沿用 account.is_manual 这一列，0 = auto、1 = manual、2 = handoff。
 * handoff = 交给手机：电脑准备内容、生成交接页，人在手机 App 里点发布；程序不访问平台
 * （docs/research/publish-risk.md）。scheduler 的 `is_manual = 0` 过滤天然把它排除在体检之外。
 */
export const ACCOUNT_MODES = ["auto", "manual", "handoff"];
const MODE_CODE = { auto: 0, manual: 1, handoff: 2 };
export const HANDOFF_CODE = MODE_CODE.handoff;

export const accountModeOf = (account) => ACCOUNT_MODES[Number(account?.is_manual ?? 0)] ?? "auto";
export const isHandoffAccount = (account) => accountModeOf(account) === "handoff";

/** 这些平台新建账号时默认交给手机（小红书：自动化测试发布会被永久禁发）。 */
export const HANDOFF_BY_DEFAULT = new Set(["xiaohongshu"]);

export const PUBLISH_VISIBILITIES = ["public", "private", "friends", "private_then_public"];

/**
 * 已失效 = 这个账号现在发不出去，不是「快过期了提醒一下」。expired 需要重登，banned 需要换号/申诉；
 * 两种都必须从发布选择里排除，并且把原因带回去，不能静默跳过让用户以为发出去了。
 */
export const UNUSABLE_ACCOUNT_STATES = ["expired", "banned"];

/** Handles are stored with or without a leading @; the person should never see `@@`. */
export const handleLabel = (handle) => (String(handle ?? "").startsWith("@") ? String(handle) : `@${handle}`);

export function accountUnusableReason(account) {
  if (account.state === "expired") {
    return `${account.platform} ${handleLabel(account.handle)} 已失效（登录过期）：先 vk account reauth ${account.id}`;
  }
  if (account.state === "banned") {
    return `${account.platform} ${handleLabel(account.handle)} 已失效（被平台封禁）：换号或申诉解封后再发`;
  }
  return null;
}

const fail = (message) => {
  throw new Error(message);
};

const requireString = (value, field, { max = 500 } = {}) => {
  if (typeof value !== "string" || !value.trim()) fail(`${field} 不能为空`);
  if (value.length > max) fail(`${field} 太长（最多 ${max} 字）`);
  return value.trim();
};

/**
 * `groupId` 为空时返回全部在用账号（引入账号组之前的读法）；给了就只看这个组。
 * 已移除（removed_at 非空）的账号不再出现在任何"当前账号"列表里：它不占槽位，
 * 但行还留着，历史发布与快照仍能通过 publish.account_id 追到。
 */
export function listAccounts({ groupId = null, includeRemoved = false } = {}) {
  const conn = open();
  const live = includeRemoved ? "" : " AND removed_at IS NULL";
  const rows = groupId
    ? conn.prepare(`SELECT * FROM account WHERE group_id = ?${live} ORDER BY platform, handle`).all(groupId)
    : conn.prepare(`SELECT * FROM account WHERE 1=1${live} ORDER BY platform, handle`).all();
  return rows.map((row) => ({ ...row, mode: accountModeOf(row) }));
}

// ------------------------------------------------------------------ account groups
//
// 账号组是第一层导航：进去先选组，之后所有页面只看该组（docs/design/HANDOFF.md §3）。
// 「当前组」是本机状态，放 meta 表，不是每个请求都要带的参数。

const CURRENT_GROUP_KEY = "current_group";

export function listGroups() {
  return open()
    .prepare(
      `SELECT g.id, g.name, g.created_at, COUNT(a.id) AS account_count
         FROM account_group g LEFT JOIN account a ON a.group_id = g.id AND a.removed_at IS NULL
        GROUP BY g.id ORDER BY g.created_at, g.name`,
    )
    .all();
}

/** 按 id 或名字找组；找不到返回 null。 */
export function findGroup(ref) {
  if (typeof ref !== "string" || !ref.trim()) return null;
  return open().prepare("SELECT * FROM account_group WHERE id = ? OR name = ?").get(ref.trim(), ref.trim()) ?? null;
}

export function addGroup({ name }) {
  const n = requireString(name, "组名", { max: 64 });
  const existing = open().prepare("SELECT id FROM account_group WHERE name = ?").get(n);
  if (existing) return { id: existing.id, name: n, existed: true };
  const id = newId("grp");
  open().prepare("INSERT INTO account_group (id, name, created_at) VALUES (?,?,?)").run(id, n, Date.now());
  return { id, name: n, existed: false };
}

/** 改组名：只改显示名，不动 id（排期、发布、账号都按 id 关联）。
 *  重名与新建组同一套规则：名字唯一，撞到自己不算冲突（幂等改名）。 */
export function renameGroup({ id, name }) {
  const target = findGroup(id);
  if (!target) fail(`没有这个账号组：${id}（先 vk group list 看看有哪些）`);
  const n = requireString(name, "组名", { max: 64 });
  if (n === target.name) return { id: target.id, name: n, changed: false };
  const clash = open().prepare("SELECT id FROM account_group WHERE name = ? AND id != ?").get(n, target.id);
  if (clash) fail(`已经有一个叫「${n}」的账号组了，换个名字`);
  open().prepare("UPDATE account_group SET name = ? WHERE id = ?").run(n, target.id);
  return { id: target.id, name: n, changed: true, previous: target.name };
}

/** 当前组；记录的组已不存在时当作没有当前组，而不是返回一个悬空 id。 */
export function currentGroup() {
  const row = open().prepare("SELECT value FROM meta WHERE key = ?").get(CURRENT_GROUP_KEY);
  if (!row) return null;
  return open().prepare("SELECT * FROM account_group WHERE id = ?").get(row.value) ?? null;
}

export function useGroup(ref) {
  const group = findGroup(ref);
  if (!group) fail(`没有这个账号组：${ref}（先 vk group add <名字>）`);
  open()
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(CURRENT_GROUP_KEY, group.id);
  return group;
}

export function getAccount(accountId) {
  return open().prepare("SELECT * FROM account WHERE id = ? AND removed_at IS NULL").get(accountId) ?? null;
}

export function findAccount(platform, handle = null) {
  const conn = open();
  return handle
    ? conn.prepare("SELECT * FROM account WHERE platform = ? AND handle = ? AND removed_at IS NULL").get(platform, handle)
    : conn.prepare("SELECT * FROM account WHERE platform = ? AND removed_at IS NULL ORDER BY created_at LIMIT 1").get(platform);
}

/** 组里当前占用某个平台槽位的账号；没有就返回 null。箭头指向的就是「被谁占用」。 */
export function occupantOf(groupId, platform) {
  return (
    open()
      .prepare("SELECT id, handle, display_name FROM account WHERE group_id = ? AND platform = ? AND removed_at IS NULL")
      .get(groupId, platform) ?? null
  );
}

export function addAccount({ platform, handle, displayName = null, credentialRef = null, groupId = null }) {
  const p = requireString(platform, "platform", { max: 32 });
  const h = requireString(handle, "handle", { max: 200 });
  if (!groupId) fail("account.add 必须带 --group：先 vk group add <名字> 建组，或 vk group list 看已有的组");
  const group = open().prepare("SELECT id, name FROM account_group WHERE id = ?").get(groupId);
  if (!group) fail(`没有这个账号组：${groupId}`);

  const existing = open().prepare("SELECT * FROM account WHERE platform = ? AND handle = ?").get(p, h);
  if (existing && !existing.removed_at) {
    if (existing.group_id !== groupId) {
      const other = open().prepare("SELECT name FROM account_group WHERE id = ?").get(existing.group_id);
      fail(`账号 ${h}（${existing.id}）已经在账号组「${other?.name ?? existing.group_id}」里：同一个账号不能同时挂两个组`);
    }
    return { id: existing.id, existed: true };
  }

  const taken = occupantOf(groupId, p);
  if (taken) {
    const who = taken.display_name && taken.display_name !== taken.handle ? `${taken.handle}（${taken.display_name}）` : taken.handle;
    fail(`账号组「${group.name}」的 ${p} 已被 ${who} 占用（${taken.id}）：一个组每个平台只能有一个；要换号，先运行 vk account remove ${taken.id}`);
  }

  // 同一个 handle 之前被移除过：复活那一行，保留它的发布历史，不造一个"新账号"把旧数据割裂。
  if (existing?.removed_at) {
    open()
      .prepare(
        "UPDATE account SET group_id = ?, display_name = ?, credential_ref = ?, state = 'ok', removed_at = NULL, last_checked_at = NULL, last_ok_at = NULL WHERE id = ?",
      )
      .run(groupId, displayName, credentialRef, existing.id);
    return { id: existing.id, existed: false, revived: true };
  }

  const id = newId("acc");
  open()
    .prepare("INSERT INTO account (id, platform, handle, display_name, credential_ref, state, created_at, group_id, is_manual) VALUES (?,?,?,?,?, 'ok', ?, ?, ?)")
    .run(id, p, h, displayName, credentialRef, Date.now(), groupId, HANDOFF_BY_DEFAULT.has(p) ? HANDOFF_CODE : 0);
  return { id, existed: false };
}

/**
 * 移除账号：不删行。把 removed_at 写上后它不再占组里的平台槽位（唯一索引只看在用账号），
 * 但 publish/snapshot 仍然能通过 account_id 找到它——换号不该把历史一起烧掉。
 * 队列里还没跑完的发布会拒绝移除：否则移除之后它仍在后台发出去，人以为已经停了。
 */
export function removeAccount(accountId) {
  const conn = open();
  const account = conn.prepare("SELECT * FROM account WHERE id = ?").get(accountId);
  if (!account) fail(`没有这个账号：${accountId}`);
  if (account.removed_at) fail(`账号 ${account.handle}（${accountId}）已经移除，不用再移一次`);

  const pending = conn
    .prepare("SELECT COUNT(*) n FROM publish WHERE account_id = ? AND state IN ('queued','auto_running','draft_running')")
    .get(accountId).n;
  if (pending) {
    fail(`这个账号还有 ${pending} 条发布在队列里或正在跑：等它们结束，或先取消对应排期，再移除账号`);
  }

  const group = account.group_id ? conn.prepare("SELECT name FROM account_group WHERE id = ?").get(account.group_id) : null;
  conn.prepare("UPDATE account SET removed_at = ? WHERE id = ?").run(Date.now(), accountId);
  const published = conn.prepare("SELECT COUNT(*) n FROM publish WHERE account_id = ?").get(accountId).n;
  return {
    accountId,
    removed: true,
    platform: account.platform,
    handle: account.handle,
    group: group ? { id: account.group_id, name: group.name } : null,
    historyKept: published,
  };
}

export function setAccountMode(accountId, mode) {
  if (!ACCOUNT_MODES.includes(mode)) fail(`模式只能是 ${ACCOUNT_MODES.join(" / ")}`);
  const account = getAccount(accountId);
  if (!account) fail(`没有这个账号：${accountId}`);
  open().prepare("UPDATE account SET is_manual = ? WHERE id = ?").run(MODE_CODE[mode], accountId);
  // handoff 不需要电脑登录：之前因登录失效标成 expired 的号，切过来后不该再显示「已过期」。
  if (mode === "handoff" && ["expired", "expiring"].includes(account.state)) {
    open().prepare("UPDATE account SET state = 'ok' WHERE id = ?").run(accountId);
  }
  return { id: accountId, mode };
}

export function setAccountState(accountId, state) {
  const allowed = ["ok", "expiring", "expired", "banned", "manual"];
  if (!allowed.includes(state)) fail(`账号状态只能是 ${allowed.join(" / ")}`);
  open().prepare("UPDATE account SET state = ? WHERE id = ?").run(state, accountId);
  return { id: accountId, state };
}

// ------------------------------------------------------------------ work / publish

export function createWork({ title, assetPath, meta = null }) {
  const t = requireString(title, "标题", { max: 200 });
  const a = requireString(assetPath, "素材路径", { max: 4096 });
  const id = newId("work");
  open()
    .prepare("INSERT INTO work (id, title, asset_path, meta_json, created_at) VALUES (?,?,?,?,?)")
    .run(id, t, a, meta ? JSON.stringify(meta) : null, Date.now());
  return { id, title: t, assetPath: a };
}

export function getWork(workId) {
  return open().prepare("SELECT * FROM work WHERE id = ?").get(workId) ?? null;
}

/**
 * One publish row per (work, account). Creating it also queues it — a row nobody queued is a
 * publish that silently never happens, which is the exact failure mode this product forbids.
 */
export function createPublish({
  workId,
  accountId,
  mode = "auto",
  visibility = "public",
  scheduledAt = null,
  overrides = null,
  enqueue = true,
}) {
  if (!getWork(workId)) fail(`没有这条内容：${workId}`);
  const account = getAccount(accountId);
  if (!account) fail(`没有这个账号：${accountId}`);
  if (!PUBLISH_MODES.includes(mode)) fail(`发布模式只能是 ${PUBLISH_MODES.join(" / ")}`);
  if (!PUBLISH_VISIBILITIES.includes(visibility)) fail(`可见性只能是 ${PUBLISH_VISIBILITIES.join(" / ")}`);
  if (scheduledAt != null && (!Number.isInteger(scheduledAt) || scheduledAt < 0)) fail("定时时间必须是毫秒时间戳");

  const id = newId("pub");
  const now = Date.now();
  try {
    open()
      .prepare(
        `INSERT INTO publish (id, work_id, account_id, mode, visibility, state, scheduled_at, overrides_json, created_at, updated_at)
         VALUES (?,?,?,?,?, 'queued', ?,?,?,?)`,
      )
      .run(id, workId, accountId, mode, visibility, scheduledAt, overrides ? JSON.stringify(overrides) : null, now, now);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      fail(`这条内容已经发过 ${account.platform} @${account.handle}：同一内容对同一账号只能有一条发布`);
    }
    throw err;
  }

  // manual means "track it, do not act on it", so it is never queued.
  const queued = enqueue && mode !== "manual";
  if (queued) {
    const runAfter = scheduledAt && scheduledAt > now ? scheduledAt : null;
    queuePublish({ id, account_id: accountId }, { runAfter });
  }
  return { id, workId, accountId, mode, visibility, queued };
}

export function getPublish(publishId) {
  return open()
    .prepare(
      `SELECT p.*, a.platform, a.handle, a.state AS account_state, a.is_manual AS account_manual, w.title AS work_title, w.asset_path, w.meta_json
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
        WHERE p.id = ?`,
    )
    .get(publishId) ?? null;
}

/**
 * Accounts per platform, so `--to tiktok,bilibili` does not need account ids on the command line.
 *
 * `groupId` scopes the lookup (publish.create defaults to the current group). Accounts in
 * `UNUSABLE_ACCOUNT_STATES` are never returned as selectable: they are reported separately with
 * a reason, which is what the caller turns into a readable error instead of a silent skip.
 */
export function accountsForPlatforms(platforms, { groupId = null } = {}) {
  const found = [];
  const missing = [];
  const unusable = [];
  const blocked = [];
  for (const platform of platforms) {
    // 已移除的账号不占槽位，也不能进候选：软删除和 group 作用域是两个独立条件，二者都在这里过滤。
    const accounts = groupId
      ? open()
          .prepare("SELECT * FROM account WHERE platform = ? AND group_id = ? AND removed_at IS NULL ORDER BY created_at")
          .all(platform, groupId)
      : open()
          .prepare("SELECT * FROM account WHERE platform = ? AND removed_at IS NULL ORDER BY created_at")
          .all(platform);
    if (!accounts.length) {
      missing.push(platform);
      continue;
    }
    const usable = accounts.filter((a) => !UNUSABLE_ACCOUNT_STATES.includes(a.state));
    if (!usable.length) {
      blocked.push(platform);
      for (const a of accounts) {
        unusable.push({ platform: a.platform, accountId: a.id, handle: a.handle, state: a.state, reason: accountUnusableReason(a) });
      }
      continue;
    }
    found.push(...usable);
    // 同一平台还有别的失效号（未分组的旧数据）不影响这次发布：列出来只是为了解释，不是拦截。
    for (const a of accounts.filter((x) => !usable.includes(x))) {
      unusable.push({ platform: a.platform, accountId: a.id, handle: a.handle, state: a.state, reason: accountUnusableReason(a) });
    }
  }
  return { accounts: found, missing, unusable, blocked };
}

// ------------------------------------------------------------------ status / stats

export function countPublished() {
  return open().prepare("SELECT COUNT(*) n FROM publish WHERE state IN ('published','published_limited')").get().n;
}

export function statusSnapshot() {
  const conn = open();
  const count = (sql, ...params) => conn.prepare(sql).get(...params)?.n ?? 0;
  return {
    accounts: {
      total: count("SELECT COUNT(*) n FROM account WHERE removed_at IS NULL"),
      by_state: Object.fromEntries(
        ["ok", "expiring", "expired", "banned", "manual"].map((s) => [
          s,
          count("SELECT COUNT(*) n FROM account WHERE state = ? AND removed_at IS NULL", s),
        ]),
      ),
      list: listAccounts(),
    },
    queue: {
      queued: count("SELECT COUNT(*) n FROM run WHERE state='queued'"),
      running: count("SELECT COUNT(*) n FROM run WHERE state='running'"),
      failed: count("SELECT COUNT(*) n FROM run WHERE state='failed'"),
    },
    publishes: {
      published: count("SELECT COUNT(*) n FROM publish WHERE state='published'"),
      published_limited: count("SELECT COUNT(*) n FROM publish WHERE state='published_limited'"),
      needs_human: count("SELECT COUNT(*) n FROM publish WHERE state='notify_pending'"),
      failed: count("SELECT COUNT(*) n FROM publish WHERE state='failed'"),
    },
    channel: (() => {
      const binding = getBinding("feishu");
      return {
        feishu: binding ? "bound" : "unbound",
        binding: binding ? { external_user_id: binding.external_user_id, paired_at: binding.paired_at } : null,
      };
    })(),
  };
}

/** "7d" / "24h" / "all" → a cutoff timestamp. Unknown values are rejected rather than ignored. */
export function rangeCutoff(range = "all", now = Date.now()) {
  if (range === "all") return 0;
  const m = /^(\d+)([hd])$/.exec(String(range));
  if (!m) throw new Error(`时间范围只能是 24h / 7d / 30d / all，收到 ${range}`);
  const unit = m[2] === "h" ? 3600e3 : 24 * 3600e3;
  return now - Number(m[1]) * unit;
}

/** Latest snapshot per publish, joined with what the row is. One row per work, not per capture. */
export function listStats({ range = "all", publishId = null, groupId = null } = {}) {
  const cutoff = rangeCutoff(range);
  const conn = open();
  const rows = conn
    .prepare(
      `SELECT p.id, p.state, p.visibility, p.external_url, a.platform, a.handle,
              w.title,
              s.captured_at, s.source, s.status, s.metrics_json
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
         LEFT JOIN snapshot s ON s.publish_id = p.id
          AND s.captured_at = (SELECT MAX(captured_at) FROM snapshot WHERE publish_id = p.id)
        WHERE (? IS NULL OR p.id = ?)
          AND (? IS NULL OR a.group_id = ?)
          AND (? = 0 OR p.created_at >= ?)
        ORDER BY p.created_at DESC`,
    )
    .all(publishId, publishId, groupId, groupId, cutoff, cutoff);

  return rows.map((r) => ({
    publishId: r.id,
    platform: r.platform,
    handle: r.handle,
    title: r.title,
    state: r.state,
    url: r.external_url,
    latest: r.captured_at
      ? { capturedAt: r.captured_at, source: r.source, status: r.status, metrics: JSON.parse(r.metrics_json) }
      : null,
  }));
}

// ------------------------------------------------------------------ 列表（Web / CLI 共用）

const boundedLimit = (limit, fallback = 100) => {
  const n = Number(limit ?? fallback);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, 500);
};

export function listPublishes({ state = null, platform = null, limit = 100 } = {}) {
  return open()
    .prepare(
      `SELECT p.id, p.state, p.mode, p.visibility, p.external_id, p.external_url,
              p.error_code, p.error_message, p.fallback_reason, p.scheduled_at,
              p.created_at, p.updated_at, a.platform, a.handle, w.title, w.asset_path
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
        WHERE (? IS NULL OR p.state = ?)
          AND (? IS NULL OR a.platform = ?)
        ORDER BY p.created_at DESC LIMIT ?`,
    )
    .all(state, state, platform, platform, boundedLimit(limit));
}

/**
 * Queue rows with an optional account-group filter.
 *
 * A run's group is not a column: publish runs point at a publish → account, check runs point at
 * an account directly. Resolving both here keeps `--group` one implementation for CLI, HTTP and
 * any future page instead of three slightly different joins.
 */
export function listRuns({ state = null, limit = 100, groupId = null } = {}) {
  return open()
    .prepare(
      `SELECT r.id, r.kind, r.target_type, r.target_id, r.lane, r.state, r.priority, r.attempts,
              r.run_after, r.lease_until, r.last_error, r.created_at
         FROM run r
         LEFT JOIN publish p ON r.target_type = 'publish' AND p.id = r.target_id
         LEFT JOIN account a ON a.id = COALESCE(p.account_id, CASE WHEN r.target_type = 'account' THEN r.target_id END)
        WHERE (? IS NULL OR r.state = ?)
          AND (? IS NULL OR a.group_id = ?)
        ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(state, state, groupId, groupId, boundedLimit(limit));
}

export function listEvents({ since = 0, limit = 100 } = {}) {
  const from = Number(since ?? 0);
  if (!Number.isFinite(from) || from < 0) fail("since 必须是毫秒时间戳");
  return open()
    .prepare(
      `SELECT id, type, severity, publish_id, payload_json, created_at
         FROM event WHERE created_at >= ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(from, boundedLimit(limit))
    .map((r) => ({ ...r, payload: r.payload_json ? JSON.parse(r.payload_json) : null }));
}

/** Every capture for one publish, oldest first: the shape a trend line needs. */
export function seriesFor({ publishId }) {
  const row = open().prepare("SELECT id FROM publish WHERE id = ?").get(publishId);
  if (!row) fail(`没有这条发布：${publishId}`);
  return open()
    .prepare("SELECT captured_at, source, status, metrics_json FROM snapshot WHERE publish_id = ? ORDER BY captured_at")
    .all(publishId)
    .map((s) => ({ at: s.captured_at, source: s.source, status: s.status, metrics: JSON.parse(s.metrics_json) }));
}

// ------------------------------------------------------------------ 通道配对

/** One binding per (channel, user); re-binding the same person just refreshes the timestamp. */
export function bindChannel(channel, externalUserId) {
  const c = requireString(channel, "channel", { max: 32 });
  const uid = requireString(externalUserId, "externalUserId", { max: 200 });
  const existing = open().prepare("SELECT id FROM channel_binding WHERE channel=? AND external_user_id=?").get(c, uid);
  if (existing) {
    open().prepare("UPDATE channel_binding SET paired_at=? WHERE id=?").run(Date.now(), existing.id);
    return { id: existing.id, existed: true, channel: c, externalUserId: uid };
  }
  const id = newId("bind");
  open()
    .prepare("INSERT INTO channel_binding (id, channel, external_user_id, paired_at) VALUES (?,?,?,?)")
    .run(id, c, uid, Date.now());
  return { id, existed: false, channel: c, externalUserId: uid };
}

/** Latest binding for a channel, or null. */
export function getBinding(channel) {
  return open().prepare("SELECT * FROM channel_binding WHERE channel=? ORDER BY paired_at DESC LIMIT 1").get(channel) ?? null;
}

/**
 * 一次性迁移：已有的小红书账号改为 handoff（交给手机）。
 *
 * 只跑一次（meta 里记标记）：之后用户用 `vk account mode <id> auto` 显式改回自动，
 * 下次启动不能再被迁移改回去。登录失效的状态一并复位——交给手机不要求电脑登录。
 */
export function migrateXiaohongshuToHandoff() {
  const conn = open();
  const KEY = "migration:xiaohongshu_handoff";
  if (conn.prepare("SELECT 1 FROM meta WHERE key = ?").get(KEY)) return { migrated: 0, already: true };
  const info = conn
    .prepare("UPDATE account SET is_manual = ?, state = CASE WHEN state IN ('expired','expiring') THEN 'ok' ELSE state END WHERE platform = 'xiaohongshu' AND is_manual != ?")
    .run(HANDOFF_CODE, HANDOFF_CODE);
  conn.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(KEY, String(Date.now()));
  return { migrated: Number(info.changes ?? 0), already: false };
}
