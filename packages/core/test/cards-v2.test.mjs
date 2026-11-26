// 飞书确认卡片（#150，ACC-v2-card-01…04）。
//
// 红线：只用 fixture 和假的发送函数（下面的 fakeChannel），不往任何真实飞书会话发消息，
// 也不碰任何平台的真实账号。时间用假时钟钉住，不靠真的等 30 秒。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIFABU_HOME = mkdtempSync(join(tmpdir(), "vk-cards-v2-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const cards = await import("../src/cards.mjs");
const { deliverPending, handleCardEvent, NEW_WORK_DELAY_MS } = await import("../src/notify.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { normalizeFormValue } = await import("../../channel-feishu/src/index.mjs");

const db = () => core.open();
const H = 3600e3;
const OPERATOR = "ou_owner";
const PLATFORMS = ["douyin", "bilibili", "xiaohongshu"];
const handlers = createCoreHandlers({ adapters: PLATFORMS.map((platform) => ({ platform })), log: () => {} });
const binding = { external_user_id: OPERATOR };

before(() => core.migrate());

/** 假通道：按发生顺序记下每一次 send / update，什么都不会真的发出去。 */
function fakeChannel() {
  const log = [];
  let n = 0;
  return {
    channel: "feishu",
    log,
    sent: () => log.filter((e) => e.op === "send"),
    updates: () => log.filter((e) => e.op === "update"),
    async send({ card, openId }) {
      assert.equal(openId, OPERATOR);
      const messageId = `om_${++n}`;
      log.push({ op: "send", messageId, card });
      return { messageId };
    },
    async updateCard({ messageId, card }) {
      log.push({ op: "update", messageId, card });
      return { ok: true };
    },
  };
}

let seq = 0;
/**
 * 一个账号组 + 三个平台账号 + 一个作品两支成片（长片、短片），每支成片每个平台一条平台稿。
 * 事件的 created_at 钉在 T0，deliverPending 用假时钟推进。
 */
function fixture({ groupName = null, twoGroups = false } = {}) {
  // 每个用例从空库开始：账号组数量会改变卡片标题，旧夹具留下的组与事件会互相串。
  db().exec(
    `DELETE FROM delivery; DELETE FROM event; DELETE FROM command_audit; DELETE FROM run; DELETE FROM snapshot;
     DELETE FROM publish; DELETE FROM cut_version; DELETE FROM cut; DELETE FROM work; DELETE FROM account; DELETE FROM account_group;`,
  );
  const k = ++seq;
  const groupId = store.addGroup({ name: groupName ?? `卡片组 ${k}` }).id;
  if (twoGroups) store.addGroup({ name: `另一组 ${k}` });
  const acc = Object.fromEntries(PLATFORMS.map((p) => [p, store.addAccount({ platform: p, handle: `@${p}${k}`, groupId }).id]));
  const w = store.upsertWork({
    title: `露营小记 ${k}`,
    source: `/tmp/cards-v2-${k}.mp4`,
    cuts: [
      { title: "长片", versions: [{ language: "zh", asset: `/tmp/cards-v2-${k}-long.mp4` }] },
      { title: "短片一", versions: [{ language: "zh", asset: `/tmp/cards-v2-${k}-short.mp4` }] },
    ],
  });
  const cutIds = db().prepare("SELECT id FROM cut WHERE work_id = ? ORDER BY position").all(w.id).map((r) => r.id);
  const at = Date.now() + 5 * H;
  const pubs = {};
  cutIds.forEach((cutId, ci) => {
    for (const p of PLATFORMS) {
      pubs[`${ci}:${p}`] = store.createPublish({ workId: w.id, cutId, accountId: acc[p], scheduledAt: at + ci * H + PLATFORMS.indexOf(p) * 20 * 60e3 }).id;
    }
  });
  const eventRow = db().prepare("SELECT * FROM event WHERE type='work.awaiting_confirm' AND dedupe_key=?").get(`work:${w.id}:awaiting_confirm`);
  const T0 = 1_800_000_000_000;
  db().prepare("UPDATE event SET created_at = ? WHERE id = ?").run(T0, eventRow.id);
  return { workId: w.id, cutIds, pubs, groupId, acc, T0, eventId: eventRow.id, title: `露营小记 ${k}` };
}

const cb = (card, cmd) => cards.callbackValues(card).find((v) => v.cmd === cmd);
const click = (channel, card, cmd, { messageId = "om_click", form = undefined, operator = OPERATOR, value = null, now = Date.now() } = {}) => {
  const v = value ?? cb(card, cmd);
  assert.ok(v, `卡片上没有 ${cmd} 按钮`);
  return handleCardEvent({ evt: { action_value: v, operator_id: operator, message_id: messageId, form_value: form }, channel, binding, handlers, now });
};
const text = (card) => JSON.stringify(card);
const stateOf = (id) => store.getPublish(id).state;

/** 把新作品卡片发出来（假时钟 T0+31s），返回它。 */
async function deliverNewWork(f, channel) {
  const res = await deliverPending({ channel, binding, now: f.T0 + NEW_WORK_DELAY_MS + 1e3 });
  assert.equal(res.sent, 1);
  return channel.sent().at(-1).card;
}

// ---------------------------------------------------------------- ACC-v2-card-01

test("ACC-v2-card-01 第一条待确认平台稿发 work.awaiting_confirm，一个作品只发一次", () => {
  const f = fixture();
  const events = db().prepare("SELECT * FROM event WHERE type='work.awaiting_confirm' AND payload_json LIKE ?").all(`%${f.workId}%`);
  assert.equal(events.length, 1, "两支成片六条平台稿，也只有一个事件");
  assert.equal(events[0].dedupe_key, `work:${f.workId}:awaiting_confirm`);
});

test("ACC-v2-card-01 新作品卡片：满 30 秒才发，1 分钟内必发；数量按投递那一刻的状态算", async () => {
  const f = fixture();
  const ch = fakeChannel();
  assert.equal((await deliverPending({ channel: ch, binding, now: f.T0 + NEW_WORK_DELAY_MS - 1 })).sent, 0, "不满 30 秒先等一批平台稿建完");
  assert.equal(ch.sent().length, 0);

  // 等待期间又有一条被别处取消：卡片上的数字是投递时的真实状态，不是事件里的旧数。
  db().prepare("UPDATE publish SET state='canceled' WHERE id = ?").run(f.pubs["1:bilibili"]);
  const sentAt = f.T0 + 45e3;
  assert.ok(sentAt - f.T0 <= 60e3, "1 分钟内");
  const res = await deliverPending({ channel: ch, binding, now: sentAt });
  assert.equal(res.sent, 1);
  const card = ch.sent()[0].card;
  assert.equal(card.header.title.content, "新作品，等你确认");
  assert.equal(card.header.subtitle.content, f.title);
  assert.match(text(card), /2 支成片 · 5 条平台稿/);
  assert.ok(cb(card, "card.review"), "只有一个入口：开始确认");
  assert.equal(cards.callbackValues(card).length, 1);

  assert.equal((await deliverPending({ channel: ch, binding, now: sentAt + 5e3 })).sent, 0, "同一个事件不会发两次");
});

test("ACC-v2-card-01 投递时已经没有待确认的：不发、不重试", async () => {
  const f = fixture();
  db().prepare("UPDATE publish SET state='canceled' WHERE work_id = ?").run(f.workId);
  const ch = fakeChannel();
  assert.equal((await deliverPending({ channel: ch, binding, now: f.T0 + 40e3 })).sent, 0);
  assert.equal(db().prepare("SELECT state FROM delivery WHERE event_id = ?").get(f.eventId).state, "skipped");
  assert.equal((await deliverPending({ channel: ch, binding, now: f.T0 + 90e3 })).considered, 0, "已记为 skipped，不再每 5 秒重判");
});

test("ACC-v2-card-01 开始确认：一支一支发，上一支处理完才发下一支；小红书单独一张，排在这支成片之后", async () => {
  const f = fixture();
  const ch = fakeChannel();
  const newWork = await deliverNewWork(f, ch);
  assert.equal(ch.sent().length, 1);

  await click(ch, newWork, "card.review", { messageId: "om_new" });
  assert.equal(ch.sent().length, 2, "开始确认后只发了第 1 支");
  const first = ch.sent()[1].card;
  assert.equal(first.header.title.content, "长片 · 第 1 支，共 2 支");

  // 第 1 支还没处理，再过多久也不会有第 2 支。
  assert.equal(ch.sent().length, 2);
  await click(ch, first, "publish.approve", { messageId: "om_first" });

  // 顺序：新作品卡片 → 第 1 支 → 新作品卡片收起 → 第 1 支更新成结果 → 第 1 支的小红书 → …
  const order = ch.log.map((e) => `${e.op}:${e.messageId}`);
  assert.deepEqual(order.slice(0, 5), ["send:om_1", "send:om_2", "update:om_new", "update:om_first", "send:om_3"]);
  const xhs = ch.sent()[2].card;
  assert.equal(xhs.header.title.content, "小红书，要你单独确认", "小红书排在下一支成片之前");
  assert.equal(ch.sent().length, 3, "小红书没处理完，第 2 支还没发");
  assert.equal(stateOf(f.pubs["0:douyin"]), "queued");
  assert.equal(stateOf(f.pubs["0:xiaohongshu"]), "pending_confirm", "小红书不会被按成片确认带上");

  await click(ch, xhs, "publish.manual", { messageId: "om_xhs" });
  assert.equal(stateOf(f.pubs["0:xiaohongshu"]), "notify_pending");
  const second = ch.sent()[3].card;
  assert.equal(second.header.title.content, "短片一 · 第 2 支，共 2 支");
  assert.equal(ch.sent().length, 4);

  await click(ch, second, "publish.skip", { messageId: "om_second" });
  assert.ok(PLATFORMS.every((p) => stateOf(f.pubs[`1:${p}`]) === "skipped"), "先不发：整支（含小红书）都跳过");
  assert.equal(ch.sent().length, 4, "没有更多了，不再发卡片");
});

test("ACC-v2-card-01 守护进程重启后点旧卡片：下一张从数据库推，不会重发已处理的", async () => {
  const f = fixture();
  const ch = fakeChannel();
  const newWork = await deliverNewWork(f, ch);
  await click(ch, newWork, "card.review");
  const first = ch.sent()[1].card;
  store.approvePublishes({ cutId: f.cutIds[0] }); // 在电脑上先确认了
  store.skipCut({ cutId: f.cutIds[0] }); // 小红书也先不发
  await click(ch, first, "publish.skip", { messageId: "om_stale" });
  assert.equal(ch.sent().length, 3);
  assert.equal(ch.sent()[2].card.header.title.content, "短片一 · 第 2 支，共 2 支", "这支已经处理完了：不重发它，直接是下一支");
});

// ---------------------------------------------------------------- ACC-v2-card-02

test("ACC-v2-card-02 确认卡片结构：schema 2.0、原地更新、每个平台稿一行、按钮带命令与幂等键", async () => {
  const f = fixture();
  const now = 1_800_000_100_000;
  store.editPublish({ publishId: f.pubs["0:douyin"], title: "抖音专属标题", now: now - 1 });
  const card = cards.buildConfirmCard({
    cut: { id: f.cutIds[0], title: "长片" },
    index: 1,
    total: 2,
    workTitle: f.title,
    rows: [
      { publishId: "p1", platform: "douyin", title: "抖音标题", at: now + H },
      { publishId: "p2", platform: "bilibili", title: "B站标题", at: now + 25 * H },
    ],
    now,
  });
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.template, "yellow");
  assert.equal(card.header.title.content, "长片 · 第 1 支，共 2 支");
  const rows = card.body.elements.filter((e) => e.tag === "markdown" && /^\*\*/.test(e.content));
  assert.equal(rows.length, 2, "平台行按实际平台稿生成，不是固定 6 行");
  assert.match(rows[0].content, /\*\*抖音\*\*　抖音标题\n<font color='grey'>.*\d\d:\d\d<\/font>/);
  assert.match(rows[1].content, /\*\*B站\*\*　B站标题/);
  assert.equal(card.body.elements.filter((e) => e.tag === "hr").length, 1);

  const approve = card.body.elements.find((e) => e.tag === "button");
  assert.equal(approve.type, "primary");
  assert.equal(approve.text.content, "确认这 2 条，按时间发");
  assert.deepEqual(approve.behaviors[0].value.args, { cutId: f.cutIds[0] });
  assert.equal(approve.behaviors[0].value.cmd, "publish.approve");
  assert.equal(approve.behaviors[0].value.exp, now + cards.CARD_TTL_MS);
  assert.ok(approve.behaviors[0].value.key);
  const cols = card.body.elements.find((e) => e.tag === "column_set").columns;
  assert.deepEqual(cols.map((c) => c.elements[0].text.content), ["改标题或时间", "这支先不发"]);
  assert.deepEqual(cols.map((c) => c.elements[0].behaviors[0].value.cmd), ["card.edit", "publish.skip"]);
});

