// plan.apply：按成片生成平台稿（#160，ACC-v2-plan-01/02/03、ACC-v2-copy-01/02/03）。
// 只用 fixture 与 dry-run，不碰任何真实账号或平台。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-plan-apply-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { publishInputFor } = await import("../src/publish-flow.mjs");
const { COMMANDS, findCommand, parseArgs } = await import("../src/commands.mjs");
const bilibili = (await import("../../adapter-bilibili/src/index.mjs")).default;
const xhs = (await import("../../adapter-xiaohongshu/src/index.mjs")).default;

const adapters = ["bilibili", "xiaohongshu", "tiktok"].map((platform) => ({ platform }));
const h = createCoreHandlers({ adapters, log: () => {} });
const MIN = 60e3;
let seq = 0;
before(() => core.migrate());

const dir = mkdtempSync(join(tmpdir(), "vk-plan-assets-"));
const file = (name) => {
  const p = join(dir, name);
  writeFileSync(p, `fixture ${name}`);
  return p;
};

/** 一个账号组，里面 B站、小红书各一个号；当前组指向它。 */
function setup() {
  const group = store.addGroup({ name: `方案组 ${++seq}` });
  store.useGroup(group.id);
  const bili = store.addAccount({ platform: "bilibili", handle: `@b${seq}`, groupId: group.id });
  const red = store.addAccount({ platform: "xiaohongshu", handle: `@x${seq}`, groupId: group.id });
  return { group, bili, red };
}
/** 入库一个有长片、短片的作品，返回短片的 cutId。 */
function ingest(extra = {}) {
  const { id } = store.upsertWork({
    title: `长短片作品 ${++seq}`,
    cuts: [
      { title: "长片", versions: [{ language: "zh", asset: file(`long-${seq}.mp4`) }] },
      { title: "短片标题", ...extra, versions: [{ language: "en", asset: file(`short-en-${seq}.mp4`) }, { language: "zh", asset: file(`short-zh-${seq}.mp4`) }] },
    ],
  });
  const work = store.showWork(id);
  return { work, long: work.cuts[0], short: work.cuts[1] };
}

test("命令表里有 plan.apply（CLI、HTTP 由它派生）", () => {
  const c = COMMANDS.find((x) => x.name === "plan.apply");
  assert.ok(c);
  assert.match(c.cli.usage, /vk plan apply <cutId> \[--accounts a,b\] \[--group <组>\]/);
});

test("ACC-v2-plan-01：默认当前组所有账号各一条，待确认，挂在这支成片的 zh 版本上；重复执行不新建", () => {
  setup();
  const { work, short } = ingest();
  const r = h["plan.apply"]({ cutId: short.id });
  assert.equal(r.created.length, 2);
  assert.deepEqual(r.created.map((c) => c.state), ["pending_confirm", "pending_confirm"]);
  assert.equal(r.language, "zh");
  const view = store.showWork(work.id).cuts[1];
  assert.equal(view.publishes.length, 2);
  assert.ok(view.publishes.every((p) => p.language === "zh" && p.state === "pending_confirm"));
  assert.deepEqual(new Set(view.publishes.map((p) => p.platform)), new Set(["bilibili", "xiaohongshu"]));
  assert.equal(store.showWork(work.id).cuts[0].publishes.length, 0, "长片上没有建");

  const again = h["plan.apply"]({ cutId: short.id });
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, 2);
  assert.equal(store.showWork(work.id).cuts[1].publishes.length, 2);
});

test("ACC-v2-plan-01：--accounts 只建指定的；写错的账号整条拒绝、什么都不建", () => {
  const { bili } = setup();
  const { work, short } = ingest();
  assert.throws(() => h["plan.apply"]({ cutId: short.id, accounts: [bili.id, "acc_nope"] }), /没有账号/);
  assert.equal(store.showWork(work.id).cuts[1].publishes.length, 0);
  const r = h["plan.apply"]({ cutId: short.id, accounts: [bili.id] });
  assert.deepEqual(r.created.map((c) => c.accountId), [bili.id]);
  assert.throws(() => h["plan.apply"]({ cutId: "cut_nope" }), /没有这支成片/);
});

test("失效账号不静默丢：列在 rejected 里带原因", () => {
  const { red } = setup();
  store.setAccountState(red.id, "expired");
  const { short } = ingest();
  const r = h["plan.apply"]({ cutId: short.id });
  assert.equal(r.created.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].accountId, red.id);
});

