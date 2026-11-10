// issue #22 / docs/design/ACCEPTANCE.md：
//   ACC-publish-01 只列当前组账号；已失效的不可选并说明原因
//   ACC-publish-03 发布后生成 work + 多条 publish，状态可查
//   ACC-runs-02   重试有上限；不静默放弃
//
// 这些断言刻意从 handler 层进入：CLI、HTTP、卡片都调用同一组 handler，组作用域与失效判定
// 只要在这里钉住一次，三端就不会各写一套「悄悄跳过」。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-publish-group-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { startDaemon } = await import("../src/daemon.mjs");
const { createRunner, MAX_ATTEMPTS } = await import("../src/runner.mjs");
const { applyTerminalFailure, recordSnapshot } = await import("../src/publish-flow.mjs");
const { AdapterError } = await import("../src/errors.mjs");

const db = () => core.open();
const asset = join(HOME, "asset.mp4");
writeFileSync(asset, "fake video");

// publish.create 只检查「有没有适配器」；这里用最小形状，不启动浏览器。
const ADAPTERS = ["tiktok", "bilibili", "xiaohongshu"].map((platform) => ({ platform }));
const handlers = createCoreHandlers({ adapters: ADAPTERS, log: () => {} });

const count = (sql, ...params) => db().prepare(sql).get(...params).n;

let daemon = null;
before(() => core.migrate());
after(async () => {
  await daemon?.close();
  core.close();
});

// ---------------------------------------------------------------- ACC-publish-01

test("ACC-publish-01：默认只取当前组账号；失效账号不可选并返回原因", () => {
  const main = handlers["group.add"]({ name: "ACC01 主矩阵" });
  const mainTt = handlers["account.add"]({ platform: "tiktok", name: "@acc01-main-tt", group: main.name }).id;
  const mainBili = handlers["account.add"]({ platform: "bilibili", name: "@acc01-main-bili", group: main.name }).id;

  const side = handlers["group.add"]({ name: "ACC01 副矩阵" });
  handlers["account.add"]({ platform: "tiktok", name: "@acc01-side-tt", group: side.name });

  // 当前组是「副矩阵」：不带 --group 时只能选副矩阵的 tiktok，不能顺带发主矩阵的号。
  const current = handlers["publish.create"]({ asset, to: ["tiktok"] });
  assert.deepEqual(current.group, { id: side.id, name: side.name }, "响应要告诉调用方实际用了哪个组");
  assert.equal(current.publishes.length, 1, "只列当前组账号");
  assert.equal(current.publishes[0].handle, "@acc01-side-tt");

  // 当前组没有 bilibili：明确报错，不静默跳过，也不去别的组借账号。
  assert.throws(
    () => handlers["publish.create"]({ asset, to: ["bilibili"] }),
    /账号组「ACC01 副矩阵」里没有 bilibili 账号/,
    "跨组不能偷偷借号：必须说清当前组缺什么",
  );

  // 显式 --group 才切换作用域。
  const explicit = handlers["publish.create"]({ asset, to: ["bilibili"], group: main.name });
  assert.deepEqual(explicit.group, { id: main.id, name: main.name });
  assert.equal(explicit.publishes[0].handle, "@acc01-main-bili");

  // 登录过期：不可选，原因里要有账号与重登命令。
  store.setAccountState(mainTt, "expired");
  assert.throws(
    () => handlers["publish.create"]({ asset, to: ["tiktok"], group: main.name }),
    (err) =>
      /已失效（登录过期）/.test(err.message) &&
      /@acc01-main-tt/.test(err.message) &&
      new RegExp(`vk account reauth ${mainTt}`).test(err.message),
    "expired 账号必须返回可执行原因",
  );

  // 封禁：同样不可选，原因不同。
  store.setAccountState(mainBili, "banned");
  assert.throws(
    () => handlers["publish.create"]({ asset, to: ["bilibili"], group: main.name }),
    /已失效（被平台封禁）/,
  );

  // 预演也必须遵守同一套选择规则：不能「预演说能发，真发才报错」。
  assert.throws(() => handlers["publish.create"]({ asset, to: ["tiktok"], group: main.name, dryRun: true }), /已失效/);
});

