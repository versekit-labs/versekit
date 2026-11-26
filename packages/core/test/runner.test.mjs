// The runner loop is the part that can silently lose work, so the tests here are about failure:
// a crashed process, a handler that throws, one account that must not run two jobs at once.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIFABU_HOME = mkdtempSync(join(tmpdir(), "vk-runner-"));

const core = await import("../src/index.mjs");
const { createRunner, MAX_ATTEMPTS, BACKOFF_MS } = await import("../src/runner.mjs");

const db = () => core.open();
let n = 0;

function seedPublish(accountId = "a1") {
  const id = `p${++n}`;
  const workId = `w${n}`;
  db().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?,?,?,?)").run(workId, `t${n}`, "/tmp/a.mp4", Date.now());
  db()
    .prepare("INSERT INTO publish (id, work_id, account_id, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(id, workId, accountId, Date.now(), Date.now());
  return id;
}

before(() => {
  core.migrate();
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a1','tiktok','@x',1)").run();
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a2','bilibili','@y',1)").run();
});

beforeEach(() => {
  db().exec("DELETE FROM run");
});

test("a queued job runs once and ends done", async () => {
  const p = seedPublish();
  core.enqueue({ kind: "publish", targetType: "publish", targetId: p, lane: "a1" });
  let calls = 0;
  const runner = createRunner({ handlers: { publish: async () => { calls++; } }, log: () => {} });
  const started = await runner.tick();
  assert.equal(started, 1);
  assert.equal(calls, 1);
  assert.equal(db().prepare("SELECT state FROM run").get().state, "done");
});

test("a throwing handler requeues with backoff, then fails at MAX_ATTEMPTS", async () => {
  const p = seedPublish();
  const runId = core.enqueue({ kind: "publish", targetType: "publish", targetId: p, lane: "a1" });
  const runner = createRunner({
    handlers: { publish: async () => { throw new Error("平台 500"); } },
    log: () => {},
  });
  await runner.tick();
  let row = db().prepare("SELECT * FROM run WHERE id=?").get(runId);
  assert.equal(row.state, "queued");
  assert.equal(row.attempts, 1);
  assert.ok(row.run_after > Date.now(), "应排到退避之后就绪");
  assert.match(row.last_error, /平台 500/);

  // 让退避立即到期，跑满剩余次数
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    db().prepare("UPDATE run SET run_after=? WHERE id=?").run(0, runId);
    await runner.tick();
  }
  row = db().prepare("SELECT * FROM run WHERE id=?").get(runId);
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, MAX_ATTEMPTS);
  const evt = db().prepare("SELECT type FROM event WHERE type='run.failed'").get();
  assert.ok(evt, "失败要留下事件，否则没人知道");
});

test("one lane never runs two jobs at the same time", async () => {
  seedPublish("a1");
  const p2 = seedPublish("a1");
  core.enqueue({ kind: "publish", targetType: "publish", targetId: p2, lane: "a1" });
  core.enqueue({ kind: "publish", targetType: "publish", targetId: "p_" + n, lane: "a1" });

  let concurrent = 0;
  let max = 0;
  const runner = createRunner({
    concurrency: 5,
    handlers: {
      publish: async () => {
        concurrent++;
        max = Math.max(max, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
      },
    },
    log: () => {},
  });
  await runner.tick();
  assert.equal(max, 1, "同一账号并发跑两个发布 = 风控");
});

test("different lanes do run in parallel", async () => {
  core.enqueue({ kind: "publish", targetType: "publish", targetId: seedPublish("a1"), lane: "a1" });
  core.enqueue({ kind: "publish", targetType: "publish", targetId: seedPublish("a2"), lane: "a2" });
  let concurrent = 0;
  let max = 0;
  const runner = createRunner({
    concurrency: 5,
    handlers: {
      publish: async () => {
        concurrent++;
        max = Math.max(max, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
      },
    },
    log: () => {},
  });
  await runner.tick();
  assert.equal(max, 2);
});

test("an expired lease is recovered instead of the work being lost", async () => {
  const p = seedPublish();
  const runId = core.enqueue({ kind: "publish", targetType: "publish", targetId: p, lane: "a1" });
  // 模拟进程被杀：任务停在 running，租约已过期
  db().prepare("UPDATE run SET state='running', lease_until=? WHERE id=?").run(Date.now() - 1000, runId);
  const runner = createRunner({ handlers: { publish: async () => {} }, log: () => {} });
  await runner.tick();
  const row = db().prepare("SELECT state, attempts FROM run WHERE id=?").get(runId);
  assert.equal(row.state, "done");
  assert.equal(row.attempts, 1);
});

test("run_after in the future keeps the job parked", async () => {
  const p = seedPublish();
  const runId = core.enqueue({ kind: "publish", targetType: "publish", targetId: p, lane: "a1", runAfter: Date.now() + 60_000 });
  const runner = createRunner({ handlers: { publish: async () => {} }, log: () => {} });
  assert.equal(await runner.tick(), 0);
  assert.equal(db().prepare("SELECT state FROM run WHERE id=?").get(runId).state, "queued");
});

test("unknown kinds fail loudly instead of spinning", async () => {
  core.enqueue({ kind: "mystery", targetType: "x", targetId: "y" });
  const runner = createRunner({ handlers: {}, log: () => {} });
  await runner.tick();
  assert.equal(db().prepare("SELECT state FROM run").get().state, "failed");
});

test("backoff schedule is monotonic", () => {
  for (let i = 1; i < BACKOFF_MS.length; i++) assert.ok(BACKOFF_MS[i] > BACKOFF_MS[i - 1]);
});
