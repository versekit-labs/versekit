// ACC-v3-fid-12 · 同一件事各处说法一致：
//   ① 作品列表「最好的一条」和数据页同一作品的倍数一致（同一个「平时」口径）
//   ② 成片还没有平台稿时，成片列表不写「已发布」，和页头「还没有平台稿」是同一句
//   ③ 系统页页头「有 N 件事要处理」的 N 等于页面上列出来的条数
// 数据用 vk demo seed 的演示数据（发布没挂成片，正是之前对不上的那种）。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-consistency-"));
const { seedDemoAsync } = await import("../../../scripts/demo-seed.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const store = await import("../src/store.mjs");
const core = await import("../src/index.mjs");

const handlers = createCoreHandlers({ adapters: [], log: () => {} });
const PUB = (f) => readFileSync(new URL(`../../web/public/${f}`, import.meta.url), "utf8");
const PROBLEM = ["failed", "blocked", "expired"];

before(async () => {
  await seedDemoAsync();
});

test("① 作品列表「最好的一条」的倍数 = 数据页同一作品里最大的倍数", () => {
  const works = handlers["work.list"]({}).works ?? handlers["work.list"]({});
  const rows = handlers["stats.works"]({}).rows;
  const byWork = new Map();
  for (const r of rows) {
    const m = r.baseline?.multiple;
    if (m == null) continue;
    byWork.set(r.workId, Math.max(byWork.get(r.workId) ?? -Infinity, m));
  }
  assert.ok(byWork.size >= 3, "演示数据里至少三个作品有倍数");
  for (const [workId, top] of byWork) {
    const w = works.find((x) => x.id === workId);
    assert.ok(w, `作品列表里有 ${workId}`);
    const best = Math.max(...(w.compared ?? []).map((c) => c.multiple));
    assert.equal(best, top, `${w.title}：列表 ${best} 倍，数据页 ${top} 倍`);
  }
});

test("② 没有平台稿的成片：状态是「还没有平台稿」，成片列表不写「已发布」", () => {
  const work = store.createWork({ title: "还没拆平台稿的作品", assetPath: "/tmp/none.mp4" });
  const view = store.showWork(work.id);
  assert.ok(view.cuts.length >= 1);
  for (const c of view.cuts) {
    assert.equal(c.publishes.length, 0);
    assert.equal(c.status.key, "none");
    assert.equal(c.status.label, "还没有平台稿");
  }
  assert.equal(view.status.label, "还没有平台稿", "页头用的就是这一句");
  // 页面：没有平台稿的成片先判这一条，才轮到「已发布」。
  const src = PUB("panel.js");
  const at = src.indexOf("!c.publishes.length");
  assert.ok(at > 0 && at < src.indexOf('["pub", "已发布"]', at), "成片步骤条先判没有平台稿");
});

test("③ 系统页：待处理数和列出的条数同源（今天页的出问题平台稿）", () => {
  const today = handlers["today"]({});
  const inDb = core.open().prepare(`SELECT COUNT(*) n FROM publish WHERE state IN (${PROBLEM.map(() => "?").join(",")})`).get(...PROBLEM).n;
  assert.ok(inDb >= 1);
  assert.equal(today.problems.length, inDb, "今天页列出的出问题平台稿 = 库里现在出问题的");
  const sys = PUB("system.html");
  // 列表的数据源和页头计数都读 ui.problems（由 today.problems 直接映射，不再按「近 7 天有失败任务」二次过滤）。
  assert.match(sys, /ui\.problems = \(ui\.today\?\.problems \?\? \[\]\)\.map/);
  assert.match(sys, /const needs = [^\n]*ui\.problems\.length/);
  assert.doesNotMatch(sys, /ui\.today\?\.problems\?\.length/);
});

test("fid-11/13/14 页面里的文案与细节", () => {
  const sys = PUB("system.html");
  assert.doesNotMatch(sys, /这台电脑/, "发布机文案写设备名");
  assert.doesNotMatch(sys, /这台发布机现在/);
  assert.doesNotMatch(PUB("today.html"), /小红书每条单独确认。<\/div>/);
  assert.doesNotMatch(PUB("works.html"), /日历只看不改/);
  assert.match(PUB("panel.js"), /mode === "now" && batch\.includes\(p\)/, "底栏选现在发 → 时间列整列「现在发」");
  assert.equal(handlers["machine.status"]({}).name, "发布机", "没起名叫「发布机」，不是主机名");
  const panel = PUB("panel.js");
  assert.match(panel, /noCover/, "封面为空不请求 ?cover=1");
  assert.match(panel, /data-sep/, "没时长时不出现孤立的「·」");
});

test("④ ACC-v3-fid-14 数据页每一条都有成片名（平台稿没记 cut_id 时用作品唯一那支成片）", () => {
  for (const range of ["all", "30d"]) {
    const rows = handlers["stats.works"]({ range }).rows;
    const missing = rows.filter((r) => !r.cutTitle && (r.cutCount ?? 0) === 1);
    assert.deepEqual(missing.map((r) => r.title), [], `${range}：只有一支成片的作品行都该带成片名`);
  }
});

test("⑤ ACC-v3-fid-11 系统页没有写在普通引号里的 ${} 模板（会原样显示）", () => {
  const src = PUB("system.html");
  const bad = src.split("\n").filter((l) => /(?<![`])'[^'`\n]*\$\{[^'`\n]*'/.test(l) && !/`/.test(l));
  assert.deepEqual(bad, []);
  assert.ok(!src.includes(`'<div class="sub">\${`) && !src.includes(`' disabled title="\${`), "离线提示的模板要用反引号");
});
