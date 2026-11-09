// 排期投影与撞车（issue #12；验收 ACC-calendar-01 / 03 / 04）。
//
// 钉住的是产品模型而不是实现：一个作品一张卡、撞车在卡上、改期整作品一起挪、
// 取消留现场且不叫醒人。这些一旦漂了，日历页面就会和 CLI 数字对不上。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-schedule-"));
const HOME = process.env.VK_HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const sched = await import("../src/schedule.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { findCommand } = await import("../src/commands.mjs");
const { matchRoute } = await import("../src/routes.mjs");

const db = () => core.open();
const H = 3600e3;
const MIN = 60e3;
// 固定在未来，避免「过去时间拦截」干扰其它用例；每个用例用自己的一天，互不撞车。
const DAY0 = Date.UTC(2030, 0, 1, 0, 0, 0);
let dayN = 0;
const nextDay = () => DAY0 + ++dayN * 24 * H;

let acc = 0;
function account(platform) {
  const { id } = store.addAccount({ platform, handle: `@${platform}${++acc}` });
  return id;
}

function schedule(title, at, accountIds) {
  const work = store.createWork({ title, assetPath: "/tmp/a.mp4" });
  const pubs = accountIds.map((accountId) => store.createPublish({ workId: work.id, accountId, scheduledAt: at }).id);
  return { workId: work.id, pubs };
}

const window = (day) => ({ from: day, to: day + 24 * H - 1 });

let bili;
let tiktok;
let xhs;

before(() => {
  core.migrate();
  bili = account("bilibili");
  tiktok = account("tiktok");
  xhs = account("xiaohongshu");
});

test("ACC-calendar-01：一个作品一张卡，卡上带全部平台，不拆成平台碎片", () => {
  const day = nextDay();
  const { workId } = schedule("三端同发", day + 20 * H, [bili, tiktok, xhs]);
  const res = sched.listSchedule(window(day));
  assert.equal(res.cards.length, 1, "3 条 publish 必须合成 1 张卡");
  const card = res.cards[0];
  assert.equal(card.workId, workId);
  assert.deepEqual(card.platforms.map((p) => p.platform).sort(), ["bilibili", "tiktok", "xiaohongshu"]);
  assert.equal(card.state, "scheduled");
  assert.deepEqual(res.counts, { works: 1, publishes: 3, conflicts: 0 });
});

test("作品状态取各平台最差：failed > needs_human > limited > scheduled > published", () => {
  const day = nextDay();
  const { pubs } = schedule("状态聚合", day + 9 * H, [bili, tiktok, xhs]);
  db().prepare("UPDATE publish SET state='published' WHERE id=?").run(pubs[0]);
  db().prepare("UPDATE publish SET state='notify_pending' WHERE id=?").run(pubs[1]);
  let card = sched.listSchedule(window(day)).cards[0];
  assert.equal(card.state, "needs_human");
  // 逐平台状态保留，不被一个状态盖住
  assert.deepEqual(card.platforms.map((p) => p.state).sort(), ["needs_human", "published", "scheduled"]);
  db().prepare("UPDATE publish SET state='failed' WHERE id=?").run(pubs[2]);
  card = sched.listSchedule(window(day)).cards[0];
  assert.equal(card.state, "failed");
  assert.equal(sched.aggregateState([{ state: "published" }, { state: "limited" }]), "limited");
});

test("ACC-calendar-04：同账号 30 分钟内两条 → 两张卡都带撞车标记，且结构化指明和谁撞", () => {
  const day = nextDay();
  const a = schedule("作品 A", day + 20 * H, [bili, tiktok]);
  const b = schedule("作品 B", day + 20 * H + 20 * MIN, [bili]);
  const c = schedule("作品 C（别的号）", day + 20 * H + 5 * MIN, [xhs]);
  const res = sched.listSchedule(window(day));

  assert.equal(res.conflicts.length, 1);
  const conflict = res.conflicts[0];
  assert.equal(conflict.platform, "bilibili");
  assert.equal(conflict.gapMin, 20);
  assert.deepEqual([conflict.a.workId, conflict.b.workId].sort(), [a.workId, b.workId].sort());

  const byId = Object.fromEntries(res.cards.map((card) => [card.workId, card]));
  assert.equal(byId[a.workId].conflict, true);
  assert.equal(byId[a.workId].conflicts[0].workId, b.workId);
  assert.equal(byId[a.workId].conflicts[0].platform, "bilibili");
  assert.equal(byId[b.workId].conflict, true);
  assert.equal(byId[b.workId].conflicts[0].workId, a.workId);
  assert.equal(byId[c.workId].conflict, false, "不同账号同一时间不算撞车");
  assert.equal(res.counts.conflicts, 2);
});

test("间隔超过 30 分钟不算撞车；窗口边缘外的排期也参与检测", () => {
  const day = nextDay();
  schedule("早", day + 10 * H, [tiktok]);
  schedule("晚 31 分钟", day + 10 * H + 31 * MIN, [tiktok]);
  assert.equal(sched.listSchedule(window(day)).conflicts.length, 0);

  const edge = schedule("窗口最后一刻", day + 24 * H - 10 * MIN, [xhs]);
  schedule("次日零点后", day + 24 * H + 5 * MIN, [xhs]);
  const res = sched.listSchedule(window(day));
  const card = res.cards.find((x) => x.workId === edge.workId);
  assert.equal(card.conflict, true, "窗口外 15 分钟的排期也要标出来");
  assert.ok(!res.cards.some((x) => x.title === "次日零点后"), "窗口外的作品本身不出卡");
});

test("ACC-calendar-03：改期移动整个作品的所有 publish，同时挪队列，状态不变", () => {
  const day = nextDay();
  const { workId, pubs } = schedule("要改期", day + 8 * H, [bili, tiktok]);
  const to = day + 15 * H;
  const res = sched.moveSchedule({ workId, at: to });
  assert.equal(res.saved, true);
  assert.equal(res.from, day + 8 * H);
  assert.equal(res.moved.length, 2);
  for (const id of pubs) {
    const row = db().prepare("SELECT scheduled_at, state FROM publish WHERE id=?").get(id);
    assert.equal(row.scheduled_at, to);
    assert.equal(row.state, "queued");
    const run = db().prepare("SELECT run_after FROM run WHERE kind='publish' AND target_id=? AND state='queued'").get(id);
    assert.equal(run.run_after, to, "队列不跟着挪，就会按旧时间发出去");
  }
  const ev = db().prepare("SELECT payload_json FROM event WHERE type='schedule.moved' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(JSON.parse(ev.payload_json).workId, workId);
});

test("改期拦截过去时间", () => {
  const day = nextDay();
  const { workId } = schedule("过去", day + 8 * H, [bili]);
  assert.throws(() => sched.moveSchedule({ workId, at: Date.now() - 1000 }), (e) => e.code === "E_SCHEDULE_PAST");
});

test("改期撞车：保存前提示，不落盘；--force 才保存", () => {
  const day = nextDay();
  const other = schedule("先占位", day + 18 * H, [bili]);
  const mine = schedule("想挪过去", day + 9 * H, [bili, tiktok]);
  const target = day + 18 * H + 10 * MIN;

  const dry = sched.moveSchedule({ workId: mine.workId, at: target });
  assert.equal(dry.saved, false);
  assert.equal(dry.code, "E_SCHEDULE_CONFLICT");
  assert.equal(dry.conflicts.length, 1);
  assert.equal(dry.conflicts[0].platform, "bilibili");
  const ids = [dry.conflicts[0].a.workId, dry.conflicts[0].b.workId];
  assert.ok(ids.includes(other.workId) && ids.includes(mine.workId));
  assert.equal(db().prepare("SELECT scheduled_at FROM publish WHERE id=?").get(mine.pubs[0]).scheduled_at, day + 9 * H, "撞车时不能落盘");

  const forced = sched.moveSchedule({ workId: mine.workId, at: target, force: true });
  assert.equal(forced.saved, true);
  assert.equal(db().prepare("SELECT scheduled_at FROM publish WHERE id=?").get(mine.pubs[0]).scheduled_at, target);
});

test("有平台正在上传时拒绝改期与取消", () => {
  const day = nextDay();
  const { workId, pubs } = schedule("在跑", day + 8 * H, [bili, tiktok]);
  db().prepare("UPDATE publish SET state='auto_running' WHERE id=?").run(pubs[0]);
  assert.throws(() => sched.moveSchedule({ workId, at: day + 9 * H }), (e) => e.code === "E_SCHEDULE_RUNNING");
  assert.throws(() => sched.cancelSchedule({ workId }), (e) => e.code === "E_SCHEDULE_RUNNING");
});

test("取消排期：迁 canceled + E_USER_CANCELLED，不删行，撤队列，不发失败卡，幂等", () => {
  const day = nextDay();
  const { workId, pubs } = schedule("要取消", day + 8 * H, [bili, tiktok, xhs]);
  db().prepare("UPDATE publish SET state='published' WHERE id=?").run(pubs[2]);

  const res = sched.cancelSchedule({ workId });
  assert.equal(res.canceled.length, 2);
  assert.deepEqual(res.skipped.map((s) => s.state), ["published"]);
  for (const id of pubs.slice(0, 2)) {
    const row = db().prepare("SELECT state, error_code FROM publish WHERE id=?").get(id);
    assert.equal(row.state, "canceled");
    assert.equal(row.error_code, sched.E_USER_CANCELLED);
    assert.equal(db().prepare("SELECT COUNT(*) n FROM run WHERE kind='publish' AND target_id=? AND state='queued'").get(id).n, 0);
    assert.equal(db().prepare("SELECT COUNT(*) n FROM event WHERE publish_id=? AND type='publish.failed'").get(id).n, 0, "主动取消不能当失败叫醒人");
  }
  assert.equal(db().prepare("SELECT COUNT(*) n FROM publish WHERE work_id=?").get(workId).n, 3, "保留现场，不删行");

  const card = sched.listSchedule(window(day)).cards.find((c) => c.workId === workId);
  assert.deepEqual(card.platforms.map((p) => p.platform), ["xiaohongshu"], "已取消的平台不再出现在卡上");

  // 只剩已发出的：再取消就没有可取消的
  assert.throws(() => sched.cancelSchedule({ workId }), (e) => e.code === "E_SCHEDULE_NOTHING");

  const solo = schedule("全取消", day + 12 * H, [tiktok]);
  sched.cancelSchedule({ workId: solo.workId });
  assert.equal(sched.cancelSchedule({ workId: solo.workId }).already, true);
});

test("不存在的作品给出可读错误", () => {
  assert.throws(() => sched.moveSchedule({ workId: "work_nope", at: nextDay() }), (e) => e.code === "E_NOT_FOUND");
  assert.throws(() => sched.cancelSchedule({ workId: "work_nope" }), (e) => e.code === "E_NOT_FOUND");
});

test("命令表 + 路由 + handler 三端同源", async () => {
  for (const name of ["schedule.list", "schedule.move", "schedule.cancel"]) assert.ok(findCommand(name), `命令表缺 ${name}`);
  assert.deepEqual(matchRoute("GET", "/api/schedule?from=1&to=2"), { command: "schedule.list", params: {} });
  assert.deepEqual(matchRoute("POST", "/api/schedule/work_x/move"), { command: "schedule.move", params: { workId: "work_x" } });
  assert.deepEqual(matchRoute("POST", "/api/schedule/work_x/cancel"), { command: "schedule.cancel", params: { workId: "work_x" } });

  const handlers = createCoreHandlers();
  const day = nextDay();
  const { workId } = schedule("经 handler", day + 8 * H, [bili]);
  const listed = await handlers["schedule.list"](window(day));
  assert.equal(listed.cards[0].workId, workId);
  const moved = await handlers["schedule.move"]({ workId, at: day + 10 * H });
  assert.equal(moved.saved, true);
  const canceled = await handlers["schedule.cancel"]({ workId });
  assert.equal(canceled.canceled.length, 1);
});

test("--group：旧库没有 account.group_id 时明确报错，不悄悄忽略过滤", () => {
  // #11 合入后主库已经有 group_id，这段只能在独立旧库上验证：造一张没有账号组列的表。
  const legacyHome = mkdtempSync(join(tmpdir(), "vk-schedule-legacy-"));
  process.env.VK_HOME = legacyHome;
  core.close();
  const { db: dbPath } = core.ensureDirs();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE account (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, handle TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  legacy.close();

  assert.throws(() => sched.listSchedule({ ...window(nextDay()), group: "g1" }), (e) => e.code === "E_GROUP_UNSUPPORTED");

  core.close();
  process.env.VK_HOME = HOME;
});

test("--group：按组过滤；不同组的同平台账号不算撞车", () => {
  const day = nextDay();
  db().prepare("INSERT INTO account_group (id, name, created_at) VALUES ('grp_a','主号组',0), ('grp_b','副号组',0)").run();
  const inA = account("bilibili");
  const inB = account("bilibili");
  db().prepare("UPDATE account SET group_id='grp_a' WHERE id=?").run(inA);
  db().prepare("UPDATE account SET group_id='grp_b' WHERE id=?").run(inB);
  const wa = schedule("A 组作品", day + 8 * H, [inA]);
  schedule("B 组作品", day + 8 * H, [inB]);

  const byName = sched.listSchedule({ ...window(day), group: "主号组" });
  assert.deepEqual(byName.cards.map((c) => c.workId), [wa.workId]);
  assert.equal(byName.conflicts.length, 0, "不同组的同平台账号不是同一个号，不算撞车");
  assert.deepEqual(sched.listSchedule({ ...window(day), group: "grp_a" }).cards.map((c) => c.workId), [wa.workId]);
  assert.throws(() => sched.listSchedule({ ...window(day), group: "没有的组" }), (e) => e.code === "E_GROUP_NOT_FOUND");
});
