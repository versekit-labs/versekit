// Writes that the CLI, the web console and the card handlers all share.
//
// Nothing above the core touches SQL directly: this module is where "create a publish" means the
// same five things everywhere (work row, publish row, queue entry, validation, readable error).

import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { open, newId, paths, DEFAULT_LANGUAGE, transitionPublish, emit } from "./index.mjs";
import { queuePublish } from "./runner.mjs";
import { withBaselines } from "./baseline.mjs";
import { planRules, takenTimes, nearestAvailable, violationAt, PUBLISH_EFFECTIVE_AT } from "./plan-rules.mjs";

export const PUBLISH_MODES = ["auto", "draft", "notify", "manual"];
export const PUBLISH_VISIBILITIES = ["public", "private", "friends", "private_then_public"];

/**
 * 已失效 = 这个账号现在发不出去，不是「快过期了提醒一下」。expired 需要重登，banned 需要换号/申诉；
 * 两种都必须从发布选择里排除，并且把原因带回去，不能静默跳过让用户以为发出去了。
 */
export const UNUSABLE_ACCOUNT_STATES = ["expired", "banned"];

/** Handles are stored with or without a leading @; the person should never see `@@`. */
export const handleLabel = (handle) => (String(handle ?? "").startsWith("@") ? String(handle) : `@${handle}`);

/**
 * 同一个对人展示的平台可以有两个后端：tiktok = TikTok Studio 浏览器自动化，tiktok-api = 官方接口
 * （#143）。内部 id 不同，对人展示一律叫「TikTok」；同一个账号只能挂其中一个。
 */
export const PLATFORM_BACKENDS = { tiktok: ["tiktok", "tiktok-api"], "tiktok-api": ["tiktok", "tiktok-api"] };
export const backendsOf = (platform) => PLATFORM_BACKENDS[platform] ?? [platform];
const BACKEND_LABEL = { tiktok: "浏览器自动化", "tiktok-api": "官方接口" };
export const TIKTOK_API = "tiktok-api";

/** 对人展示的平台名：两个 TikTok 后端都叫 TikTok，不出现内部 id。 */
export const platformLabelOf = (platform) => (backendsOf(platform).includes("tiktok") ? "TikTok" : platform);

const normHandle = (handle) => String(handle ?? "").replace(/^@/, "").trim().toLowerCase();

export function accountUnusableReason(account) {
  if (account.state === "expired") {
    return `${account.platform} ${handleLabel(account.handle)} 已失效（登录过期）：先到系统页重新登录`;
  }
  if (account.state === "banned") {
    return `${account.platform} ${handleLabel(account.handle)} 已失效（被平台封禁）：换号或申诉解封后再发`;
  }
  return null;
}

const fail = (message, hint) => {
  throw Object.assign(new Error(message), hint ? { hint } : {});
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
  return groupId
    ? conn.prepare(`SELECT * FROM account WHERE group_id = ?${live} ORDER BY platform, handle`).all(groupId)
    : conn.prepare(`SELECT * FROM account WHERE 1=1${live} ORDER BY platform, handle`).all();
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
  if (!target) fail(`没有这个账号组：${id}（在系统页的账号组里看有哪些）`, "vk group list");
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
  if (!group) fail(`没有这个账号组：${ref}（先到系统页建一个）`, "vk group add <名字>");
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
  if (!groupId) fail("接入账号要先选账号组：先建一个账号组，或在已有的组里接入", "vk group add <名字>");
  const group = open().prepare("SELECT id, name FROM account_group WHERE id = ?").get(groupId);
  if (!group) fail(`没有这个账号组：${groupId}`);

  // 同一个 TikTok 账号不能同时挂两个后端（ACC-tiktok-api-04）：由 core 强制，不靠「平台名不同所以天然不冲突」。
  const family = backendsOf(p);
  if (family.length > 1) {
    const others = open()
      .prepare(`SELECT * FROM account WHERE platform IN (${family.map(() => "?").join(",")}) AND platform != ? AND removed_at IS NULL`)
      .all(...family, p);
    const same = others.find((a) => normHandle(a.handle) === normHandle(h));
    if (same) {
      fail(`${handleLabel(h)} 已经用「${BACKEND_LABEL[same.platform]}」接入 TikTok（${same.id}）：同一个账号不能同时挂两个后端；要换，先到系统页退出并移除旧账号`, `vk account remove ${same.id}`);
    }
    const slot = others.find((a) => a.group_id === groupId);
    if (slot) {
      fail(`账号组「${group.name}」的 TikTok 已被 ${handleLabel(slot.handle)} 占用（${slot.id}，${BACKEND_LABEL[slot.platform]}）：一个组每个平台只能有一个；要换号或换后端，先到系统页移除旧账号`, `vk account remove ${slot.id}`);
    }
  }

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
    fail(`账号组「${group.name}」的 ${p} 已被 ${who} 占用（${taken.id}）：一个组每个平台只能有一个；要换号，先到系统页移除旧账号`, `vk account remove ${taken.id}`);
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
    .prepare("INSERT INTO account (id, platform, handle, display_name, credential_ref, state, created_at, group_id) VALUES (?,?,?,?,?, 'ok', ?, ?)")
    .run(id, p, h, displayName, credentialRef, Date.now(), groupId);
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
  if (!["auto", "manual"].includes(mode)) fail("模式只能是 auto 或 manual");
  const account = getAccount(accountId);
  if (!account) fail(`没有这个账号：${accountId}`);
  open().prepare("UPDATE account SET is_manual = ? WHERE id = ?").run(mode === "manual" ? 1 : 0, accountId);
  return { id: accountId, mode };
}

/**
 * 授权完成后把结果落到账号行：账号表只存 credential_ref（token 在本机凭证目录里），昵称进 display_name。
 * 头像不进表：留在凭证文件的 profile 里，由 accountProfile 读出来给界面显示。
 */
export function applyAccountConnection({ accountId, credentialRef, displayName = null, expiresAt = null }) {
  const account = getAccount(accountId);
  if (!account) fail(`没有这个账号：${accountId}`);
  const now = Date.now();
  open()
    .prepare(
      "UPDATE account SET credential_ref = ?, display_name = COALESCE(?, display_name), state = 'ok', expires_at = COALESCE(?, expires_at), last_ok_at = ?, last_checked_at = ? WHERE id = ?",
    )
    .run(requireString(credentialRef, "credentialRef", { max: 512 }), displayName, expiresAt, now, now, accountId);
  return { accountId, state: "ok", displayName: displayName ?? account.display_name ?? null };
}

