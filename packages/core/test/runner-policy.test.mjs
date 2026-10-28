// The disposition table (ARCHITECTURE §4.3) is only real if the queue honours it. These tests are
// about what happens *after* an adapter fails: does auth burn three backoff rounds? does a quota
// error consume the retry budget? does a page redesign end up in front of a person?
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-policy-"));

const core = await import("../src/index.mjs");
const { createRunner } = await import("../src/runner.mjs");
const { buildHandlers } = await import("../src/adapters.mjs");
const { applyTerminalFailure } = await import("../src/publish-flow.mjs");
const { AdapterError } = await import("../src/errors.mjs");

const db = () => core.open();
let n = 0;

const seed = () => {
  const k = ++n;
  db().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?,?,?,?)").run(`w${k}`, `t${k}`, "/tmp/a.mp4", Date.now());
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES (?,?,?,?)").run(`a${k}`, "tiktok", `@h${k}`, Date.now());
  db()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES (?,?,?,'queued',?,?)")
    .run(`p${k}`, `w${k}`, `a${k}`, Date.now(), Date.now());
  core.enqueue({ kind: "publish", targetType: "publish", targetId: `p${k}`, lane: `a${k}` });
  return { publishId: `p${k}`, accountId: `a${k}` };
};

const adapterThrowing = (err) => [
  {
    platform: "tiktok",
    publish: "web",
    collect: "web",
    visibility: [],
    draft: false,
    requiresQualification: false,
    minScheduleLeadMs: null,
    maxFileSizeMb: null,
    adapter: { platform: "tiktok", ready: () => null, async publish() { throw err; }, async collect() {} },
  },
];

before(() => core.migrate());

beforeEach(() => {
  db().exec("DELETE FROM publish; DELETE FROM work; DELETE FROM account; DELETE FROM run; DELETE FROM event; DELETE FROM followup;");
});

test("flaky_ui 用尽次数后，发布被交到人手里（notify_pending + fallback_reason）", async () => {
  const { publishId } = seed();
  const handlers = buildHandlers(adapterThrowing(new AdapterError("flaky_ui", "找不到发布按钮")));
  const runner = createRunner({
    handlers,
    maxAttempts: 1,
    onRunFailed: (run, err) => applyTerminalFailure(run.target_id, err),
    log: () => {},
  });
  await runner.tick();

  const row = db().prepare("SELECT state, fallback_reason, error_code FROM publish WHERE id=?").get(publishId);
  assert.equal(row.state, "notify_pending", "队列放弃时不能停在 auto_running");
  assert.equal(row.fallback_reason, "flaky_automation");
  assert.equal(row.error_code, "flaky_ui");
  assert.equal(db().prepare("SELECT state FROM run WHERE target_id=?").get(publishId).state, "failed");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM event WHERE type='publish.needs_human'").get().n, 1);
});

test("auth 第一次就终止：blocked + 账号 expired，不烧退避", async () => {
  const { publishId, accountId } = seed();
  const handlers = buildHandlers(adapterThrowing(new AdapterError("auth", "cookie 过期")));
  const runner = createRunner({ handlers, maxAttempts: 3, log: () => {} });
  await runner.tick();

  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "blocked");
  assert.equal(db().prepare("SELECT state FROM account WHERE id=?").get(accountId).state, "expired");
  // 非重试性失败被处理器消费掉：run 不该再排一次
  assert.notEqual(db().prepare("SELECT state FROM run WHERE target_id=?").get(publishId).state, "queued");
});

test("quota 不计次数，只延后：三次限流不该把一条发布耗成失败", async () => {
  const { publishId } = seed();
  const runner = createRunner({
    handlers: { publish: async () => { throw new AdapterError("quota", "今天发得太频"); } },
    maxAttempts: 3,
    log: () => {},
  });
  await runner.tick();
  const run = db().prepare("SELECT state, attempts, run_after FROM run WHERE target_id=?").get(publishId);
  assert.equal(run.state, "queued");
  assert.equal(run.attempts, 0);
  assert.ok(run.run_after > Date.now() + 20 * 60e3, "配额错误按策略延后 30 分钟");
});

test("普通错误按 1m/5m/30m 退避，第三次才失败", async () => {
  const { publishId } = seed();
  const runner = createRunner({
    handlers: { publish: async () => { throw new Error("socket hang up"); } },
    maxAttempts: 2,
    log: () => {},
  });
  await runner.tick();
  const first = db().prepare("SELECT state, attempts, run_after FROM run WHERE target_id=?").get(publishId);
  assert.equal(first.state, "queued");
  assert.equal(first.attempts, 1);
  assert.ok(first.run_after > Date.now() + 50e3);
});

test("缺处理器是配置错误：直接失败，不重试三次", async () => {
  const { publishId } = seed();
  const runner = createRunner({ handlers: {}, log: () => {} });
  await runner.tick();
  const run = db().prepare("SELECT state, attempts, last_error FROM run WHERE target_id=?").get(publishId);
  assert.equal(run.state, "failed");
  assert.match(run.last_error, /没有注册 publish 处理器/);
});
