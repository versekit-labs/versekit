// 手机拍板的两段逻辑：卡片长什么样、按钮点了会发生什么。
// 这些测试不碰飞书、不碰网络——通道是注入的假对象，所以能断言得很细。
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-notify-"));

const core = await import("../src/index.mjs");
const { buildEventCard, resultCard, cardButtonCount } = await import("../src/cards.mjs");
const { deliverPending, executeAction } = await import("../src/notify.mjs");

const db = () => core.open();
let n = 0;

function seed() {
  const k = ++n;
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES (?,?,?,?)").run(`a${k}`, "tiktok", `@h${k}`, Date.now());
  db().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?,?,?,?)").run(`w${k}`, `第 ${k} 条`, "/tmp/a.mp4", Date.now());
  db()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES (?,?,?,'failed',?,?)")
    .run(`p${k}`, `w${k}`, `a${k}`, Date.now(), Date.now());
  const eventId = core.emit({
    type: "publish.failed",
    severity: "warn",
    publishId: `p${k}`,
    payload: { code: "flaky_ui" },
    dedupeKey: `test:${k}`,
  });
  return { publishId: `p${k}`, eventId, accountId: `a${k}` };
}

const fakeChannel = (failTimes = 0) => {
  const sent = [];
  let failures = failTimes;
  return {
    channel: "feishu",
    sent,
    async send(payload) {
      if (failures-- > 0) throw new Error("网络抖动");
      sent.push(payload);
      return { messageId: `om_${sent.length}` };
    },
  };
};

before(() => core.migrate());

beforeEach(() => {
  db().exec("DELETE FROM delivery; DELETE FROM event; DELETE FROM command_audit; DELETE FROM publish; DELETE FROM work; DELETE FROM account;");
});

// ---------------------------------------------------------------- 卡片

test("发布失败卡片：一句话结论 + 最多三个按钮，按钮带 24h 过期与幂等键", () => {
  const now = 1_700_000_000_000;
  const event = { id: "evt_1", type: "publish.failed", severity: "warn", publish_id: "p1", payload: { code: "flaky_ui" } };
  const publish = { id: "p1", platform: "tiktok", handle: "@me", title: "第一条" };
  const card = buildEventCard(event, { publish, now });

  assert.ok(cardButtonCount(card) <= 3);
  assert.match(JSON.stringify(card), /发布失败/);
  const button = card.elements.find((e) => e.tag === "action").actions[0];
  assert.equal(button.value.cmd, "publish.retry");
  assert.equal(button.value.args.publishId, "p1");
  assert.equal(button.value.exp, now + 24 * 3600e3);
  assert.match(button.value.key, /evt_1/);
  // 卡片不该出现内部路径 / 凭证 / open_id
  assert.doesNotMatch(JSON.stringify(card), /ou_|\/Users\/|cookie|token/i);
});

test("登录失效卡片带重新授权与转手动，且需要 accountId 才给按钮", () => {
  const event = {
    id: "evt_2",
    type: "account.expired",
    severity: "critical",
    payload: { accountId: "a1", platform: "tiktok", handle: "@me", detail: "cookie 过期" },
  };
  const card = buildEventCard(event, {});
  assert.equal(card.header.template, "red");
  assert.equal(cardButtonCount(card), 2);
});

test("内部 trace 不生成卡片，避免半夜吵醒人", () => {
  for (const type of ["publish.state_changed", "run.interrupted", "system.alive"]) {
    assert.equal(buildEventCard({ id: "x", type, severity: "info", payload: {} }), null);
  }
});

test("执行结果卡片把按钮收起来", () => {
  const card = resultCard("已处理", "已重新排队。", { ok: true });
  assert.equal(cardButtonCount(card), 0);
  assert.match(JSON.stringify(card), /已重新排队/);
});

// ---------------------------------------------------------------- 投递

test("同一事件只投递一次；再跑一遍不会重复发", async () => {
  const { eventId } = seed();
  const channel = fakeChannel();
  const binding = { external_user_id: "ou_1" };

  const first = await deliverPending({ channel, binding });
  assert.equal(first.sent, 1);
  assert.equal(channel.sent[0].openId, "ou_1");
  assert.equal(channel.sent[0].idempotencyKey, `event:${eventId}`.slice(0, 50));

  const second = await deliverPending({ channel, binding });
  assert.equal(second.sent, 0);
  assert.equal(channel.sent.length, 1);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM delivery WHERE event_id=?").get(eventId).n, 1);
});