test("ACC-publish-01：预演也只列当前组账号，且不写库", () => {
  const g = handlers["group.add"]({ name: "ACC01 预演组" });
  handlers["account.add"]({ platform: "tiktok", name: "@acc01-dry-tt", group: g.name });
  handlers["account.add"]({ platform: "xiaohongshu", name: "@acc01-dry-xhs", group: g.name });

  const worksBefore = count("SELECT COUNT(*) n FROM work");
  const publishesBefore = count("SELECT COUNT(*) n FROM publish");
  const dry = handlers["publish.create"]({ asset, to: ["tiktok", "xiaohongshu"], title: "预演一条", dryRun: true });

  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.group, { id: g.id, name: g.name });
  assert.deepEqual(dry.publishes.map((p) => p.platform).sort(), ["tiktok", "xiaohongshu"]);
  assert.deepEqual(dry.publishes.map((p) => p.handle).sort(), ["@acc01-dry-tt", "@acc01-dry-xhs"]);
  assert.equal(count("SELECT COUNT(*) n FROM work"), worksBefore, "预演不写 work");
  assert.equal(count("SELECT COUNT(*) n FROM publish"), publishesBefore, "预演不写 publish");
});

// ---------------------------------------------------------------- ACC-publish-03

test("ACC-publish-03：发布后生成 work + 多条 publish，状态可查", () => {
  const g = handlers["group.add"]({ name: "ACC03 发布组" });
  handlers["account.add"]({ platform: "tiktok", name: "@acc03-tt", group: g.name });
  handlers["account.add"]({ platform: "bilibili", name: "@acc03-bili", group: g.name });

  const worksBefore = count("SELECT COUNT(*) n FROM work");
  const created = handlers["publish.create"]({ asset, to: ["tiktok", "bilibili"], title: "一条作品多平台" });

  assert.equal(created.publishes.length, 2, "一条内容 → 两条平台发布");
  assert.equal(count("SELECT COUNT(*) n FROM work"), worksBefore + 1, "必须生成了且只生成一个 work");

  const work = store.getWork(created.workId);
  assert.equal(work.title, "一条作品多平台");
  assert.equal(work.asset_path, asset);

  const rows = db().prepare("SELECT id, state, work_id FROM publish WHERE work_id = ? ORDER BY account_id").all(created.workId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.work_id === created.workId));
  assert.ok(rows.every((r) => r.state === "queued"), "新建发布从 queued 开始");
  assert.deepEqual(new Set(rows.map((r) => r.id)), new Set(created.publishes.map((p) => p.publishId)));

  // 每条 publish 都有对应的队列任务，lane 指向账号：发布不是「写一行就算完」。
  for (const p of created.publishes) {
    const run = db().prepare("SELECT state, lane FROM run WHERE kind='publish' AND target_id=?").get(p.publishId);
    assert.ok(run, `${p.platform} 要入队`);
    assert.equal(run.state, "queued");
    const pub = store.getPublish(p.publishId);
    assert.equal(run.lane, pub.account_id);
  }

  // 状态可查：publish.list / stats.works 都从同一张表读。
  const queued = handlers["publish.list"]({ state: "queued" }).rows;
  assert.ok(queued.some((r) => r.id === created.publishes[0].publishId), "publish.list 能看到刚建的发布");

  // 状态迁移只走 transitionPublish，然后按组查指标。
  const publishId = created.publishes[0].publishId;
  core.transitionPublish(publishId, "auto_running");
  core.transitionPublish(publishId, "published");

  const published = handlers["publish.list"]({ state: "published" }).rows;
  const row = published.find((r) => r.id === publishId);
  assert.ok(row, "发布成功后状态可查");
  assert.equal(row.title, "一条作品多平台");

  const stats = handlers["stats.works"]({ group: g.name });
  assert.deepEqual(stats.group, { id: g.id, name: g.name });
  const stat = stats.rows.find((r) => r.publishId === publishId);
  assert.ok(stat, "按组查指标能看到这条发布");
  assert.equal(stat.state, "published");
});

