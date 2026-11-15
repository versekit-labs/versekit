// issue #74 / docs/design/ACCEPTANCE.md：
//   ACC-publish-04 素材类型与平台能力不匹配时在创建前拒绝并说人话
//   ACC-publish-05 auto_running 有总时限，超时转 failed（error_code=timeout），不留无声卡死
//   ACC-runs-02   重试有上限；不静默放弃（超时要把 run 标成失败，任务页才有重试入口）
//
// 复现方式是工单要求的「假适配器永远不返回」：不发真请求、不启动浏览器、不写用户库。

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-publish-safety-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const { buildHandlers } = await import("../src/adapters.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { createRunner } = await import("../src/runner.mjs");
const { applyTerminalFailure, sweepStuckPublishes, getPublishRow } = await import("../src/publish-flow.mjs");
const { validateAdapter } = await import("../src/contract.mjs");
const { publishTimeoutMs, DEFAULT_PUBLISH_TIMEOUT_MS } = await import("../src/config.mjs");

const db = () => core.open();
let n = 0;

const count = () => db().prepare("SELECT (SELECT COUNT(*) FROM publish) AS publishes, (SELECT COUNT(*) FROM work) AS works").get();

before(() => core.migrate());
beforeEach(() => {
  db().exec("DELETE FROM publish; DELETE FROM work; DELETE FROM account; DELETE FROM run; DELETE FROM event; DELETE FROM followup;");
});

function seed({ state = "queued", platform = "xiaohongshu", asset = "/tmp/a.mp4" } = {}) {
  const k = ++n;
  const now = Date.now();
  db().prepare("INSERT INTO work (id,title,asset_path,created_at) VALUES (?,?,?,?)").run(`w${k}`, `t${k}`, asset, now);
  db().prepare("INSERT INTO account (id,platform,handle,created_at) VALUES (?,?,?,?)").run(`a${k}`, platform, `@h${k}`, now);
  db().prepare("INSERT INTO publish (id,work_id,account_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(`p${k}`, `w${k}`, `a${k}`, state, now, now);
  return { publishId: `p${k}`, accountId: `a${k}` };
}

const adapterThatNeverReturns = (hooks = {}) => [
  {
    platform: "xiaohongshu",
    publish: "web",
    collect: "none",
    visibility: [],
    draft: false,
    requiresQualification: false,
    assetTypes: ["video"],
    adapter: {
      platform: "xiaohongshu",
      ready: () => null,
      async publish(input) {
        hooks.signal = input.signal;
        input.onStep?.("等待视频上传完成");
        return new Promise(() => {}); // 页面停在「上传视频」，文件根本没传：永远不 settle
      },
    },
  },
];

// ---------------------------------------------------------------- ACC-publish-05

test("ACC-publish-05：适配器永不返回时超时转 failed，原因里带停在哪一步", async () => {
  const { publishId, accountId } = seed();
  core.enqueue({ kind: "publish", targetType: "publish", targetId: publishId, lane: accountId });
  const hooks = {};
  const handlers = buildHandlers(adapterThatNeverReturns(hooks), { publishTimeoutMs: 40 });
  const runner = createRunner({
    handlers,
    log: () => {},
    onRunFailed: (run, err) => applyTerminalFailure(run.target_id, err),
  });

  await runner.tick();

  const row = getPublishRow(publishId);
  assert.equal(row.state, "failed", "不能停在 auto_running");
  assert.equal(row.error_code, "timeout");
  assert.match(row.error_message, /没有结果（停在「等待视频上传完成」）/, "人话要说清停在哪一步");
  assert.ok(hooks.signal?.aborted, "超时要 abort 适配器：它据此关闭为这次发布打开的浏览器");

  const run = db().prepare("SELECT state, last_error FROM run WHERE target_id=?").get(publishId);
  assert.equal(run.state, "failed", "run 也要失败：任务页靠它显示错误并提供重试入口（ACC-runs-02）");
  assert.match(run.last_error, /超时|超过/);
});

test("视频照常：适配器按时返回时发布成功，不受超时逻辑影响", async () => {
  const { publishId, accountId } = seed();
  core.enqueue({ kind: "publish", targetType: "publish", targetId: publishId, lane: accountId });
  const adapters = [
    {
      platform: "xiaohongshu",
      publish: "web",
      collect: "none",
      visibility: [],
      draft: false,
      requiresQualification: false,
      assetTypes: ["video"],
      adapter: {
        platform: "xiaohongshu",
        ready: () => null,
        async publish() {
          return { id: "note1", url: "https://example.test/note1", visibility: "public", state: "published", followups: [] };
        },
      },
    },
  ];
  const runner = createRunner({ handlers: buildHandlers(adapters, { publishTimeoutMs: 500 }), log: () => {} });
  await runner.tick();

  const row = getPublishRow(publishId);
  assert.equal(row.state, "published");
  assert.equal(row.external_id, "note1");
});

test("默认 5 分钟总时限，可用环境变量配置", () => {
  assert.equal(DEFAULT_PUBLISH_TIMEOUT_MS, 5 * 60e3);
  const previous = process.env.VK_PUBLISH_TIMEOUT_MS;
  try {
    process.env.VK_PUBLISH_TIMEOUT_MS = "1234";
    assert.equal(publishTimeoutMs(), 1234);
    process.env.VK_PUBLISH_TIMEOUT_MS = "oops";
    assert.equal(publishTimeoutMs(), DEFAULT_PUBLISH_TIMEOUT_MS, "配错了退回默认值，而不是变成永不超时");
    delete process.env.VK_PUBLISH_TIMEOUT_MS;
    assert.equal(publishTimeoutMs(), DEFAULT_PUBLISH_TIMEOUT_MS);
  } finally {
    if (previous === undefined) delete process.env.VK_PUBLISH_TIMEOUT_MS;
    else process.env.VK_PUBLISH_TIMEOUT_MS = previous;
  }
});

test("ACC-publish-05：没有活 run 的 auto_running 也会被总时限收掉（进程崩过也不留无声卡死）", () => {
  const { publishId } = seed({ state: "auto_running" });
  db().prepare("UPDATE publish SET updated_at=? WHERE id=?").run(Date.now() - 10 * 60e3, publishId);

  const { failed } = sweepStuckPublishes({ timeoutMs: 5 * 60e3 });
  assert.deepEqual(failed, [publishId]);

  const row = getPublishRow(publishId);
  assert.equal(row.state, "failed");
  assert.equal(row.error_code, "timeout");
  assert.match(row.error_message, /5 分钟没有推进/);
});

test("ACC-publish-05：还有活 run 的行不跟正在返回的适配器抢状态", () => {
  const { publishId, accountId } = seed({ state: "auto_running" });
  db().prepare("UPDATE publish SET updated_at=? WHERE id=?").run(Date.now() - 10 * 60e3, publishId);
  core.enqueue({ kind: "publish", targetType: "publish", targetId: publishId, lane: accountId });
  const runId = db().prepare("SELECT id FROM run WHERE target_id=?").get(publishId).id;
  db().prepare("UPDATE run SET state='running', lease_until=? WHERE id=?").run(Date.now() + 60e3, runId);

  const { failed } = sweepStuckPublishes({ timeoutMs: 5 * 60e3 });
  assert.deepEqual(failed, [], "有活 run 时超时由 handler 的定时器负责");
  assert.equal(getPublishRow(publishId).state, "auto_running");
});

// ---------------------------------------------------------------- ACC-publish-04

test("ACC-publish-04：图片素材发小红书在创建前被拒绝，且不留下任何行", () => {
  const png = join(HOME, "01_pier_landing.png");
  const mp4 = join(HOME, "clip.mp4");
  writeFileSync(png, "fake image");
  writeFileSync(mp4, "fake video");

  const handlers = createCoreHandlers({ adapters: [{ platform: "xiaohongshu", assetTypes: ["video"] }], log: () => {} });
  handlers["group.add"]({ name: "ACC04 测试探针" });
  handlers["account.add"]({ platform: "xiaohongshu", name: "@测试", group: "ACC04 测试探针" });
  const before = count();

  assert.throws(
    () => handlers["publish.create"]({ asset: png, to: ["xiaohongshu"] }),
    (err) => /小红书目前只能发视频/.test(err.message) && /01_pier_landing\.png/.test(err.message) && /没有创建/.test(err.message),
    "要告诉人平台只能发视频、选中了什么、这条没有创建",
  );
  assert.throws(
    () => handlers["publish.create"]({ asset: png, to: ["xiaohongshu"], dryRun: true }),
    /只能发视频/,
    "预演也要提前说清楚，而不是等真发才失败",
  );
  assert.deepEqual(count(), before, "被拒绝的发布不能留下 work / publish 行");

  const ok = handlers["publish.create"]({ asset: mp4, to: ["xiaohongshu"], title: "视频照常" });
  assert.equal(ok.publishes.length, 1, "视频照常创建");
  assert.equal(getPublishRow(ok.publishes[0].publishId).state, "queued");
});

// ---------------------------------------------------------------- ACC-publish-06（多图口径）

const xhsBoth = () => [{ platform: "xiaohongshu", assetTypes: ["video", "image"] }];

test("ACC-publish-06：图集（目录 = 1–18 张图片）在创建前放行，work 记住目录", () => {
  const dir = join(HOME, "note-two-images");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2-blue.png"), "fake image");
  writeFileSync(join(dir, "01-red.png"), "fake image");

  const handlers = createCoreHandlers({ adapters: xhsBoth(), log: () => {} });
  handlers["group.add"]({ name: "ACC06 图文探针" });
  handlers["account.add"]({ platform: "xiaohongshu", name: "@测试", group: "ACC06 图文探针" });

  const ok = handlers["publish.create"]({ asset: dir, to: ["xiaohongshu"], title: "两张图", body: "正文", tags: ["测试"] });
  assert.equal(ok.publishes.length, 1, "图片发小红书不再被拒");
  const work = db().prepare("SELECT asset_path FROM work WHERE id=?").get(ok.workId);
  assert.equal(work.asset_path, dir, "目录就是图集：不改 schema，asset_path 直接指向目录");
});

test("ACC-publish-06：同一作品图片与视频混装时创建前拒绝并说人话，不留任何行", () => {
  const dir = join(HOME, "note-mixed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-red.png"), "fake image");
  writeFileSync(join(dir, "clip.mp4"), "fake video");

  const handlers = createCoreHandlers({ adapters: xhsBoth(), log: () => {} });
  handlers["group.add"]({ name: "ACC06 混装探针" });
  handlers["account.add"]({ platform: "xiaohongshu", name: "@测试", group: "ACC06 混装探针" });
  const before = count();

  assert.throws(
    () => handlers["publish.create"]({ asset: dir, to: ["xiaohongshu"] }),
    (err) => /不能把图片和视频混在一起/.test(err.message) && /图文发一组图片，视频发一个文件/.test(err.message) && /没有创建/.test(err.message),
    "混选必须在创建前拒绝，而不是交给适配器打开浏览器后才发现",
  );
  assert.throws(() => handlers["publish.create"]({ asset: dir, to: ["xiaohongshu"], dryRun: true }), /混在一起/, "预演同样适用");
  assert.deepEqual(count(), before, "被拒绝的发布不能留下 work / publish 行");
});

test("ACC-publish-06：图集最多 18 张，19 张在创建前拒绝", () => {
  const dir = join(HOME, "note-too-many");
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 19; i++) writeFileSync(join(dir, `img-${String(i).padStart(2, "0")}.png`), "fake image");

  const handlers = createCoreHandlers({ adapters: xhsBoth(), log: () => {} });
  handlers["group.add"]({ name: "ACC06 超量探针" });
  handlers["account.add"]({ platform: "xiaohongshu", name: "@测试", group: "ACC06 超量探针" });
  assert.throws(() => handlers["publish.create"]({ asset: dir, to: ["xiaohongshu"] }), /最多 18 张/);
});