test("ACC-v2-card-02 实际发出的确认卡片：行数 = 这支成片非小红书的平台稿数，标题用改过的", async () => {
  const f = fixture();
  store.editPublish({ publishId: f.pubs["0:douyin"], title: "抖音专属标题" });
  db().prepare("UPDATE publish SET state='canceled' WHERE id = ?").run(f.pubs["0:bilibili"]);
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  const card = ch.sent()[1].card;
  const rows = card.body.elements.filter((e) => e.tag === "markdown" && /^\*\*/.test(e.content));
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /\*\*抖音\*\*　抖音专属标题/);
  assert.equal(card.body.elements.find((e) => e.tag === "button").text.content, "确认这 1 条，按时间发");
});

test("ACC-v2-card-02 改标题或时间：上一张卡片原地换成表单；取消在表单外面，表单里没有带回调的重置", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  const confirm = ch.sent()[1].card;
  await click(ch, confirm, "card.edit", { messageId: "om_edit" });
  const edit = ch.updates().at(-1);
  assert.equal(edit.messageId, "om_edit", "原地更新同一条消息，不是新发");
  assert.equal(ch.sent().length, 2);

  const card = edit.card;
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.title.content, "长片 · 改标题或时间");
  const form = card.body.elements.find((e) => e.tag === "form");
  assert.equal(form.name, `edit_${f.cutIds[0]}`);
  assert.deepEqual(
    form.elements.filter((e) => e.tag === "input" || e.tag === "picker_datetime").map((e) => e.name),
    ["title_douyin", "at_douyin", "title_bilibili", "at_bilibili"],
    "表单只含非小红书的平台稿，控件名与设计稿一致",
  );
  const input = form.elements.find((e) => e.name === "title_douyin");
  assert.equal(input.max_length, 55);
  assert.match(form.elements.find((e) => e.name === "at_douyin").initial_datetime, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  const submit = form.elements.find((e) => e.tag === "button");
  assert.equal(submit.form_action_type, "submit");
  assert.equal(submit.behaviors[0].value.cmd, "publish.edit");
  assert.equal(form.elements.filter((e) => e.tag === "button").length, 1, "表单里只有提交，没有重置按钮");
  const cancel = card.body.elements.at(-1);
  assert.equal(cancel.tag, "button");
  assert.equal(cancel.text.content, "取消");
  assert.equal(cancel.behaviors[0].value.cmd, "card.show");

  await click(ch, card, "card.show", { messageId: "om_edit" });
  assert.equal(ch.updates().at(-1).card.header.title.content, "长片 · 第 1 支，共 2 支", "取消回到确认卡片");
});

