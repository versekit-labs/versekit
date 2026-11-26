// 作品页的周视图和月视图的数据面（#247，ACC-v3-cal-02/05/06/08）。只用临时库和假数据。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-cal-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { planRules, takenTimes, violationAt, dayUsage } = await import("../src/schedule-rules.mjs");
const { updateConfig } = await import("../src/config.mjs");
after(() => core.close());

const h = createCoreHandlers({ adapters: ["tiktok", "bilibili"].map((platform) => ({ platform })), log: () => {} });
const asset = join(HOME, "a.mp4");
writeFileSync(asset, "fake video");
core.migrate();
const conn = () => core.open();
const H = 3600e3;
let seq = 0;
const at = (day, hour = 12) => new Date(2030, 0, day, hour, 0, 0).getTime();

const group = h["group.add"]({ name: "日历组" });
const other = h["group.add"]({ name: "别的组" });
const acc = h["account.add"]({ platform: "tiktok", name: "@cal", group: group.name }).id;
const accB = h["account.add"]({ platform: "bilibili", name: "@calb", group: group.name }).id;
const accOther = h["account.add"]({ platform: "tiktok", name: "@cal-other", group: other.name }).id;
h["group.use"]({ group: group.name });

function newWork(title) {
  const w = h["work.add"]({ title, source: join(HOME, `${title}.json`), cuts: [{ title: `${title}成片`, versions: [{ language: "zh", asset }] }] });
  return { id: w.id, cutId: conn().prepare("SELECT id FROM cut WHERE work_id = ?").get(w.id).id };
}
function pub(w, accountId, { state = "pending_confirm", scheduledAt = null, publishedAt = null, fallback = null } = {}) {
  const id = `pub_cal${++seq}`;
  // 每个账号每支成片只有一条平台稿：同一个作品下按需再加一支成片。
  if (conn().prepare("SELECT 1 FROM publish WHERE cut_id = ? AND account_id = ?").get(w.cutId, accountId)) {
    w = { ...w, cutId: `cut_cal${seq}` };
    conn().prepare("INSERT INTO cut (id, work_id, title, position, created_at) VALUES (?,?,?,?,?)").run(w.cutId, w.id, `成片${seq}`, seq, seq);
  }
  conn()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, scheduled_at, published_at, fallback_reason, cut_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, w.id, accountId, state, scheduledAt, publishedAt, fallback, w.cutId, 1 + seq, 1 + seq);
  return id;
}
const range = (a, b) => h["publish.list"]({ from: a, to: b });

test("ACC-v3-cal-08 只返回 [from, to] 里的，并只限当前组", () => {
  const w = newWork("范围");
  const inside = pub(w, acc, { scheduledAt: at(5) });
  const before = pub(w, accB, { scheduledAt: at(2) });
  pub(w, accOther, { scheduledAt: at(5, 13) });
  const rows = range(at(4), at(6)).rows;
  assert.deepEqual(rows.map((r) => r.id), [inside]);
  assert.equal(rows[0].title, "范围");
  assert.equal(rows[0].cutTitle, "范围成片");
  assert.ok(!range(at(4), at(6)).rows.some((r) => r.id === before));
  assert.throws(() => h["publish.list"]({ from: at(1) }), /同时给/);
  // 不给范围时老行为不变
  assert.ok(Array.isArray(h["publish.list"]({}).rows));
});

test("ACC-v3-cal-02 已发布用实际发布时间；现在发、我自己发、不发、已取消的不上日历", () => {
  const w = newWork("口径");
  const published = pub(w, acc, { state: "published", scheduledAt: at(10, 9), publishedAt: at(10, 15) });
  const skipped = pub(w, accB, { state: "skipped", scheduledAt: at(10, 10) });
  const canceled = pub(w, acc, { state: "canceled", scheduledAt: at(10, 11) });
  const self = pub(w, accB, { state: "notify_pending", scheduledAt: at(10, 12), fallback: "self_publish" });
  const nowOne = pub(w, accB, { state: "pending_confirm", scheduledAt: at(10, 13) });
  core.transitionPublish(nowOne, "queued", { reason: "approved_now_by_operator" });
  const rows = range(at(10, 0), at(10, 23)).rows;
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids, [published]);
  assert.equal(rows[0].at, at(10, 15));
  for (const x of [skipped, canceled, self, nowOne]) assert.ok(!ids.includes(x), x);
});

test("ACC-v3-cal-05 状态只有四种；账号暂停时写「暂停中」", () => {
  const w = newWork("状态");
  const day = 12;
  const m = { pending_confirm: "wait", queued: "sched", published: "pub", failed: "bad" };
  const ids = {};
  let hour = 0;
  for (const [state, cal] of Object.entries(m)) ids[cal] = pub(w, accB, { state, scheduledAt: at(day, hour++), publishedAt: state === "published" ? at(day, hour - 1) : null });
  const rows = range(at(day, 0), at(day, 23)).rows;
  for (const [cal, id] of Object.entries(ids)) assert.equal(rows.find((r) => r.id === id).cal, cal);
  assert.deepEqual(rows.map((r) => r.calLabel), ["等你确认", "已确认", "已发布", "出了问题"]);
  conn().prepare("UPDATE account SET is_manual = 1 WHERE id = ?").run(accB);
  const paused = range(at(day, 0), at(day, 23)).rows;
  assert.deepEqual(paused.map((r) => r.calLabel), ["暂停中", "暂停中", "已发布", "出了问题"]);
  conn().prepare("UPDATE account SET is_manual = 0 WHERE id = ?").run(accB);
});

test("ACC-v3-cal-06 额度的上限就是排期用的那条规则，超了的和排期拒绝的是同一个数", () => {
  updateConfig({ plan: { rules: { platforms: { tiktok: { daily_cap: 2, min_gap_minutes: 10 } } } } });
  const w = newWork("额度");
  const day = 20;
  pub(w, acc, { scheduledAt: at(day, 9) });
  pub(w, acc, { state: "queued", scheduledAt: at(day, 10) });
  let q = range(at(day, 0), at(day, 23)).quota.find((x) => x.platform === "tiktok" && x.day === "2030-01-20");
  assert.deepEqual({ used: q.used, cap: q.cap, over: q.over }, { used: 2, cap: 2, over: false });
  assert.equal(q.cap, planRules("tiktok").dailyCap);
  // 满额：排期规则再加一条会被拒（daily_cap）
  assert.equal(violationAt(at(day, 15), takenTimes(acc, "none"), planRules("tiktok"))?.reason, "daily_cap");
  pub(w, acc, { scheduledAt: at(day, 11) });
  q = range(at(day, 0), at(day, 23)).quota.find((x) => x.platform === "tiktok" && x.day === "2030-01-20");
  assert.deepEqual({ used: q.used, cap: q.cap, over: q.over }, { used: 3, cap: 2, over: true });
  // 现在发的、我自己发的也占名额（和排期一致），哪怕它们不上日历
  pub(w, acc, { state: "notify_pending", scheduledAt: at(day, 16), fallback: "self_publish" });
  q = dayUsage({ from: at(day, 0), to: at(day, 23), groupId: group.id }).find((x) => x.platform === "tiktok");
  assert.equal(q.used, 4);
  // 别的组、没有稿子的平台不出现
  assert.ok(!dayUsage({ from: at(day, 0), to: at(day, 23), groupId: group.id }).some((x) => x.platform === "bilibili"));
  updateConfig({ plan: { rules: { platforms: { tiktok: { daily_cap: 10, min_gap_minutes: 10 } } } } });
});