/** 账号的头像与昵称（来自 user.info.basic）。只读凭证文件里的 profile 字段，绝不把 token 带出去。 */
export function accountProfile(account) {
  if (account?.platform !== TIKTOK_API || !account.credential_ref) return null;
  const ref = normalize(String(account.credential_ref));
  if (isAbsolute(ref) || ref.split(sep).includes("..")) return null;
  const file = join(paths().credentials, ref);
  if (!existsSync(file)) return null;
  try {
    const profile = JSON.parse(readFileSync(file, "utf8")).profile ?? null;
    return profile ? { avatarUrl: profile.avatar_url ?? null, displayName: profile.display_name ?? null } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 平台侧用户标识（#220）
//
// 登录成功后读出平台那边的用户 id（小红书 = 创作者账号 id），存在 meta 表（不改表结构）。
// 同一个平台号接在两个账号上，等于第二个账号「直接登进了第一个号」：不标正常，就地写清楚。

const UID_KEY = (accountId) => `acct_uid:${accountId}`;
const CONFLICT_KEY = (accountId) => `acct_uid_conflict:${accountId}`;

export function getPlatformUid(accountId) {
  return open().prepare("SELECT value FROM meta WHERE key = ?").get(UID_KEY(accountId))?.value ?? null;
}

/** 这个账号当前的串号提示（人话）；没有冲突返回 null。 */
export function getIdentityConflict(accountId) {
  const row = open().prepare("SELECT value FROM meta WHERE key = ?").get(CONFLICT_KEY(accountId));
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function clearPlatformIdentity(accountId) {
  open().prepare("DELETE FROM meta WHERE key IN (?, ?)").run(UID_KEY(accountId), CONFLICT_KEY(accountId));
}

/**
 * 记下登录后读到的平台标识。同平台（含 TikTok 两个后端）已有别的在用账号用着同一个标识 → 冲突：
 * 账号状态压成 expired（发布会被拦），并写下人话；否则存下标识、清掉旧冲突。
 * 返回 { ok: true } 或 { ok: false, message, other }。
 */
export function recordPlatformUid(accountId, uid) {
  const account = getAccount(accountId);
  if (!account) fail(`没有这个账号：${accountId}`);
  const id = requireString(String(uid ?? ""), "平台用户标识", { max: 200 });
  const conn = open();
  const family = backendsOf(account.platform);
  const rows = conn
    .prepare(`SELECT key, value FROM meta WHERE key LIKE 'acct_uid:%' AND value = ?`)
    .all(id)
    .map((r) => r.key.slice("acct_uid:".length))
    .filter((other) => other !== accountId);
  for (const otherId of rows) {
    const other = getAccount(otherId);
    if (!other || !family.includes(other.platform)) continue;
    const group = other.group_id ? conn.prepare("SELECT name FROM account_group WHERE id = ?").get(other.group_id) : null;
    const otherName = other.display_name || other.handle;
    const label = account.platform === "xiaohongshu" ? "小红书号" : `${platformLabelOf(account.platform)} 号`;
    const message = `这个${label}已经接在「${group?.name ?? "未分组"}」的 ${otherName} 上；要接另一个号，先点「退出登录」，再扫码或短信登录另一个号`;
    conn
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(CONFLICT_KEY(accountId), JSON.stringify({ message, otherAccountId: otherId, otherName, group: group?.name ?? null }));
    conn.prepare("DELETE FROM meta WHERE key = ?").run(UID_KEY(accountId));
    conn.prepare("UPDATE account SET state = 'expired' WHERE id = ?").run(accountId);
    return { ok: false, message, other: { accountId: otherId, name: otherName, group: group?.name ?? null } };
  }
  conn
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(UID_KEY(accountId), id);
  conn.prepare("DELETE FROM meta WHERE key = ?").run(CONFLICT_KEY(accountId));
  return { ok: true, uid: id };
}

/** 退出登录后的账号状态：没连上（expired = 要重新登录），并清掉标识与冲突。 */
export function markAccountLoggedOut(accountId) {
  const account = getAccount(accountId);
  if (!account) fail(`没有这个账号：${accountId}`);
  clearPlatformIdentity(accountId);
  open().prepare("UPDATE account SET state = 'expired', last_ok_at = NULL, last_checked_at = NULL WHERE id = ?").run(accountId);
  return { accountId, state: "expired" };
}

/** 暂停账号（不再自动发）并记因：TikTok 的 spam_risk_* / reached_active_user_cap 走这里。 */
export function pauseAccount(accountId, { banned = false } = {}) {
  open().prepare(`UPDATE account SET is_manual = 1${banned ? ", state = 'banned'" : ""} WHERE id = ?`).run(accountId);
}

export function setAccountState(accountId, state) {
  const allowed = ["ok", "expiring", "expired", "banned", "manual"];
  if (!allowed.includes(state)) fail(`账号状态只能是 ${allowed.join(" / ")}`);
  open().prepare("UPDATE account SET state = ? WHERE id = ?").run(state, accountId);
  return { id: accountId, state };
}

// ------------------------------------------------------------------ work / publish

/**
 * publish.create 的快捷方式：1 作品 + 1 成片 + 1 语言版本。
 * 每次都新建（不按来源去重）——重复入库是 `work.add` 的语义，不改 publish.create 对外的行为。
 */
export function createWork({ title, assetPath, meta = null }) {
  const t = requireString(title, "标题", { max: 200 });
  const a = requireString(assetPath, "素材路径", { max: 4096 });
  const id = newId("work");
  const now = Date.now();
  const conn = open();
  conn.exec("BEGIN");
  try {
    conn
      .prepare("INSERT INTO work (id, title, asset_path, meta_json, created_at) VALUES (?,?,?,?,?)")
      .run(id, t, a, meta ? JSON.stringify(meta) : null, now);
    const cutId = newId("cut");
    conn.prepare("INSERT INTO cut (id, work_id, title, position, created_at) VALUES (?,?,?,0,?)").run(cutId, id, t, now);
    conn
      .prepare("INSERT INTO cut_version (id, cut_id, language, asset_path, meta_json, created_at) VALUES (?,?,?,?,?,?)")
      .run(newId("ver"), cutId, DEFAULT_LANGUAGE, a, meta ? JSON.stringify(meta) : null, now);
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return { id, title: t, assetPath: a };
}

export function getWork(workId) {
  return open().prepare("SELECT * FROM work WHERE id = ?").get(workId) ?? null;
}

/**
 * 入库一个作品（`vk work add`）：作品 → 成片 → 语言版本。
 *
 * 「同一来源、同一标题」是同一个作品：重复入库只更新（成片按标题认、版本按语言认，素材路径换成新的），
 * 不新建，也不删掉这次没提到的成片/版本——入库是追加与更新，不是整体替换，
 * 已经挂在成片下的平台稿因此不会被悄悄丢掉。
 *
 * cuts: [{ title, copy?, versions: [{ language, asset, meta?, copy? }] }]。校验在写任何行之前做完。
 * copy 是 Claude 入库时写好的各平台文案（见 normaliseCopy）；成片级打底、版本级覆盖，
 * 整理后存进每个语言版本的 meta_json.copy。
 */
/**
 * 清单的校验与规整：只看清单本身，不碰库、不看文件在不在。work.add 入库前用它，
 * 制作机 `vk work push` 上传前也用它——同一套规则，不合格当场报错。
 */
export function checkWorkPlan({ title, source = null, cuts }) {
  const t = requireString(title, "作品标题", { max: 200 });
  if (!Array.isArray(cuts) || !cuts.length) fail("至少要有一支成片");
  const seenCuts = new Set();
  const plan = cuts.map((c, i) => {
    const cutTitle = requireString(c?.title ?? (cuts.length === 1 ? t : ""), `第 ${i + 1} 支成片的标题`, { max: 200 });
    if (seenCuts.has(cutTitle)) fail(`成片标题重复：${cutTitle}（同一个作品里成片标题不能重名）`);
    seenCuts.add(cutTitle);
    const versions = Array.isArray(c?.versions) ? c.versions : [];
    if (!versions.length) fail(`成片「${cutTitle}」至少要有一个语言版本`);
    const seenLang = new Set();
    const cutCopy = normaliseCopy(c?.copy, `成片「${cutTitle}」的文案`);
    return {
      title: cutTitle,
      versions: versions.map((v) => {
        const language = requireString(v?.language ?? "", `成片「${cutTitle}」的语言`, { max: 32 });
        if (seenLang.has(language)) fail(`成片「${cutTitle}」的语言重复：${language}`);
        seenLang.add(language);
        const where = `成片「${cutTitle}」${language} 版本`;
        const copy = mergeCopy(cutCopy, normaliseCopy(v?.copy, `${where}的文案`));
        const cover = normaliseCover(v, c, where);
        const meta0 = copy ? { ...(v?.meta ?? {}), copy } : v?.meta ?? null;
        const meta = cover ? { ...(meta0 ?? {}), cover } : meta0;
        return { language, asset: requireString(v?.asset ?? "", `${where}的素材路径`, { max: 4096 }), meta };
      }),
    };
  });
  const src = source == null ? plan[0].versions[0].asset : requireString(source, "来源", { max: 4096 });
  const sourceKey = resolve(src);
  return { t, plan, sourceKey };
}

const COVER_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/** 清单里的 cover：图片路径（成片级打底、版本级覆盖）。没写是 null，写了就必须是图片。 */
function normaliseCover(v, c, where) {
  const raw = v?.cover ?? c?.cover;
  if (raw == null || raw === "") return null;
  const path = requireString(raw, `${where}的封面路径`, { max: 4096 });
  if (!COVER_EXTS.has(extname(path).toLowerCase())) fail(`${where}的封面要是图片（jpg / png / webp / gif）：${path}`);
  return path;
}

const editedList = (json) => {
  try {
    const list = JSON.parse(json ?? "[]");
    return Array.isArray(list) ? list.filter((f) => ["title", "body", "tags"].includes(f)) : [];
  } catch {
    return [];
  }
};

/** 再次入库时：人改过的通用字段取库里现有的值（现有没有就保持没有），其余取这次入库的。 */
function keepEditedCopy(meta, have) {
  const edited = editedList(have.edited_fields);
  if (!edited.length || !meta?.copy) return meta;
  const current = asObject(have.meta_json)?.copy?.default ?? {};
  const def = { ...(meta.copy.default ?? {}) };
  for (const f of edited) {
    if (f in current) def[f] = current[f];
    else delete def[f];
  }
  return { ...meta, copy: { ...meta.copy, default: def } };
}

export function upsertWork({ title, source = null, cuts, meta = null }) {
  const { t, plan, sourceKey } = checkWorkPlan({ title, source, cuts });

  const conn = open();
  const now = Date.now();
  const stats = { cuts: { created: 0, updated: 0 }, versions: { created: 0, updated: 0 } };
  conn.exec("BEGIN");
  try {
    let work = conn.prepare("SELECT * FROM work WHERE source = ? AND title = ?").get(sourceKey, t);
    const existed = Boolean(work);
    const primary = plan[0].versions[0];
    if (work) {
      conn.prepare("UPDATE work SET meta_json = COALESCE(?, meta_json) WHERE id = ?").run(meta ? JSON.stringify(meta) : null, work.id);
    } else {
      const id = newId("work");
      conn
        .prepare("INSERT INTO work (id, title, asset_path, meta_json, created_at, source) VALUES (?,?,?,?,?,?)")
        .run(id, t, primary.asset, meta ? JSON.stringify(meta) : null, now, sourceKey);
      work = { id };
    }
    let position = (conn.prepare("SELECT COALESCE(MAX(position), -1) m FROM cut WHERE work_id = ?").get(work.id).m ?? -1) + 1;
    for (const c of plan) {
      let cut = conn.prepare("SELECT id FROM cut WHERE work_id = ? AND title = ?").get(work.id, c.title);
      if (cut) {
        stats.cuts.updated++;
        conn.prepare("UPDATE cut SET rev = rev + 1 WHERE id = ?").run(cut.id);
      } else {
        cut = { id: newId("cut") };
        conn.prepare("INSERT INTO cut (id, work_id, title, position, created_at) VALUES (?,?,?,?,?)").run(cut.id, work.id, c.title, position++, now);
        stats.cuts.created++;
      }
      for (const v of c.versions) {
        const have = conn.prepare("SELECT id, meta_json, edited_fields FROM cut_version WHERE cut_id = ? AND language = ?").get(cut.id, v.language);
        // 人改过的通用文案字段不被再次入库覆盖（ACC-v3-edit-07）。
        const metaJson = v.meta ? JSON.stringify(have ? keepEditedCopy(v.meta, have) : v.meta) : null;
        if (have) {
          conn.prepare("UPDATE cut_version SET asset_path = ?, meta_json = COALESCE(?, meta_json) WHERE id = ?").run(v.asset, metaJson, have.id);
          stats.versions.updated++;
        } else {
          conn
            .prepare("INSERT INTO cut_version (id, cut_id, language, asset_path, meta_json, created_at) VALUES (?,?,?,?,?,?)")
            .run(newId("ver"), cut.id, v.language, v.asset, metaJson, now);
          stats.versions.created++;
        }
      }
    }
    // work.asset_path 跟着第一支成片的第一个版本走：适配器至今仍直接读这一列。
    const first = conn
      .prepare(
        `SELECT v.asset_path FROM cut c JOIN cut_version v ON v.cut_id = c.id
          WHERE c.work_id = ? ORDER BY c.position, v.rowid LIMIT 1`,
      )
      .get(work.id);
    if (first) conn.prepare("UPDATE work SET asset_path = ? WHERE id = ?").run(first.asset_path, work.id);
    conn.exec("COMMIT");
    return { id: work.id, existed, updated: existed, ...stats };
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

// ------------------------------------------------------------------ 平台文案（ACC-v2-copy-01）
//
// 各平台的标题、正文、话题在入库时由 Claude 写好、随清单交来；versekit 不接 LLM。
// 限制只在这张表里写一次：入库、生成平台稿、`vk doctor` 都读它。超限一律拒绝并指出平台与字段，
// 不悄悄截断。长度按字符（码点）算。
//   title / body / tags:{max,each}  分开计
//   combined                        标题 + 正文 + 话题（带 #）合计
//   verified:false                  查不到官方数字：不校验，只在 `vk doctor` 里列出
export const COPY_LIMITS = Object.freeze({
  bilibili: { label: "B站", title: 80, body: 2000, tags: { max: 10, each: 20 } },
  xiaohongshu: { label: "小红书", title: 20, body: 1000, tags: { max: 10 } },
  douyin: { label: "抖音", combined: 1000 },
  tiktok: { label: "TikTok", combined: 2200 },
  youtube: { label: "YouTube", title: 100, body: 5000 },
});

const COPY_ALIASES = { "tiktok-api": "tiktok", xhs: "xiaohongshu", bili: "bilibili" };
export const copyPlatformOf = (platform) => COPY_ALIASES[String(platform)] ?? String(platform);

/** 表里标了「未核实」的平台（不校验）。 */
export const unverifiedCopyPlatforms = () => Object.entries(COPY_LIMITS).filter(([, l]) => l.verified === false).map(([k]) => k);

const chars = (text) => [...String(text ?? "")].length;
const tagText = (tags) => (tags ?? []).map((t) => `#${t}`).join(" ");

/** 一份文案的结构校验与整理：{ title?, body?, tags? }。空的字段不保留。 */
function normaliseEntry(raw, where) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${where}：文案必须是 { title, body, tags } 对象`);
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!["title", "body", "tags"].includes(key)) fail(`${where}：文案里没有「${key}」这个字段（只有 title / body / tags）`);
  }
  for (const key of ["title", "body"]) {
    if (raw[key] == null) continue;
    if (typeof raw[key] !== "string") fail(`${where}：${key} 必须是字符串`);
    if (raw[key].trim()) out[key] = raw[key].trim();
  }
  if (raw.tags != null) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string")) fail(`${where}：tags 必须是字符串数组（不带 #）`);
    const tags = raw.tags.map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
    if (tags.length) out.tags = tags;
  }
  return out;
}

/** 这份文案放进某平台超限吗？返回人话数组（空 = 合规）。未核实的平台不校验。 */
export function copyViolations(platform, copy) {
  const limit = COPY_LIMITS[copyPlatformOf(platform)];
  if (!limit || limit.verified === false) return [];
  const bad = [];
  const { title = "", body = "", tags = [] } = copy ?? {};
  if (limit.title != null && chars(title) > limit.title) bad.push(`${limit.label} 标题最多 ${limit.title} 字，现在是 ${chars(title)} 字`);
  if (limit.body != null && chars(body) > limit.body) bad.push(`${limit.label} 正文最多 ${limit.body} 字，现在是 ${chars(body)} 字`);
  if (limit.tags?.max != null && tags.length > limit.tags.max) bad.push(`${limit.label} 话题最多 ${limit.tags.max} 个，现在是 ${tags.length} 个`);
  if (limit.tags?.each != null) {
    const long = tags.filter((t) => chars(t) > limit.tags.each);
    if (long.length) bad.push(`${limit.label} 每个话题最多 ${limit.tags.each} 字，超限的有：${long.join("、")}`);
  }
  if (limit.combined != null) {
    const total = chars([title, body, tagText(tags)].filter(Boolean).join("\n"));
    if (total > limit.combined) bad.push(`${limit.label} 文案（标题、正文、话题合计）最多 ${limit.combined} 字，现在是 ${total} 字`);
  }
  return bad;
}

/**
 * 清单里的 `copy` → { default?: {...}, <platform>: {...} }。
 * 写法二选一或并用：`{ title, body, tags }` 是不分平台的默认文案；`{ bilibili: {...}, xiaohongshu: {...} }`
 * 是按平台写；也可以显式写 `default`。平台名写错（表里没有）直接拒绝，免得文案悄悄落空。
 * 平台文案在这里就按平台限制校验；默认文案要到生成平台稿、知道发哪个平台时才能判（plan.apply）。
 */
export function normaliseCopy(raw, where) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail(`${where}：copy 必须是对象`);
  const out = {};
  const direct = {};
  for (const [key, value] of Object.entries(raw)) {
    if (["title", "body", "tags"].includes(key)) direct[key] = value;
    else if (key === "default") out.default = normaliseEntry(value, `${where} 的默认文案`);
    else {
      const platform = copyPlatformOf(key);
      if (!COPY_LIMITS[platform]) fail(`${where}：不认识的平台「${key}」（可选：${Object.keys(COPY_LIMITS).join(" / ")}；不分平台的默认文案直接写 title / body / tags）`);
      const entry = normaliseEntry(value, `${where} 的 ${COPY_LIMITS[platform].label} 文案`);
      const bad = copyViolations(platform, entry);
      if (bad.length) fail(`${where}：${bad.join("；")}（超限不会自动截断，请改短后重新入库）`);
      out[platform] = entry;
    }
  }
  if (Object.keys(direct).length) out.default = { ...normaliseEntry(direct, `${where} 的默认文案`), ...(out.default ?? {}) };
  return Object.keys(out).length ? out : null;
}

/** 成片级文案打底、语言版本级文案按平台覆盖。 */
const mergeCopy = (base, over) => {
  if (!base) return over ?? null;
  if (!over) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = { ...(base[k] ?? {}), ...v };
  return out;
};

/** 这个平台、这份文案表里该用哪一条：逐字段，平台专属盖住默认。 */
export const copyFor = (copy, platform) => ({ ...(copy?.default ?? {}), ...(copy?.[copyPlatformOf(platform)] ?? {}) });

/** 一支成片的默认语言版本：最早建的那个。publish.create 的快捷方式靠它挂版本。 */
function defaultCutOf(workId) {
  const conn = open();
  const cut = conn.prepare("SELECT id FROM cut WHERE work_id = ? ORDER BY position, created_at LIMIT 1").get(workId);
  if (!cut) return null;
  const version = conn.prepare("SELECT id FROM cut_version WHERE cut_id = ? ORDER BY rowid LIMIT 1").get(cut.id);
  return { cutId: cut.id, versionId: version?.id ?? null };
}

/**
 * 作品状态由平台稿推出，只取最要紧的一个（ACC-v2-work-01）：
 * 出了问题 > 等确认 > 已确认等时间 > 都发完了。
 * 已取消的不参与；没有平台稿（或全取消）不假装「都发完了」。
 */
export const PUBLISH_STATE_GROUP = {
  failed: "problem",
  blocked: "problem",
  expired: "problem",
  notify_pending: "awaiting_confirm",
  draft_pending: "awaiting_confirm",
  pending_confirm: "awaiting_confirm",
  // 「这支先不发」：不催人（不算等确认），但也不是取消——以后还能在作品里再确认。
  skipped: "skipped",
  queued: "scheduled",
  auto_running: "scheduled",
  draft_running: "scheduled",
  published: "done",
  published_limited: "done",
  // 不是真实状态：statusState() 把「已发出但被平台锁成私享」映射到这里，作品不能算「都发完了」。
  forced_private: "problem",
};
/** 算作品状态时用的「有效状态」：published_limited + visibility_forced_private 算出了问题（视频在，但可见性不是人要的）。 */
export const statusState = (p) => (p.state === "published_limited" && (p.error?.code ?? p.error_code) === "visibility_forced_private" ? "forced_private" : p.state);
export const WORK_STATUS_ORDER = ["problem", "awaiting_confirm", "scheduled", "skipped", "done"];
export const WORK_STATUS_LABEL = {
  problem: "出了问题",
  awaiting_confirm: "等确认",
  scheduled: "已确认等时间",
  done: "都发完了",
  none: "还没有平台稿",
  skipped: "先不发",
  canceled: "已取消",
};

export function deriveStatus(publishStates) {
  const groups = new Set();
  let any = false;
  for (const state of publishStates) {
    any = true;
    const g = PUBLISH_STATE_GROUP[state];
    if (g) groups.add(g);
  }
  const key = WORK_STATUS_ORDER.find((g) => groups.has(g)) ?? (any ? "canceled" : "none");
  return { key, label: WORK_STATUS_LABEL[key] };
}

const asObject = (json) => {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const nonEmpty = (value) => (typeof value === "string" && value.trim() ? value : null);

const textList = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : null);

/**
 * 一条平台稿「现在点确认，实际会发出去」的标题、正文、话题（ACC-v2-plan-03 / ACC-v2-copy-03）。
 *
 * 通用文案存在语言版本上（meta.copy.default），平台稿只存「单独写的」字段，逐字段覆盖（ACC-v3-edit-01）。
 * 取值链：人改过的（overrides 顶层的 title/body/tags）> 入库时给这个平台单独写的（overrides.copy）>
 * 语言版本的通用文案（meta.copy.default）> 语言版本 meta > 作品 meta（旧的 publish.create 把正文/话题放在这里）>
 * 成片标题 > 作品标题。正文、话题没有就是空，不编造。生效文案只在这一处算，发布、卡片、页面都读它。
 * 平台自己的限制仍在适配器里判；这里给的是页面、卡片、适配器共用的那一个值。
 */
export function effectiveCopy({ overrides, versionMeta, workMeta, cutTitle = null, workTitle = null }) {
  const ov = asObject(overrides);
  const oc = ov.copy && typeof ov.copy === "object" ? ov.copy : {};
  const vm = asObject(versionMeta);
  const vd = vm.copy && typeof vm.copy.default === "object" && vm.copy.default ? vm.copy.default : {};
  const wm = asObject(workMeta);
  const pick = (...vals) => vals.find((v) => nonEmpty(v)) ?? null;
  return {
    title: pick(ov.title, oc.title, vd.title, vm.title, wm.title, cutTitle, workTitle) ?? "",
    // 人亲手清空的正文（空字符串）也算数：不回退到入库时写的正文。
    body: typeof ov.body === "string" ? ov.body : pick(ov.body, ov.desc, oc.body, vd.body, vm.body, vm.description, wm.body, wm.description) ?? "",
    tags: textList(ov.tags) ?? textList(oc.tags) ?? textList(vd.tags) ?? textList(vm.tags) ?? textList(wm.tags) ?? [],
  };
}

/** 这条平台稿哪些字段是「单独写的」（不跟通用）：页面据此标「跟通用」或「单独写的」。 */
export function ownCopyFields(overrides) {
  const ov = asObject(overrides);
  const oc = ov.copy && typeof ov.copy === "object" ? ov.copy : {};
  return [
    ...(nonEmpty(ov.title) || nonEmpty(oc.title) ? ["title"] : []),
    ...(typeof ov.body === "string" || nonEmpty(oc.body) ? ["body"] : []),
    ...(textList(ov.tags) || textList(oc.tags) ? ["tags"] : []),
  ];
}

/**
 * 一条平台稿「现在点确认，实际会发出去」的标题（ACC-v2-title-01 / ACC-v2-confirm-04）。
 *
 * 不另写回退链：直接取 effectiveCopy().title，也就是 resolvePublishCopy 交给适配器的那个值。
 * 页面（workView）、确认卡片（notify.mjs）、适配器三处读同一个来源。
 * 入参是带 overrides_json / version_meta / work_meta_json（或 work_meta）/ cut_title / work_title 的查询行。
 */
export function effectiveTitle(row) {
  return effectiveCopy({
    overrides: row?.overrides_json ?? row?.overrides,
    versionMeta: row?.version_meta,
    workMeta: row?.work_meta_json ?? row?.work_meta,
    cutTitle: row?.cut_title,
    workTitle: row?.work_title,
  }).title;
}

/**
 * core 解析好、交给适配器的文案（ACC-v2-copy-03）：适配器不再 JOIN `work` 表取标题/元数据。
 * 返回 { title, body, tags, language, cutId, cutTitle, workTitle, metaJson, overridesJson }：
 * `metaJson` 是作品 meta 叠语言版本 meta、再用解析后的标题/正文/话题盖住同名字段（平台专属字段原样保留），
 * 适配器里原有的纯函数（planNote / planPost / postSettings）读它就行；`overridesJson` 是这条平台稿自己的。
 */
export function resolvePublishCopy(publishId) {
  const row = open()
    .prepare(
      `SELECT p.id, p.overrides_json, a.platform, c.title AS cut_title, c.id AS cut_id, v.language, v.meta_json AS version_meta,
              w.title AS work_title, w.meta_json AS work_meta
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
         LEFT JOIN cut c ON c.id = p.cut_id
         LEFT JOIN cut_version v ON v.id = p.version_id
        WHERE p.id = ?`,
    )
    .get(publishId);
  if (!row) fail(`没有这条发布：${publishId}`);
  const copy = effectiveCopy({ overrides: row.overrides_json, versionMeta: row.version_meta, workMeta: row.work_meta, cutTitle: row.cut_title, workTitle: row.work_title });
  const { copy: _planCopy, ...versionRest } = asObject(row.version_meta);
  const meta = { ...asObject(row.work_meta), ...versionRest, title: copy.title, body: copy.body, description: copy.body, tags: copy.tags };
  return {
    ...copy,
    language: row.language ?? null,
    cutId: row.cut_id ?? null,
    cutTitle: row.cut_title ?? null,
    workTitle: row.work_title,
    metaJson: JSON.stringify(meta),
    overridesJson: row.overrides_json ?? null,
  };
}

/** 适配器 load() 用：把解析后的文案摊成它原来读的那几列（work_title / meta_json / overrides_json）。 */
export const copyRowFields = (copy) => ({ work_title: copy.title, meta_json: copy.metaJson, overrides_json: copy.overridesJson });

const PUBLISHED_STATES = new Set(["published", "published_limited"]);

/**
 * 发过的平台稿补「和平时比」：24 小时播放、平时的中位数、倍数、结论（口径只在 baseline.mjs 一处）。
 * 没发过的不带这些字段；发了但数据不足时 multiple 为 null、reason 说清为什么（页面显示「还没法比」）。
 * accountId 是内部键，算完就拿掉，不外泄。
 */
function attachBaselines(cuts) {
  const rows = cuts.flatMap((c) => c.publishes).filter((p) => PUBLISHED_STATES.has(p.state) && p.publishedAt != null);
  const byId = new Map(withBaselines(rows.map((p) => ({ ...p, publishId: p.id }))).map((r) => [r.id, r.baseline]));
  for (const c of cuts) {
    for (const p of c.publishes) {
      const b = byId.get(p.id);
      if (b) Object.assign(p, { play24h: b.play24h, baselineMedian: b.baselineMedian, multiple: b.multiple, verdict: b.verdict, verdictLabel: b.verdictLabel, reason: b.reason });
      delete p.accountId;
    }
  }
}

/** 语言版本上的通用文案（meta.copy.default），给改内容的界面用；没写的字段是空。 */
function genericCopyOf(metaJson) {
  const vm = asObject(metaJson);
  const d = vm.copy && typeof vm.copy.default === "object" && vm.copy.default ? vm.copy.default : {};
  return { title: d.title ?? vm.title ?? "", body: d.body ?? vm.body ?? vm.description ?? "", tags: textList(d.tags) ?? textList(vm.tags) ?? [] };
}

function workView(work) {
  const conn = open();
  const cuts = conn.prepare("SELECT * FROM cut WHERE work_id = ? ORDER BY position, created_at").all(work.id).map((c, ci) => {
    const versions = conn
      .prepare("SELECT id, language, asset_path, created_at, meta_json FROM cut_version WHERE cut_id = ? ORDER BY rowid")
      .all(c.id)
      .map((v) => {
        const cover = asObject(v.meta_json)?.cover;
        return { id: v.id, language: v.language, asset: v.asset_path, generic: genericCopyOf(v.meta_json), ...(typeof cover === "string" && cover ? { cover: `/media/${v.id}?cover=1` } : {}) };
      });
    const publishes = conn
      .prepare(
        `SELECT p.id, p.state, p.mode, p.version_id, p.scheduled_at, p.external_url, p.error_code, p.error_message,
                p.overrides_json, p.published_at, p.account_id, a.platform, a.handle, v.language, v.meta_json AS version_meta
           FROM publish p
           JOIN account a ON a.id = p.account_id
           LEFT JOIN cut_version v ON v.id = p.version_id
          WHERE p.cut_id = ? OR (? = 1 AND p.cut_id IS NULL AND p.work_id = ?)
          ORDER BY p.created_at, p.id`,
      )
      // 没挂成片的平台稿（早期数据、手工入库）算在作品的第一支成片上：和数据页、今天页数的是同一批发布，倍数才对得上（ACC-v3-fid-12）。
      .all(c.id, ci === 0 ? 1 : 0, work.id)
      .map((p) => {
        const copy = effectiveCopy({ overrides: p.overrides_json, versionMeta: p.version_meta, workMeta: work.meta_json, cutTitle: c.title, workTitle: work.title });
        const schedule = effectiveSchedule({ id: p.id, state: p.state, scheduled_at: p.scheduled_at, account_id: p.account_id, platform: p.platform });
        return {
        id: p.id,
        platform: p.platform,
        handle: p.handle,
        state: p.state,
        mode: p.mode,
        title: copy.title,
        body: copy.body,
        tags: copy.tags,
        // 哪些是空的：标题总有回退（成片标题），正文、话题没写就是空，页面据此提示。
        empty: [...(copy.title ? [] : ["title"]), ...(copy.body ? [] : ["body"]), ...(copy.tags.length ? [] : ["tags"])],
        titleEdited: Boolean(nonEmpty(asObject(p.overrides_json).title)),
        ownFields: ownCopyFields(p.overrides_json),
        versionId: p.version_id,
        language: p.language ?? null,
        // 建议时间过了还没确认的，读出来按平台规则顺延（ACC-v3-time-03）；原定时间一并给出，页面写「原定…，已顺延」。
        scheduledAt: schedule.at,
        ...(schedule.shifted ? { originalAt: schedule.originalAt, shifted: true } : {}),
        url: p.external_url,
        error: p.error_code ? { code: p.error_code, message: p.error_message } : null,
        publishedAt: p.published_at ?? null,
        accountId: p.account_id,
        };
      });
    // 改内容的界面要知道各平台的文案限制：数字只从 COPY_LIMITS 取，页面不另写一份（ACC-v3-edit-04）。
    const copyLimit = {};
    for (const p of publishes) {
      const limit = COPY_LIMITS[copyPlatformOf(p.platform)];
      if (limit && limit.verified !== false) copyLimit[p.platform] = { ...limit, tags: limit.tags ? { ...limit.tags } : undefined };
    }
    for (const v of versions) v.copyLimit = copyLimit;
    return { id: c.id, title: c.title, rev: c.rev ?? 0, status: deriveStatus(publishes.map(statusState)), versions, publishes };
  });
  attachBaselines(cuts);
  const allStates = cuts.flatMap((c) => c.publishes.map(statusState));
  return {
    id: work.id,
    title: work.title,
    source: work.source ?? null,
    asset: work.asset_path,
    createdAt: work.created_at,
    status: deriveStatus(allStates),
    cuts,
  };
}

export function listWorks({ limit = 100 } = {}) {
  return open()
    .prepare("SELECT * FROM work ORDER BY created_at DESC, id LIMIT ?")
    .all(boundedLimit(limit))
    .map((w) => {
      const v = workView(w);
      return {
        id: v.id,
        title: v.title,
        status: v.status,
        cuts: v.cuts.length,
        versions: v.cuts.reduce((n, c) => n + c.versions.length, 0),
        publishes: v.cuts.reduce((n, c) => n + c.publishes.length, 0),
        createdAt: v.createdAt,
        platformList: v.cuts.flatMap((c) => c.publishes.map((p) => ({ publishId: p.id, platform: p.platform, state: p.state, cutId: c.id }))),
        coverVersionId: (v.cuts.flatMap((c) => c.versions).find((x) => x.cover) ?? v.cuts.flatMap((c) => c.versions)[0])?.id ?? null,
        // 入库封面（ACC-v3-fid-10）：有就给地址，没有是 null，页面退回首帧。
        cover: v.cuts.flatMap((c) => c.versions).find((x) => x.cover)?.cover ?? null,
        // 有倍数的已发平台稿（页面取最大的一条当「最好的一条」；按组过滤要靠 publishId，所以带上）。
        compared: v.cuts.flatMap((c) =>
          c.publishes.filter((p) => p.multiple != null).map((p) => ({ publishId: p.id, platform: p.platform, cutId: c.id, multiple: p.multiple, verdictLabel: p.verdictLabel })),
        ),
      };
    });
}

/** 按 id 找作品；找不到时抛带下一步的错。 */
export function showWork(workId) {
  const work = getWork(workId);
  if (!work) fail(`没有这个作品：${workId}（到作品页看有哪些）`, "vk work list");
  return workView(work);
}

/**
 * One publish row per (cut, account). 平台稿生成后先停在「待确认」（pending_confirm，#146）：
 * 不排队、不发——到了建议时间也一样。只有人确认（publish.approve / now / manual）才进队列，
 * 见 handlers.mjs 的确认命令。所有者定的口径是「不能不经过人同意就发了」。
 *
 * 不给 cutId/versionId 就是 publish.create 的快捷方式：挂在作品唯一（或第一支）成片的默认版本上。
 */
export function createPublish({
  workId,
  accountId,
  cutId = null,
  versionId = null,
  mode = "auto",
  visibility = "public",
  scheduledAt = null,
  overrides = null,
}) {
  if (!getWork(workId)) fail(`没有这条内容：${workId}`);
  const account = getAccount(accountId);
  if (!account) fail(`没有这个账号：${accountId}`);
  if (!PUBLISH_MODES.includes(mode)) fail(`发布模式只能是 ${PUBLISH_MODES.join(" / ")}`);
  if (!PUBLISH_VISIBILITIES.includes(visibility)) fail(`可见性只能是 ${PUBLISH_VISIBILITIES.join(" / ")}`);
  if (scheduledAt != null && (!Number.isInteger(scheduledAt) || scheduledAt < 0)) fail("定时时间必须是毫秒时间戳");

  let cut = cutId, version = versionId;
  if (cut) {
    const row = open().prepare("SELECT id FROM cut WHERE id = ? AND work_id = ?").get(cut, workId);
    if (!row) fail(`成片 ${cut} 不属于作品 ${workId}`);
  } else {
    const d = defaultCutOf(workId);
    cut = d?.cutId ?? null;
    version = version ?? d?.versionId ?? null;
  }
  if (cut && !version) version = open().prepare("SELECT id FROM cut_version WHERE cut_id = ? ORDER BY rowid LIMIT 1").get(cut)?.id ?? null;
  if (version && !open().prepare("SELECT 1 FROM cut_version WHERE id = ? AND cut_id = ?").get(version, cut)) {
    fail(`语言版本 ${version} 不属于成片 ${cut}`);
  }

  const id = newId("pub");
  const now = Date.now();
  try {
    open()
      .prepare(
        `INSERT INTO publish (id, work_id, cut_id, version_id, account_id, mode, visibility, state, scheduled_at, overrides_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'pending_confirm', ?,?,?,?)`,
      )
      .run(id, workId, cut, version, accountId, mode, visibility, scheduledAt, overrides ? JSON.stringify(overrides) : null, now, now);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      fail(`这支成片已经发过 ${account.platform} @${account.handle}：同一支成片对同一账号只能有一条发布`);
    }
    throw err;
  }

  // 新作品等确认（#150）：一个作品只发一次（dedupe_key），之后再建的平台稿不会重复打扰。
  emit({
    type: "work.awaiting_confirm",
    severity: "info",
    publishId: id,
    payload: { workId },
    dedupeKey: `work:${workId}:awaiting_confirm`,
  });

  return { id, workId, cutId: cut, versionId: version, accountId, mode, visibility, state: "pending_confirm", queued: false };
}

export function getPublish(publishId) {
  return open()
    .prepare(
      `SELECT p.*, a.platform, a.handle, a.state AS account_state, w.title AS work_title, w.asset_path, w.meta_json
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
    // --to tiktok 同时覆盖两个后端（浏览器自动化 / 官方接口）：同一个账号只会挂其中一个。
    const family = backendsOf(platform);
    const inList = family.map(() => "?").join(",");
    const accounts = groupId
      ? open()
          .prepare(`SELECT * FROM account WHERE platform IN (${inList}) AND group_id = ? AND removed_at IS NULL ORDER BY created_at`)
          .all(...family, groupId)
      : open()
          .prepare(`SELECT * FROM account WHERE platform IN (${inList}) AND removed_at IS NULL ORDER BY created_at`)
          .all(...family);
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
/**
 * 平台稿没记 cut_id 时，作品只有一支成片就用它的名字（数据页每条标题下的成片名）；
 * 有多支又说不清是哪支的，不猜，返回 null。
 */
export function soleCutTitles(workIds) {
  const ids = [...new Set(workIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = open()
    .prepare(`SELECT work_id, MIN(title) AS title FROM cut WHERE work_id IN (${ids.map(() => "?").join(",")}) GROUP BY work_id HAVING COUNT(*) = 1`)
    .all(...ids);
  return new Map(rows.map((r) => [r.work_id, r.title]));
}

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

/** 日历上的状态只有四种（ACC-v3-cal-05）：wait 等你确认 / sched 已确认 / pub 已发布 / bad 出了问题。 */
const CAL_STATE = {
  pending_confirm: "wait", notify_pending: "wait", draft_pending: "wait",
  queued: "sched", auto_running: "sched", draft_running: "sched",
  published: "pub", published_limited: "pub",
  failed: "bad", blocked: "bad", expired: "bad",
};
const CAL_LABEL = { wait: "等你确认", sched: "已确认", pub: "已发布", bad: "出了问题" };
const CAL_LIMIT = 2000;

/**
 * 日历用的平台稿（ACC-v3-cal-02、08）：只取 [from, to] 里的，一次只取可见范围。
 * 时间 = 已发布的用实际发布时间，没发的用计划时间。现在发的、我自己发的、先不发的、已取消的不上日历。
 * `groupId` 把范围限在一个账号组里（日历是当前组的）。
 */
export function listCalendarPublishes({ from = null, to = null, groupId = null } = {}) {
  const lo = from == null ? -8.64e15 : Number(from);
  const hi = to == null ? 8.64e15 : Number(to);
  if (Number.isNaN(lo) || Number.isNaN(hi)) fail("from / to 必须是毫秒时间戳");
  if (lo > hi) fail("from 不能晚于 to");
  const states = Object.keys(CAL_STATE);
  // Drive the calendar from the visible time range even when SQLite prefers the state index.
  const rows = open()
    .prepare(
      `SELECT p.id, p.state, p.error_code, ${PUBLISH_EFFECTIVE_AT} AS at,
              p.work_id, p.cut_id, a.platform, a.handle, a.is_manual, w.title,
              c.title AS cut_title,
              (SELECT COUNT(*) FROM cut c2 WHERE c2.work_id = p.work_id) AS cut_count
         FROM publish p INDEXED BY idx_publish_effective_at
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
         LEFT JOIN cut c ON c.id = p.cut_id
        WHERE ${PUBLISH_EFFECTIVE_AT} BETWEEN ? AND ?
          AND (? IS NULL OR a.group_id = ?)
          AND p.state IN (${states.map(() => "?").join(",")})
          AND COALESCE(p.fallback_reason, '') != 'self_publish'
          AND p.approved_now = 0
        ORDER BY at, p.id
        LIMIT ?`,
    )
    .all(lo, hi, groupId, groupId, ...states, CAL_LIMIT);
  return rows.map((r) => {
    const cal = CAL_STATE[r.state];
    const paused = Boolean(r.is_manual) && (cal === "wait" || cal === "sched");
    return {
      id: r.id,
      state: r.state,
      at: r.at,
      platform: r.platform,
      handle: r.handle,
      workId: r.work_id,
      title: r.title,
      cutId: r.cut_id,
      cutTitle: r.cut_title,
      cutCount: r.cut_count,
      cal,
      calLabel: paused ? "暂停中" : CAL_LABEL[cal],
      paused,
      errorCode: r.error_code ?? null,
    };
  });
}

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

/** 断开通道：只删配对（卡片不再发给这个人）；飞书里的机器人不动。 */
export function unbindChannel(channel) {
  const res = open().prepare("DELETE FROM channel_binding WHERE channel=?").run(channel);
  return { channel, removed: Number(res.changes) };
}

// ------------------------------------------------------------------ 飞书通知设置与发送状态（#311）
//
// 放 meta 表（不改 schema）。settings：往飞书发哪几类、是不是「不用飞书」；delivery：最近一张卡片送没送到。
// 凭证不在这里：app secret 只在 lark-cli 的钥匙串里，这里只有布尔和时间。

export const FEISHU_KINDS = ["confirm", "issue", "daily"];
const FEISHU_DEFAULTS = { kinds: { confirm: true, issue: true, daily: true }, off: false, testSentAt: null };

export function getFeishuSettings() {
  const saved = readMeta("feishu.settings") ?? {};
  return { ...FEISHU_DEFAULTS, ...saved, kinds: { ...FEISHU_DEFAULTS.kinds, ...(saved.kinds ?? {}) } };
}
export function patchFeishuSettings(patch = {}) {
  const cur = getFeishuSettings();
  const next = { ...cur, ...patch, kinds: { ...cur.kinds, ...(patch.kinds ?? {}) } };
  putMeta("feishu.settings", next);
  return next;
}

/** { lastOkAt, failure: { at, reason, eventType } | null }：failure 只在「最近一张没送到」时存在，送到一张就清掉。 */
export const getFeishuDelivery = () => ({ lastOkAt: null, failure: null, ...(readMeta("feishu.delivery") ?? {}) });
export const patchFeishuDelivery = (patch) => {
  const next = { ...getFeishuDelivery(), ...patch };
  putMeta("feishu.delivery", next);
  return next;
};

// ------------------------------------------------------------------ 发布前人确认（#146）
//
// 平台稿生成后停在 pending_confirm。下面这几个函数是**唯一**能把它推进队列的地方，而且都只由
// 人发起的命令调用（publish.approve / now / manual / skip / edit，见 commands.mjs）。
// 调度、队列、重试路径都不会碰 pending_confirm / skipped。
//
// 与 approval.mjs 的区别：那是「签名审批链接」，处理的是已经失败 / 阻塞的平台稿要不要重试；
// 这里是「还没发过的平台稿要不要发」。两者不共用状态集合，命令名也不重叠。

/** 等人拍板的状态：待确认，以及「这支先不发」之后还能再确认的。 */
export const CONFIRMABLE_STATES = ["pending_confirm", "skipped"];

/**
 * 逐条决定的平台：按成片确认时**不会**被带上（ACC-v2-confirm-02），每条由人单独选
 * 按建议时间发 / 现在发 / 我自己发（ACC-v2-confirm-03）。
 */
export const PER_ITEM_PLATFORMS = ["xiaohongshu"];

/** 「今天 20:00」「明天 09:30」「11-20 20:00」：对人说的时间。 */
export function whenLabel(t, now = Date.now()) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / 86400e3);
  const head = diff === 0 ? "今天" : diff === 1 ? "明天" : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${head} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const platformName = (platform) => COPY_LIMITS[copyPlatformOf(platform)]?.label ?? platform;

/**
 * 等确认的平台稿「读出来」的建议时间（ACC-v3-time-03）：已经过去的，按平台规则（每日上限、最小间隔）
 * 顺延到最近的可用时间，并带上原定时间；没过期的原样。不写库——确认时（admit）才把顺延后的时间存下来，
 * 所以确认按钮不会因为时间过期而失败。row 要有 id、state、scheduled_at、account_id、platform。
 */
export function effectiveSchedule(row, now = Date.now()) {
  const at = row.scheduled_at ?? null;
  if (at == null || at > now || !CONFIRMABLE_STATES.includes(row.state)) return { at, originalAt: null, shifted: false };
  const next = nearestAvailable(now + 60e3, takenTimes(row.account_id, row.id), planRules(row.platform), now);
  return next == null ? { at, originalAt: null, shifted: false } : { at: next, originalAt: at, shifted: true };
}

const coded = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

/**
 * 「现在发」不绕过任何检查（ACC-v3-time-09）：账号登录状态、平台每日上限、最小间隔。
 * 过不了返回 { code, reason, nextAt }——原因里已带最近能发的时间，调用方不发这一条、留在待确认。
 */
function nowBlocker(row, now) {
  if (UNUSABLE_ACCOUNT_STATES.includes(row.account_state)) {
    return { code: "account_unusable", reason: accountUnusableReason({ id: row.account_id, platform: row.platform, handle: row.handle, state: row.account_state }), nextAt: null };
  }
  const rules = planRules(row.platform);
  const taken = takenTimes(row.account_id, row.id);
  const v = violationAt(now, taken, rules);
  if (!v) return null;
  const nextAt = nearestAvailable(now, taken, rules, now);
  const why =
    v.reason === "daily_cap"
      ? `${platformName(row.platform)} 今天已经排了 ${v.count} 条，每日上限 ${rules.dailyCap} 条`
      : `和${whenLabel(v.conflictAt, now)}那条隔得太近，最小间隔 ${rules.minGapMinutes} 分钟`;
  return {
    code: v.reason === "daily_cap" ? "plan_daily_cap" : "plan_min_gap",
    reason: `${why}，现在不能发${nextAt != null ? `；最近能发：${whenLabel(nextAt, now)}` : ""}`,
    nextAt,
  };
}

const confirmRows = (where, ...params) =>
  open()
    .prepare(
      `SELECT p.id, p.state, p.mode, p.scheduled_at, p.account_id, p.cut_id, p.overrides_json, a.platform, a.handle, a.removed_at, a.state AS account_state
         FROM publish p JOIN account a ON a.id = p.account_id
        WHERE ${where}
        ORDER BY p.created_at, p.id`,
    )
    .all(...params);

function requireCut(cutId) {
  const cut = open().prepare("SELECT id, work_id, title FROM cut WHERE id = ?").get(cutId);
  if (!cut) fail(`没有这支成片：${cutId}（到作品页看有哪些成片）`, "vk work show <作品 id>");
  return cut;
}

function requireConfirmable(publishId) {
  const row = confirmRows("p.id = ?", publishId)[0];
  if (!row) fail(`没有这条平台稿：${publishId}`);
  if (!CONFIRMABLE_STATES.includes(row.state)) {
    fail(`这条平台稿现在是 ${row.state}，不在等确认：只有待确认或先不发的平台稿能确认、改或跳过`);
  }
  return row;
}

const label = (r) => `${r.platform} ${handleLabel(r.handle)}`;

const asObj = (json) => {
  try {
    const v = json ? JSON.parse(json) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/**
 * TikTok 官方接口的 Post 必须由人选了隐私级别（审核要求：不预选，没选不能发）。送草稿箱不需要隐私级别。
 * 返回人话原因；没问题返回 null。选项是否合法由适配器对照 creator_info 判，core 不硬编码任何级别。
 */
export function missingPlatformSettings(row) {
  if (row.platform !== TIKTOK_API) return null;
  const o = asObj(row.overrides_json);
  if (o.draft === true || row.mode === "draft") return null;
  if (typeof o.tiktok?.privacy_level === "string" && o.tiktok.privacy_level) return null;
  return `TikTok 发布前要先选隐私级别，没选不会发：在这条的详情里选一个隐私级别（可选项以 TikTok 返回为准），想送草稿箱就选草稿箱`;
}

/** 人确认了：进队列，按建议时间（或现在）发。mode=manual 的只记跟踪，不排 run。 */
function admit(row, { reason, now, at = null }) {
  const missing = missingPlatformSettings(row);
  if (missing) fail(missing);
  // 账号已从组里移除：确认了也发不出去，而且会从一个已让出的槽位发帖。说清楚，不进队列。
  if (row.removed_at) fail(`${label(row)} 已从账号组移除，这条平台稿不能再确认（${row.id}）`);
  // 按时间发：建议时间已过的，顺延后存下来再排队，不因为时间过期而失败（ACC-v3-time-03）。
  const eff = at == null ? effectiveSchedule(row, now) : null;
  const patch = at != null ? { scheduled_at: at } : eff?.shifted ? { scheduled_at: eff.at } : {};
  transitionPublish(row.id, "queued", { reason, patch });
  const when = at ?? eff?.at ?? row.scheduled_at;
  const runAfter = when && when > now ? when : null;
  const runId = row.mode === "manual" ? null : queuePublish({ id: row.id, account_id: row.account_id }, { runAfter });
  return {
    publishId: row.id,
    platform: row.platform,
    handle: row.handle,
    state: "queued",
    scheduledAt: when ?? null,
    ...(eff?.shifted ? { originalAt: eff.originalAt, shifted: true } : {}),
    runAfter,
    runId,
  };
}

function inTransaction(fn) {
  const conn = open();
  conn.exec("BEGIN");
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

/**
 * publish.approve。
 *  · 给 cutId：确认这支成片下**所有非小红书**的待确认（含先不发）平台稿，按建议时间发；
 *    小红书的不带上，原样留在待确认，回执里列出来让人逐条决定。
 *  · 给 publishId：只确认这一条（小红书「按建议时间发」走这里）。
 */
export function approvePublishes({ cutId = null, publishId = null, when = "scheduled", now = Date.now() } = {}) {
  if (Boolean(cutId) === Boolean(publishId)) fail("确认要指定一支成片或一条平台稿，二选一");
  if (!["scheduled", "now"].includes(when)) fail(`发布方式只能是 scheduled（预约发）或 now（现在发），收到：${when}`);
  const immediate = when === "now";
  if (publishId) {
    const row = requireConfirmable(publishId);
    if (immediate) return { approved: [publishNow({ publishId, now })], perItem: [], when };
    return inTransaction(() => ({ approved: [admit(row, { reason: "approved_by_operator", now })], perItem: [] }));
  }
  const cut = requireCut(cutId);
  const rows = confirmRows(`p.cut_id = ? AND p.state IN (${CONFIRMABLE_STATES.map(() => "?").join(",")})`, cutId, ...CONFIRMABLE_STATES);
  // 账号已移除的不带上，回执里单独列出（不静默跳过）。
  const removed = rows.filter((r) => r.removed_at).map((r) => ({ publishId: r.id, platform: r.platform, handle: r.handle, reason: `${label(r)} 已从账号组移除` }));
  // 缺必填设置的（TikTok 没选隐私级别）不带上，也不静默：回执里写明原因，其余平台照常确认。
  const incomplete = rows
    .filter((r) => !r.removed_at && missingPlatformSettings(r))
    .map((r) => ({ publishId: r.id, platform: r.platform, handle: r.handle, reason: missingPlatformSettings(r) }));
  const batch = rows.filter((r) => !r.removed_at && !PER_ITEM_PLATFORMS.includes(r.platform) && !missingPlatformSettings(r));
  const perItem = rows
    .filter((r) => !r.removed_at && PER_ITEM_PLATFORMS.includes(r.platform))
    .map((r) => ({ publishId: r.id, platform: r.platform, handle: r.handle, state: r.state, scheduledAt: r.scheduled_at }));
  if (!batch.length) {
    if (incomplete.length) fail(`成片「${cut.title}」还不能确认：${incomplete.map((x) => x.reason).join("；")}`);
    if (perItem.length) {
      fail(`成片「${cut.title}」只剩 ${perItem.map(label).join("、")} 要逐条决定：到今天页逐条确认`, `vk publish approve --publish ${perItem[0].publishId}`);
    }
    fail(`成片「${cut.title}」没有等确认的平台稿`);
  }
  // 现在发：每一条先过账号状态、每日上限、最小间隔；过不了的不发，留在待确认，回执里写原因和最近能发的时间。
  const held = [];
  const go = immediate
    ? batch.filter((r) => {
        const block = nowBlocker(r, now);
        if (block) held.push({ publishId: r.id, platform: r.platform, handle: r.handle, ...block });
        return !block;
      })
    : batch;
  const approved = inTransaction(() => go.map((r) => (immediate ? admit(r, { reason: "approved_now_by_operator", now, at: now }) : admit(r, { reason: "approved_by_operator", now }))));
  return {
    cutId,
    title: cut.title,
    when,
    approved,
    perItem,
    ...(held.length ? { held } : {}),
    ...(removed.length ? { removed } : {}),
    ...(incomplete.length ? { incomplete } : {}),
  };
}

/** publish.now：这一条现在就发（建议时间改成现在）。 */
export function publishNow({ publishId, now = Date.now() }) {
  const row = requireConfirmable(publishId);
  const block = nowBlocker(row, now);
  if (block) throw coded(block.code, `${label(row)} 这条现在发不了：${block.reason}`, { suggestedAt: block.nextAt });
  return inTransaction(() => admit(row, { reason: "approved_now_by_operator", now, at: now }));
}

/**
 * publish.manual：「我自己发」。不进队列、不碰平台；转成 notify_pending 等人在 App 里发完，
 * 发完用现有的 publish.confirm（含义不变）记成已发布。
 */
export function publishManual({ publishId }) {
  const row = requireConfirmable(publishId);
  transitionPublish(row.id, "notify_pending", { reason: "self_publish_by_operator", patch: { fallback_reason: "self_publish" } });
  return { publishId: row.id, platform: row.platform, handle: row.handle, state: "notify_pending", next: `在 App 里发完后：vk publish confirm ${row.id}` };
}

/** publish.skip：「这支先不发」——整支成片的待确认平台稿都跳过，**包括小红书**。以后还能再确认。 */
export function skipCut({ cutId }) {
  const cut = requireCut(cutId);
  const all = confirmRows("p.cut_id = ?", cutId);
  const rows = all.filter((r) => r.state === "pending_confirm");
  if (!rows.length) {
    if (all.some((r) => r.state === "skipped")) return { cutId, title: cut.title, skipped: [], already: true };
    fail(`成片「${cut.title}」没有等确认的平台稿可以跳过（已确认的请在排期里取消）`);
  }
  const skipped = inTransaction(() =>
    rows.map((r) => {
      transitionPublish(r.id, "skipped", { reason: "skipped_by_operator" });
      return { publishId: r.id, platform: r.platform, handle: r.handle, state: "skipped" };
    }),
  );
  return { cutId, title: cut.title, skipped, next: `以后想发：vk publish approve --cut ${cutId}` };
}

/**
 * publish.edit：确认前改这一条的标题和建议时间（ACC-v2-confirm-04 前半）。
 * 标题写进这条平台稿的 overrides_json.title（适配器优先读它），不改作品标题——
 * 改一个平台的标题不该波及同一支成片的其他平台。时间只拦过去；平台的每日上限、
 * 最小间隔不在这里判（#151）。状态不变，所以不走 transitionPublish，但留 publish.edited 事件。
 */
export function editPublish({
  publishId,
  title = null,
  at = null,
  privacy = null,
  comment = null,
  duet = null,
  stitch = null,
  caption = null,
  draft = null,
  body = null,
  tags = null,
  now = Date.now(),
}) {
  const row = requireConfirmable(publishId);
  const tiktokFields = { privacy, comment, duet, stitch, caption, draft };
  const touchesTiktok = Object.values(tiktokFields).some((v) => v != null);
  if (title == null && at == null && body == null && tags == null && !touchesTiktok) {
    fail("要改什么？给 title、body、tags 或 at（至少一个）；TikTok 平台稿还可以改隐私级别、评论、合拍、拼接、说明或草稿");
  }
  if (touchesTiktok && row.platform !== TIKTOK_API) {
    fail(`隐私级别、评论/合拍/拼接开关、文案和送草稿箱只适用于 TikTok 官方接口的平台稿；这条是 ${row.platform}，只能改标题和时间`);
  }
  const changes = {};
  const overrides = row.overrides_json ? JSON.parse(row.overrides_json) : {};
  if (title != null) {
    changes.title = { from: overrides.title ?? null, to: requireString(title, "标题", { max: 200 }) };
    overrides.title = changes.title.to;
  }
  // 正文、话题（ACC-v2-copy-04）：存在 overrides 顶层，effectiveCopy 取值链里排第一。
  // 正文可以清空（给空字符串）；话题可以清空（给 []）。改完按这个平台的限制整体校验，超限拒绝、不截断。
  if (body != null) {
    if (typeof body !== "string") fail("正文必须是字符串");
    if (body.length > 20000) fail("正文太长（最多 20000 字）");
    const to = body.trim();
    changes.body = { from: overrides.body ?? null, to };
    overrides.body = to;
  }
  if (tags != null) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) fail("话题必须是字符串数组（不带 #）");
    const to = tags.map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
    changes.tags = { from: overrides.tags ?? null, to };
    overrides.tags = to;
  }
  const now0 = resolvePublishCopy(row.id);
  if (body != null || tags != null || (title != null && title.trim() !== now0.title)) {
    const next = {
      title: overrides.title ?? now0.title,
      body: overrides.body ?? now0.body,
      tags: Array.isArray(overrides.tags) ? overrides.tags : now0.tags,
    };
    const bad = copyViolations(row.platform, next);
    if (bad.length) fail(`${bad.join("；")}（超限不会自动截断，请改短后再保存）`);
  }
  if (touchesTiktok) {
    const t = { ...(overrides.tiktok ?? {}) };
    if (privacy != null) {
      // 不在这里枚举合法级别：可选项只来自 TikTok 的 creator_info，发布时由适配器对照。
      const level = requireString(privacy, "隐私级别", { max: 64 });
      if (!/^[A-Z_]+$/.test(level)) fail(`隐私级别要写 TikTok 返回的原样名字（如 SELF_ONLY），收到「${level}」；可选项以 TikTok 返回为准`);
      changes.privacy = { from: t.privacy_level ?? null, to: level };
      t.privacy_level = level;
    }
    for (const [key, name, value] of [["allow_comment", "comment", comment], ["allow_duet", "duet", duet], ["allow_stitch", "stitch", stitch]]) {
      if (value == null) continue;
      if (typeof value !== "boolean") fail(`${name} 只能是 true 或 false`);
      changes[name] = { from: t[key] === true, to: value };
      t[key] = value;
    }
    overrides.tiktok = t;
    if (caption != null) {
      changes.caption = { from: overrides.caption ?? null, to: requireString(caption, "文案", { max: 2200 }) };
      overrides.caption = changes.caption.to;
    }
    if (draft != null) {
      if (typeof draft !== "boolean") fail("draft 只能是 true 或 false");
      changes.draft = { from: overrides.draft === true, to: draft };
      overrides.draft = draft;
    }
  }
  if (at != null) {
    if (!Number.isInteger(at) || at < 0) fail("时间必须是毫秒时间戳");
    if (at <= now) fail(`不能改到过去的时间：${new Date(at).toISOString()}`);
    changes.at = { from: row.scheduled_at ?? null, to: at };
  }
  return inTransaction(() => {
    // 「送到草稿箱」走现有的 draft 模式（draft_running → draft_pending），不新增状态。
    const mode = changes.draft ? (changes.draft.to ? "draft" : row.mode === "draft" ? "auto" : row.mode) : row.mode;
    open()
      .prepare("UPDATE publish SET overrides_json = ?, scheduled_at = ?, mode = ?, updated_at = ? WHERE id = ?")
      .run(Object.keys(overrides).length ? JSON.stringify(overrides) : null, changes.at ? at : row.scheduled_at, mode, Date.now(), row.id);
    if (row.cut_id) open().prepare("UPDATE cut SET rev = rev + 1 WHERE id = ?").run(row.cut_id);
    emit({ type: "publish.edited", severity: "info", publishId: row.id, payload: { state: row.state, changes } });
    return {
      publishId: row.id,
      platform: row.platform,
      handle: row.handle,
      state: row.state,
      title: overrides.title ?? null,
      body: overrides.body ?? null,
      tags: overrides.tags ?? null,
      scheduledAt: changes.at ? at : row.scheduled_at,
      ...(touchesTiktok ? { tiktok: { ...(overrides.tiktok ?? {}), caption: overrides.caption ?? null, draft: overrides.draft === true } } : {}),
      changes,
    };
  });
}

// ------------------------------------------------------------------ 改内容：cut.edit（ACC-v3-edit-*）

/**
 * 还能改的平台稿：等确认的（含先不发），以及已确认、还没到点的（按时间发的那些，ACC-v3-edit-06）。
 * 已经发出去的、正在发的（含现在发）、失败的都不能改。
 */
const isEditable = (row, now) =>
  CONFIRMABLE_STATES.includes(row.state) || (row.state === "queued" && row.scheduled_at != null && row.scheduled_at > now);

const COPY_FIELDS = ["title", "body", "tags"];

function copyField(field, value, where) {
  if (field === "tags") {
    if (!Array.isArray(value) || value.some((t) => typeof t !== "string")) fail(`${where}：话题必须是字符串数组（不带 #）`);
    return value.map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
  }
  if (typeof value !== "string") fail(`${where}：${field === "title" ? "标题" : "正文"}必须是字符串`);
  if (field === "title") return requireString(value, `${where}的标题`, { max: 200 });
  if (value.length > 20000) fail(`${where}：正文太长（最多 20000 字）`);
  return value.trim();
}

/** 预约的时间选到过去、或碰到平台规则：说原因和最近能排的时间（ACC-v3-time-04）。 */
function assertEditTime(row, at, now) {
  if (!Number.isInteger(at) || at < 0) fail("时间必须是毫秒时间戳");
  const rules = planRules(row.platform);
  const taken = takenTimes(row.account_id, row.id);
  const past = at <= now;
  const v = past ? null : violationAt(at, taken, rules);
  if (!past && !v) return;
  const nextAt = nearestAvailable(Math.max(at, now + 60e3), taken, rules, now);
  const why = past
    ? `${whenLabel(at, now)} 已经过去了`
    : v.reason === "daily_cap"
      ? `${platformName(row.platform)} 那天已经排了 ${v.count} 条，每日上限 ${rules.dailyCap} 条`
      : `和${whenLabel(v.conflictAt, now)}那条隔得太近，最小间隔 ${rules.minGapMinutes} 分钟`;
  throw coded(past ? "E_TIME_PAST" : v.reason === "daily_cap" ? "plan_daily_cap" : "plan_min_gap", `${why}${nextAt != null ? `；最近能排：${whenLabel(nextAt, now)}` : ""}`, { suggestedAt: nextAt, publishId: row.id });
}

/**
 * cut.edit：改一支成片的内容，一次提交、一个事务（ACC-v3-edit-02）。
 *  · rev：打开编辑时读到的成片版本号；别处先改过（rev 变了）就拒绝，不覆盖；
 *  · generic：{ title?, body?, tags? } 改通用文案，存在 language 指定的语言版本上（只有一个版本时可省略）；
 *  · platforms：{ <平台稿 id>: { title?, body?, tags?, at? } }，字段给值 = 单独写，给 null = 改回跟通用；
 *    at 是按时间发的时间，只有给了才提交（只改文案不碰时间，ACC-v3-time-02）。
 * 只校验这次动过的字段：超出某个平台限制的新问题拒绝、不截断；入库时就有的问题不拦无关的保存（ACC-v3-edit-08）。
 * 现在发 / 预约发不在这里选（ACC-v3-time-08）。
 */
export function editCut({ cutId, rev, language = null, generic = null, platforms = null, now = Date.now() }) {
  const conn = open();
  const cut = conn.prepare("SELECT id, work_id, title, rev FROM cut WHERE id = ?").get(cutId);
  if (!cut) fail(`没有这支成片：${cutId}`);
  if (!Number.isInteger(rev) || rev < 0) fail("rev 必须是整数：用打开编辑时读到的成片版本号");
  if (cut.rev !== rev) throw coded("E_REV_CONFLICT", "这支成片刚在别处改过，重新打开再改", { rev: cut.rev });
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (generic != null && !isObj(generic)) fail("generic 必须是 { title, body, tags } 对象");
  if (platforms != null && !isObj(platforms)) fail("platforms 必须是 { <平台稿 id>: { title, body, tags, at } } 对象");
  if (!Object.keys(generic ?? {}).length && !Object.keys(platforms ?? {}).length) fail("要改什么？给 generic（通用文案）或 platforms（平台稿）");

  const work = conn.prepare("SELECT title, meta_json FROM work WHERE id = ?").get(cut.work_id);
  const versions = conn.prepare("SELECT * FROM cut_version WHERE cut_id = ? ORDER BY rowid").all(cut.id);
  const rows = conn
    .prepare(
      `SELECT p.id, p.state, p.mode, p.scheduled_at, p.account_id, p.version_id, p.overrides_json, a.platform, a.handle, v.meta_json AS version_meta
         FROM publish p JOIN account a ON a.id = p.account_id LEFT JOIN cut_version v ON v.id = p.version_id
        WHERE p.cut_id = ? ORDER BY p.created_at, p.id`,
    )
    .all(cut.id);

  // 通用文案：写到语言版本的 meta.copy.default，并记下人改过哪些字段。
  let version = null;
  let nextMeta = null;
  let nextEdited = null;
  const genericChanges = {};
  if (generic && Object.keys(generic).length) {
    for (const k of Object.keys(generic)) if (!COPY_FIELDS.includes(k)) fail(`通用文案里没有「${k}」这个字段（只有 title / body / tags）`);
    if (language != null) version = versions.find((v) => v.language === language) ?? fail(`成片「${cut.title}」没有「${language}」这个语言版本`);
    else if (versions.length === 1) version = versions[0];
    else fail(`成片「${cut.title}」有 ${versions.length} 个语言版本（${versions.map((v) => v.language).join("、")}），改通用文案要指定语言`);
    const meta = asObject(version.meta_json);
    const copy = { ...(meta.copy && typeof meta.copy === "object" ? meta.copy : {}) };
    const def = { ...(copy.default ?? {}) };
    for (const [k, v] of Object.entries(generic)) {
      const to = copyField(k, v, "通用文案");
      genericChanges[k] = { from: def[k] ?? null, to };
      if ((k === "tags" && !to.length) || (k === "body" && !to)) delete def[k];
      else def[k] = to;
    }
    copy.default = def;
    nextMeta = { ...meta, copy };
    nextEdited = [...new Set([...editedList(version.edited_fields), ...Object.keys(generic)])];
  }

  // 平台稿：逐条改字段 / 改回跟通用 / 改时间。
  const targets = new Map();
  for (const [publishId, spec] of Object.entries(platforms ?? {})) {
    const row = rows.find((r) => r.id === publishId) ?? fail(`成片「${cut.title}」下没有这条平台稿：${publishId}`);
    if (!isObj(spec) || !Object.keys(spec).length) fail(`平台稿 ${publishId}：要改什么？给 title / body / tags / at`);
    for (const k of Object.keys(spec)) if (![...COPY_FIELDS, "at"].includes(k)) fail(`平台稿 ${publishId}：不认识「${k}」（只有 title / body / tags / at；现在发还是按时间发在确认时选）`);
    if (!isEditable(row, now)) {
      fail(`${platformName(row.platform)} ${handleLabel(row.handle)} 这条${["published", "published_limited"].includes(row.state) ? "已经发出去了" : "已经在发或不在等待中"}（${row.state}），不能改`);
    }
    targets.set(publishId, { row, spec });
  }

  const after = new Map(); // publishId → { overrides, scheduledAt, changes }
  const touched = new Set([...targets.keys()]);
  if (version) for (const r of rows) if (r.version_id === version.id && isEditable(r, now)) touched.add(r.id);
  for (const id of touched) {
    const { row, spec = {} } = targets.get(id) ?? { row: rows.find((r) => r.id === id) };
    const overrides = asObject(row.overrides_json);
    const changes = {};
    for (const [k, v] of Object.entries(spec)) {
      if (k === "at") continue;
      const own = ownCopyFields(row.overrides_json).includes(k);
      if (v === null) {
        // 改回跟通用：顶层和入库时写的都去掉。
        delete overrides[k];
        if (overrides.copy) {
          delete overrides.copy[k];
          if (!Object.keys(overrides.copy).length) delete overrides.copy;
        }
        changes[k] = { from: own ? "own" : "generic", to: "generic" };
      } else {
        const to = copyField(k, v, `${platformName(row.platform)} 的文案`);
        overrides[k] = to;
        changes[k] = { from: own ? "own" : "generic", to };
      }
    }
    let scheduledAt = row.scheduled_at;
    if ("at" in spec && spec.at !== null) {
      assertEditTime(row, spec.at, now);
      changes.at = { from: row.scheduled_at ?? null, to: spec.at };
      scheduledAt = spec.at;
    }
    after.set(id, { row, overrides, scheduledAt, changes });
  }

  // 只拦这次新出现的超限（入库时就超的不拦无关的保存）。
  const problems = [];
  for (const [id, { row, overrides }] of after) {
    const ctx = { workMeta: work.meta_json, cutTitle: cut.title, workTitle: work.title };
    const was = effectiveCopy({ overrides: row.overrides_json, versionMeta: row.version_meta, ...ctx });
    const now_ = effectiveCopy({
      overrides: JSON.stringify(overrides),
      versionMeta: version && row.version_id === version.id ? JSON.stringify(nextMeta) : row.version_meta,
      ...ctx,
    });
    const had = copyViolations(row.platform, was);
    for (const message of copyViolations(row.platform, now_)) if (!had.includes(message)) problems.push({ publishId: id, platform: row.platform, message });
  }
  if (problems.length) {
    throw coded("E_COPY_LIMIT", `${problems.map((p) => p.message).join("；")}（超限不会自动截断，请改短，或给该平台单独写一份）`, { problems });
  }

  return inTransaction(() => {
    const bumped = conn.prepare("UPDATE cut SET rev = rev + 1 WHERE id = ? AND rev = ?").run(cut.id, rev);
    if (!bumped.changes) throw coded("E_REV_CONFLICT", "这支成片刚在别处改过，重新打开再改");
    if (version) {
      conn.prepare("UPDATE cut_version SET meta_json = ?, edited_fields = ? WHERE id = ?").run(JSON.stringify(nextMeta), JSON.stringify(nextEdited), version.id);
    }
    const out = [];
    for (const [id, { row, overrides, scheduledAt, changes }] of after) {
      if (Object.keys(changes).length) {
        conn
          .prepare("UPDATE publish SET overrides_json = ?, scheduled_at = ?, updated_at = ? WHERE id = ?")
          .run(Object.keys(overrides).length ? JSON.stringify(overrides) : null, scheduledAt, Date.now(), id);
        // 已确认、还没到点的：时间变了，队列里的开始时间跟着变；没改时间就仍按原来的时间发。
        if (changes.at && row.state === "queued") {
          conn.prepare("UPDATE run SET run_after = ? WHERE kind = 'publish' AND target_type = 'publish' AND target_id = ? AND state = 'queued'").run(scheduledAt, id);
        }
        emit({ type: "publish.edited", severity: "info", publishId: id, payload: { state: row.state, via: "cut.edit", changes } });
      }
      const shown = effectiveCopy({
        overrides: JSON.stringify(overrides),
        versionMeta: version && row.version_id === version.id ? JSON.stringify(nextMeta) : row.version_meta,
        workMeta: work.meta_json,
        cutTitle: cut.title,
        workTitle: work.title,
      });
      out.push({
        publishId: id,
        platform: row.platform,
        handle: row.handle,
        state: row.state,
        title: shown.title,
        body: shown.body,
        tags: shown.tags,
        ownFields: ownCopyFields(JSON.stringify(overrides)),
        scheduledAt,
        changes,
      });
    }
    return {
      cutId: cut.id,
      title: cut.title,
      rev: rev + 1,
      ...(version ? { language: version.language, generic: nextMeta.copy.default, editedFields: nextEdited, genericChanges } : {}),
      publishes: out,
      ...(out.some((p) => p.state === "queued") ? { note: "已确认的仍按原来的时间发" } : {}),
    };
  });
}

// ------------------------------------------------------------------ 发布方案 / 发布机心跳（#209）
// 都存在 meta 表（key/value），不改 schema。方案按账号组各一份：meta['plan:<groupId>']。

const planKey = (groupId) => `plan:${groupId}`;
const upsertMeta = (key, value) =>
  open().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));