test("ACC-v2-card-02 提交表单：改动逐条走 publish.edit；改后回到确认卡片，显示新标题和新时间", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  await click(ch, ch.sent()[1].card, "card.edit", { messageId: "om_edit" });
  const edit = ch.updates().at(-1).card;
  const newAt = Date.now() + 30 * H;
  const d = new Date(newAt);
  const p2 = (n) => String(n).padStart(2, "0");
  const picked = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

  await click(ch, edit, "publish.edit", { messageId: "om_edit", form: { title_douyin: "  新标题  ", at_douyin: picked, title_bilibili: store.resolvePublishCopy(f.pubs["0:bilibili"]).title, at_bilibili: cards.formatPickerTime(store.getPublish(f.pubs["0:bilibili"]).scheduled_at) } });
  const row = store.getPublish(f.pubs["0:douyin"]);
  assert.equal(JSON.parse(row.overrides_json).title, "新标题");
  assert.equal(row.scheduled_at, cards.parsePickerTime(picked));
  assert.equal(row.state, "pending_confirm", "改不等于确认");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM command_audit WHERE name='publish.edit' AND result='ok'").get().n >= 1, true);
  const back = ch.updates().at(-1).card;
  assert.equal(back.header.title.content, "长片 · 第 1 支，共 2 支");
  assert.match(text(back), /新标题/);
  assert.match(text(back), /已改好 1 处/);
});

