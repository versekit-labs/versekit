// bootstrap 聚合与 overview 口径（issue #23；验收 ACC-overview-01 / 02、ACC-matrix-01）。
//
// 钉住四件事：作品数与平台发布数分开算；新鲜度只有一份、账号页与总览共用；
// 跨组矩阵只读且由 core 产出；CLI --json 与 /api/bootstrap 是同一份响应
// （三端一致律 + 验收 §三）。数字对不上的时候先看这里，不要先怀疑页面。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "vk-bootstrap-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const overview = await import("../src/overview.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { findCommand } = await import("../src/commands.mjs");
const { matchRoute } = await import("../src/routes.mjs");
const { startDaemon } = await import("../src/daemon.mjs");

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../../cli/src/vk.mjs", import.meta.url));
const H = 3600e3;
const MIN = 60e3;

let daemon = null;
let handlers = null;
let g1 = null;
let g2 = null;
let xhs = null;
let douyin = null;
let bilibili = null;
let youtube = null;
let tiktok = null;
let w1 = null;
let w2 = null;
let w3 = null;

const db = () => core.open();
const setState = (publishId, state) => db().prepare("UPDATE publish SET state = ? WHERE id = ?").run(state, publishId);
const snapshot = (publishId, capturedAt, source = "public_api", status = "ok") =>
  db()
    .prepare("INSERT INTO snapshot (id, publish_id, captured_at, source, status, metrics_json) VALUES (?,?,?,?,?,?)")
    .run(`snap_${publishId}`, publishId, capturedAt, source, status, JSON.stringify({ views: 1 }));

function publish(workId, accountId) {
  return store.createPublish({ workId, accountId, enqueue: false }).id;
}

before(() => {
  core.migrate();
  handlers = createCoreHandlers();

  // 两个组，当前组是 g1。组列表、矩阵、rollup 都要覆盖到「其他组」。
  g1 = handlers["group.add"]({ name: "主矩阵" });
  g2 = handlers["group.add"]({ name: "剪辑日记" });
  handlers["group.use"]({ group: g1.id });

  xhs = handlers["account.add"]({ platform: "xiaohongshu", name: "主号小红书", group: g1.id }).id;
  douyin = handlers["account.add"]({ platform: "douyin", name: "主号抖音", group: g1.id }).id;
  bilibili = handlers["account.add"]({ platform: "bilibili", name: "主号B站", group: g1.id }).id;
  youtube = handlers["account.add"]({ platform: "youtube", name: "副号YouTube", group: g2.id }).id;
  tiktok = handlers["account.add"]({ platform: "tiktok", name: "副号TikTok", group: g2.id }).id;

  // 小红书账号已失效：即使有旧快照，新鲜度也必须是 bad（不能拿旧数据装新鲜）。
  handlers["account.mode"]({ accountId: xhs, mode: "auto" });
  store.setAccountState(xhs, "expired");

  // w1 是 g1 的双平台作品；w2 跨组（g1 抖音 + g2 YouTube）；w3 只在 g2。
  // 这组数据专门让「作品数」和「平台发布数」不相等，并且各组作品数之和 ≠ 全局作品数。
  const now = Date.now();
  w1 = store.createWork({ title: "作品一", assetPath: "/tmp/w1.mp4" }).id;
  const w1xhs = publish(w1, xhs);
  const w1bili = publish(w1, bilibili);
  w2 = store.createWork({ title: "作品二（跨组）", assetPath: "/tmp/w2.mp4" }).id;
  const w2dy = publish(w2, douyin);
  const w2yt = publish(w2, youtube);
  w3 = store.createWork({ title: "作品三", assetPath: "/tmp/w3.mp4" }).id;
  const w3tt = publish(w3, tiktok);

  setState(w1xhs, "failed");
  setState(w1bili, "published");
  setState(w2dy, "failed");
  setState(w2yt, "published_limited");
  setState(w3tt, "queued");

  snapshot(w1bili, now - 10 * MIN); // 新鲜
  snapshot(w1xhs, now - 3 * 24 * H); // 3 天前；账号已失效 → bad
  snapshot(w2dy, now - 2 * H); // 超过 1 小时 → warn
  snapshot(w2yt, now - 5 * MIN); // 新鲜
  // w3tt 没有快照：unknown，不能算进 fresh
});

