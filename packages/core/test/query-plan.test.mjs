import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, migrate, open, transitionPublish } from "../src/index.mjs";
import { createCoreHandlers } from "../src/handlers.mjs";

const from = new Date(2030, 0, 15, 9).getTime();
const hour = 3600e3;
const to = from + 6 * hour;
const schema = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");

function openTestDb(t, ddl = null) {
  const home = mkdtempSync(join(tmpdir(), "vk-query-plan-"));
  const previousHome = process.env.HIFABU_HOME;
  process.env.HIFABU_HOME = home;
  t.after(() => {
    close();
    if (previousHome === undefined) delete process.env.HIFABU_HOME;
    else process.env.HIFABU_HOME = previousHome;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  if (ddl) open().exec(ddl);
  else migrate();
  return open();
}

function seed(conn) {
  conn.exec(`
    INSERT INTO account_group VALUES ('group', '主组', 1), ('other', '另一组', 1);
    INSERT INTO account (id, platform, handle, created_at, group_id) VALUES
      ('account', 'tiktok', '@mine', 1, 'group'), ('other-account', 'tiktok', '@other', 1, 'other');
    INSERT INTO meta VALUES ('current_group', 'group');
    INSERT INTO work (id, title, asset_path, created_at) VALUES ('work', '作品', '/fixture.mp4', 1);
  `);
  const insert = conn.prepare(`
    INSERT INTO publish (id, account_id, state, scheduled_at, published_at, fallback_reason,
                         work_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'work', 1, 1)
  `);
  insert.run("scheduled", "account", "queued", from, null, null);
  insert.run("published", "account", "published", from - hour, to, null);
  insert.run("now", "account", "queued", from + hour, null, null);
  insert.run("self", "account", "notify_pending", from + 2 * hour, null, "self_publish");
  insert.run("failed", "account", "failed", from + 3 * hour, null, null);
  insert.run("skipped", "account", "skipped", from + 4 * hour, null, null);
  insert.run("out-of-range", "account", "published", from, to + 1, null);
  insert.run("other", "other-account", "queued", from, null, null);
  conn.exec(`
    INSERT INTO cut (id, work_id, title, created_at) SELECT id, work_id, id, 1 FROM publish;
    INSERT INTO cut_version (id, cut_id, language, asset_path, created_at)
      SELECT id, id, 'zh', '/fixture.mp4', 1 FROM cut;
    UPDATE publish SET cut_id = id, version_id = id;
    INSERT INTO event (id, type, severity, publish_id, payload_json, created_at) VALUES
      ('old-now', 'publish.state_changed', 'info', 'now',
       '{"from":"pending_confirm","to":"queued","reason":"approved_now_by_operator"}', 1),
      ('later-failed', 'publish.failed', 'warn', 'now', '{"reason":"timeout"}', 2),
      ('later-retry', 'publish.state_changed', 'info', 'now', '{"reason":"manual_retry"}', 3),
      ('old-scheduled', 'publish.state_changed', 'info', 'scheduled', '{"reason":"approved_by_operator"}', 4);
  `);
}

const eventsByPublish = "SELECT id, type, payload_json FROM event WHERE publish_id = ? ORDER BY created_at";

test("ACC-arch-14: calendar, quota and publish event lookups use indexes", (t) => {
  const conn = openTestDb(t);
  seed(conn);
  const prepare = conn.prepare.bind(conn);
  const queries = [];
  t.mock.method(conn, "prepare", (sql) => {
    queries.push(sql);
    return prepare(sql);
  });
  createCoreHandlers({})["publish.list"]({ from, to });

  const check = (query, indexedSearch) => {
    assert.ok(query, "expected command query");
    const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all().map(({ detail }) => detail).join("\n");
    assert.match(plan, indexedSearch);
    assert.doesNotMatch(plan, /\bSCAN (?:p|publish|e|event)\b/);
  };
  const calendar = queries.find((sql) => sql.includes("AS cut_count"));
  const quota = queries.find((sql) => sql.includes("SELECT p.account_id, a.platform"));
  const timeRangeSearch = /SEARCH p USING INDEX idx_publish_effective_at \(<expr>>\? AND <expr><\?\)/;
  check(calendar, timeRangeSearch);
  check(quota, timeRangeSearch);
  check(eventsByPublish, /SEARCH event USING INDEX idx_event_publish_id \(publish_id=\?\)/);
  assert.doesNotMatch(calendar, /\bevent\b|payload_json/i);
});

test("ACC-arch-05: opening and migrating a previous database preserves command results", (t) => {
  // Reconstruct the preceding schema and the calendar predicate used by its command handler.
  const oldSchema = schema
    .replace(/,( *-- 用的是哪个语言版本)\n  approved_now[^\n]*/, "$1")
    .replace(/^CREATE INDEX IF NOT EXISTS idx_(?:publish_effective_at|event_publish_id) .+\n/gm, "");
  const conn = openTestDb(t, oldSchema);
  seed(conn);
  assert.ok(!conn.prepare("PRAGMA table_info(publish)").all().some(({ name }) => name === "approved_now"));
  const handlers = createCoreHandlers({});
  const readCommands = () => ({
    calendar: handlers["publish.list"]({ from, to }),
    publishes: handlers["publish.list"]({}),
    events: handlers["event.list"]({}),
  });
  const prepare = conn.prepare.bind(conn);
  const legacyPredicate = `NOT EXISTS (
    SELECT 1 FROM event e WHERE e.publish_id = p.id AND e.payload_json LIKE '%"reason":"approved_now_by_operator"%'
  )`;
  const mock = t.mock.method(conn, "prepare", (sql) => prepare(sql
    .replace(" INDEXED BY idx_publish_effective_at", "")
    .replace("p.approved_now = 0", legacyPredicate)));
  const before = readCommands();
  mock.mock.restore();
  assert.deepEqual(before.calendar.rows.map(({ id, at }) => [id, at]), [
    ["scheduled", from],
    ["failed", from + 3 * hour],
    ["published", to],
  ]);
  assert.equal(before.calendar.quota[0].used, 4);
  close(); // Reopen the database file through the normal migration path.

  for (let attempt = 0; attempt < 2; attempt++) {
    migrate();
    assert.deepEqual(readCommands(), before);
  }
  assert.throws(() => open().exec("UPDATE publish SET approved_now = 2 WHERE id = 'now'"), /CHECK constraint failed/);
});

test("ACC-arch-14: new immediate approvals stay off the calendar through retries", (t) => {
  const conn = openTestDb(t);
  seed(conn);
  conn.exec("UPDATE publish SET state = 'pending_confirm' WHERE id = 'scheduled'");
  transitionPublish("scheduled", "queued", { reason: "approved_now_by_operator" });
  transitionPublish("scheduled", "failed", { reason: "timeout" });
  transitionPublish("scheduled", "queued", { reason: "manual_retry" });
  const calendar = createCoreHandlers({})["publish.list"]({ from, to });
  assert.ok(!calendar.rows.some(({ id }) => id === "scheduled"));
  assert.equal(calendar.quota[0].used, 4);
});
