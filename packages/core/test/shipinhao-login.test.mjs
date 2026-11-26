// 视频号的登录：量登录能撑多久、只在需要时查、过期提醒（ACC-shipinhao-03/04/05/06 的 core 一侧）。
//
// 假时钟 + stub 适配器，不起浏览器、不碰平台。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-sph-core-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { AdapterError } = await import("../src/errors.mjs");
const { checkAccount, buildHandlers } = await import("../src/adapters.mjs");
const { validateAdapter } = await import("../src/contract.mjs");
const overview = await import("../src/overview.mjs");
const sched = await import("../src/scheduler.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { findCommand } = await import("../src/commands.mjs");

const db = () => core.open();
const H = 3600e3;
const T0 = Date.UTC(2026, 10, 21, 9, 0, 0); // 假时钟的起点
let seq = 0;

before(() => core.migrate());

function account(platform = "shipinhao") {
  const k = ++seq;
  const group = store.addGroup({ name: `视频号组 ${k}` });
  return { groupId: group.id, id: store.addAccount({ platform, handle: `@sph${k}`, groupId: group.id }).id };
}
const stubAdapter = (state) => [{ platform: "shipinhao", adapter: { check: async () => (typeof state === "function" ? state() : state) } }];
const checkAt = (id, adapters, at) => checkAccount(adapters, id, { now: () => at });
const clockOf = (id, now) => overview.loginClockOf(store.getAccount(id), now);
const results = (id) => overview.loginRecords(id);

// ---------------------------------------------------------------- ACC-shipinhao-04 量登录能撑多久

test("ACC-shipinhao-04 登录时长：这次登录已 X 小时、最近几次平均撑 Y 小时；不足一次完整记录显示「还在记录」（假时钟）", async () => {
  const { id } = account();
  const ok = stubAdapter({ state: "ok" });
  const gone = stubAdapter({ state: "expired", detail: "视频号登录过期了，请重新扫码" });

  await checkAt(id, ok, T0);
  assert.equal(clockOf(id, T0).label, "这次登录已 不到 1 小时 · 还在记录");
  await checkAt(id, ok, T0 + 9 * H);
  assert.equal(clockOf(id, T0 + 9 * H).label, "这次登录已 9 小时 · 还在记录", "中间的正常检查不重置计时");
  assert.equal(clockOf(id, T0 + 9 * H).completed, 0);

  await checkAt(id, gone, T0 + 30 * H);
  assert.equal(store.getAccount(id).state, "expired");
  const afterFirst = clockOf(id, T0 + 30 * H);
  assert.equal(afterFirst.completed, 1);
  assert.equal(afterFirst.averageHours, 30, "从登录成功到第一次查到过期：30 小时");
  assert.equal(afterFirst.label, "平均撑 30 小时", "过期了就不再说「这次登录已」");

  // 重新扫码、再检查正常：重新计时。
  await checkAt(id, ok, T0 + 31 * H);
  assert.equal(clockOf(id, T0 + 40 * H).label, "这次登录已 9 小时 · 平均撑 30 小时");

  // 第二次过期：最近几次取平均。
  await checkAt(id, gone, T0 + 41 * H);
  const second = clockOf(id, T0 + 41 * H);
  assert.equal(second.completed, 2);
  assert.equal(second.averageHours, 20, "(30 + 10) / 2");
  assert.equal(second.label, "平均撑 20 小时");
});

test("ACC-shipinhao-04 每次登录成功、每次检查结果都记成账号事件", async () => {
  const { id } = account();
  await checkAt(id, stubAdapter({ state: "ok" }), T0);
  await checkAt(id, stubAdapter({ state: "expired" }), T0 + 2 * H);
  await checkAt(id, stubAdapter({ state: "ok" }), T0 + 3 * H);
  const rows = db().prepare("SELECT type, payload_json FROM event WHERE type IN ('account.login_ok','account.check_result') AND payload_json LIKE ? ORDER BY rowid").all(`%"accountId":"${id}"%`);
  const seen = rows.map((r) => { const p = JSON.parse(r.payload_json); return `${r.type.split(".")[1]}:${p.result ?? p.source}`; });
  assert.deepEqual(seen, ["login_ok:observed", "check_result:ok", "check_result:expired", "login_ok:relogin", "check_result:ok"]);
});

test("ACC-shipinhao-04 发布途中落到二维码页（auth）也记一次「过期」；检查抛 auth 同样", async () => {
  const { id } = account();
  await checkAt(id, stubAdapter({ state: "ok" }), T0);
  const authFail = stubAdapter(() => { throw new AdapterError("auth", "视频号登录过期了，请重新扫码"); });
  await assert.rejects(checkAt(id, authFail, T0 + 12 * H), (e) => e.code === "auth");
  assert.equal(store.getAccount(id).state, "expired");
  assert.equal(clockOf(id, T0 + 12 * H).averageHours, 12);
});

test("ACC-shipinhao-04 account.show 和 account.list 是同一份数字；别的平台没有登录时长", async () => {
  const { id, groupId } = account();
  await checkAt(id, stubAdapter({ state: "ok" }), Date.now() - 9 * H);
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  const show = h["account.show"]({ accountId: id });
  const listed = h["account.list"]({ group: groupId }).accounts.find((a) => a.id === id);
  assert.equal(show.loginClock.label, listed.loginClock.label);
  assert.match(show.loginClock.label, /^这次登录已 9 小时 · 还在记录$/);
  const other = account("xiaohongshu");
  assert.equal(h["account.show"]({ accountId: other.id }).loginClock, undefined);
  assert.throws(() => h["account.show"]({ accountId: "nope" }), /没有这个账号/);
  assert.ok(findCommand("account.show").cli.usage.includes("hifabu account show"), "命令在注册表里，CLI / HTTP 由它派生");
});

// ---------------------------------------------------------------- ACC-shipinhao-05 只在需要时查

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, delay) => { const t = { fn, delay, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    live: () => timers.filter((t) => !t.cleared).at(-1),
  };
}
const queuedChecks = (id) => db().prepare("SELECT * FROM run WHERE kind='check' AND target_id=? AND state='queued'").all(id);
const drain = (id) => db().prepare("UPDATE run SET state='done' WHERE kind='check' AND target_id=?").run(id);