after(async () => {
  await daemon?.close();
  core.close();
});

test("bootstrap 同时给出当前组、组列表、账号、新鲜度与计数", () => {
  const data = handlers["bootstrap"]();
  assert.equal(data.current.id, g1.id, "当前组来自 group.use");
  assert.equal(data.groups.length, 2);
  assert.deepEqual(data.groups.map((g) => g.name).sort(), ["主矩阵", "剪辑日记"].sort());
  assert.equal(data.accounts.length, 5, "bootstrap 带全部账号，页面按 current 过滤");
  assert.equal(data.accounts.filter((a) => a.group_id === g1.id).length, 3);
  assert.equal(data.matrix.readOnly, true);
  assert.equal(data.rollup.readOnly, true);
});

test("ACC-overview-01：作品数与平台发布数分开计数，跨组汇总只读", () => {
  const data = handlers["bootstrap"]();

  // g1：w1（2 路）+ w2（1 路）= 2 个作品 / 3 条平台发布；已发布成功只有 w1 的 B 站 1 条。
  assert.equal(data.counts.scope, g1.id);
  assert.equal(data.counts.works, 2);
  assert.equal(data.counts.publishes, 3);
  assert.equal(data.counts.publishedPublishes, 1);
  assert.notEqual(data.counts.works, data.counts.publishes, "两个口径必须能对得上、也必须分得开");

  // 全局：w1/w2/w3 = 3 个作品，5 条平台发布；两组作品数相加是 4，但 w2 跨组只算一个全局作品。
  assert.equal(data.rollup.counts.scope, "all");
  assert.equal(data.rollup.counts.works, 3);
  assert.equal(data.rollup.counts.publishes, 5);
  assert.equal(data.rollup.counts.publishedPublishes, 2);
  assert.equal(data.groups.reduce((n, g) => n + g.counts.works, 0), 4, "组内作品数之和可以大于全局作品数");

  // 数字自带口径：页面不需要再猜 works 和 publishes 分别是什么。
  assert.match(data.counts.definitions.works, /作品数/);
  assert.match(data.counts.definitions.publishes, /平台发布/);
  assert.match(data.counts.definitions.publishedPublishes, /已发布成功/);
  assert.deepEqual(Object.keys(data.counts.byState).sort(), ["failed", "published"], "当前组只有这两种状态");
  assert.deepEqual(Object.keys(data.rollup.counts.byState).sort(), ["failed", "published", "published_limited", "queued"]);
  assert.equal(data.rollup.counts.byState.published, 1);
});

test("ACC-overview-02：新鲜度面板与账号页是同一份对象", () => {
  const data = handlers["bootstrap"]();
  const accountList = handlers["account.list"]({ group: g1.id }).accounts;
  const fromBootstrap = data.accounts.filter((a) => a.group_id === g1.id);

  assert.deepEqual(fromBootstrap.map((a) => a.id), accountList.map((a) => a.id));
  assert.deepEqual(fromBootstrap.map((a) => a.freshness), accountList.map((a) => a.freshness), "两个接口不能各算一次新鲜度");

  assert.equal(data.freshness.total, 3);
  assert.equal(data.freshness.fresh, 1, "B 站 10 分钟前采集");
  assert.equal(data.freshness.stale, 1, "抖音 2 小时前采集");
  assert.equal(data.freshness.failing, 1, "小红书账号已失效");
  assert.equal(data.freshness.unknown, 0);
  assert.equal(data.freshness.ratio, "1/3");

  // 摘要必须等于同一批账号的 level 计数，而不是另一套判断。
  const levels = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const account of accountList) levels[account.freshness.level] += 1;
  assert.deepEqual(
    { fresh: data.freshness.fresh, stale: data.freshness.stale, failing: data.freshness.failing, unknown: data.freshness.unknown },
    { fresh: levels.ok, stale: levels.warn, failing: levels.bad, unknown: levels.unknown },
  );

  // 全局新鲜度：ff=YouTube 新鲜、tt=unknown；xhs 的 expired 优先于旧快照。
  assert.equal(data.rollup.freshness.total, 5);
  assert.equal(data.rollup.freshness.fresh, 2);
  assert.equal(data.rollup.freshness.failing, 1);
  assert.equal(data.rollup.freshness.unknown, 1);
});

