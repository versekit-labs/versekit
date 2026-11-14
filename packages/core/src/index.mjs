// Core: paths, database, and the two things every other package needs — a handle and an id.
// Everything that writes goes through here; adapters and channels never touch the file directly.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { eventForTransition, isKnownEvent } from "./events.mjs";
import { migrateXiaohongshuToHandoff } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, "schema.sql");

export const SCHEMA_VERSION = "1";

/** All state lives under one root so a test can point it elsewhere. */
export function paths() {
  const home = process.env.VK_HOME ?? homedir();
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
// file) can point VK_HOME at a fresh directory without sharing state between cases.
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
  migrateXiaohongshuToHandoff(); // 小红书默认交给手机；只迁一次（#120）
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
  publish: { published_at: "INTEGER" },
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
};

export function transitionPublish(publishId, to, { reason = null, patch = {} } = {}) {
  const conn = open();
  const row = conn.prepare("SELECT * FROM publish WHERE id = ?").get(publishId);
  if (!row) throw new Error(`没有这条发布：${publishId}`);
  const allowed = PUBLISH_TRANSITIONS[row.state] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`非法状态迁移：${row.state} → ${to}（允许：${allowed.join(", ") || "无"}）`);
  }
  const fields = { ...patch, state: to, updated_at: Date.now() };
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
