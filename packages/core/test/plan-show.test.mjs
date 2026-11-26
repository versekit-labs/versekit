// 发布方案：plan.show / plan.set / plan.reset 与 plan.apply 的联动（#209，ACC-v2-sys-08、ACC-v2-sys-09）。
// 只用 fixture，不碰真实账号或平台。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIFABU_HOME = mkdtempSync(join(tmpdir(), "vk-plan-show-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { COMMANDS, parseArgs } = await import("../src/commands.mjs");
const { matchRoute } = await import("../src/routes.mjs");

const adapters = ["bilibili", "xiaohongshu", "tiktok"].map((platform) => ({ platform }));
const h = createCoreHandlers({ adapters, log: () => {} });
let seq = 0;
before(() => core.migrate());

const dir = mkdtempSync(join(tmpdir(), "vk-plan-show-assets-"));
const file = (name) => {
  const p = join(dir, name);
  writeFileSync(p, `fixture ${name}`);
  return p;
};
function setup() {
  const group = store.addGroup({ name: `方案组 ${++seq}` });
  store.useGroup(group.id);
  store.addAccount({ platform: "bilibili", handle: `@b${seq}`, groupId: group.id });
  store.addAccount({ platform: "xiaohongshu", handle: `@x${seq}`, groupId: group.id });
  return group;
}
function cutOf(language = "zh") {
  const { id } = store.upsertWork({ title: `作品 ${++seq}`, cuts: [{ title: "长片", versions: [{ language, asset: file(`v-${seq}.mp4`) }] }] });
  return store.showWork(id).cuts[0];
}
const platformsOf = (res) => res.created.map((c) => c.platform).sort();

test("命令表里有 plan.show / plan.set / plan.reset / machine.status，HTTP 路由能匹配回自己", () => {
  for (const [name, method, path, usage] of [
    ["plan.show", "GET", "/api/plan", /hifabu plan show/],
    ["plan.set", "POST", "/api/plan", /hifabu plan set/],
    ["plan.reset", "POST", "/api/plan/reset", /hifabu plan reset/],
    ["machine.status", "GET", "/api/machine", /hifabu machine/],
  ]) {
    const c = COMMANDS.find((x) => x.name === name);
    assert.ok(c, name);
    assert.deepEqual(c.http, { method, path });
    assert.match(c.cli.usage, usage);
    assert.equal(matchRoute(method, path)?.command, name);
  }
  assert.deepEqual(parseArgs(COMMANDS.find((x) => x.name === "plan.set"), { platforms: ["bilibili"], delayDays: 1 }), { platforms: ["bilibili"], delayDays: 1 });
});

test("ACC-v2-sys-08：没改过就是默认方案，列出组里已接入的平台；规则带「默认值」标记", () => {
  const group = setup();
  const view = h["plan.show"]({});
  assert.equal(view.group.id, group.id);
  assert.equal(view.isDefault, true);
  assert.equal(view.rows.length, 1);
  assert.deepEqual(view.rows[0].platforms.map((p) => p.platform).sort(), ["bilibili", "xiaohongshu"]);
  assert.equal(view.rows[0].label, "成片 · 所有语言");
  assert.ok(view.rules.every((r) => r.isDefault === true && r.dailyCap === 10 && r.minGapMinutes === 10));
});

test("ACC-v2-sys-08：改方案后新作品按新方案生成平台稿，已生成的平台稿不变", () => {
  setup();
  const before = cutOf();
  const first = h["plan.apply"]({ cutId: before.id });
  assert.deepEqual(platformsOf(first), ["bilibili", "xiaohongshu"]);

  const view = h["plan.set"]({ kind: "video", language: "zh", platforms: ["bilibili"], delayDays: 0 });
  assert.equal(view.isDefault, false);
  assert.ok(view.rows.some((r) => r.kind === "video" && r.language === "zh" && r.platforms.length === 1));

  const after = cutOf();
  assert.deepEqual(platformsOf(h["plan.apply"]({ cutId: after.id })), ["bilibili"]);
  // 旧成片的平台稿原样还在，再 apply 也不会因为方案变了而删掉或新增
  const again = h["plan.apply"]({ cutId: before.id });
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, 1); // 方案现在只发 B站，小红书那条早就生成的稿不被动
  assert.equal(again.skipped[0].platform, "bilibili");
  assert.equal(core.open().prepare("SELECT COUNT(*) n FROM publish WHERE cut_id = ?").get(before.id).n, 2);
});

