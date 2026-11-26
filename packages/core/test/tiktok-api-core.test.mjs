// TikTok 官方接口（platform = tiktok-api）在 core 层的规则（#143）：后端互斥、确认前必须选隐私级别、
// 发布设置的校验、对人展示的平台名、排期规则。只用 fixture，不碰网络与真实账号。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIFABU_HOME = mkdtempSync(join(tmpdir(), "vk-tta-core-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const overview = await import("../src/overview.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { COMMANDS, parseArgs, findCommand } = await import("../src/commands.mjs");
const { planRules, assertPlanSlot } = await import("../src/schedule-rules.mjs");
const { updateConfig } = await import("../src/config.mjs");

const h = createCoreHandlers({ adapters: [{ platform: "tiktok" }, { platform: "tiktok-api" }, { platform: "bilibili" }], log: () => {} });
let seq = 0;
before(() => core.migrate());

const group = () => store.addGroup({ name: `组 ${++seq}` }).id;
const account = (platform, handle, groupId = group()) => store.addAccount({ platform, handle, groupId });
function pub(accountId, extra = {}) {
  const work = store.createWork({ title: `作品 ${++seq}`, assetPath: "/tmp/a.mp4" });
  return store.createPublish({ workId: work.id, accountId, ...extra }).id;
}

test("互斥：同一个 handle 已挂浏览器后端，再挂官方接口要拒绝并给人话，反过来也一样", () => {
  account("tiktok", "@same");
  assert.throws(() => account("tiktok-api", "@same"), /已经用「浏览器自动化」接入 TikTok.*不能同时挂两个后端/);
  account("tiktok-api", "@other");
  assert.throws(() => account("tiktok", "@other"), /已经用「官方接口」接入 TikTok.*不能同时挂两个后端/);
  // @ 与大小写不影响判断
  assert.throws(() => account("tiktok-api", "SAME"), /不能同时挂两个后端/);
  // 错误里不出现内部 id
  try {
    account("tiktok-api", "@same");
  } catch (err) {
    assert.ok(!err.message.includes("tiktok-api"), err.message);
  }
});

test("互斥：同一个组里 TikTok 只有一个槽位，换后端要先移除", () => {
  const g = group();
  const a = account("tiktok", "@slot-a", g);
  assert.throws(() => account("tiktok-api", "@slot-b", g), /TikTok 已被 @slot-a 占用/);
  store.removeAccount(a.id);
  assert.doesNotThrow(() => account("tiktok-api", "@slot-b", g), "移除后可以换后端");
});

test("互斥：已移除的账号不占着 handle", () => {
  const a = account("tiktok", "@gone");
  store.removeAccount(a.id);
  assert.doesNotThrow(() => account("tiktok-api", "@gone"));
});

test("--to tiktok 能选到官方接口后端的账号；失效的同样被排除", () => {
  const g = group();
  const a = account("tiktok-api", "@pick", g);
  const found = store.accountsForPlatforms(["tiktok"], { groupId: g });
  assert.deepEqual(found.accounts.map((x) => x.id), [a.id]);
  store.setAccountState(a.id, "expired");
  const blocked = store.accountsForPlatforms(["tiktok"], { groupId: g });
  assert.equal(blocked.accounts.length, 0);
  assert.deepEqual(blocked.blocked, ["tiktok"]);
});

test("对人展示的平台名都是 TikTok", () => {
  assert.equal(store.platformLabelOf("tiktok-api"), "TikTok");
  assert.equal(store.platformLabelOf("tiktok"), "TikTok");
  assert.equal(store.platformLabelOf("bilibili"), "bilibili");
  const col = overview.MATRIX_COLUMNS.find((c) => c.platform === "tiktok");
  assert.ok(col.aliases.includes("tiktok-api"));
  const g = group();
  account("tiktok-api", "@matrix", g);
  const matrix = overview.buildBootstrap();
  const cell = matrix.matrix.groups.find((x) => x.id === g).cells.find((c) => c.platform === "tiktok");
  assert.equal(cell.filled, true);
  assert.equal(cell.label, "TikTok");
});

