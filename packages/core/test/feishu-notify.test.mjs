// #311 往飞书发什么：三类开关、不用飞书、发送失败的留痕。通道是注入的假对象，不碰飞书和网络。
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIFABU_HOME = mkdtempSync(join(tmpdir(), "vk-fsnotify-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { deliverPending, feishuState, humanizeCardError } = await import("../src/notify.mjs");
const { cardKindOf } = await import("../src/cards.mjs");
const { notifyRoute, buildToday } = await import("../src/overview.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");

const db = () => core.open();
const BINDING = { external_user_id: "ou_owner" };
const channel = (fail = null) => {
  const sent = [];
  return { channel: "feishu", sent, async send(p) { if (fail) throw new Error(fail); sent.push(p); return { messageId: `om_${sent.length}` }; } };
};
let n = 0;

function seedPublish() {
  const k = ++n;
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES (?,?,?,?)").run(`fa${k}`, "tiktok", `@h${k}`, Date.now());
  db().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?,?,?,?)").run(`fw${k}`, `第 ${k} 条`, "/tmp/a.mp4", Date.now());
  db().prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES (?,?,?,'failed',?,?)").run(`fp${k}`, `fw${k}`, `fa${k}`, Date.now(), Date.now());
  return core.emit({ type: "publish.failed", severity: "warn", publishId: `fp${k}`, payload: { code: "flaky_ui" }, dedupeKey: `fs:${k}` });
}
function seedAwaiting() {
  const k = ++n;
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES (?,?,?,?)").run(`fa${k}`, "tiktok", `@h${k}`, Date.now());
  db().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?,?,?,?)").run(`fw${k}`, `新作品 ${k}`, "/tmp/a.mp4", Date.now());
  db().prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES (?,?,?,'pending_confirm',?,?)").run(`fp${k}`, `fw${k}`, `fa${k}`, Date.now(), Date.now());
  return { workId: `fw${k}`, publishId: `fp${k}`, eventId: core.emit({ type: "work.awaiting_confirm", payload: { workId: `fw${k}` }, dedupeKey: `fsw:${k}` }) };
}

before(() => core.migrate());
beforeEach(() => {
  db().exec("DELETE FROM delivery; DELETE FROM event; DELETE FROM channel_binding; DELETE FROM meta WHERE key LIKE 'feishu.%'; DELETE FROM publish; DELETE FROM work; DELETE FROM account;");
});

test("三类：确认 / 出问题 / 每天的结果，各归各的", () => {
  assert.equal(cardKindOf("work.awaiting_confirm"), "confirm");
  assert.equal(cardKindOf("digest.daily"), "daily");
  for (const t of ["publish.failed", "account.expired", "system.dead", "collect.degraded"]) assert.equal(cardKindOf(t), "issue");
});

test("关掉「要你确认的」：新作品卡片不发，别的照发；确认只能在网页上（ACC-v3-feishu-04）", async () => {
  const a = seedAwaiting();
  const p = seedPublish();
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  h["channel.settings"]({ confirm: false });
  const ch = channel();
  await deliverPending({ channel: ch, binding: BINDING, now: Date.now() + 60e3 });
  assert.equal(ch.sent.length, 1, "只发出了出问题的那张");
  assert.match(JSON.stringify(ch.sent[0].card), /发布失败/);
  assert.equal(db().prepare("SELECT state FROM delivery WHERE event_id=?").get(a.eventId).state, "skipped");
  assert.ok(p);

  // 没有人确认，一条都不会发：平台稿还停在待确认，今天页照常列出
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(a.publishId).state, "pending_confirm");
  const today = buildToday({});
  assert.ok(today.awaiting.some((w) => w.workId === a.workId), "今天页照常列出要你确认的");
  assert.equal(today.notify.why, "none", "没配对时今天页不写飞书的说明");
});

