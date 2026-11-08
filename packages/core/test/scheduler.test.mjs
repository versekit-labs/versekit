// G3: the system finds an expired login before the person does. That needs a clock, and the clock
// needs to survive restarts — so "who is due" is derived from the account row, not from memory.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-sched-"));

const core = await import("../src/index.mjs");
const { dueAccounts, sweepAccountChecks, CHECK_INTERVAL_MS } = await import("../src/scheduler.mjs");
const { buildHandlers } = await import("../src/adapters.mjs");

const db = () => core.open();

before(() => core.migrate());

beforeEach(() => {
  db().exec("DELETE FROM run; DELETE FROM account; DELETE FROM event;");
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a1','tiktok','@one',1)").run();
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a2','bilibili','@two',1)").run();
  db().prepare("INSERT INTO account (id, platform, handle, is_manual, created_at) VALUES ('a3','tiktok','@manual',1,1)").run();
});

test("an account that has never been probed is due immediately", () => {
  const due = dueAccounts().map((a) => a.id).sort();
  assert.deepEqual(due, ["a1", "a2"], "手动账号不做主动探测");
});

test("the sweep queues one check per due account, on its own lane", () => {
  const queued = sweepAccountChecks();
  assert.deepEqual(queued.sort(), ["a1", "a2"]);
  const runs = db().prepare("SELECT target_id, lane, kind, state FROM run WHERE kind='check' ORDER BY target_id").all();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].lane, "a1");
  assert.equal(runs[0].state, "queued");
});

test("sweeping twice does not pile up duplicate checks", () => {
  sweepAccountChecks();
  sweepAccountChecks();
  assert.equal(db().prepare("SELECT COUNT(*) n FROM run WHERE kind='check'").get().n, 2);
});

test("a recent probe takes the account out of the due set", () => {
  db().prepare("UPDATE account SET last_checked_at=? WHERE id='a1'").run(Date.now());
  assert.deepEqual(dueAccounts().map((a) => a.id), ["a2"]);
});

test("a stale probe (older than the interval) is due again", () => {
  db().prepare("UPDATE account SET last_checked_at=? WHERE id='a1'").run(Date.now() - CHECK_INTERVAL_MS - 1);
  assert.ok(dueAccounts().map((a) => a.id).includes("a1"));
});

// ---------------------------------------------------------------- the check handler

const fakeAdapter = (check) => ({
  platform: "tiktok",
  publish: "web",
  collect: "web",
  visibility: [],
  draft: false,
  requiresQualification: false,
  minScheduleLeadMs: null,
  maxFileSizeMb: null,
  adapter: { platform: "tiktok", ready: () => null, async publish() {}, async collect() {}, check },
});

test("check() ok records the probe and keeps the account healthy", async () => {
  const handlers = buildHandlers([fakeAdapter(async () => ({ state: "ok" }))]);
  const res = await handlers.check({ target_id: "a1", kind: "check" });
  assert.equal(res.state, "ok");
  const row = db().prepare("SELECT state, last_ok_at, last_checked_at FROM account WHERE id='a1'").get();
  assert.equal(row.state, "ok");
  assert.ok(row.last_ok_at > 0);
  assert.ok(row.last_checked_at > 0);
});

test("check() expiring is announced once, not on every probe", async () => {
  const handlers = buildHandlers([fakeAdapter(async () => ({ state: "expiring", detail: "还有 48 小时" }))]);
  await handlers.check({ target_id: "a1", kind: "check" });
  await handlers.check({ target_id: "a1", kind: "check" });
  const events = db().prepare("SELECT COUNT(*) n FROM event WHERE type='account.expiring'").get().n;
  assert.equal(events, 1);
  assert.equal(db().prepare("SELECT state FROM account WHERE id='a1'").get().state, "expiring");
});

test("check() throwing auth expires the account and emits a card", async () => {
  const { AdapterError } = await import("../src/errors.mjs");
  const handlers = buildHandlers([fakeAdapter(async () => { throw new AdapterError("auth", "cookie 没了"); })]);
  await assert.rejects(() => handlers.check({ target_id: "a1", kind: "check" }));
  assert.equal(db().prepare("SELECT state FROM account WHERE id='a1'").get().state, "expired");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM event WHERE type='account.expired'").get().n, 1);
});

test("an adapter without check() is recorded as passive-only, not silently healthy", async () => {
  const handlers = buildHandlers([{ ...fakeAdapter(undefined), adapter: { platform: "tiktok", ready: () => null, async publish() {} } }]);
  const res = await handlers.check({ target_id: "a1", kind: "check" });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /没有 check/);
  assert.ok(db().prepare("SELECT last_checked_at FROM account WHERE id='a1'").get().last_checked_at > 0);
});