test("发送失败会记 failed，并在冷却后重试，不会静默丢掉", async () => {
  const { eventId } = seed();
  const channel = fakeChannel(1);
  const binding = { external_user_id: "ou_1" };

  await deliverPending({ channel, binding });
  assert.equal(db().prepare("SELECT state, attempted FROM delivery WHERE event_id=?").get(eventId).state, "failed");

  // 冷却没到：不重试
  await deliverPending({ channel, binding });
  assert.equal(channel.sent.length, 0);

  // 冷却到了：重试并成功
  await deliverPending({ channel, binding, now: Date.now() + 120e3 });
  assert.equal(channel.sent.length, 1);
  assert.equal(db().prepare("SELECT state FROM delivery WHERE event_id=?").get(eventId).state, "sent");
});

test("没配对就不投递，也不写 delivery", async () => {
  seed();
  const channel = fakeChannel();
  const res = await deliverPending({ channel, binding: null });
  assert.equal(res.skipped, "unbound");
  assert.equal(channel.sent.length, 0);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM delivery").get().n, 0);
});

// ---------------------------------------------------------------- 按钮

test("点按钮执行命令，并写一条带幂等键的审计", async () => {
  const { publishId } = seed();
  let calls = 0;
  const handlers = { "publish.retry": async (args) => { calls++; return { publishId: args.publishId, state: "queued" }; } };
  const action = { cmd: "publish.retry", args: { publishId }, exp: Date.now() + 60e3, key: "card:1:retry" };

  const first = await executeAction({ action, operator: "ou_1", binding: { external_user_id: "ou_1" }, handlers });
  assert.equal(first.ok, true);
  assert.match(first.message, /重新排队/);
  assert.equal(calls, 1);

  const second = await executeAction({ action, operator: "ou_1", binding: { external_user_id: "ou_1" }, handlers });
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1, "同一张卡点两次只能执行一次");

  const audit = db().prepare("SELECT * FROM command_audit WHERE idempotency_key=?").get("card:1:retry");
  assert.equal(audit.result, "ok");
  assert.equal(audit.origin, "feishu");
  assert.equal(audit.actor, "feishu:ou_1");
});

test("过期按钮、别人的按钮、非远程命令一律拒绝", async () => {
  const handlers = { "publish.retry": async () => ({}) };
  const base = { args: { publishId: "p1" }, key: "k" };

  const expired = await executeAction({
    action: { ...base, cmd: "publish.retry", exp: Date.now() - 1 },
    operator: "ou_1",
    binding: { external_user_id: "ou_1" },
    handlers,
  });
  assert.equal(expired.ok, false);
  assert.match(expired.message, /过期/);

  const wrongUser = await executeAction({
    action: { ...base, cmd: "publish.retry", exp: Date.now() + 60e3 },
    operator: "ou_2",
    binding: { external_user_id: "ou_1" },
    handlers,
  });
  assert.equal(wrongUser.ok, false);

  const local = await executeAction({
    action: { cmd: "init", args: {}, exp: Date.now() + 60e3, key: "k2" },
    operator: "ou_1",
    binding: { external_user_id: "ou_1" },
    handlers,
  });
  assert.equal(local.ok, false);
  assert.match(local.message, /只能在电脑上执行/);
});

test("命令报错时返回原因，并留一条 error 审计", async () => {
  const handlers = { "publish.retry": async () => { throw new Error("这条已经发布成功，不需要重试"); } };
  const action = { cmd: "publish.retry", args: { publishId: "p1" }, exp: Date.now() + 60e3, key: "k3" };
  const res = await executeAction({ action, operator: "ou_1", binding: { external_user_id: "ou_1" }, handlers });
  assert.equal(res.ok, false);
  assert.match(res.message, /已经发布成功/);
  assert.equal(db().prepare("SELECT result FROM command_audit WHERE idempotency_key='k3'").get().result, "error");
});