test("不用飞书：一张卡片都不发，今天页写明只在网页上", async () => {
  const a = seedAwaiting();
  seedPublish();
  store.bindChannel("feishu", "ou_owner");
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  store.patchFeishuSettings({ off: true });
  const ch = channel();
  const res = await deliverPending({ channel: ch, binding: BINDING, now: Date.now() + 60e3 });
  assert.equal(res.skipped, "off");
  assert.equal(ch.sent.length, 0);
  assert.equal(notifyRoute().why, "off");
  assert.ok(buildToday({}).awaiting.some((w) => w.workId === a.workId));
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(a.publishId).state, "pending_confirm");
  assert.ok(h);
});

test("卡片发送失败：记下人话原因、留一条事件（只一条）、今天页说明；送到一张就清掉（ACC-v3-feishu-05）", async () => {
  store.bindChannel("feishu", "ou_owner");
  seedPublish();
  seedPublish();
  const bad = channel("bot has been disabled");
  await deliverPending({ channel: bad, binding: BINDING });
  const d = store.getFeishuDelivery();
  assert.match(d.failure.reason, /机器人被停用或删除/);
  assert.equal(db().prepare("SELECT COUNT(*) c FROM event WHERE type='channel.card_failed'").get().c, 1, "连着失败只记一条事件");
  assert.deepEqual({ why: notifyRoute().why }, { why: "failed" });
  assert.equal(feishuState({ bound: true, configured: true, authorized: true, subscribed: true, failure: d.failure }), "bad");

  const ok = channel();
  await deliverPending({ channel: ok, binding: BINDING, now: Date.now() + 120e3 });
  assert.equal(ok.sent.length, 2);
  assert.equal(store.getFeishuDelivery().failure, null);
  assert.equal(notifyRoute().why, null);
});

test("失败原因翻成人话，不泄露长串标识", () => {
  assert.match(humanizeCardError("spawn lark-cli ENOENT"), /飞书组件找不到/);
  assert.match(humanizeCardError("getaddrinfo ENOTFOUND open.feishu.cn"), /网络/);
  assert.match(humanizeCardError("token expired 99991663"), /授权失效/);
  const odd = humanizeCardError(`weird ${"A1b2".repeat(20)}`);
  assert.ok(!/A1b2A1b2A1b2A1b2A1b2A1b2A1b2A1b2/.test(odd));
});

test("状态词表：每个状态都能由事实推出来", () => {
  const base = { installed: true };
  assert.equal(feishuState({ installed: false }), "missing");
  assert.equal(feishuState({ installed: false, skipped: true }), "off");
  assert.equal(feishuState({ ...base }), "none");
  assert.equal(feishuState({ ...base, creating: true }), "qr");
  assert.equal(feishuState({ ...base, configured: true }), "qr");
  assert.equal(feishuState({ ...base, configured: true, authorized: true, bound: true, subscribed: false }), "sub");
  assert.equal(feishuState({ ...base, configured: true, authorized: true, bound: true, subscribed: null }), "sub");
  assert.equal(feishuState({ ...base, bound: true, subscribed: true }), "ok");
  assert.equal(feishuState({ ...base, bound: true, subscribed: true, failure: { reason: "x" } }), "bad");
  assert.equal(feishuState({ ...base, bound: true, subscribed: true, failure: { reason: "x" }, creating: true }), "qr", "重新接的时候不停在红色");
});

test("channel.settings / channel.unbind：改了留事件；断开后记成不用飞书", () => {
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  store.bindChannel("feishu", "ou_owner");
  assert.deepEqual(h["channel.settings"]({}).kinds, { confirm: true, issue: true, daily: true });
  const r = h["channel.settings"]({ confirm: false, daily: false });
  assert.deepEqual(r.kinds, { confirm: false, issue: true, daily: false });
  assert.match(r.next, /只能在网页/);
  assert.equal(db().prepare("SELECT COUNT(*) c FROM event WHERE type='channel.settings_changed'").get().c, 1);
  const d = h["channel.unbind"]();
  assert.equal(d.removed, 1);
  assert.equal(store.getBinding("feishu"), null);
  assert.equal(store.getFeishuSettings().off, true);
  assert.equal(db().prepare("SELECT COUNT(*) c FROM event WHERE type='channel.disconnected'").get().c, 1);
});