test("ACC-v2-plan-02：同账号已有 10 分钟后的平台稿，新稿建议时间不早于它之后 10 分钟", () => {
  const { bili } = setup();
  const other = store.createWork({ title: "占位", assetPath: "/tmp/a.mp4" });
  const busyAt = Date.now() + 10 * MIN;
  store.createPublish({ workId: other.id, accountId: bili.id, scheduledAt: busyAt });
  const { short } = ingest();
  const r = h["plan.apply"]({ cutId: short.id, accounts: [bili.id] });
  assert.ok(r.created[0].suggestedAt >= busyAt + 10 * MIN, "不早于占位之后 10 分钟");
  const row = store.getPublish(r.created[0].publishId);
  assert.equal(row.scheduled_at, r.created[0].suggestedAt);
});

test("ACC-v2-copy-01：清单文案按平台限制校验，超限拒绝并指出平台、字段、限多少", () => {
  const base = { title: "作品", cuts: [{ title: "片", versions: [{ language: "zh", asset: file("c1.mp4") }] }] };
  const withCopy = (copy) => store.upsertWork({ ...base, cuts: [{ ...base.cuts[0], copy }] });
  assert.throws(() => withCopy({ xiaohongshu: { title: "一二三四五六七八九十一二三四五六七八九十一" } }), /小红书 标题最多 20 字，现在是 21 字/);
  assert.throws(() => withCopy({ bilibili: { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) } }), /B站 话题最多 10 个/);
  assert.throws(() => withCopy({ bilibili: { tags: ["x".repeat(21)] } }), /B站 每个话题最多 20 字/);
  assert.throws(() => withCopy({ tiktok: { body: "x".repeat(2201) } }), /TikTok 文案.*最多 2200/);
  assert.throws(() => withCopy({ douyin: { body: "x".repeat(1001) } }), /抖音 文案.*最多 1000/);
  assert.throws(() => withCopy({ youtube: { title: "x".repeat(101) } }), /YouTube 标题最多 100/);
  assert.throws(() => withCopy({ weibo: { title: "x" } }), /不认识的平台「weibo」/);
  assert.throws(() => withCopy({ bilibili: { titel: "x" } }), /没有「titel」这个字段/);
});

test("ACC-v2-copy-02：plan.apply 把平台文案写进平台稿；没有就用默认文案，再没有就用成片标题", () => {
  setup();
  const { work, short } = ingest({
    copy: {
      title: "默认标题",
      body: "默认正文",
      tags: ["默认"],
      bilibili: { title: "B站标题", body: "B站简介", tags: ["a", "#b"] },
    },
  });
  h["plan.apply"]({ cutId: short.id });
  const byPlatform = Object.fromEntries(store.showWork(work.id).cuts[1].publishes.map((p) => [p.platform, p]));
  assert.equal(byPlatform.bilibili.title, "B站标题");
  assert.equal(byPlatform.bilibili.body, "B站简介");
  assert.deepEqual(byPlatform.bilibili.tags, ["a", "b"]);
  assert.equal(byPlatform.xiaohongshu.title, "默认标题", "没有小红书文案就用默认文案");
  assert.equal(byPlatform.xiaohongshu.body, "默认正文");
  assert.deepEqual(byPlatform.xiaohongshu.empty, []);

  setup();
  const bare = ingest();
  const r = h["plan.apply"]({ cutId: bare.short.id });
  assert.equal(r.created[0].title, "短片标题");
  assert.deepEqual(r.created[0].empty, ["body", "tags"], "正文、话题为空要标出来");
  assert.equal(store.showWork(bare.work.id).cuts[1].publishes[0].body, "");
});

test("默认文案放进某平台超限：这条不建、说明原因，不截断", () => {
  setup();
  const { short } = ingest({ copy: { title: "x".repeat(30) } });
  const r = h["plan.apply"]({ cutId: short.id });
  assert.deepEqual(r.created.map((c) => c.platform), ["bilibili"]);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /小红书 标题最多 20 字/);
});

test("ACC-v2-plan-03 / copy-03：适配器拿到的是成片标题和这条平台稿的文案，各平台不同", async () => {
  setup();
  const { work, short } = ingest({
    copy: { bilibili: { title: "B站短片", body: "B站简介", tags: ["b1", "b2"] }, xiaohongshu: { title: "红书短片", body: "红书正文", tags: ["r1"] } },
  });
  assert.notEqual(work.title, short.title);
  h["plan.apply"]({ cutId: short.id });
  const pubs = Object.fromEntries(store.showWork(work.id).cuts[1].publishes.map((p) => [p.platform, p]));

  const biliInput = publishInputFor(pubs.bilibili.id, { dryRun: true });
  assert.equal(biliInput.copy.title, "B站短片");
  const bili = await bilibili.publish(biliInput);
  assert.equal(bili.title, "B站短片", "不是作品标题");
  assert.deepEqual(bili.tags, ["b1", "b2"]);
  assert.equal(bili.args[bili.args.indexOf("--desc") + 1], "B站简介");
  assert.equal(bili.args[bili.args.indexOf("--tag") + 1], "b1,b2");

  const red = await xhs.publish(publishInputFor(pubs.xiaohongshu.id, { dryRun: true }));
  assert.equal(red.target.title, "红书短片");
  assert.equal(red.target.bodyPreview, "红书正文");
  assert.deepEqual(red.target.tags, ["r1"]);
});