test("空目录与多视频目录也在创建前拒绝（不把空目录当成 0 张图文发出去）", () => {
  const empty = join(HOME, "note-empty");
  mkdirSync(empty, { recursive: true });
  const twoVideos = join(HOME, "note-two-videos");
  mkdirSync(twoVideos, { recursive: true });
  writeFileSync(join(twoVideos, "a.mp4"), "fake video");
  writeFileSync(join(twoVideos, "b.mp4"), "fake video");

  const handlers = createCoreHandlers({ adapters: xhsBoth(), log: () => {} });
  handlers["group.add"]({ name: "ACC06 空目录探针" });
  handlers["account.add"]({ platform: "xiaohongshu", name: "@测试", group: "ACC06 空目录探针" });
  assert.throws(() => handlers["publish.create"]({ asset: empty, to: ["xiaohongshu"] }), /目录是空的/);
  assert.throws(() => handlers["publish.create"]({ asset: twoVideos, to: ["xiaohongshu"] }), /视频作品只能放一个视频文件/);
});

// ---------------------------------------------------------------- 能力声明

test("assetTypes：合法声明可加载；空数组和未知值直接报错，不静默吞掉", () => {
  const base = { platform: "probe", ready: () => null, async publish() {} };

  const declared = validateAdapter({ ...base, capabilities: { publish: "web", collect: "none", assetTypes: ["video"] } });
  assert.deepEqual(declared.assetTypes, ["video"]);

  const loose = validateAdapter({ ...base, capabilities: { publish: "web", collect: "none" } });
  assert.equal(loose.assetTypes, null, "没声明 = 不限制（旧适配器兼容）");

  assert.throws(() => validateAdapter({ ...base, capabilities: { publish: "web", collect: "none", assetTypes: [] } }), /空数组/);
  assert.throws(() => validateAdapter({ ...base, capabilities: { publish: "web", collect: "none", assetTypes: ["audio"] } }), /未知值/);
});