test("改节奏：delayDays 把建议时间往后推", () => {
  setup();
  h["plan.set"]({ platforms: ["bilibili"], delayDays: 2 });
  const res = h["plan.apply"]({ cutId: cutOf().id });
  const at = res.created[0].suggestedAt;
  assert.ok(at - Date.now() >= 2 * 86400e3 - 5 * 60e3, "至少晚两天");
  assert.match(h["plan.show"]({}).rows[0].rhythm, /第 2 天/);
});

test("方案没有命中的行：plan.apply 说人话报错，不静默", () => {
  setup();
  h["plan.set"]({ kind: "image", language: "zh", platforms: ["xiaohongshu"] });
  h["plan.set"]({ remove: true }); // 去掉兜底的「成片 · 所有语言」行，只剩图片中文
  assert.throws(() => h["plan.apply"]({ cutId: cutOf().id }), /发布方案里没有「视频 · 中文」/);
});

test("方案里的平台组里没接入：报错带出路", () => {
  setup();
  h["plan.set"]({ platforms: ["tiktok"] });
  assert.throws(() => h["plan.apply"]({ cutId: cutOf().id }), /还没有这些平台的账号/);
});

test("--accounts 显式指定时不受方案限制；plan.reset 恢复默认；plan.set 校验输入", () => {
  setup();
  h["plan.set"]({ platforms: ["bilibili"] });
  assert.deepEqual(platformsOf(h["plan.apply"]({ cutId: cutOf().id, accounts: ["xiaohongshu"] })), ["xiaohongshu"]);
  assert.throws(() => h["plan.set"]({ platforms: ["nope"] }), /没有 nope 适配器/);
  assert.throws(() => h["plan.set"]({ platforms: [] }), /要发到哪些平台/);
  assert.throws(() => h["plan.set"]({ platforms: ["bilibili"], kind: "audio" }), /成片类型/);
  assert.throws(() => h["plan.set"]({ platforms: ["bilibili"], delayDays: -1 }), /0 到/);
  assert.equal(h["plan.reset"]({}).isDefault, true);
  assert.deepEqual(platformsOf(h["plan.apply"]({ cutId: cutOf().id })), ["bilibili", "xiaohongshu"]);
});

test("plan.set --remove 删一行；最后一行不能删", () => {
  setup();
  h["plan.set"]({ kind: "video", language: "zh", platforms: ["bilibili"] });
  const two = h["plan.show"]({});
  assert.equal(two.rows.length, 2); // 默认行被保留成显式行 + 新行
  h["plan.set"]({ kind: "video", language: "zh", remove: true });
  assert.equal(h["plan.show"]({}).rows.length, 1);
  assert.throws(() => h["plan.set"]({ remove: true }), /至少要留一行/);
});

test("方案按账号组各存一份", () => {
  const a = setup();
  h["plan.set"]({ platforms: ["bilibili"] });
  const b = setup();
  assert.equal(h["plan.show"]({}).isDefault, true);
  assert.equal(h["plan.show"]({ group: a.id }).isDefault, false);
  assert.equal(h["plan.show"]({ group: b.id }).isDefault, true);
});

test("ACC-v2-sys-09：machine.status 的数字与 today 同源；心跳决定在线", () => {
  setup();
  let m = h["machine.status"]({});
  assert.equal(m.online, false);
  assert.equal(m.heartbeatAt, null);
  assert.equal(m.queued.count, 0);
  assert.equal(m.awaiting.count, 0);

  h["plan.apply"]({ cutId: cutOf().id });
  store.recordHeartbeat(Date.now() - 10e3);
  m = h["machine.status"]({});
  assert.equal(m.online, true);
  assert.equal(m.awaiting.count, 2);
  assert.equal(m.awaiting.count, h["today"]({}).awaiting.reduce((n, w) => n + w.cuts.reduce((k, c) => k + c.publishes.length, 0), 0));

  store.recordHeartbeat(Date.now() - 10 * 60e3);
  assert.equal(h["machine.status"]({}).online, false);
});