test("确认前必须选隐私级别：approve / now 拒绝并给人话；选了才放行", () => {
  const acc = account("tiktok-api", "@approve");
  const id = pub(acc.id);
  assert.throws(() => store.approvePublishes({ publishId: id }), /TikTok 发布前要先选隐私级别，没选不会发/);
  assert.throws(() => store.publishNow({ publishId: id }), /没选不会发/);
  assert.equal(core.open().prepare("SELECT state FROM publish WHERE id=?").get(id).state, "pending_confirm");
  store.editPublish({ publishId: id, privacy: "SELF_ONLY" });
  assert.equal(store.approvePublishes({ publishId: id }).approved[0].state, "queued");
});

test("确认前必须选隐私级别：整支成片确认时，缺设置的单独列出、其他平台照常确认，不静默", () => {
  const g = group();
  const tk = account("tiktok-api", "@cut-tk", g);
  const bili = account("bilibili", "@cut-bili", g);
  const work = store.createWork({ title: `作品 ${++seq}`, assetPath: "/tmp/a.mp4" });
  const p1 = store.createPublish({ workId: work.id, accountId: tk.id });
  const p2 = store.createPublish({ workId: work.id, accountId: bili.id });
  const r = store.approvePublishes({ cutId: p1.cutId });
  assert.deepEqual(r.approved.map((x) => x.publishId), [p2.id]);
  assert.equal(r.incomplete.length, 1);
  assert.equal(r.incomplete[0].publishId, p1.id);
  assert.match(r.incomplete[0].reason, /隐私级别/);
  // 只剩缺设置的：整体拒绝并说原因
  assert.throws(() => store.approvePublishes({ cutId: p1.cutId }), /还不能确认.*隐私级别/s);
});

test("送草稿箱不需要隐私级别；改成 --no-draft 后又需要", () => {
  const acc = account("tiktok-api", "@draft");
  const id = pub(acc.id);
  const r = store.editPublish({ publishId: id, draft: true });
  assert.equal(r.tiktok.draft, true);
  assert.equal(core.open().prepare("SELECT mode FROM publish WHERE id=?").get(id).mode, "draft", "走现有 draft 模式，不新增状态");
  assert.equal(store.approvePublishes({ publishId: id }).approved[0].state, "queued");

  const id2 = pub(account("tiktok-api", "@draft2").id);
  store.editPublish({ publishId: id2, draft: true });
  store.editPublish({ publishId: id2, draft: false });
  assert.equal(core.open().prepare("SELECT mode FROM publish WHERE id=?").get(id2).mode, "auto");
  assert.throws(() => store.approvePublishes({ publishId: id2 }), /隐私级别/);
});

test("发布设置：评论/合拍/拼接默认全关；人改了才开；文案可改；overrides 里留着", () => {
  const id = pub(account("tiktok-api", "@settings").id);
  const r = store.editPublish({ publishId: id, privacy: "SELF_ONLY", comment: true, caption: "新文案" });
  assert.equal(r.tiktok.privacy_level, "SELF_ONLY");
  assert.equal(r.tiktok.allow_comment, true);
  assert.equal(r.tiktok.allow_duet, undefined, "没动过的开关不写，适配器按「关」处理");
  assert.equal(r.tiktok.caption, "新文案");
  const o = JSON.parse(core.open().prepare("SELECT overrides_json FROM publish WHERE id=?").get(id).overrides_json);
  assert.deepEqual(o.tiktok, { privacy_level: "SELF_ONLY", allow_comment: true });
  assert.equal(o.caption, "新文案");
  store.editPublish({ publishId: id, comment: false });
  assert.equal(JSON.parse(core.open().prepare("SELECT overrides_json FROM publish WHERE id=?").get(id).overrides_json).tiktok.allow_comment, false);
  const ev = core.open().prepare("SELECT payload_json FROM event WHERE type='publish.edited' AND publish_id=?").all(id);
  assert.equal(ev.length, 2, "每次改动都留痕");
});