test("ACC-v2-card-02 表单只校验格式：时间格式不对 / 标题清空，什么都不改，表单留着并说明", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  await click(ch, ch.sent()[1].card, "card.edit", { messageId: "om_edit" });
  const edit = ch.updates().at(-1).card;
  const before = store.getPublish(f.pubs["0:douyin"]);
  await click(ch, edit, "publish.edit", { messageId: "om_edit", form: { title_douyin: "要改的标题", at_douyin: "明天晚上八点", title_bilibili: "", at_bilibili: "" } });
  const after = store.getPublish(f.pubs["0:douyin"]);
  assert.equal(after.overrides_json, before.overrides_json);
  assert.equal(after.scheduled_at, before.scheduled_at);
  const shown = ch.updates().at(-1).card;
  assert.ok(shown.body.elements.some((e) => e.tag === "form"), "表单还在，能接着改");
  assert.match(text(shown), /抖音：时间「明天晚上八点」格式不对/);
  assert.match(text(shown), /B站：标题不能为空/);
});

test("ACC-v2-card-02 平台规则（#151）拒绝的改动：留在表单里，把命令的原话给人看", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  await click(ch, ch.sent()[1].card, "card.edit", { messageId: "om_edit" });
  const edit = ch.updates().at(-1).card;
  const bili = store.getPublish(f.pubs["0:bilibili"]);
  // 把抖音挪到和 B 站同一分钟没问题（不同账号）；挪到过去必被拒。
  const past = new Date(Date.now() - 2 * H);
  const p2 = (n) => String(n).padStart(2, "0");
  const picked = `${past.getFullYear()}-${p2(past.getMonth() + 1)}-${p2(past.getDate())} ${p2(past.getHours())}:${p2(past.getMinutes())}`;
  await click(ch, edit, "publish.edit", { messageId: "om_edit", form: { title_douyin: store.resolvePublishCopy(f.pubs["0:douyin"]).title, at_douyin: picked } });
  assert.match(text(ch.updates().at(-1).card), /抖音：.*过去的时间/);
  assert.ok(ch.updates().at(-1).card.body.elements.some((e) => e.tag === "form"));
});

