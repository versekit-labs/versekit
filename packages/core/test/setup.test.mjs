// 接入步骤是给「没读过 README 的人」看的，所以它的顺序与判定必须被钉死：
// 第一个不是绿色的步骤，就是用户下一步该做的地方。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupStatus } from "../src/setup.mjs";

const doctor = (overrides = {}) => ({
  ok: true,
  checks: ["node", "config_dir", "database", "schema_version", "chrome", "daemon", "adapters"].map((id) => ({
    id,
    ok: overrides[id] ?? true,
    detail: `${id} ok`,
  })),
});

const account = (state = "ok", platform = "bilibili") => ({ id: `a_${state}_${platform}`, platform, handle: "@x", state });
const stepOf = (result, id) => result.steps.find((s) => s.id === id);

test("全空：停在第 1 步或第 2 步，不会假装绿", () => {
  const r = setupStatus({ doctor: doctor(), accounts: [], channel: { bound: false }, publishedCount: 0 });
  assert.equal(stepOf(r, "env").status, "ok");
  assert.equal(stepOf(r, "account").status, "blocked");
  assert.equal(r.nextStep, "account");
  assert.equal(r.done, 1);
});

test("没有账号时，下一步是添加账号，并给出页面动作", () => {
  const r = setupStatus({ doctor: doctor(), accounts: [] });
  assert.equal(stepOf(r, "account").fix.kind, "page");
  assert.equal(stepOf(r, "account").fix.href, "#accounts");
});

test("账号失效：标记为 blocked，并给出重新授权命令与 accountId", () => {
  const r = setupStatus({ doctor: doctor(), accounts: [account("expired")] });
  const step = stepOf(r, "account");
  assert.equal(step.status, "blocked");
  assert.equal(step.fix.kind, "command");
  assert.equal(step.fix.command, "account.reauth");
  assert.equal(step.fix.args.accountId, "a_expired_bilibili");
});

test("账号好了但没通道：不阻塞发布，状态是 todo 而不是 blocked", () => {
  const r = setupStatus({ doctor: doctor(), accounts: [account()], channel: { bound: false } });
  assert.equal(stepOf(r, "account").status, "ok");
  assert.equal(stepOf(r, "channel").status, "todo");
  assert.equal(r.nextStep, "channel");
});

test("通道好了但没发过：下一步是第一条发布", () => {
  const r = setupStatus({ doctor: doctor(), accounts: [account()], channel: { bound: true } });
  assert.equal(stepOf(r, "channel").status, "ok");
  assert.equal(r.nextStep, "first-publish");
});

test("全都做完：nextStep 为空，四步全绿", () => {
  const r = setupStatus({ doctor: doctor(), accounts: [account()], channel: { bound: true }, publishedCount: 3 });
  assert.equal(r.nextStep, null);
  assert.equal(r.done, 4);
});

test("环境有红灯：第 1 步 blocked，后面的步骤仍然可读", () => {
  const r = setupStatus({ doctor: doctor({ chrome: false }), accounts: [account()], channel: { bound: true }, publishedCount: 1 });
  assert.equal(stepOf(r, "env").status, "blocked");
  assert.equal(stepOf(r, "env").fix.href, "#doctor");
  assert.equal(r.nextStep, "env");
});

test("拿不到自检结果时不假装通过", () => {
  const r = setupStatus({ doctor: null });
  assert.equal(stepOf(r, "env").status, "todo");
  assert.equal(stepOf(r, "env").checks[0].ok, false);
});

test("每步都有 intent 与 checks，界面不需要再拼文案", () => {
  const r = setupStatus({ doctor: doctor(), accounts: [account()], channel: { bound: true }, publishedCount: 1 });
  for (const step of r.steps) {
    assert.ok(step.title && step.intent, step.id);
    assert.ok(Array.isArray(step.checks) && step.checks.length > 0, step.id);
  }
});

test("跳过手机通道时算完成，下一步直接是第一条发布", () => {
  const r = setupStatus({
    doctor: doctor(),
    accounts: [account()],
    channel: { bound: false },
    channelSkipped: true,
    publishedCount: 0,
  });
  assert.equal(stepOf(r, "channel").status, "ok");
  assert.equal(stepOf(r, "channel").skipped, true);
  assert.equal(r.nextStep, "first-publish");
  assert.equal(r.done, 3);
});
