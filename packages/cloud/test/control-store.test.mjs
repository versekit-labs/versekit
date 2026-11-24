import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createActivityLog } from "../src/activity-log.mjs";
import { openControlStore, sessionTtlMs } from "../src/control-store.mjs";
import { tokenHash } from "../src/google.mjs";

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "hifabu-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("ACC-cloud-01: opening the control store repeatedly preserves six tables and merges verified identities by email", (t) => {
  const path = join(temp(t), "control.db");
  let now = 1_800_000_000_000;
  const clock = () => now;

  const first = openControlStore(path, { clock });
  let google;
  try {
    google = first.signIn({ provider: "google", subject: "subject-a", email: "Owner@Example.test" });
    assert.equal(first.session(google.token).id, google.user.id);
  } finally {
    first.close();
  }

  const second = openControlStore(path, { clock });
  try {
    const email = second.signIn({ provider: "email", subject: "owner@example.test", email: "owner@example.test" }, google.token);
    assert.equal(email.user.id, google.user.id);
    assert.notEqual(email.token, google.token);
    assert.equal(second.session(google.token), null);
    assert.equal(second.session(email.token).email, "owner@example.test");
    const another = second.signIn({ provider: "google", subject: "subject-b", email: "another@example.test" });
    assert.notEqual(another.user.id, google.user.id);

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
      assert.deepEqual(tables.map(({ name }) => name), ["device", "identity", "login_code", "relay_grant", "session", "user"]);
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
      assert.equal(database.prepare("SELECT count(*) AS n FROM user").get().n, 2);
      assert.equal(database.prepare("SELECT count(*) AS n FROM identity WHERE user_id = ?").get(google.user.id).n, 2);
      assert.equal(database.prepare("SELECT count(*) AS n FROM session WHERE token_hash = ?").get(email.token).n, 0);
      assert.equal(database.prepare("SELECT count(*) AS n FROM session WHERE token_hash = ?").get(tokenHash(email.token)).n, 1);
    } finally {
      database.close();
    }
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    now += sessionTtlMs;
    assert.equal(second.session(email.token), null);
  } finally {
    second.close();
  }
});

test("ACC-cloud-01: an existing non-Hifabu database is rejected without changes", (t) => {
  const path = join(temp(t), "other.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE existing (id INTEGER); INSERT INTO existing VALUES (1);");
  db.close();
  const before = readFileSync(path);
  assert.throws(() => openControlStore(path), /不是受支持的 Hifabu 控制库/);
  assert.deepEqual(readFileSync(path), before);
});

test("ACC-cloud-06: upgrading a control database preserves existing grants and adds a nullable closure timestamp", (t) => {
  const path = join(temp(t), "control.db");
  const schema = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");
  const oldSchema = schema.replace(",\n  closed_at INTEGER\n", "\n");
  assert.notEqual(oldSchema, schema);
  const old = new DatabaseSync(path);
  old.exec(`${oldSchema}
    PRAGMA application_id = 0x48494641;
    PRAGMA user_version = 1;
    INSERT INTO user VALUES ('a', 'a@example.test', 100), ('b', 'b@example.test', 100);
    INSERT INTO relay_grant VALUES ('a', NULL, 1, 500), ('b', 120, 0, 10000000000);
  `);
  old.close();

  const first = openControlStore(path, { clock: () => 200 });
  try {
    assert.deepEqual(first.relayGrant("a"), { enabled: true, capacityBytes: 500, requestedAt: null, closedAt: null });
    assert.deepEqual(first.relayGrant("b"), { enabled: false, capacityBytes: 10_000_000_000, requestedAt: 120, closedAt: null });
    assert.equal(first.setRelayGrant("a", { enabled: false }).closedAt, 200);
  } finally {
    first.close();
  }
  const reopened = openControlStore(path);
  try {
    assert.equal(reopened.relayGrant("a").closedAt, 200);
  } finally {
    reopened.close();
  }
});

test("Activity log retention is configurable up to 30 UTC days and can be turned off", (t) => {
  const directory = temp(t);
  let now = Date.UTC(2026, 10, 24, 10);
  const clock = () => now;
  const latest = join(directory, "activity-2026-11-24.ndjson");
  const old = join(directory, "activity-2026-11-23.ndjson");
  const unrelated = join(directory, "keep.txt");
  writeFileSync(old, "expired activity");
  writeFileSync(unrelated, "keep");
  assert.throws(() => createActivityLog({ directory, retentionDays: 31 }), /0 到 30 天/);
  const log = createActivityLog({ directory, retentionDays: 1, clock });
  try {
    assert.throws(() => readFileSync(old), { code: "ENOENT" });
    log.record("untrusted-raw-token");
    const entry = JSON.parse(readFileSync(latest, "utf8"));
    assert.deepEqual(Object.keys(entry).sort(), ["at", "error_code", "event", "message"]);
    assert.equal(entry.error_code, "internal_error");
    now += 86_400_000;
    log.record("login_succeeded");
    assert.throws(() => readFileSync(latest), { code: "ENOENT" });
  } finally {
    log.close();
  }
  const disabled = createActivityLog({ directory, retentionDays: 0, clock });
  disabled.record("login_succeeded");
  disabled.close();
  assert.throws(() => readFileSync(join(directory, "activity-2026-11-25.ndjson")), { code: "ENOENT" });
  assert.equal(readFileSync(unrelated, "utf8"), "keep");
});