test("ACC-v2-card-02 小红书单独卡片：结构与按钮；点完原地更新成结果，按钮消失", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  await click(ch, ch.sent()[1].card, "publish.skip", { messageId: "om_c1" }); // 先不发第 1 支，下一张是第 2 支
  const second = ch.sent()[2].card;
  await click(ch, second, "publish.approve", { messageId: "om_c2" });
  const xhs = ch.sent()[3].card;

  assert.equal(xhs.schema, "2.0");
  assert.equal(xhs.header.title.content, "小红书，要你单独确认");
  assert.equal(xhs.header.subtitle.content, `${f.title} · 短片一`);
  const info = xhs.body.elements[0].content;
  assert.match(info, /^\*\*短片一\*\*\n<font color='grey'>zh 版本 · cards-v2-\d+-short\.mp4 · 建议 .*\d\d:\d\d 发 · 今天还能发 \d+ 条<\/font>\n<font color='grey'>没有正文<\/font>\n<font color='grey'>没有话题<\/font>$/);
  const primary = xhs.body.elements.find((e) => e.tag === "button");
  assert.equal(primary.type, "primary");
  assert.match(primary.text.content, /\d\d:\d\d 发$/);
  assert.equal(primary.behaviors[0].value.cmd, "publish.approve");
  assert.deepEqual(primary.behaviors[0].value.args, { publishId: f.pubs["1:xiaohongshu"] });
  const cols = xhs.body.elements.find((e) => e.tag === "column_set").columns;
  assert.deepEqual(cols.map((c) => c.elements[0].text.content), ["现在发", "我自己发"]);
  assert.deepEqual(cols.map((c) => c.elements[0].behaviors[0].value.cmd), ["publish.now", "publish.manual"]);

  await click(ch, xhs, "publish.now", { messageId: "om_x" });
  const done = ch.updates().at(-1);
  assert.equal(done.messageId, "om_x");
  assert.equal(done.card.header.template, "grey");
  assert.equal(cards.callbackValues(done.card).length, 0, "按钮消失");
  assert.match(text(done.card), /已排到现在发/);
  assert.equal(stateOf(f.pubs["1:xiaohongshu"]), "queued");
});