test("ACC-shipinhao-05 通用 6 小时体检不包含视频号；别的平台照旧", () => {
  const sph = account();
  const xhs = account("xiaohongshu");
  const due = sched.dueAccounts({ now: Date.now() + 100 * H }).map((a) => a.id);
  assert.ok(!due.includes(sph.id), "视频号不进通用体检");
  assert.ok(due.includes(xhs.id));
});

test("ACC-shipinhao-05 检查时机：启动、每天一次（对准钟点，不是固定间隔）、之后不再有别的定时", () => {
  const a = account();
  let now = T0; // 09:00
  const t = fakeTimers();
  const realInterval = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = (...x) => { intervals++; return realInterval(...x); };
  let stop;
  try {
    stop = sched.startLoginChecker({ now: () => now, setTimer: t.setTimer, clearTimer: t.clearTimer });
  } finally {
    globalThis.setInterval = realInterval;
  }
  assert.equal(intervals, 0, "没有 setInterval：不是按固定小时间隔反复检查");
  assert.equal(queuedChecks(a.id).length, 1, "发布机启动时查一次");
  assert.equal(t.live().delay, sched.nextDailyAt(T0, "08:00") - T0, "下一次醒来 = 明天 08:00，不是几小时之后");
  assert.equal(new Date(T0 + t.live().delay).getHours(), 8);

  // 到了每天的钟点：再查一次。
  drain(a.id);
  now = sched.nextDailyAt(T0, "08:00");
  t.live().fn();
  assert.equal(queuedChecks(a.id).length, 1, "每天一次");
  // 醒来之后只有下一个钟点在等，没有额外的定时。
  assert.equal(new Date(now + t.live().delay).getHours(), 8);
  assert.ok(t.live().delay >= 23 * H, "再下一次是明天");

  // 没到钟点（比如发布前 2 小时的扫描醒来）不会触发每天的那一次。
  drain(a.id);
  now += 2 * H;
  t.live().fn();
  assert.equal(queuedChecks(a.id).length, 0);
  stop();
});