/** 某个账号组存下来的发布方案行；没存过返回 null（调用方按「默认方案」处理）。 */
export function getGroupPlan(groupId) {
  const row = open().prepare("SELECT value FROM meta WHERE key = ?").get(planKey(groupId));
  if (!row) return null;
  try {
    const rows = JSON.parse(row.value)?.rows;
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

export function setGroupPlan(groupId, rows) {
  if (rows == null) open().prepare("DELETE FROM meta WHERE key = ?").run(planKey(groupId));
  else upsertMeta(planKey(groupId), JSON.stringify({ rows }));
}

export const DAEMON_HEARTBEAT_KEY = "daemon_heartbeat";
export const recordHeartbeat = (now = Date.now()) => upsertMeta(DAEMON_HEARTBEAT_KEY, now);
export function lastHeartbeat() {
  const v = Number(open().prepare("SELECT value FROM meta WHERE key = ?").get(DAEMON_HEARTBEAT_KEY)?.value);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ------------------------------------------------------------------ 云端中转（ACC-relay-03）
//
// 发布机拉取投递后「这个投递 id 入库过没有」记在 meta 表（不改 schema）：重复拉取、服务重启都不重复入库。
// 连接状态（上次拉取时间、上次出错、最近失败）也放这里，系统页与 vk relay status 读同一份。

const relayKey = (id) => `relay.delivery.${id}`;
const RELAY_STATE_KEY = "relay.state";

const putMeta = (key, value) => open().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
const readMeta = (key) => {
  try {
    const row = open().prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
};

export const getRelayDelivery = (id) => readMeta(relayKey(id));
export const setRelayDelivery = (id, record) => putMeta(relayKey(id), record);
export const getRelayState = () => readMeta(RELAY_STATE_KEY) ?? {};
export const patchRelayState = (patch) => {
  const next = { ...getRelayState(), ...patch };
  putMeta(RELAY_STATE_KEY, next);
  return next;
};

// ------------------------------------------------------------------ 发布机出口位置（#310）
//
// 全放 meta 表（不改 schema）：最近一次探测、每个账号「平时的国家」、「等发布机复查」的账号、IP 库的下载记录。
// 判断逻辑在 egress.mjs；这里只管读写。

export const getEgress = () => readMeta("egress.state");
export const setEgress = (state) => putMeta("egress.state", state);
export const getEgressBaselines = () => readMeta("egress.baselines") ?? {};
export const setEgressBaselines = (map) => putMeta("egress.baselines", map);
export const getEgressWaits = () => readMeta("egress.waits") ?? {};
export const setEgressWaits = (map) => putMeta("egress.waits", map);
export const getEgressGeoDb = () => readMeta("egress.geodb");
export const setEgressGeoDb = (record) => putMeta("egress.geodb", record);