test("只给成片标题：适配器拿到成片标题而不是作品标题；人改过的标题优先", async () => {
  setup();
  const { work, short } = ingest();
  h["plan.apply"]({ cutId: short.id, accounts: ["bilibili"] });
  const p = store.showWork(work.id).cuts[1].publishes[0];
  assert.equal((await bilibili.publish(publishInputFor(p.id, { dryRun: true }))).title, "短片标题");
  store.editPublish({ publishId: p.id, title: "人改的标题" });
  assert.equal((await bilibili.publish(publishInputFor(p.id, { dryRun: true }))).title, "人改的标题");
});

test("ACC-v2-copy-04：publish.edit 可改正文、话题；适配器收到改后的值；清空后「没有正文/没有话题」", async () => {
  setup();
  const { work, short } = ingest({ copy: { bilibili: { title: "B站标题", body: "入库正文", tags: ["a", "b"] } } });
  h["plan.apply"]({ cutId: short.id, accounts: ["bilibili"] });
  const view = () => store.showWork(work.id).cuts[1].publishes[0];
  const p = view();
  assert.equal(p.body, "入库正文");

  const r = h["publish.edit"]({ publishId: p.id, body: "人改的正文", tags: ["#新话题", " 第二个 "] });
  assert.equal(r.body, "人改的正文");
  assert.deepEqual(view().tags, ["新话题", "第二个"]);
  const out = await bilibili.publish(publishInputFor(p.id, { dryRun: true }));
  assert.equal(out.args[out.args.indexOf("--desc") + 1], "人改的正文");
  assert.deepEqual(out.tags, ["新话题", "第二个"]);

  h["publish.edit"]({ publishId: p.id, body: "", tags: [] });
  assert.equal(view().body, "");
  assert.deepEqual(view().tags, []);
  assert.deepEqual(view().empty.filter((k) => k !== "title"), ["body", "tags"]);
});

test("ACC-v2-copy-04：经 parseArgs（CLI/HTTP 入口）给空正文也能清空，而不是被当成没填", () => {
  setup();
  const { work, short } = ingest({ copy: { bilibili: { title: "B站标题", body: "入库正文", tags: ["a"] } } });
  h["plan.apply"]({ cutId: short.id, accounts: ["bilibili"] });
  const p = store.showWork(work.id).cuts[1].publishes[0];
  const cmd = findCommand("publish.edit");
  const args = parseArgs(cmd, { publishId: p.id, body: "" });
  assert.equal(args.body, "", "空字符串要保留下来");
  h["publish.edit"](args);
  assert.equal(store.showWork(work.id).cuts[1].publishes[0].body, "");
  // 其他可选参数的空串仍当没填
  assert.deepEqual(parseArgs(cmd, { publishId: p.id, title: "" }), { publishId: p.id });
});

test("ACC-v2-copy-04：改正文、话题按平台限制校验，超限给人话且不落库；只改时间不受已超限标题影响", () => {
  setup();
  const { work, short } = ingest({ copy: { xiaohongshu: { title: "短标题", body: "正文" } } });
  h["plan.apply"]({ cutId: short.id, accounts: ["xiaohongshu", "bilibili"] });
  const pubs = Object.fromEntries(store.showWork(work.id).cuts[1].publishes.map((x) => [x.platform, x]));
  assert.throws(() => h["publish.edit"]({ publishId: pubs.xiaohongshu.id, body: "字".repeat(1001) }), /小红书 正文最多 1000 字，现在是 1001 字/);
  assert.throws(() => h["publish.edit"]({ publishId: pubs.xiaohongshu.id, title: "题".repeat(21) }), /小红书 标题最多 20 字/);
  assert.throws(() => h["publish.edit"]({ publishId: pubs.bilibili.id, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), /B站 话题最多 10 个/);
  assert.throws(() => h["publish.edit"]({ publishId: pubs.bilibili.id, tags: ["字".repeat(21)] }), /每个话题最多 20 字/);
  assert.equal(store.showWork(work.id).cuts[1].publishes.find((x) => x.platform === "xiaohongshu").body, "正文");
  assert.throws(() => h["publish.edit"]({ publishId: pubs.bilibili.id }), /要改什么/);
});
