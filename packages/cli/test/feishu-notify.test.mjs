// #311 系统页「通知」：整条接飞书的路径，用真实 vk 守护进程 + 假的 lark-cli（不碰任何真实飞书账号）。
// 页面只调命令（三端一致律），这里就按页面的方式调 HTTP：每一步状态自己往下走，没有「我弄好了」。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttp } from "node:http";
import { fileURLToPath } from "node:url";

const VK = fileURLToPath(new URL("../src/vk.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-lark.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
after(() => { for (const fn of cleanups) fn(); });

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const SECRET = "s3cr3t-from-registration";
/** 假的飞书应用注册接口：poll 一直 pending，直到测试置 st.scan = true（= 用户在飞书里扫码确认）；st.mode 控制结局。 */
async function fakeRegistration() {
  const st = { scan: false, mode: "ok", polls: 0, switched: false };
  const srv = createHttp((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      res.setHeader("content-type", "application/json");
      if (form.action === "begin") return res.end(JSON.stringify({ device_code: "dev_1", user_code: "ABCD-EFGH", expire_in: 600, interval: 5 }));
      st.polls++;
      if (!st.scan) return res.end(JSON.stringify({ error: "authorization_pending" }));
      if (st.mode === "denied") { res.statusCode = 400; return res.end(JSON.stringify({ error: "access_denied" })); }
      if (st.mode === "expired") { res.statusCode = 400; return res.end(JSON.stringify({ error: "expired_token" })); }
      // 品牌矛盾：先报告用户在 lark 租户（让通道切到 lark 域名），最终凭证上却写 feishu。
      if (st.mode === "brand" && !st.switched) { st.switched = true; return res.end(JSON.stringify({ error: "authorization_pending", user_info: { tenant_brand: "lark" } })); }
      res.end(JSON.stringify({ client_id: "cli_fromreg", client_secret: SECRET, user_info: { open_id: "ou_from_registration", tenant_brand: "feishu" } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => srv.close());
  st.url = `http://127.0.0.1:${srv.address().port}`;
  return st;
}

/** 起一个真实 vk 守护进程；larkBin = null 表示发布机上没有飞书组件。 */
async function boot({ larkBin = FAKE, registration = null } = {}) {
  const home = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "vkf-"));
  const lark = mkdtempSync(join(tmpdir(), "vk-fakelark-"));
  const port = await freePort();
  const env = { ...process.env, VK_HOME: home, VK_NO_BROWSER: "1", FAKE_LARK_DIR: lark, VK_LARK_BIN: larkBin ?? join(lark, "没有这个文件"), ...(registration ? { VK_FEISHU_ACCOUNTS_URL: registration.url, VK_FEISHU_POLL_SCALE: "0.01" } : {}) };
  const init = spawn(process.execPath, [VK, "init"], { env });
  await new Promise((r) => init.on("close", r));
  const child = spawn(process.execPath, [VK, "serve", "--offline", "--port", String(port)], { env, stdio: "ignore" });
  cleanups.push(() => { child.kill("SIGTERM"); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(lark, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/channels/feishu/status`)).ok) break; } catch { /* 还没起来 */ }
    await sleep(100);
  }
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, body: body ? JSON.stringify(body) : method === "POST" ? "{}" : undefined });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json, data: json.data ?? json };
  };
  const status = async () => (await call("GET", "/api/channels/feishu/status")).data;
  const until = async (pred, what) => {
    let last;
    for (let i = 0; i < 150; i++) { last = await status(); if (pred(last)) return last; await sleep(100); }
    assert.fail(`等不到「${what}」，现在是 ${JSON.stringify(last)}`);
  };
  const go = (name, text = "1") => writeFileSync(join(lark, name), text);
  return { call, status, until, go, lark, home };
}

test("发布机上没有飞书组件：写明状态，不出现命令，接不了也不静默（ACC-v3-feishu-01）", async () => {
  const k = await boot({ larkBin: null });
  const st = await k.status();
  assert.equal(st.state, "missing");
  assert.equal(st.installed, false);
  // 「不用飞书」仍然可选
  await k.call("POST", "/api/channels/feishu/skip");
  assert.equal((await k.status()).state, "off");
});

test("接飞书只扫一次码：出码 → 扫码 → 自动配对（open_id 来自注册结果）→ 差一步开通按钮 → 接好后自动发测试卡片（ACC-v3-feishu-02 / -10）", async () => {
  const reg = await fakeRegistration();
  const k = await boot({ registration: reg });
  let st = await k.status();
  assert.equal(st.state, "none");
  assert.equal(st.installed, true);

  // 点「接飞书」：只调一个命令，拿到二维码
  const created = await k.call("POST", "/api/channels/feishu/app/create");
  assert.ok(created.ok, JSON.stringify(created.json));
  st = await k.until((s) => s.state === "qr" && s.create.running && s.create.qr, "等你扫码");
  assert.match(st.create.qr, /^data:image\/png;base64,/);
  assert.match(st.create.url, /\/page\/cli\?user_code=ABCD-EFGH/);

  // 用户在飞书里扫完：建好应用 + 直接配对，不出现第二个码、不需要授权
  reg.scan = true;
  st = await k.until((s) => s.bound && !s.create.running && s.state === "sub" && s.subscription?.url, "差一步：开通按钮");
  assert.equal(st.externalUserId, "ou_from_registration", "open_id 直接来自注册结果");
  assert.equal(st.appId, "cli_fromreg");
  assert.equal(st.authorized, true, "只看应用与机器人，不要求用户身份令牌");
  assert.equal("auth" in st, false, "状态里没有第二步授权");
  assert.match(st.subscription.url, /^https:\/\/open\.feishu\.cn\//);
  assert.equal(existsSync(join(k.lark, "sent.log")), false, "按钮还不能点，测试卡片不该提前发");
  assert.equal(readFileSync(join(k.lark, "secret.len"), "utf8"), String(SECRET.length), "secret 经 stdin 交给了 lark-cli");
  const calls = readFileSync(join(k.lark, "calls.log"), "utf8");
  assert.ok(!calls.includes(SECRET), "secret 不在任何子进程参数里");
  assert.ok(!/"auth","login"/.test(calls), "全程不调用 lark-cli auth login");
  assert.equal((await k.call("POST", "/api/channels/feishu/login/start")).status, 404, "第二次授权的入口已经没有了");

  // 用户在飞书里开通：自己变成「接好了」，并自动发一张测试卡片
  k.go("subscribed");
  st = await k.until((s) => s.state === "ok" && s.testSentAt, "接好了");
  assert.ok(st.lastOkAt);
  assert.equal(readFileSync(join(k.lark, "sent.log"), "utf8").trim().split("\n").length, 1);
  assert.ok(!JSON.stringify(st).includes(SECRET), "状态里不能有凭证");

  // 发测试卡片、断开（ACC-v3-feishu-06）
  assert.ok((await k.call("POST", "/api/channels/feishu/test")).ok);
  assert.equal(readFileSync(join(k.lark, "sent.log"), "utf8").trim().split("\n").length, 2);
  const dropped = await k.call("POST", "/api/channels/feishu/unbind");
  assert.ok(dropped.ok);
  st = await k.status();
  assert.equal(st.bound, false);
  assert.equal(st.state, "off", "断开后不再往飞书发，要你确认的只在网页上");
  const ev = (await k.call("GET", "/api/events?limit=100")).data;
  const types = (ev.events ?? ev.rows ?? ev).map((e) => e.type);
  assert.ok(types.includes("channel.connected") && types.includes("channel.disconnected"), `事件：${types}`);
});

test("已建应用、没配对的发布机（所有者现在的状态）：回到「还没接」，点「重新接」走一遍注册就通，不用先删旧应用（ACC-v3-feishu-10）", async () => {
  const reg = await fakeRegistration();
  const k = await boot({ registration: reg });
  k.go("profile"); // 应用早就建好了，但没配对
  let st = await k.status();
  assert.equal(st.configured, true);
  assert.equal(st.bound, false);
  assert.equal(st.state, "none", "不再停在「等你扫码」：页面据此给「重新接」");

  assert.ok((await k.call("POST", "/api/channels/feishu/app/create")).ok);
  await k.until((s) => s.create.running && s.create.qr, "出码");
  reg.scan = true;
  st = await k.until((s) => s.bound && !s.create.running, "配对");
  assert.equal(st.externalUserId, "ou_from_registration");
  assert.equal(st.appId, "cli_fromreg", "旧应用被新应用覆盖");
});

for (const [mode, expected] of [["denied", /点了拒绝/], ["expired", /二维码过期了/], ["brand", /品牌.*对不上/]]) {
  test(`扫码没成（${mode}）：页面写原因、二维码收起、没有配对，点「重新接」还能再来`, async () => {
    const reg = await fakeRegistration();
    const k = await boot({ registration: reg });
    reg.mode = mode;
    assert.ok((await k.call("POST", "/api/channels/feishu/app/create")).ok);
    await k.until((s) => s.create.running && s.create.qr, "出码");
    reg.scan = true;
    const st = await k.until((s) => !s.create.running && s.create.error, "写明原因");
    assert.match(st.create.error, expected);
    assert.equal(st.create.qr, null);
    assert.equal(st.bound, false);
    assert.equal(st.state, "none");
    // 再来一次就能成
    reg.mode = "ok";
    assert.ok((await k.call("POST", "/api/channels/feishu/app/create")).ok);
    await k.until((s) => s.bound, "重新接成功");
  });
}

test("卡片发不出去：「通知」变红并写明原因，今天页带上说明，有事件；送到一张就恢复（ACC-v3-feishu-05）", async () => {
  const k = await boot();
  k.go("profile"); k.go("authed"); k.go("subscribed");
  assert.ok((await k.call("POST", "/api/channels/feishu/bind", {})).ok);
  await k.until((s) => s.state === "ok" && s.testSentAt, "接好了");

  k.go("sendfail", "bot has been disabled by the admin");
  const t = await k.call("POST", "/api/channels/feishu/test");
  assert.equal(t.ok, false);
  assert.match(JSON.stringify(t.json), /机器人被停用或删除/);

  const st = await k.status();
  assert.equal(st.state, "bad");
  assert.match(st.failure.reason, /机器人被停用或删除/);
  assert.ok(!/bot has been disabled/.test(st.failure.reason), "原因是人话，不是原文");

  const today = (await k.call("GET", "/api/today")).data;
  assert.equal(today.notify.why, "failed");
  assert.match(today.notify.reason, /机器人被停用或删除/);

  const ev = (await k.call("GET", "/api/events?limit=100")).data;
  const rows = (ev.events ?? ev.rows ?? ev).filter((e) => e.type === "channel.card_failed");
  assert.equal(rows.length, 1, "有事件，不静默");

  // 再失败一次不刷屏
  await k.call("POST", "/api/channels/feishu/test");
  const again = (await k.call("GET", "/api/events?limit=100")).data;
  assert.equal((again.events ?? again.rows ?? again).filter((e) => e.type === "channel.card_failed").length, 1);

  unlinkSync(join(k.lark, "sendfail"));
  assert.ok((await k.call("POST", "/api/channels/feishu/test")).ok);
  assert.equal((await k.status()).state, "ok");
  assert.equal((await k.call("GET", "/api/today")).data.notify.why, null);
});

test("往飞书发哪几类：改了就存下，关「要你确认的」后今天页写明只在网页上（ACC-v3-feishu-04）", async () => {
  const k = await boot();
  k.go("profile"); k.go("authed"); k.go("subscribed");
  await k.call("POST", "/api/channels/feishu/bind", {});
  assert.deepEqual((await k.status()).kinds, { confirm: true, issue: true, daily: true });
  const r = await k.call("POST", "/api/channels/feishu/settings", { confirm: false });
  assert.ok(r.ok);
  assert.deepEqual((await k.status()).kinds, { confirm: false, issue: true, daily: true });
  assert.equal((await k.call("GET", "/api/today")).data.notify.why, "confirm_off");
  const view = await k.call("POST", "/api/channels/feishu/settings", {});
  assert.equal(view.data.kinds.confirm, false, "不带参数只是看");
});