test("ACC-v2-card-02 点完原地更新成结果：确认 / 先不发都是灰色标题、无按钮，内容带真实结果", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  await click(ch, ch.sent()[1].card, "publish.approve", { messageId: "om_c1" });
  const done = ch.updates().find((u) => u.messageId === "om_c1").card;
  assert.equal(done.header.template, "grey");
  assert.equal(done.header.title.content, "长片 · 已确认");
  assert.equal(cards.callbackValues(done).length, 0);
  assert.match(text(done), /已确认 2 条，按时间发/);
  assert.match(text(done), /抖音/);
  assert.match(text(done), /B站/);
  assert.match(text(done), /小红书要你单独确认/);
});

test("ACC-v2-card-02 重复点不会执行第二次：状态命令只审计一次，不重复更新、不重复发下一张", async () => {
  const f = fixture();
  const ch = fakeChannel();
  const newWork = await deliverNewWork(f, ch);
  await click(ch, newWork, "card.review");
  await click(ch, newWork, "card.review"); // 开始确认连点两次
  assert.equal(ch.sent().length, 2, "第 1 支只发了一次");

  const first = ch.sent()[1].card;
  const value = cb(first, "publish.approve");
  await click(ch, first, "publish.approve", { messageId: "om_c1", value });
  const sentAfter = ch.sent().length;
  const updatesAfter = ch.updates().length;
  const second = await click(ch, first, "publish.approve", { messageId: "om_c1", value });
  assert.equal(second.duplicate, true);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM command_audit WHERE idempotency_key = ?").get(value.key).n, 1);
  assert.equal(ch.sent().length, sentAfter, "没有多发下一张");
  assert.equal(ch.updates().length, updatesAfter, "没有拿「已经执行过」盖掉结果");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM run WHERE kind='publish' AND target_id = ?").get(f.pubs["0:douyin"]).n, 1, "只排了一次队");
});

test("ACC-v2-card-02 四道闸仍在：别人点的不执行也不动卡片；过期的不执行", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  const first = ch.sent()[1].card;
  const before = ch.log.length;
  const res = await click(ch, first, "publish.approve", { operator: "ou_stranger" });
  assert.equal(res.ok, false);
  assert.equal(ch.log.length, before, "别人乱点不会把你的确认卡弄没");
  assert.equal(stateOf(f.pubs["0:douyin"]), "pending_confirm");

  const stale = { ...cb(first, "publish.approve"), exp: Date.now() - 1 };
  const expired = await click(ch, first, "publish.approve", { value: stale });
  assert.equal(expired.ok, false);
  assert.equal(stateOf(f.pubs["0:douyin"]), "pending_confirm");
  assert.match(text(ch.updates().at(-1).card), /过期/);
});

test("ACC-v2-card-02 命令执行失败（账号已移除）：确认卡片留着并带原因，不假装成功", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  const first = ch.sent()[1].card;
  db().prepare("UPDATE publish SET state='failed' WHERE id = ?").run(f.pubs["0:douyin"]); // 在别处被改了状态
  db().prepare("UPDATE publish SET state='failed' WHERE id = ?").run(f.pubs["0:bilibili"]);
  const res = await click(ch, first, "publish.approve", { messageId: "om_c1" });
  assert.equal(res.ok, false);
  const shown = ch.updates().at(-1).card;
  assert.equal(shown.header.template, "red");
  assert.match(text(shown), /没有执行/);
});

// ---------------------------------------------------------------- ACC-v2-card-03

test("ACC-v2-card-03 账号组多于一个：每种卡片标题都带组名；只有一个组不带", async () => {
  const many = fixture({ groupName: "美食号", twoGroups: true });
  const ch = fakeChannel();
  const newWork = await deliverNewWork(many, ch);
  assert.equal(newWork.header.title.content, "美食号 · 新作品，等你确认");
  await click(ch, newWork, "card.review");
  const confirm = ch.sent()[1].card;
  assert.equal(confirm.header.title.content, "美食号 · 长片 · 第 1 支，共 2 支");
  await click(ch, confirm, "card.edit", { messageId: "om_e" });
  assert.equal(ch.updates().at(-1).card.header.title.content, "美食号 · 长片 · 改标题或时间");
  await click(ch, ch.updates().at(-1).card, "card.show", { messageId: "om_e" });
  await click(ch, ch.updates().at(-1).card, "publish.approve", { messageId: "om_e" });
  assert.equal(ch.sent().at(-1).card.header.title.content, "美食号 · 小红书，要你单独确认");
  assert.equal(ch.updates().at(-1).card.header.title.content, "美食号 · 长片 · 已确认");
});

