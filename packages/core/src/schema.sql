-- versekit schema v1  (docs/ARCHITECTURE.md §3)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 账号组：产品第一层导航（进去先选组，之后所有页面只看该组）。docs/design/HANDOFF.md §3
CREATE TABLE IF NOT EXISTS account_group (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id             TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,
  handle         TEXT NOT NULL,
  display_name   TEXT,
  credential_ref TEXT,
  state          TEXT NOT NULL DEFAULT 'ok',
  is_manual      INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER,
  last_ok_at     INTEGER,
  last_checked_at INTEGER,          -- 最近一次主动探测（成功失败都算），调度靠它
  created_at     INTEGER NOT NULL,
  group_id       TEXT REFERENCES account_group(id),  -- null = 未分组，行为与引入账号组之前一致
  removed_at     INTEGER,                            -- 非空 = 已从组的槽位移除；行保留，历史发布仍可追溯
  UNIQUE (platform, handle)
);
-- 一个组里每个平台只有一个槽位；未分组与已移除的账号不占槽位。
-- 先 DROP 再建：旧库的索引谓词里没有 removed_at，IF NOT EXISTS 不会替换它，
-- 移除后换号就会被旧索引拦下。第一遍 exec 因缺列中断时由 migrate() 的第二遍补建。
DROP INDEX IF EXISTS idx_account_group_platform;
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_group_platform
  ON account(group_id, platform) WHERE group_id IS NOT NULL AND removed_at IS NULL;

CREATE TABLE IF NOT EXISTS work (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  asset_path TEXT NOT NULL,
  asset_sha  TEXT,
  meta_json  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS publish (
  id              TEXT PRIMARY KEY,
  work_id         TEXT NOT NULL REFERENCES work(id),
  account_id      TEXT NOT NULL REFERENCES account(id),
  mode            TEXT NOT NULL DEFAULT 'auto',
  visibility      TEXT NOT NULL DEFAULT 'public',
  state           TEXT NOT NULL DEFAULT 'queued',
  scheduled_at    INTEGER,
  overrides_json  TEXT,
  external_id     TEXT,
  external_url    TEXT,
  fallback_reason TEXT,
  error_code      TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  published_at    INTEGER,           -- 首次进入 published/published_limited；采集节奏从它起算
  UNIQUE (work_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_publish_state ON publish(state, scheduled_at);

CREATE TABLE IF NOT EXISTS snapshot (
  id           TEXT PRIMARY KEY,
  publish_id   TEXT NOT NULL REFERENCES publish(id),
  captured_at  INTEGER NOT NULL,
  source       TEXT NOT NULL,
  status       TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  UNIQUE (publish_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_pub ON snapshot(publish_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS followup (
  id          TEXT PRIMARY KEY,
  publish_id  TEXT NOT NULL REFERENCES publish(id),
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open',
  verify_hint TEXT,
  done_at     INTEGER
);

CREATE TABLE IF NOT EXISTS run (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  lane         TEXT,                 -- 并发闸门：同一 lane（通常是 account_id）同时只跑一个任务
  state        TEXT NOT NULL DEFAULT 'queued',
  priority     INTEGER NOT NULL DEFAULT 100,
  run_after    INTEGER,
  lease_until  INTEGER,
  heartbeat_at INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_ready ON run(state, run_after, priority);
CREATE INDEX IF NOT EXISTS idx_run_lane ON run(lane, state);

CREATE TABLE IF NOT EXISTS event (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  publish_id   TEXT,
  payload_json TEXT,
  dedupe_key   TEXT UNIQUE,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES event(id),
  channel         TEXT NOT NULL,
  state           TEXT NOT NULL,
  external_msg_id TEXT,
  attempted       INTEGER NOT NULL DEFAULT 0,
  sent_at         INTEGER
);

CREATE TABLE IF NOT EXISTS command_audit (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  origin     TEXT NOT NULL,
  args_json  TEXT,
  result     TEXT,
  reason     TEXT,
  idempotency_key TEXT,          -- 卡片按钮的幂等键：同一张卡点两次只执行一次
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_idem ON command_audit(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_binding (
  id               TEXT PRIMARY KEY,
  channel          TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  paired_at        INTEGER,
  UNIQUE (channel, external_user_id)
);
