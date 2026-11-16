// issue #147 · ACC-v2-today-01 / ACC-v2-group-01 / ACC-v2-base-01
// vk today 四块、work / today / stats 默认只看当前账号组、和平时比的倍数。
// 只用临时库和假数据：不登录、不发布、不采集任何真实账号。
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-today-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { baselineFor, median, play24hOf, BASELINE_DEFAULTS } = await import("../src/baseline.mjs");
const { updateConfig } = await import("../src/config.mjs");

after(() => core.close());

const handlers = createCoreHandlers({ adapters: ["tiktok", "bilibili", "xiaohongshu"].map((platform) => ({ platform })), log: () => {} });
const asset = join(HOME, "a.mp4");
writeFileSync(asset, "fake video");

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
let seq = 0;
const id = (p) => `${p}_t${++seq}`;

core.migrate();
const conn = () => core.open();

function group(name) {
  return handlers["group.add"]({ name });
}
const account = (g, platform, name) => handlers["account.add"]({ platform, name, group: g.name }).id;

/** 直接写一条发布与它的快照：测的是聚合口径，不经过调度和适配器。 */
function insertPublish({ workId, accountId, state = "published", publishedAt = null, scheduledAt = null, cutId = null, play = null, snapshotAt = null, error = null }) {
  const pid = id("pub");
  conn()
    .prepare(
      `INSERT INTO publish (id, work_id, account_id, state, scheduled_at, published_at, cut_id, error_code, error_message, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(pid, workId, accountId, state, scheduledAt, publishedAt, cutId, error?.code ?? null, error?.message ?? null, 1 + seq, 1 + seq);
  if (play != null) {
    conn()
      .prepare("INSERT INTO snapshot (id, publish_id, captured_at, source, status, metrics_json) VALUES (?,?,?,?,?,?)")
      .run(id("snap"), pid, snapshotAt ?? publishedAt + DAY, "api", "ok", JSON.stringify({ play }));
  }
  return pid;
}

const newWork = (title, cutTitles = [title]) =>
  handlers["work.add"]({
    title,
    source: join(HOME, `${title}.json`),
    cuts: cutTitles.map((t) => ({ title: t, versions: [{ language: "zh", asset }] })),
  });

/** 在一个账号上依次造 n 条各隔一天、24 小时播放为 plays[i] 的已发布发布，返回最后一条之后的时间点。 */
function history(accountId, plays, { endAt = NOW - 10 * DAY } = {}) {
  const w = newWork(`历史-${accountId}`).id;
  return plays.map((play, i) =>
    insertPublish({ workId: w, accountId, publishedAt: endAt - (plays.length - i) * DAY, play }),
  );
}

// ---------------------------------------------------------------- 倍数口径

test("ACC-v2-base-01 median：奇偶个数", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("ACC-v2-base-01 历史不足 5 条不给倍数；够 5 条才给", () => {
  const g = group("基线组");
  const acc = account(g, "tiktok", "@base");
  history(acc, [100, 100, 100, 100]); // 4 条
  const w = newWork("目标").id;
  const target = insertPublish({ workId: w, accountId: acc, publishedAt: NOW - 2 * DAY, play: 500 });

  const few = baselineFor({ publishId: target, accountId: acc, publishedAt: NOW - 2 * DAY });
  assert.equal(few.multiple, null, "4 条历史不给倍数");
  assert.equal(few.verdict, null);
  assert.equal(few.historyCount, 4);
  assert.match(few.reason, /历史不足 5 条/);
  assert.equal(few.play24h, 500, "播放数本身还是给的");

  history(acc, [100]); // 补到 5 条（更早的）
  const enough = baselineFor({ publishId: target, accountId: acc, publishedAt: NOW - 2 * DAY });
  assert.equal(enough.historyCount, 5);
  assert.equal(enough.multiple, 5);
  assert.equal(enough.verdict, "better");
  assert.equal(enough.verdictLabel, "比平时好");
});

test("ACC-v2-base-01 倍数 = 24 小时播放 ÷ 最近 20 条的中位数；2 倍以上好、一半以下差、阈值可配", () => {
  const g = group("阈值组");
  const acc = account(g, "bilibili", "@thr");
  // 25 条：最早的 5 条是 1000（窗口外），最近 20 条中位数是 100。
  history(acc, [...Array(5).fill(1000), ...Array(20).fill(100)]);
  const at = NOW - 3 * DAY;
  const w = newWork("阈值作品").id;
  const mk = (play) => insertPublish({ workId: w, accountId: acc, publishedAt: at, play });
  const probe = (pid) => baselineFor({ publishId: pid, accountId: acc, publishedAt: at });

  const good = probe(mk(200));
  assert.equal(good.baselineMedian, 100, "只取最近 20 条，窗口外的 1000 不参与");
  assert.equal(good.historyCount, 20);
  assert.equal(good.multiple, 2);
  assert.equal(good.verdict, "better", "正好 2 倍算好");

  const bad = probe(mk(50));
  assert.equal(bad.multiple, 0.5);
  assert.equal(bad.verdict, "worse", "正好一半算差");
  assert.equal(bad.verdictLabel, "比平时差");

  const normal = probe(mk(120));
  assert.equal(normal.multiple, 1.2);
  assert.equal(normal.verdict, "normal");

  updateConfig({ baseline: { good: 1.1, bad: 0.9 } });
  try {
    assert.equal(probe(mk(120)).verdict, "better", "阈值写在 config.json 的 baseline 里，可以改");
  } finally {
    updateConfig({ baseline: { good: BASELINE_DEFAULTS.good, bad: BASELINE_DEFAULTS.bad } });
  }
});

test("ACC-v2-base-01 平时是 0 不给倍数；只在 7 天时采过一次的不冒充 24 小时", () => {
  const g = group("边界组");
  const acc = account(g, "tiktok", "@edge");
  history(acc, [0, 0, 0, 0, 0]);
  const w = newWork("边界作品").id;
  const target = insertPublish({ workId: w, accountId: acc, publishedAt: NOW - 3 * DAY, play: 10 });
  const zero = baselineFor({ publishId: target, accountId: acc, publishedAt: NOW - 3 * DAY });
  assert.equal(zero.multiple, null);
  assert.match(zero.reason, /中位数是 0/);

  const late = insertPublish({ workId: w, accountId: acc, publishedAt: NOW - 20 * DAY, play: 999, snapshotAt: NOW - 13 * DAY });
  assert.equal(play24hOf(late, NOW - 20 * DAY), null, "+7d 的快照不是 24 小时的数");
  const none = baselineFor({ publishId: late, accountId: acc, publishedAt: NOW - 20 * DAY });
  assert.equal(none.multiple, null);
  assert.match(none.reason, /24 小时/);
});

test("ACC-v2-base-01 不同平台不相加、不互相比：基线只来自同一个账号", () => {
  const g = group("跨平台组");
  const tt = account(g, "tiktok", "@cross-tt");
  const bili = account(g, "bilibili", "@cross-bili");
  history(tt, Array(10).fill(10000)); // 抖音类账号很大
  history(bili, [10, 10, 10]); // B 站账号只有 3 条
  const w = newWork("跨平台作品").id;
  const at = NOW - 2 * DAY;
  const biliPub = insertPublish({ workId: w, accountId: bili, publishedAt: at, play: 50 });
  const ttPub = insertPublish({ workId: w, accountId: tt, publishedAt: at, play: 30000 });

  const b = baselineFor({ publishId: biliPub, accountId: bili, publishedAt: at });
  assert.equal(b.historyCount, 3, "B 站账号只数自己的 3 条，不借抖音的历史凑数");
  assert.equal(b.multiple, null);
  const t = baselineFor({ publishId: ttPub, accountId: tt, publishedAt: at });
  assert.equal(t.baselineMedian, 10000);
  assert.equal(t.multiple, 3);

  // today 的 results 也一样：每行是一条平台稿自己的数，没有任何合计字段。
  const today = handlers["today"]({ group: g.name });
  const rows = today.results.filter((r) => r.workId === w);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.platform === "bilibili").multiple, null);
  assert.equal(rows.find((r) => r.platform === "tiktok").multiple, 3);
  const flat = JSON.stringify(today);
  assert.ok(!/"(total|sum)Play|"totalViews|"plays"/.test(flat), "没有跨平台合计");
});

test("stats.works 每条带 24 小时播放与倍数", () => {
  const g = group("统计组");
  const acc = account(g, "tiktok", "@stat");
  history(acc, Array(5).fill(100));
  const w = newWork("统计作品").id;
  const pid = insertPublish({ workId: w, accountId: acc, publishedAt: NOW - 2 * DAY, play: 300 });
  const { rows } = handlers["stats.works"]({ group: g.name });
  const row = rows.find((r) => r.publishId === pid);
  assert.equal(row.baseline.multiple, 3);
  assert.ok(!("accountId" in row), "内部键不外泄");
});

// ---------------------------------------------------------------- 账号组

test("ACC-v2-group-01 两个账号组互不串；默认当前组，--group 指定；能看到其他组各有几件事", () => {
  const a = group("互不串 A");
  const accA = account(a, "tiktok", "@iso-a");
  const wa = newWork("A 的作品", ["A 长片", "A 短片", "A 第三支"]);
  const [ca1, ca2, ca3] = wa.work.cuts.map((c) => c.id);
  insertPublish({ workId: wa.id, accountId: accA, state: "pending_confirm", cutId: ca1 });
  insertPublish({ workId: wa.id, accountId: accA, state: "pending_confirm", cutId: ca2 });
  insertPublish({ workId: wa.id, accountId: accA, state: "failed", cutId: ca3, error: { code: "E_A", message: "A 失败了" } });

  const b = group("互不串 B"); // group.add 会把 B 设成当前组
  const accB = account(b, "bilibili", "@iso-b");
  const wb = newWork("B 的作品");
  insertPublish({ workId: wb.id, accountId: accB, state: "pending_confirm", cutId: wb.work.cuts[0].id });
  insertPublish({ workId: wb.id, accountId: accB, state: "queued", scheduledAt: NOW + HOUR });

  // 默认：当前组 B
  const dflt = handlers["today"]({});
  assert.equal(dflt.group.name, b.name);
  assert.deepEqual(dflt.awaiting.map((w) => w.title), ["B 的作品"]);
  assert.equal(dflt.problems.length, 0, "A 的失败不串进 B");
  assert.equal(dflt.scheduled.length, 1);
  const otherA = dflt.others.find((o) => o.group.name === a.name);
  assert.equal(otherA.awaiting, 2, "A 有 2 支成片等确认");
  assert.equal(otherA.problems, 1);
  assert.equal(otherA.total, 3);
  assert.ok(!dflt.others.some((o) => o.group.name === b.name), "others 不含当前组自己");

  // --group A
  const asA = handlers["today"]({ group: a.name });
  assert.deepEqual(asA.awaiting.map((w) => w.title), ["A 的作品"]);
  assert.equal(asA.awaiting[0].cuts.length, 2, "按成片分（第三支是失败的，不在等确认里）");
  assert.equal(asA.problems.length, 1);
  assert.equal(asA.problems[0].error.message, "A 失败了");
  assert.equal(asA.scheduled.length, 0);
  assert.equal(asA.others.find((o) => o.group.name === b.name).total, 1);

  // work.list / work.show 同样按组
  const titles = (res) => res.works.map((w) => w.title);
  assert.ok(titles(handlers["work.list"]({})).includes("B 的作品"));
  assert.ok(!titles(handlers["work.list"]({})).includes("A 的作品"), "work.list 默认只看当前组");
  assert.ok(titles(handlers["work.list"]({ group: a.name })).includes("A 的作品"));
  assert.ok(!titles(handlers["work.list"]({ group: a.name })).includes("B 的作品"));
  const shownB = handlers["work.show"]({ workId: wa.id, group: b.name }).work;
  assert.equal(shownB.cuts.flatMap((c) => c.publishes).length, 0, "B 组看 A 的作品，看不到 A 账号的平台稿");
  const shownA = handlers["work.show"]({ workId: wa.id, group: a.name }).work;
  assert.equal(shownA.cuts.flatMap((c) => c.publishes).length, 3);
  assert.equal(shownA.status.key, "problem", "状态按这个组的平台稿推出");

  assert.throws(() => handlers["today"]({ group: "没有这个组" }), /没有这个账号组/);
});

// ---------------------------------------------------------------- today 四块

test("ACC-v2-today-01 四块：等确认按成片、出了问题、等时间按时间排、满 24 小时的结果", () => {
  const g = group("今天组");
  const tt = account(g, "tiktok", "@today-tt");
  const xhs = account(g, "xiaohongshu", "@today-xhs");
  history(tt, Array(5).fill(100));

  const w = newWork("今天作品", ["长片", "短片"]);
  const [long, short] = w.work.cuts.map((c) => c.id);
  insertPublish({ workId: w.id, accountId: tt, state: "pending_confirm", cutId: long });
  insertPublish({ workId: w.id, accountId: xhs, state: "pending_confirm", cutId: long });
  insertPublish({ workId: w.id, accountId: tt, state: "skipped", cutId: short });
  insertPublish({ workId: w.id, accountId: xhs, state: "blocked", cutId: short, error: { code: "E_X", message: "需要重新登录" } });

  const late = insertPublish({ workId: w.id, accountId: tt, state: "queued", scheduledAt: NOW + 5 * HOUR });
  const early = insertPublish({ workId: w.id, accountId: tt, state: "queued", scheduledAt: NOW + HOUR });
  const nodate = insertPublish({ workId: w.id, accountId: tt, state: "queued", scheduledAt: null });

  const old = insertPublish({ workId: w.id, accountId: tt, publishedAt: NOW - 2 * DAY, play: 400 });
  const fresh = insertPublish({ workId: w.id, accountId: tt, publishedAt: NOW - 3 * HOUR }); // 还没满 24 小时

  // 用例里的时间都相对固定的 NOW；把 Date 钉在 NOW，否则真实日期一过，"没满 24 小时"就会翻成满了。
  mock.timers.enable({ apis: ["Date"], now: NOW });
  let today;
  try { today = handlers["today"]({ group: g.name }); } finally { mock.timers.reset(); }
  assert.deepEqual(Object.keys(today).filter((k) => ["awaiting", "problems", "scheduled", "results"].includes(k)).sort(), ["awaiting", "problems", "results", "scheduled"]);

  // 等确认：只有长片；先不发的短片不催；小红书标逐条
  assert.equal(today.awaiting.length, 1);
  assert.deepEqual(today.awaiting[0].cuts.map((c) => c.title), ["长片"]);
  const pubs = today.awaiting[0].cuts[0].publishes;
  assert.equal(pubs.find((p) => p.platform === "xiaohongshu").perItem, true);
  assert.equal(pubs.find((p) => p.platform === "tiktok").perItem, false);

  assert.equal(today.problems.length, 1);
  assert.equal(today.problems[0].error.message, "需要重新登录");

  assert.deepEqual(today.scheduled.map((p) => p.publishId), [early, late, nodate], "按时间排，没有时间的最后");

  const ids = today.results.map((r) => r.publishId);
  assert.ok(ids.includes(old));
  assert.ok(!ids.includes(fresh), "没满 24 小时的不在结果里");
  const row = today.results.find((r) => r.publishId === old);
  assert.equal(row.play24h, 400);
  assert.equal(row.multiple, 4);
  assert.equal(row.verdictLabel, "比平时好");
});