test("ACC-v2-card-03 纯函数：groupName 为空不带前缀，有值才带", () => {
  const base = { cut: { id: "c", title: "长片" }, index: 1, total: 1, workTitle: "w", rows: [{ publishId: "p", platform: "douyin", title: "t", at: null }] };
  assert.equal(cards.buildConfirmCard({ ...base }).header.title.content, "长片 · 第 1 支，共 1 支");
  assert.equal(cards.buildConfirmCard({ ...base, groupName: null }).header.title.content, "长片 · 第 1 支，共 1 支");
  assert.equal(cards.buildConfirmCard({ ...base, groupName: "旅行号" }).header.title.content, "旅行号 · 长片 · 第 1 支，共 1 支");
  assert.equal(cards.buildNewWorkCard({ workId: "w", workTitle: "t", cutCount: 1, publishCount: 1, eventId: "e", groupName: "旅行号" }).header.title.content, "旅行号 · 新作品，等你确认");
  assert.equal(cards.buildXhsCard({ publishId: "p", workTitle: "w", cutTitle: "c", title: "t", at: null, groupName: "旅行号" }).header.title.content, "旅行号 · 小红书，要你单独确认");
});

// ---------------------------------------------------------------- 工具函数

test("时间选择器：只校验格式，认本机时区与显式偏移，拒绝不存在的日期", () => {
  const local = new Date(2026, 10, 15, 20, 5).getTime();
  assert.equal(cards.parsePickerTime("2026-11-15 20:05"), local);
  assert.equal(cards.parsePickerTime("2026-11-15T20:05:00"), local);
  assert.equal(cards.parsePickerTime("2026-11-15 20:05 +0800"), Date.UTC(2026, 10, 15, 12, 5));
  assert.equal(cards.parsePickerTime("2026-11-15 20:05 +08:00"), Date.UTC(2026, 10, 15, 12, 5));
  assert.equal(cards.parsePickerTime("2026-11-15 20:05 GMT+08"), Date.UTC(2026, 10, 15, 12, 5));
  assert.equal(cards.parsePickerTime("2026-11-15 12:05Z"), Date.UTC(2026, 10, 15, 12, 5));
  for (const bad of ["", "明天", "2026-13-01 10:00", "2026-02-30 10:00", "2026-11-15 25:00", "2026/11/15 20:00", null, 5]) {
    assert.equal(cards.parsePickerTime(bad), null, String(bad));
  }
  assert.equal(cards.parsePickerTime(cards.formatPickerTime(local)), local, "格式化再解析回到原值");
});

test("formatWhen：今天 / 明天 / 日期，没定时间明说", () => {
  const now = new Date(2026, 10, 15, 9, 0).getTime();
  assert.equal(cards.formatWhen(new Date(2026, 10, 15, 20, 0).getTime(), now), "今天 20:00");
  assert.equal(cards.formatWhen(new Date(2026, 10, 16, 8, 30).getTime(), now), "明天 08:30");
  assert.equal(cards.formatWhen(new Date(2026, 10, 18, 8, 30).getTime(), now), "11-18 08:30");
  assert.equal(cards.formatWhen(null, now), "还没定时间");
});

test("通道：表单回传的值兼容对象与 JSON 字符串，其余当作不是表单", () => {
  assert.deepEqual(normalizeFormValue({ a: "1" }), { a: "1" });
  assert.deepEqual(normalizeFormValue('{"a":"1"}'), { a: "1" });
  assert.equal(normalizeFormValue("不是 json"), undefined);
  assert.equal(normalizeFormValue(undefined), undefined);
});

test("旧按钮（重试等）行为不变：照旧执行并原地更新成一句结论", async () => {
  const ch = fakeChannel();
  const value = { cmd: "publish.retry", args: { publishId: "nope" }, exp: Date.now() + H, key: "legacy:1" };
  const res = await handleCardEvent({
    evt: { action_value: value, operator_id: OPERATOR, message_id: "om_legacy" },
    channel: ch,
    binding,
    handlers: { "publish.retry": async () => ({}) },
  });
  assert.equal(res.ok, true);
  assert.equal(ch.updates().length, 1);
  assert.equal(ch.updates()[0].card.header.title.content, "Hifabu · 已处理");
});