test("ACC-publish-03：定时发布写 scheduled_at，队列任务也等这个时间", () => {
  const g = handlers["group.add"]({ name: "ACC03 定时组" });
  handlers["account.add"]({ platform: "bilibili", name: "@acc03-sched", group: g.name });
  const at = Date.now() + 3600e3;
  const created = handlers["publish.create"]({ asset, to: ["bilibili"], title: "定时一条", schedule: at });

  const pub = store.getPublish(created.publishes[0].publishId);
  assert.equal(pub.scheduled_at, at);
  assert.equal(db().prepare("SELECT run_after FROM run WHERE target_id=?").get(pub.id).run_after, at);
});

// ---------------------------------------------------------------- stats.works --group

test("stats.works --group 只返回该组数据；不存在的组给人话", () => {
  const a = handlers["group.add"]({ name: "ACC-stats A" });
  handlers["account.add"]({ platform: "tiktok", name: "@acc-stats-a", group: a.name });
  const pa = handlers["publish.create"]({ asset, to: ["tiktok"], title: "A 组作品" }).publishes[0].publishId;
  core.transitionPublish(pa, "auto_running");
  core.transitionPublish(pa, "published");
  recordSnapshot({ publishId: pa, source: "api", status: "ok", metrics: { play: 11 }, capturedAt: 1 });

  const b = handlers["group.add"]({ name: "ACC-stats B" });
  handlers["account.add"]({ platform: "tiktok", name: "@acc-stats-b", group: b.name });
  const pb = handlers["publish.create"]({ asset, to: ["tiktok"], title: "B 组作品" }).publishes[0].publishId;
  core.transitionPublish(pb, "auto_running");
  core.transitionPublish(pb, "published");
  recordSnapshot({ publishId: pb, source: "api", status: "ok", metrics: { play: 22 }, capturedAt: 2 });

  const onlyA = handlers["stats.works"]({ group: a.name });
  assert.equal(onlyA.rows.length, 1, "只返回 A 组");
  assert.equal(onlyA.rows[0].publishId, pa);
  assert.equal(onlyA.rows[0].latest.metrics.play, 11);

  const all = handlers["stats.works"]({});
  assert.ok(all.rows.some((r) => r.publishId === pa));
  assert.ok(all.rows.some((r) => r.publishId === pb));

  assert.throws(() => handlers["stats.works"]({ group: "没有这个组" }), /没有这个账号组/);
});

// ---------------------------------------------------------------- run.list --group

test("run.list --group 按账号组过滤，publish 与 check 任务都能归组", () => {
  const a = handlers["group.add"]({ name: "ACC-runs-list A" });
  const accA = handlers["account.add"]({ platform: "bilibili", name: "@acc-runs-list-a", group: a.name }).id;
  const pa = handlers["publish.create"]({ asset, to: ["bilibili"], title: "A 组队列" }).publishes[0].publishId;
  const checkA = core.enqueue({ kind: "check", targetType: "account", targetId: accA, lane: accA });

  const b = handlers["group.add"]({ name: "ACC-runs-list B" });
  handlers["account.add"]({ platform: "bilibili", name: "@acc-runs-list-b", group: b.name });
  const pb = handlers["publish.create"]({ asset, to: ["bilibili"], title: "B 组队列" }).publishes[0].publishId;

  const onlyA = handlers["run.list"]({ group: a.name });
  assert.deepEqual(onlyA.group, { id: a.id, name: a.name });
  const targetsA = new Set(onlyA.rows.map((r) => r.target_id));
  assert.ok(targetsA.has(pa), "publish 任务按 publish → account 归组");
  assert.ok(targetsA.has(accA), "check 任务按 account 直接归组");
  assert.equal(targetsA.has(pb), false, "不能混进 B 组");

  const onlyB = handlers["run.list"]({ group: b.name });
  assert.deepEqual(onlyB.rows.map((r) => r.target_id), [pb]);

  assert.equal(onlyA.retry_limit, MAX_ATTEMPTS);
  for (const r of onlyA.rows) {
    assert.equal(r.max_attempts, MAX_ATTEMPTS);
    assert.equal(r.attempts_left, MAX_ATTEMPTS - r.attempts);
  }
  assert.throws(() => handlers["run.list"]({ group: "没有这个组" }), /没有这个账号组/);
  assert.ok(checkA);
});

// ---------------------------------------------------------------- ACC-runs-02

