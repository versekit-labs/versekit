// Core: paths, database, and the two things every other package needs — a handle and an id.
// Everything that writes goes through here; adapters and channels never touch the file directly.

import { readEnv } from "./env.mjs";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { eventForTransition, isKnownEvent } from "./events.mjs";
import { frozenDeliveryOverrides } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, "schema.sql");

export const SCHEMA_VERSION = "1";

/** 旧作品补成片时的语言标记：升级前没有语言这个概念，不替人猜。 */
export const DEFAULT_LANGUAGE = "default";

/** All state lives under one root so a test can point it elsewhere. */
export function paths() {
  const home = readEnv("HIFABU_HOME") ?? homedir();
  const config = join(home, ".config", "versekit");
  const state = join(home, ".local", "state", "versekit");
  return {
    root: home,
    config,
    state,
    configFile: join(config, "config.json"),
    db: join(state, "vk.db"),
    socket: join(state, "vk.sock"),
    log: join(state, "vk.log"),
    browserProfile: join(state, "browser"),
    credentials: join(config, "credentials"),
  };
}

export function ensureDirs() {
  const p = paths();
  for (const dir of [p.config, p.state, p.credentials]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(p.config, 0o700);
    chmodSync(p.credentials, 0o700);
  } catch {
    /* best effort on non-POSIX filesystems */
  }
  return p;
}

// One process, one home. Connections are cached per database path so a test (or a daemon test
// file) can point HIFABU_HOME at a fresh directory without sharing state between cases.
let cache = { path: null, write: null, read: null };

/**
 * Open the database.
 *
 * `readonly: true` must never create a file: `vk doctor` runs before `vk init` and a doctor run
 * that leaves an empty `vk.db` behind would make `isInitialised()` lie forever after. So a
 * read-only open checks the file first and otherwise refuses with the sentence the person needs.
 */
export function open({ readonly = false } = {}) {
  const p = paths();
  if (cache.path !== p.db) cache = { path: p.db, write: null, read: null };
  if (!readonly) {
    if (!cache.write) {
      mkdirSync(dirname(p.db), { recursive: true, mode: 0o700 });
      cache.write = new DatabaseSync(p.db);
    }
    return cache.write;
  }
  if (cache.write) return cache.write;
  if (!existsSync(p.db)) throw new Error("还没有初始化：先运行 vk init");
  if (!cache.read) cache.read = new DatabaseSync(p.db, { readOnly: true });
  return cache.read;
}

/** Close cached connections (used by tests and by a clean daemon shutdown). */
export function close() {
  for (const key of ["write", "read"]) {
    try {
      cache[key]?.close();
    } catch {
      /* already closed */
    }
    cache[key] = null;
  }
  cache.path = null;
}

export function migrate() {
  const p = ensureDirs();
  const conn = open();
  const schema = readFileSync(SCHEMA, "utf8");
  try {
    conn.exec(schema);
  } catch (err) {
    // An older database may lack a column that a new index references; the second pass below
    // creates it once the column exists. Anything else is a real schema error.
    if (!/no such column/i.test(err.message)) throw err;
  }
  addMissingColumns(conn);
  conn.exec(schema); // 幂等：补齐第一遍因缺列而没建成的索引
  backfillCuts(conn);
  dropLegacyPublishUnique(conn);
  backfillApprovedNow(conn);
  unsnapshotGenericCopy(conn);
  conn.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SCHEMA_VERSION);
  conn.prepare("INSERT INTO meta (key, value) VALUES ('installed_at', ?) ON CONFLICT(key) DO NOTHING").run(String(Date.now()));
  try {
    chmodSync(p.db, 0o600);
  } catch {
    /* ignore */
  }
  return p;
}

/** SQLite has no "ADD COLUMN IF NOT EXISTS"; keep re-runs cheap and idempotent. */
const COLUMNS = {
  run: { lane: "TEXT" },
  publish: {
    published_at: "INTEGER",
    cut_id: "TEXT REFERENCES cut(id)",
    version_id: "TEXT REFERENCES cut_version(id)",
    approved_now: "INTEGER NOT NULL DEFAULT 0 CHECK (approved_now IN (0, 1))",
  },
  work: { source: "TEXT" },
  cut: { rev: "INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0)" },
  cut_version: { edited_fields: "TEXT CHECK (edited_fields IS NULL OR json_valid(edited_fields))" },
  account: { last_checked_at: "INTEGER", group_id: "TEXT REFERENCES account_group(id)", removed_at: "INTEGER" },
  command_audit: { idempotency_key: "TEXT" },
};

