// The seam between "adapter said something" and "the database agrees". Every rule here exists
// because the failure mode it prevents is invisible: a publish that moves to a state nothing
// finishes, or a failure that never becomes a card.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-flow-"));

const core = await import("../src/index.mjs");
const { applyPublishResult, applyPublishError, applyTerminalFailure, recordSnapshot, getPublishRow } = await import("../src/publish-flow.mjs");
const { AdapterError } = await import("../src/errors.mjs");

const db = () => core.open();
let n = 0;

function seed(state = "queued") {
  const k = ++n;
  db().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?,?,?,?)").run(`w${k}`, `t${k}`, "/tmp/a.mp4", Date.now());
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES (?,?,?,?)").run(`a${k}`, "tiktok", `@h${k}`, Date.now());
  db()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(`p${k}`, `w${k}`, `a${k}`, state, Date.now(), Date.now());
  return `p${k}`;
}

before(() => core.migrate());

test("a published result lands the id, the state and the first collection", () => {
  const id = seed("auto_running");
  applyPublishResult(id, {
    id: "vid_1",
    url: "https://t.test/vid_1",
    visibility: "public",
    state: "published",
  });
  const row = getPublishRow(id);
  assert.equal(row.state, "published");
  assert.equal(row.external_id, "vid_1");
  const collect = db().prepare("SELECT run_after FROM run WHERE target_id=? AND kind='collect'").get(id);
  assert.ok(collect, "发布成功必须自动排采集");
  assert.ok(collect.run_after > Date.now(), "第一次采集在一个小时后，不是立刻");
});

test("followups are written once and announced once", () => {
  const id = seed("auto_running");
  const result = {
    id: "vid_2",
    url: "https://t.test/vid_2",
    visibility: "private",
    state: "published_limited",
    followups: [{ kind: "set_visibility_public", hint: "确认后放行", verify: "visibility" }],
  };
  applyPublishResult(id, result);
  applyPublishResult(id, result); // a retry must not duplicate the card or the row
  const rows = db().prepare("SELECT * FROM followup WHERE publish_id=?").all(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verify_hint, "确认后放行");
  const events = db().prepare("SELECT COUNT(*) n FROM event WHERE publish_id=? AND type='publish.needs_followup'").get(id).n;
  assert.equal(events, 1);
});

test("a malformed result is rejected before the row is touched", () => {
  const id = seed("auto_running");
  assert.throws(() => applyPublishResult(id, { url: "u", visibility: "public", state: "published" }), /缺少 id/);
  assert.equal(getPublishRow(id).state, "auto_running");
});

test("auth failure blocks the publish and expires the account, once", () => {
  const id = seed("auto_running");
  const disposition = applyPublishError(id, new AdapterError("auth", "cookie 过期"));
  assert.equal(disposition.terminal, true);
  assert.equal(disposition.retryable, false);
  assert.equal(getPublishRow(id).state, "blocked");
  assert.equal(getPublishRow(id).account_state, "expired");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM event WHERE type='account.expired' AND publish_id=?").get(id).n, 1);
});

test("platform_reject goes to the person instead of retrying", () => {
  const id = seed("auto_running");
  const d = applyPublishError(id, new AdapterError("platform_reject", "审核不通过"));
  assert.equal(d.retryable, false);
  assert.equal(getPublishRow(id).state, "notify_pending");
});

test("asset_invalid fails immediately — retrying a file the platform rejects is pointless", () => {
  const id = seed("auto_running");
  const d = applyPublishError(id, new AdapterError("asset_invalid", "超过 4GB"));
  assert.equal(d.terminal, true);
  assert.equal(getPublishRow(id).state, "failed");
  assert.equal(getPublishRow(id).error_code, "asset_invalid");
});

test("flaky_ui stays retryable and records the code without moving the row", () => {
  const id = seed("auto_running");
  const d = applyPublishError(id, new AdapterError("flaky_ui", "找不到发布按钮"));
  assert.equal(d.retryable, true);
  const row = getPublishRow(id);
  assert.equal(row.state, "auto_running");
  assert.equal(row.error_code, "flaky_ui");
});

test("giving up hands the publish to a human with a readable fallback reason", () => {
  const id = seed("auto_running");
  const out = applyTerminalFailure(id, new AdapterError("flaky_ui", "页面改版"));
  assert.equal(out.state, "notify_pending");
  assert.equal(out.fallback, "flaky_automation");
  const row = getPublishRow(id);
  assert.equal(row.state, "notify_pending");
  assert.equal(row.fallback_reason, "flaky_automation");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM event WHERE type='publish.needs_human' AND publish_id=?").get(id).n, 1);
});

test("a plain error is treated as unknown, not dropped", () => {
  const id = seed("auto_running");
  const d = applyPublishError(id, new Error("socket hang up"));
  assert.equal(d.code, "unknown");
  assert.equal(d.retryable, true);
});

test("snapshots refuse an unknown source and a duplicate capture is reported, not thrown", () => {
  const id = seed("published");
  assert.throws(() => recordSnapshot({ publishId: id, source: "guess", status: "ok", metrics: {} }), /采集来源/);
  const first = recordSnapshot({ publishId: id, source: "intercept", status: "ok", metrics: { play: 3 }, capturedAt: 1000 });
  assert.equal(first.duplicate, false);
  const second = recordSnapshot({ publishId: id, source: "intercept", status: "ok", metrics: { play: 3 }, capturedAt: 1000 });
  assert.equal(second.duplicate, true);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM snapshot WHERE publish_id=?").get(id).n, 1);
});