test("ACC-matrix-01：跨组只读矩阵由 core 产出，五列固定", () => {
  const data = handlers["bootstrap"]();
  assert.equal(data.matrix.readOnly, true);
  assert.deepEqual(data.matrix.columns.map((c) => c.platform), ["xiaohongshu", "douyin", "bilibili", "youtube", "tiktok"]);
  assert.deepEqual(data.matrix.totals, { groups: 2, accounts: 5 });

  const main = data.matrix.groups.find((g) => g.id === g1.id);
  assert.equal(main.filled, 3);
  assert.equal(main.slots, 5);
  const xhsCell = main.cells.find((c) => c.platform === "xiaohongshu");
  assert.equal(xhsCell.filled, true);
  assert.equal(xhsCell.account.handle, "主号小红书");
  assert.equal(xhsCell.account.freshness.level, "bad", "矩阵里的状态与账号页同源");

  const other = data.matrix.groups.find((g) => g.id === g2.id);
  assert.equal(other.filled, 2);
  assert.equal(other.cells.find((c) => c.platform === "douyin").filled, false, "未接入的槽位明确留空");
  assert.equal(data.matrix.groups.every((g) => g.cells.length === 5), true);
});

test("无当前组时 counts 不会把全部组冒充成当前组（ACC-groups-01 首屏）", () => {
  const conn = db();
  const previous = conn.prepare("SELECT value FROM meta WHERE key = 'current_group'").get().value;
  conn.prepare("UPDATE meta SET value = 'grp_missing' WHERE key = 'current_group'").run();
  try {
    const data = handlers["bootstrap"]();
    assert.equal(data.current, null);
    assert.equal(data.counts.scope, null);
    assert.equal(data.counts.works, 0);
    assert.equal(data.counts.publishes, 0);
    assert.deepEqual(data.counts.byState, {});
    assert.equal(data.freshness.total, 0);
    assert.equal(data.rollup.counts.works, 3, "跨组汇总仍然是真实的 3 个作品");
  } finally {
    conn.prepare("UPDATE meta SET value = ? WHERE key = 'current_group'").run(previous);
  }
});

test("bootstrap 已在命令表注册，HTTP 路由由命令表派生（三端一致律）", () => {
  const command = findCommand("bootstrap");
  assert.ok(command, "commands.mjs 里必须先有 bootstrap");
  assert.deepEqual(command.http, { method: "GET", path: "/api/bootstrap" });
  assert.equal(command.remote, false);
  assert.deepEqual(command.args, {});
  assert.deepEqual(matchRoute("GET", "/api/bootstrap"), { command: "bootstrap", params: {} });
  assert.equal(matchRoute("POST", "/api/bootstrap"), null, "读接口不该接受 POST");
});

test("CLI --json 与 /api/bootstrap 返回完全一致（验收 §三）", async () => {
  daemon = await startDaemon({
    handlers,
    runQueue: false,
    port: 0,
    socketPath: core.paths().socket,
  });

  const viaHttp = await (await fetch(`http://127.0.0.1:${daemon.port}/api/bootstrap`)).json();
  const { stdout } = await execFileAsync(process.execPath, [CLI, "bootstrap"], {
    env: { ...process.env, VK_HOME: HOME },
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const viaCli = JSON.parse(stdout);

  // 同一份 handler、同一份快照；响应里不放当前时间，所以两次调用可以逐字段相等。
  assert.deepEqual(viaCli, viaHttp);
  assert.equal(viaHttp.ok, true);
  assert.equal(viaHttp.counts.works, handlers["bootstrap"]().counts.works);
});

test("bootstrap 不含易变时间戳，重复读的数字稳定", () => {
  const a = handlers["bootstrap"]();
  const b = handlers["bootstrap"]();
  assert.deepEqual(a, b, "没有 now / ageMs 这类每次调用都变的字段，CLI 与 HTTP 才能逐字段对照");
  assert.equal(overview.FRESH_AFTER_MS, 3600e3);
});