test("ACC-runs-02：自动重试到上限就失败，转 notify 并留事件，不静默放弃", async () => {
  const g = handlers["group.add"]({ name: "ACC-runs-retry" });
  const accountId = handlers["account.add"]({ platform: "tiktok", name: "@acc-runs-retry", group: g.name }).id;
  const publishId = handlers["publish.create"]({ asset, to: ["tiktok"], title: "会失败的一条" }).publishes[0].publishId;

  // 把其他测试留下的队列清掉，保证 runner 只处理这一条；重排本条的 run。
  db().prepare("DELETE FROM run").run();
  const runId = core.enqueue({ kind: "publish", targetType: "publish", targetId: publishId, lane: accountId });

  let calls = 0;
  const runner = createRunner({
    handlers: {
      publish: async () => {
        calls++;
        throw new AdapterError("flaky_ui", "找不到发布按钮");
      },
    },
    maxAttempts: MAX_ATTEMPTS,
    onRunFailed: (run, err) => applyTerminalFailure(run.target_id, err),
    log: () => {},
  });

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await runner.tick();
    if (i < MAX_ATTEMPTS - 1) db().prepare("UPDATE run SET run_after=0 WHERE id=?").run(runId);
  }

  const run = db().prepare("SELECT state, attempts, last_error FROM run WHERE id=?").get(runId);
  assert.equal(calls, MAX_ATTEMPTS, "上限到了就不该再调用适配器");
  assert.equal(run.state, "failed");
  assert.equal(run.attempts, MAX_ATTEMPTS, "尝试次数停在 MAX_ATTEMPTS");
  assert.match(run.last_error, /找不到发布按钮/, "失败现场要留平台原文");

  const publish = store.getPublish(publishId);
  assert.equal(publish.state, "notify_pending", "队列放弃后发布不能停在 running/queued");
  assert.equal(publish.fallback_reason, "flaky_automation");
  assert.equal(publish.error_code, "flaky_ui");

  const events = db().prepare("SELECT type FROM event WHERE type IN ('run.failed','publish.needs_human')").all().map((e) => e.type);
  assert.ok(events.includes("run.failed"), "队列失败要留事件");
  assert.ok(events.includes("publish.needs_human"), "要叫人，不是静默放弃");

  // 已经 failed 的 run 不会再被 tick 捞起来：上限是硬上限，不是「再试一次」。
  await runner.tick();
  assert.equal(calls, MAX_ATTEMPTS);

  const listed = handlers["run.list"]({ state: "failed" });
  const row = listed.rows.find((r) => r.id === runId);
  assert.equal(listed.retry_limit, MAX_ATTEMPTS);
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.attempts_left, 0);
});

// ---------------------------------------------------------------- HTTP：由命令表派生

test("HTTP：publish.create / stats.works / run.list 的 --group 来自同一条命令表", async () => {
  const g = handlers["group.add"]({ name: "ACC-http 组" });
  handlers["account.add"]({ platform: "xiaohongshu", name: "@acc-http-xhs", group: g.name });

  daemon = await startDaemon({ runQueue: false, port: 0, socketPath: join(HOME, `vk-${Date.now()}.sock`), handlers });
  const base = `http://127.0.0.1:${daemon.port}`;
  const post = (path, body) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    const created = await post("/api/publishes", { asset, to: ["xiaohongshu"], group: g.name, title: "HTTP 一条" });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.group.id, g.id);
    assert.equal(body.publishes.length, 1);
    const publishId = body.publishes[0].publishId;

    const stats = await (await fetch(`${base}/api/stats/works?group=${encodeURIComponent(g.name)}`)).json();
    assert.equal(stats.group.id, g.id);
    assert.ok(stats.rows.some((r) => r.publishId === publishId));

    const runs = await (await fetch(`${base}/api/runs?group=${encodeURIComponent(g.name)}`)).json();
    assert.equal(runs.group.id, g.id);
    assert.ok(runs.rows.some((r) => r.target_id === publishId));

    const bad = await (await fetch(`${base}/api/runs?group=${encodeURIComponent("没有这个组")}`)).json();
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /没有这个账号组/);
  } finally {
    await daemon.close();
    daemon = null;
  }
});