function addMissingColumns(conn) {
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    // 表还不存在：第一遍 exec 在某个引用新列的索引处中断，后面的表没建出来。
    // 交给第二遍 exec 按 schema.sql 原样建（自带全部列），这里不能 ALTER 一张不存在的表。
    if (!have.size) continue;
    for (const [name, type] of Object.entries(cols)) {
      if (!have.has(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

/**
 * 旧库升级：每个还没有成片的作品补一支成片 + 一个语言版本（素材取作品原来的那个文件），
 * 并把还没挂成片的平台稿挂上去。只处理「缺」的行，所以重复运行不会重复建成片。
 */
function backfillCuts(conn) {
  const now = Date.now();
  conn.exec("BEGIN");
  try {
    const orphans = conn.prepare("SELECT * FROM work w WHERE NOT EXISTS (SELECT 1 FROM cut c WHERE c.work_id = w.id)").all();
    for (const w of orphans) {
      const cutId = newId("cut");
      conn.prepare("INSERT INTO cut (id, work_id, title, position, created_at) VALUES (?,?,?,0,?)").run(cutId, w.id, w.title, w.created_at ?? now);
      conn
        .prepare("INSERT INTO cut_version (id, cut_id, language, asset_path, asset_sha, meta_json, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(newId("ver"), cutId, DEFAULT_LANGUAGE, w.asset_path, w.asset_sha ?? null, w.meta_json ?? null, w.created_at ?? now);
    }
    conn.exec(`UPDATE publish
                  SET cut_id = (SELECT c.id FROM cut c WHERE c.work_id = publish.work_id ORDER BY c.position, c.created_at LIMIT 1)
                WHERE cut_id IS NULL`);
    conn.exec(`UPDATE publish
                  SET version_id = (SELECT v.id FROM cut_version v WHERE v.cut_id = publish.cut_id ORDER BY v.rowid LIMIT 1)
                WHERE version_id IS NULL AND cut_id IS NOT NULL`);
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

// 同 store.COPY_ALIASES（store 依赖本文件，这里不能反向 import）。
const COPY_ALIAS = { "tiktok-api": "tiktok", xhs: "xiaohongshu", bili: "bilibili" };

/**
 * 旧版 plan.apply 把「通用 + 平台」合并后的文案整份抄进平台稿的 overrides.copy，之后改通用文案传不下去。
 * 现在平台稿只存「单独写的」字段（ACC-v3-edit-01）：这里把还没发的平台稿里「和通用文案一样、
 * 且入库时没给这个平台单独写」的字段去掉，让它们重新跟通用。幂等；已发出去的不动。
 */
function unsnapshotGenericCopy(conn) {
  const rows = conn
    .prepare(
      `SELECT p.id, p.overrides_json, a.platform, v.meta_json AS version_meta
         FROM publish p JOIN account a ON a.id = p.account_id JOIN cut_version v ON v.id = p.version_id
        WHERE p.overrides_json LIKE '%"copy"%'
          AND p.state IN ('pending_confirm','skipped','queued','notify_pending','draft_pending')`,
    )
    .all();
  for (const r of rows) {
    try {
      const ov = JSON.parse(r.overrides_json);
      const copy = JSON.parse(r.version_meta ?? "null")?.copy;
      if (!ov?.copy || !copy?.default) continue;
      const own = copy[COPY_ALIAS[r.platform] ?? r.platform] ?? {};
      let changed = false;
      for (const f of ["title", "body", "tags"]) {
        if (own[f] != null || ov.copy[f] == null) continue;
        if (JSON.stringify(ov.copy[f]) === JSON.stringify(copy.default[f])) {
          delete ov.copy[f];
          changed = true;
        }
      }
      if (!changed) continue;
      if (!Object.keys(ov.copy).length) delete ov.copy;
      conn.prepare("UPDATE publish SET overrides_json = ? WHERE id = ?").run(Object.keys(ov).length ? JSON.stringify(ov) : null, r.id);
    } catch {
      /* 解析不了的行原样保留 */
    }
  }
}

/**
 * 旧库的 publish 表带 UNIQUE(work_id, account_id)，装不下「同一个账号发一支长片和三支短片」。
 * SQLite 不能 DROP CONSTRAINT，只能重建：新表 → 拷数据 → 删旧表 → 改名，一个事务。
 *
 * 要点（SQLite 官方的 12 步法）：
 *  - foreign_keys 必须在事务外关掉，否则 DROP TABLE 会因 snapshot/followup 仍引用而失败；
 *  - 行原样拷贝（id 不变），snapshot / followup / run 引用的 publish id 因此不变；
 *  - 索引随表一起删，必须重建；
 *  - 提交前 foreign_key_check，有违规就回滚，不留半成品。
 * 已经去掉约束的库直接返回，所以幂等。
 */
function dropLegacyPublishUnique(conn) {
  if (!hasLegacyPublishUnique(conn)) return;
  const create = readFileSync(SCHEMA, "utf8").match(/CREATE TABLE IF NOT EXISTS publish \([\s\S]*?\n\);/)?.[0];
  if (!create) throw new Error("schema.sql 里找不到 publish 表定义，无法迁移");
  const cols = conn.prepare("PRAGMA table_info(publish)").all().map((c) => c.name).join(", ");

  conn.exec("PRAGMA foreign_keys = OFF");
  try {
    conn.exec("BEGIN");
    try {
      conn.exec("DROP TABLE IF EXISTS publish_new");
      conn.exec(create.replace("CREATE TABLE IF NOT EXISTS publish (", "CREATE TABLE publish_new ("));
      conn.exec(`INSERT INTO publish_new (${cols}) SELECT ${cols} FROM publish`);
      conn.exec("DROP TABLE publish");
      conn.exec("ALTER TABLE publish_new RENAME TO publish");
      conn.exec("CREATE INDEX IF NOT EXISTS idx_publish_state ON publish(state, scheduled_at)");
      conn.exec("CREATE INDEX IF NOT EXISTS idx_publish_effective_at ON publish(COALESCE(published_at, scheduled_at), id)");
      conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_cut_account ON publish(cut_id, account_id) WHERE cut_id IS NOT NULL");
      const bad = conn.prepare("PRAGMA foreign_key_check").all();
      if (bad.length) throw new Error(`迁移 publish 表后外键检查失败（${bad.length} 处），已回滚`);
      conn.exec("COMMIT");
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  } finally {
    conn.exec("PRAGMA foreign_keys = ON");
  }
}

/** Preserve the old calendar exclusions once, including publishes that have since changed state. */
function backfillApprovedNow(conn) {
  conn.exec("BEGIN IMMEDIATE");
  try {
    const migration = conn.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('backfilled_approved_now', '1')").run();
    if (migration.changes) {
      conn.exec(`UPDATE publish SET approved_now = 1
                  WHERE id IN (
                    SELECT publish_id FROM event
                     WHERE payload_json LIKE '%"reason":"approved_now_by_operator"%'
                  )`);
    }
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

function hasLegacyPublishUnique(conn) {
  for (const idx of conn.prepare("PRAGMA index_list(publish)").all()) {
    if (!idx.unique || idx.origin !== "u") continue; // origin 'u' = 表内 UNIQUE 约束；'c' 是我们自己建的索引
    const columns = conn.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all().map((c) => c.name);
    if (columns.join(",") === "work_id,account_id") return true;
  }
  return false;
}

export function getMeta(key) {
  // A database file can exist without the schema (an interrupted init, a stray empty file). Ask
  // the schema first so this never creates a table, never throws `no such table`, and never turns
  // "not initialised" into "initialised" by accident.
  if (!isInitialised()) return null;
  return open({ readonly: true }).prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

/**
 * "Initialised" means the schema is there, not merely that a file exists. The old check let one
 * `vk doctor` (which used to open a writable connection) flip this to true on an empty database.
 */
export function isInitialised() {
  const p = paths();
  if (!existsSync(p.db)) return false;
  try {
    const conn = open({ readonly: true });
    return Boolean(conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get());
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ ids

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function shortId(n = 10) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const newId = (prefix) => `${prefix}_${shortId()}`;

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// ------------------------------------------------------------------ events

/**
 * Every state change must leave an event (docs/ARCHITECTURE.md §4).
 * dedupeKey makes delivery idempotent — the same logical fact is never sent twice.
 */
export function emit({ type, severity = "info", publishId = null, payload = null, dedupeKey = null }) {
  // A typo'd event type used to land in the table and never be deliverable. The catalog is the
  // contract with the channels, so an unregistered type is a bug, not a row.
  if (!isKnownEvent(type)) throw new Error(`未登记的事件类型：${type}（见 core/src/events.mjs）`);
  const conn = open();
  const id = newId("evt");
  try {
    conn
      .prepare("INSERT INTO event (id, type, severity, publish_id, payload_json, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, type, severity, publishId, payload ? JSON.stringify(payload) : null, dedupeKey, Date.now());
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return null; // already emitted
    throw err;
  }
  return id;
}

/**
 * Moves a publish row and records the fact. Throws on an unknown transition so a bad
 * code path fails loudly instead of writing a state nobody handles.
 */
export const PUBLISH_TRANSITIONS = {
  queued: ["auto_running", "draft_running", "notify_pending", "failed", "canceled", "blocked"],
  auto_running: ["published", "published_limited", "draft_running", "notify_pending", "failed", "blocked", "canceled"],
  draft_running: ["draft_pending", "notify_pending", "failed", "blocked", "canceled"],
  draft_pending: ["published", "notify_pending", "failed", "canceled"],
  notify_pending: ["published", "failed", "canceled", "expired", "queued"],
  published: [],
  published_limited: ["published"],
  failed: ["queued", "notify_pending", "canceled"],
  blocked: ["queued", "canceled"],
  expired: ["queued", "canceled"],
  canceled: [],
  // 发布前人确认（#146，ACC-v2-confirm-*）。平台稿生成后先停在 pending_confirm；只有人确认的命令
  // （publish.approve / now / manual）能把它推进去，任何调度或队列代码都不会。
  pending_confirm: ["queued", "notify_pending", "skipped", "canceled"],
  // 「这支先不发」：以后还能再确认（直接确认、我自己发，或回到待确认）。
  skipped: ["pending_confirm", "queued", "notify_pending", "canceled"],
};

export function transitionPublish(publishId, to, { reason = null, patch = {}, input } = {}) {
  const conn = open();
  const row = conn.prepare("SELECT * FROM publish WHERE id = ?").get(publishId);
  if (!row) throw new Error(`没有这条发布：${publishId}`);
  const allowed = PUBLISH_TRANSITIONS[row.state] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`非法状态迁移：${row.state} → ${to}（允许：${allowed.join(", ") || "无"}）`);
  }
  const fields = { ...patch, state: to, updated_at: Date.now() };
  if ((to === "published" || to === "published_limited") && row.state !== "published_limited") {
    const overrides = Object.hasOwn(fields, "overrides_json") ? fields.overrides_json : row.overrides_json;
    const frozen = frozenDeliveryOverrides(conn, row, overrides, input);
    if (frozen !== overrides) fields.overrides_json = frozen;
  }
  if (reason === "approved_now_by_operator") fields.approved_now = 1;
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  conn.prepare(`UPDATE publish SET ${sets} WHERE id = ?`).run(...Object.values(fields), publishId);
  const event = eventForTransition(to);
  emit({
    type: event.type,
    severity: event.severity,
    publishId,
    payload: { from: row.state, to, reason },
    dedupeKey: `${publishId}:${row.state}->${to}:${row.updated_at}`,
  });
  return { from: row.state, to };
}

/** Enqueue work. One queued run per (kind, target) keeps retries from piling up. */
export function enqueue({ kind, targetType, targetId, lane = null, priority = 100, runAfter = null }) {
  const conn = open();
  const existing = conn
    .prepare("SELECT id FROM run WHERE kind=? AND target_type=? AND target_id=? AND state IN ('queued','running')")
    .get(kind, targetType, targetId);
  if (existing) return existing.id;
  const id = newId("run");
  conn
    .prepare("INSERT INTO run (id, kind, target_type, target_id, lane, state, priority, run_after, created_at) VALUES (?,?,?,?,?, 'queued', ?,?,?)")
    .run(id, kind, targetType, targetId, lane, priority, runAfter, Date.now());
  return id;
}

export { randomUUID };
