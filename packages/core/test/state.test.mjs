// The state machine is the part of versekit that is easiest to get subtly wrong: a bad transition
// means a publish that nothing ever finishes. These tests pin the whitelist and the audit trail.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-test-"));

const core = await import("../src/index.mjs");

before(() => {
  core.migrate();
  const db = core.open();
  db.prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES ('w1','t','/tmp/a.mp4',1)").run();
  db.prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a1','tiktok','@x',1)").run();
  db.prepare("INSERT INTO publish (id, work_id, account_id, created_at, updated_at) VALUES ('p1','w1','a1',1,1)").run();
});

test("new publish starts queued", () => {
  const row = core.open().prepare("SELECT state FROM publish WHERE id='p1'").get();
  assert.equal(row.state, "queued");
});

test("legal transition moves the row and leaves an event", () => {
  const res = core.transitionPublish("p1", "auto_running");
  assert.deepEqual(res, { from: "queued", to: "auto_running" });
  const events = core.open().prepare("SELECT type, payload_json FROM event WHERE publish_id='p1' ORDER BY created_at").all();
  // Running states are bookkeeping, so they land on the generic trace rather than a card event.
  const trace = events.find((e) => e.type === "publish.state_changed");
  assert.ok(trace, "每个迁移都要留事件");
  assert.equal(JSON.parse(trace.payload_json).to, "auto_running");
});

test("illegal transition throws instead of writing a state nobody handles", () => {
  // auto_running may go to published, but never back to queued
  assert.throws(() => core.transitionPublish("p1", "queued"), /非法状态迁移/);
});

test("auto_running can end in published_limited (platform forced the visibility)", () => {
  // p1 is currently auto_running from the earlier test
  core.transitionPublish("p1", "published_limited", { reason: "forced_private" });
  const row = core.open().prepare("SELECT state FROM publish WHERE id='p1'").get();
  assert.equal(row.state, "published_limited");
});

test("published_limited can still be released to published", () => {
  core.transitionPublish("p1", "published");
  const row = core.open().prepare("SELECT state FROM publish WHERE id='p1'").get();
  assert.equal(row.state, "published");
});

test("published is terminal", () => {
  assert.throws(() => core.transitionPublish("p1", "queued"), /非法状态迁移|允许：无/);
});

test("enqueue is idempotent for the same target", () => {
  const a = core.enqueue({ kind: "collect", targetType: "publish", targetId: "p1" });
  const b = core.enqueue({ kind: "collect", targetType: "publish", targetId: "p1" });
  assert.equal(a, b);
  const rows = core.open().prepare("SELECT COUNT(*) n FROM run WHERE target_id='p1'").get();
  assert.equal(rows.n, 1);
});

test("events dedupe on the same key so a retry does not double-notify", () => {
  const first = core.emit({ type: "account.expired", severity: "warn", dedupeKey: "acc:a1:expired:1" });
  const second = core.emit({ type: "account.expired", severity: "warn", dedupeKey: "acc:a1:expired:1" });
  assert.ok(first);
  assert.equal(second, null);
});