test("ACC-v2-copy-04：确认卡片显示正文前几行与话题；为空时写「没有正文」「没有话题」", () => {
  const rows = [
    { publishId: "p1", platform: "bilibili", title: "标题", body: "第一行\n第二行\n\n第三行\n第四行", tags: ["露营", "新手"], at: Date.now() + H },
    { publishId: "p2", platform: "douyin", title: "标题二", body: "", tags: [], at: Date.now() + H },
  ];
  const card = cards.buildConfirmCard({ cut: { id: "c1", title: "长片" }, index: 1, total: 1, workTitle: "作品", rows });
  const t = text(card);
  assert.match(t, /第一行\\n第二行\\n第三行…/);
  assert.doesNotMatch(t, /第四行/);
  assert.match(t, /#露营 #新手/);
  assert.match(t, /没有正文/);
  assert.match(t, /没有话题/);
  const long = cards.copySummary({ body: "字".repeat(60), tags: [] });
  assert.equal([...long.bodyText].length, 41);
});

// ---------------------------------------------------------------- #245 · ACC-v3-time-06 / ACC-v3-fid-07

test("ACC-v3-time-06 飞书改单里有「什么时候发」：选现在发时没有时间输入，确认按钮是「现在发」", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  const confirm = ch.sent()[1].card;
  await click(ch, confirm, "card.edit", { messageId: "om_edit" });
  const edit = ch.updates().at(-1).card;
  const inForm = (card) => card.body.elements.find((e) => e.tag === "form").elements;

  // 按时间发（默认）：每个平台有时间选择器；上面有两个选项。
  assert.match(text(edit), /什么时候发/);
  assert.ok(inForm(edit).some((e) => e.tag === "picker_datetime"));
  const choices = cards.callbackValues(edit).filter((v) => v.cmd === "card.edit");
  assert.equal(choices.length, 2, "按时间发 / 现在发");

  // 选现在发：重画成没有时间输入的表单，标题输入还在。
  await click(ch, edit, "card.edit", { messageId: "om_edit", value: choices.find((v) => v.args.when === "now") });
  const now = ch.updates().at(-1).card;
  assert.equal(inForm(now).some((e) => e.tag === "picker_datetime"), false, "选现在发时不出现时间输入");
  assert.ok(inForm(now).some((e) => e.tag === "input"));
  assert.equal(cb(now, "publish.edit").args.when, "now");
  assert.equal(cb(now, "card.show").args.when, "now", "取消回到确认卡片，仍是现在发");

  // 现在发下提交表单：只改标题，不碰时间；回到确认卡片，按钮写「现在发」，行上不写时间。
  const before = store.getPublish(f.pubs["0:douyin"]).scheduled_at;
  await click(ch, now, "publish.edit", { messageId: "om_edit", form: { title_douyin: "现在发的新标题", title_bilibili: store.resolvePublishCopy(f.pubs["0:bilibili"]).title } });
  assert.equal(store.getPublish(f.pubs["0:douyin"]).scheduled_at, before);
  assert.equal(JSON.parse(store.getPublish(f.pubs["0:douyin"]).overrides_json).title, "现在发的新标题");
  const back = ch.updates().at(-1).card;
  assert.match(text(back), /确认这 2 条，现在发/);
  assert.equal(cb(back, "publish.approve").args.when, "now");
  assert.doesNotMatch(text(back), /今天 \d\d:\d\d|明天 \d\d:\d\d/);

  // 按钮仍要人点才发：这时平台稿还没确认。
  assert.equal(stateOf(f.pubs["0:douyin"]), "pending_confirm");
});

test("ACC-v3-time-05 确认卡片默认还是「按时间发」，approve 不带 when", async () => {
  const f = fixture();
  const ch = fakeChannel();
  await click(ch, await deliverNewWork(f, ch), "card.review");
  const confirm = ch.sent()[1].card;
  assert.match(text(confirm), /确认这 2 条，按时间发/);
  assert.equal(cb(confirm, "publish.approve").args.when, undefined);
});

test("ACC-v3-fid-07 没有建议时间：写「还没定时间」", () => {
  assert.equal(cards.formatWhen(null), "还没定时间");
});