test("ACC-shipinhao-05 已经是「过期」时不再自动打开页面，等人重新扫码", async () => {
  const a = account();
  await checkAt(a.id, stubAdapter({ state: "expired" }), T0);
  assert.equal(store.getAccount(a.id).state, "expired");
  const t = fakeTimers();
  const stop = sched.startLoginChecker({ now: () => T0, setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.equal(queuedChecks(a.id).length, 0, "启动时不查过期的");
  t.live().fn();
  assert.equal(sched.queueLoginChecks({ trigger: "daily" }).includes(a.id), false);
  assert.equal(sched.queueLoginChecks({ trigger: "confirm", accountIds: [a.id] }).includes(a.id), false);
  stop();
});

test("ACC-shipinhao-05 离线模式什么都不排", () => {
  const a = account();
  const t = fakeTimers();
  const stop = sched.startLoginChecker({ offline: true, setTimer: t.setTimer });
  assert.equal(t.timers.length, 0);
  assert.equal(queuedChecks(a.id).length, 0);
  stop();
});

test("ACC-shipinhao-05 每天检查的钟点可以改（默认 08:00），改了马上重新对准", () => {
  assert.equal(sched.loginCheckTime(), "08:00");
  const a = account();
  const t = fakeTimers();
  const stop = sched.startLoginChecker({ now: () => T0, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  assert.deepEqual(h["login.checktime.show"]().time, "08:00");
  const r = h["login.checktime.set"]({ time: "7:30" });
  assert.equal(r.time, "07:30");
  assert.equal(sched.loginCheckTime(), "07:30");
  assert.equal(new Date(T0 + t.live().delay).getHours(), 7, "新钟点马上生效");
  assert.equal(new Date(T0 + t.live().delay).getMinutes(), 30);
  assert.throws(() => h["login.checktime.set"]({ time: "25:00" }), /时:分/);
  assert.equal(sched.loginCheckTime(), "07:30", "写坏了不改");
  h["login.checktime.set"]({ time: "08:00" });
  stop();
  void a;
});

test("ACC-shipinhao-05 确认视频号平台稿时查一次登录；脚本里没有固定间隔的视频号定时任务", async () => {
  const k = ++seq;
  const group = store.addGroup({ name: `确认视频号 ${k}` });
  const acc = store.addAccount({ platform: "shipinhao", handle: `@c${k}`, groupId: group.id }).id;
  const work = store.createWork({ title: `作品 ${k}`, assetPath: "/tmp/a.mp4" });
  const pub = store.createPublish({ workId: work.id, accountId: acc, scheduledAt: Date.now() + 5 * H });
  const preflight = ({ publishId }) => { if (publishId === pub.id && globalThis.__bad) throw new AdapterError("asset_invalid", "视频号短标题「x」超过 16 字（空格也算，现在是 20 字）：改短后再确认"); };
  const h = createCoreHandlers({ adapters: [{ platform: "shipinhao", adapter: { preflight } }], log: () => {} });

  // 不合规：在人确认的这一刻就拦下，说明原因，一条都不确认。
  globalThis.__bad = true;
  assert.throws(() => h["publish.approve"]({ cutId: pub.cutId }), (e) => /还不能确认.*视频号.*短标题.*超过 16 字/.test(e.message));
  assert.equal(store.getPublish(pub.id).state, "pending_confirm");
  assert.equal(queuedChecks(acc).length, 0);

  // 合规：确认，并排一次登录检查（触发时机 = confirm）。
  globalThis.__bad = false;
  const res = h["publish.approve"]({ cutId: pub.cutId });
  assert.equal(res.approved.length, 1);
  assert.equal(queuedChecks(acc).length, 1, "确认时查一次登录");
  await checkAt(acc, stubAdapter({ state: "ok" }), T0);
  const last = db().prepare("SELECT payload_json FROM event WHERE type='account.check_result' AND payload_json LIKE ? ORDER BY rowid DESC").get(`%"accountId":"${acc}"%`);
  assert.equal(JSON.parse(last.payload_json).trigger, "confirm");

  // 仓库里没有「按固定小时间隔反复检查视频号」的定时任务。
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const src = readFileSync(join(dir, "scheduler.mjs"), "utf8");
  const body = src.slice(src.indexOf("export function startLoginChecker"), src.indexOf("export function dueAccounts"));
  assert.ok(!/setInterval/.test(body), "startLoginChecker 里没有 setInterval");
  assert.ok(/LOGIN_TRACKED/.test(src.slice(src.indexOf("export function dueAccounts"), src.indexOf("export function sweepAccountChecks"))) || /platform NOT IN/.test(src), "通用体检排除了视频号");
});

test("ACC-shipinhao-05 计划发布前 2 小时额外查一次：只查一次，已经查过的不再查", async () => {
  db().prepare("UPDATE publish SET state = 'canceled' WHERE state = 'queued'").run(); // 前面的测试留下的排期不参与
  const k = ++seq;
  const group = store.addGroup({ name: `发布前 ${k}` });
  const acc = store.addAccount({ platform: "shipinhao", handle: `@p${k}`, groupId: group.id }).id;
  const work = store.createWork({ title: `作品 ${k}`, assetPath: "/tmp/a.mp4" });
  const at = T0 + 6 * H; // 15:00 发
  const pub = store.createPublish({ workId: work.id, accountId: acc, scheduledAt: at });
  store.approvePublishes({ publishId: pub.id });
  assert.equal(store.getPublish(pub.id).state, "queued");
  db().prepare("UPDATE publish SET scheduled_at = ? WHERE id = ?").run(at, pub.id);

  let now = T0;
  const t = fakeTimers();
  const stop = sched.startLoginChecker({ now: () => now, setTimer: t.setTimer, clearTimer: t.clearTimer });
  drain(acc); // 启动那一次先放一边
  assert.equal(sched.nextPrePublishAt({ now }), at - 2 * H);
  assert.equal(t.live().delay, at - 2 * H - T0, "对准发布前 2 小时（13:00），比明天 08:00 早");

  now = at - 2 * H;
  t.live().fn();
  assert.equal(queuedChecks(acc).length, 1, "到点查一次");
  await checkAt(acc, stubAdapter({ state: "ok" }), now);
  const rec = db().prepare("SELECT payload_json FROM event WHERE type='account.check_result' AND payload_json LIKE ? ORDER BY rowid DESC").get(`%"accountId":"${acc}"%`);
  assert.equal(JSON.parse(rec.payload_json).trigger, "pre_publish");
  assert.equal(JSON.parse(rec.payload_json).publishId, pub.id);
  drain(acc);
  now += 30 * 60e3;
  t.live().fn();
  assert.equal(queuedChecks(acc).length, 0, "不会为同一条发布反复查");

  // 登录在发布前 2 小时查出来过期：立刻提醒（事件），不等到发布失败。
  const acc2 = account().id;
  await checkAt(acc2, stubAdapter({ state: "expired", detail: "视频号登录过期了，请重新扫码" }), now);
  const ev = db().prepare("SELECT payload_json, severity FROM event WHERE type='account.expired' AND payload_json LIKE ?").get(`%"accountId":"${acc2}"%`);
  assert.equal(ev.severity, "critical");
  assert.match(JSON.parse(ev.payload_json).detail ?? "", /视频号登录过期了，请重新扫码/);
  stop();
});

// ---------------------------------------------------------------- ACC-shipinhao-06 提醒

test("ACC-shipinhao-06 过期：今天页「要处理」出现「视频号要重新扫码」，扫完（检查正常）自己消失", async () => {
  const a = account();
  await checkAt(a.id, stubAdapter({ state: "ok" }), T0);
  assert.deepEqual(overview.buildToday({ groupId: a.groupId }).relogin, []);
  await checkAt(a.id, stubAdapter({ state: "expired" }), T0 + 5 * H);
  const today = overview.buildToday({ groupId: a.groupId });
  assert.equal(today.relogin.length, 1);
  assert.equal(today.relogin[0].text, "视频号要重新扫码");
  assert.equal(today.relogin[0].accountId, a.id);
  await checkAt(a.id, stubAdapter({ state: "ok" }), T0 + 6 * H);
  assert.deepEqual(overview.buildToday({ groupId: a.groupId }).relogin, []);
  // 侧栏「N 个账号要处理」读的是账号状态：过期时 displayState 就是 expired。
  await checkAt(a.id, stubAdapter({ state: "expired" }), T0 + 7 * H);
  const view = createCoreHandlers({ adapters: [], log: () => {} })["account.list"]({ group: a.groupId }).accounts.find((x) => x.id === a.id);
  assert.equal(view.displayState, "expired");
  // 过期事件是飞书通道推送的那一种（account.expired 带卡片），人话在 detail 里。
  const ev = db().prepare("SELECT type FROM event WHERE type='account.expired' AND payload_json LIKE ?").get(`%"accountId":"${a.id}"%`);
  assert.equal(ev.type, "account.expired");
});

test("ACC-shipinhao-06 发布：auto 模式的视频号平台稿按草稿跑，到草稿箱为止；途中 auth 记过期并留事件", async () => {
  const k = ++seq;
  const group = store.addGroup({ name: `发布视频号 ${k}` });
  const acc = store.addAccount({ platform: "shipinhao", handle: `@r${k}`, groupId: group.id }).id;
  let mode = "draft";
  const adapter = validateAdapter(
    {
      platform: "shipinhao",
      capabilities: { publish: "web", collect: "none", draft: true },
      draftOnly: true,
      ready: () => null,
      async publish() {
        if (mode === "auth") throw new AdapterError("auth", "视频号登录过期了，请重新扫码");
        return { id: "短标题", url: "https://channels.weixin.qq.com/platform/post/list", visibility: "private", state: "draft_pending", note: "已送到视频号草稿箱，在手机上点发表" };
      },
    },
    "adapter-shipinhao",
  );
  const handlers = buildHandlers([adapter], { log: () => {} });
  const mk = () => {
    const w = store.createWork({ title: `作品 ${k}-${Math.random()}`, assetPath: "/tmp/a.mp4" });
    const p = store.createPublish({ workId: w.id, accountId: acc, scheduledAt: Date.now() + 5 * H });
    store.approvePublishes({ publishId: p.id });
    return p.id;
  };
  const p1 = mk();
  assert.equal(store.getPublish(p1).mode, "auto");
  await handlers.publish({ id: "run_1", target_id: p1 });
  assert.equal(store.getPublish(p1).state, "draft_pending", "auto 也走草稿：状态是 draft_pending，不是 published");
  assert.equal(store.getPublish(p1).mode, "draft");
  const notice = db().prepare("SELECT payload_json FROM event WHERE type='publish.needs_human' AND publish_id=?").get(p1);
  assert.match(JSON.parse(notice.payload_json).message, /在手机上点发表/);

  mode = "auth";
  const p2 = mk();
  await handlers.publish({ id: "run_2", target_id: p2 });
  assert.equal(store.getAccount(acc).state, "expired");
  assert.ok(results(acc).some((r) => r.kind === "expired"), "发布途中的过期也记进登录记录");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM event WHERE type='account.expired' AND payload_json LIKE ?").get(`%"accountId":"${acc}"%`).n >= 1, true);
});