test("发布设置的校验：隐私级别要写原样名字；非 TikTok 官方接口的平台稿不接受这些设置", () => {
  const id = pub(account("tiktok-api", "@validate").id);
  assert.throws(() => store.editPublish({ publishId: id, privacy: "self only" }), /原样名字/);
  const bili = pub(account("bilibili", "@v-bili").id);
  assert.throws(() => store.editPublish({ publishId: bili, privacy: "SELF_ONLY" }), /只适用于 TikTok 官方接口/);
  assert.throws(() => store.editPublish({ publishId: id }), /要改什么/);
});

test("命令表：新增的命令与参数是纯增量，原有 publish.edit 参数照常可用", () => {
  const edit = findCommand("publish.edit");
  assert.deepEqual(parseArgs(edit, { publishId: "p", title: "t", at: 5 }), { publishId: "p", title: "t", at: 5 });
  assert.deepEqual(parseArgs(edit, { publishId: "p", privacy: "SELF_ONLY", comment: false, duet: true, stitch: false, caption: "c", draft: false }), {
    publishId: "p", privacy: "SELF_ONLY", comment: false, duet: true, stitch: false, caption: "c", draft: false,
  });
  assert.throws(() => parseArgs(edit, { publishId: "p", comment: "yes" }), /布尔/);
  const connect = findCommand("account.connect");
  assert.equal(connect.localOnly, true, "授权要在本机完成，卡片按钮不能触发");
  assert.equal(connect.remote, false);
  assert.equal(findCommand("account.creator").http.method, "GET");
  assert.ok(COMMANDS.filter((c) => c.name === "account.connect").length === 1);
});

test("排期规则对官方接口后端生效，并沿用 tiktok 的平台覆盖（按账号算）", () => {
  const acc = account("tiktok-api", "@plan");
  const day = new Date(); day.setDate(day.getDate() + 3); day.setHours(12, 0, 0, 0);
  const t0 = day.getTime();
  const first = pub(acc.id, { scheduledAt: t0 });
  const second = pub(acc.id, { scheduledAt: t0 + 3600e3 });
  const row = store.getPublish(second);
  // 默认最小间隔 10 分钟：5 分钟后太近
  assert.throws(() => assertPlanSlot(row, t0 + 5 * 60e3), (e) => e.code === "plan_min_gap");
  assert.ok(first);
  // 配置里给 tiktok 设了更严的间隔，tiktok-api 同样适用
  updateConfig({ plan: { rules: { platforms: { tiktok: { daily_cap: 2, min_gap_minutes: 30 } } } } });
  try {
    assert.equal(planRules("tiktok-api").minGapMinutes, 30);
    assert.equal(planRules("tiktok-api").dailyCap, 2);
    assert.throws(() => assertPlanSlot(row, t0 + 20 * 60e3), (e) => e.code === "plan_min_gap");
    assert.throws(() => h["publish.edit"]({ publishId: second, at: t0 + 10 * 60e3 }), /最小间隔 30 分钟/);
  } finally {
    updateConfig({ plan: { rules: { platforms: { tiktok: null } } } });
  }
});

test("不是官方接口账号时，account.connect / account.creator 说清楚而不是崩", async () => {
  const bili = account("bilibili", "@nc-bili");
  await assert.rejects(Promise.resolve().then(() => h["account.connect"]({ accountId: bili.id })), /不需要这种授权/);
  await assert.rejects(Promise.resolve().then(() => h["account.creator"]({ accountId: bili.id })), /不是 TikTok 官方接口账号/);
});

test("account.add 之后的下一步提示：官方接口账号指向 vk account connect", () => {
  const g = store.addGroup({ name: `组 ${++seq}` });
  const r = h["account.add"]({ platform: "tiktok-api", name: "主号", handle: "@next", group: g.name });
  assert.match(r.next, /vk account connect/);
});
