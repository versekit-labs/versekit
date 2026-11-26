// ACC-v3-feishu-10：接飞书只扫一次码。本地假的注册接口 + 假的 lark-cli，不访问真实飞书。
// 覆盖：成功（三样都拿到、secret 只走 stdin、open_id 交给配对）、用户拒绝/取消、二维码过期、品牌矛盾；
// 并盯住 secret 不出现在日志与子进程参数里。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SECRET = "s3cr3t-registration-value-XYZ";
const DIR = mkdtempSync(join(tmpdir(), "vk-feishu-reg-"));
const AUDIT = join(DIR, "audit.log");

// ── 假的注册接口：按场景回答 poll ──
let script = []; // poll 依次的响应（用完后重复最后一条）
let hits = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    hits.push({ url: req.url, ...form });
    res.setHeader("content-type", "application/json");
    if (form.action === "begin") return res.end(JSON.stringify({ device_code: "dev_1", user_code: "ABCD-EFGH", expire_in: 600, interval: 5 }));
    const r = script.length > 1 ? script.shift() : script[0];
    res.statusCode = r.error && r.error !== "authorization_pending" ? 400 : 200;
    res.end(JSON.stringify(r));
  });
});

const BIN = join(DIR, "lark-cli");
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.HIFABU_FEISHU_ACCOUNTS_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.HIFABU_FEISHU_POLL_SCALE = "0.01"; // 5 秒的轮询间隔压成 50ms
  writeFileSync(
    BIN,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(AUDIT)}, "argv " + JSON.stringify(a) + "\\n");
if (a[0] === "auth" && a[1] === "qrcode") { fs.writeFileSync(a[a.indexOf("-o") + 1], Buffer.from([137, 80, 78, 71])); process.exit(0); }
const P = ${JSON.stringify(join(DIR, "profiles.json"))};
const load = () => (fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, "utf8")) : {});
const fail = (m) => { console.error(JSON.stringify({ ok: false, error: { type: "validation", message: m } }, null, 2)); process.exit(2); };
if (a[0] === "profile" && a[1] === "add") {
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const p = load(); const name = a[a.indexOf("--name") + 1];
    if (p[name]) fail('profile "' + name + '" already exists');
    p[name] = a[a.indexOf("--app-id") + 1];
    fs.writeFileSync(${JSON.stringify(join(DIR, "stdin.txt"))}, d); fs.writeFileSync(P, JSON.stringify(p));
    fs.writeFileSync(${JSON.stringify(join(DIR, "profile"))}, p.versekit ?? "");
    console.log(JSON.stringify({ ok: true }));
  });
  return;
}
if (a[0] === "profile" && a[1] === "remove") {
  const p = load(); const n = a[2];
  if (!p[n]) fail('profile "' + n + '" not found');
  if (Object.keys(p).length === 1) fail("cannot remove the only profile");
  delete p[n]; fs.writeFileSync(P, JSON.stringify(p)); process.exit(0);
}
if (a[0] === "profile" && a[1] === "rename") {
  const p = load(); const [from, to] = [a[2], a[3]];
  if (!p[from]) fail('profile "' + from + '" not found');
  if (p[to]) fail('profile "' + to + '" already exists');
  p[to] = p[from]; delete p[from]; fs.writeFileSync(P, JSON.stringify(p));
  fs.writeFileSync(${JSON.stringify(join(DIR, "profile"))}, p.versekit ?? ""); process.exit(0);
}
if (a[0] === "profile") { const p = load(); console.log(JSON.stringify(Object.entries(p).map(([name, appId]) => ({ name, appId })))); process.exit(0); }
process.exit(0);
`,
  );
  chmodSync(BIN, 0o755);
  process.env.HIFABU_LARK_BIN = BIN;
});
after(() => {
  server.close();
  rmSync(DIR, { recursive: true, force: true });
});

const { beginRegistration, pollRegistration } = await import("../src/registration.mjs");
const channel = (await import("../src/index.mjs")).default;

const pending = { error: "authorization_pending" };
const done = (extra = {}) => ({ client_id: "cli_reg1", client_secret: SECRET, user_info: { open_id: "ou_owner", tenant_brand: "feishu" }, ...extra });
const waitDone = async () => {
  for (let i = 0; i < 200 && channel.createAppStatus().running; i++) await delay(25);
  return channel.createAppStatus();
};
/** 收集 console.error：日志里不能有 secret。 */
function captureLog() {
  const saved = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => (console.error = saved) };
}

test("begin：照 lark-cli 的参数请求（PersonalAgent + request_user_info），验证页带 user_code", async () => {
  hits = [];
  const b = await beginRegistration();
  assert.deepEqual(hits[0], { url: "/oauth/v1/app/registration", action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id tenant_brand" });
  assert.equal(b.deviceCode, "dev_1");
  assert.match(b.verificationUrl, /^https?:\/\/.+\/page\/cli\?user_code=ABCD-EFGH&from=cli$/);
});

test("成功：一次扫码拿到 client_id / client_secret / open_id；secret 只走 stdin，open_id 交给配对（ACC-v3-feishu-10）", async () => {
  script = [pending, { error: "slow_down" }, pending, done()];
  const log = captureLog();
  let paired = null;
  try {
    const started = await channel.createAppStart({ onDone: (r) => (paired = r) });
    assert.equal(started.running, true);
    assert.match(started.qr, /^data:image\/png;base64,/);
    assert.match(started.url, /\/page\/cli\?user_code=/);
    const st = await waitDone();
    assert.equal(st.error, null);
    assert.equal(st.configured, true);
    assert.equal(st.appId, "cli_reg1");
    assert.deepEqual(paired, { appId: "cli_reg1", openId: "ou_owner", brand: "feishu" });
    assert.equal(st.qr, null, "接好后二维码收起");
  } finally {
    log.restore();
  }
  assert.equal(readFileSync(join(DIR, "stdin.txt"), "utf8").trim(), SECRET, "secret 经 stdin 交给 lark-cli profile add");
  const audit = readFileSync(AUDIT, "utf8");
  assert.ok(!audit.includes(SECRET), "secret 不能出现在任何子进程参数里");
  assert.ok(!log.lines.join("\n").includes(SECRET), "secret 不能出现在日志里");
  assert.ok(!JSON.stringify(channel.createAppStatus()).includes(SECRET), "也不能出现在状态里");
  assert.ok(!audit.includes("auth login"), "全程不调用 lark-cli auth login");
});

test("用户在飞书里点了拒绝：写人话、二维码收起、不配对、不存应用", async () => {
  rmSync(join(DIR, "profile"), { force: true }); rmSync(join(DIR, "profiles.json"), { force: true });
  script = [pending, { error: "access_denied" }];
  const log = captureLog();
  let paired = false;
  try {
    await channel.createAppStart({ onDone: () => (paired = true) });
    const st = await waitDone();
    assert.match(st.error, /点了拒绝/);
    assert.equal(st.qr, null);
    assert.equal(st.url, null);
    assert.equal(st.configured, false);
    assert.equal(paired, false);
  } finally {
    log.restore();
  }
});

test("二维码过期：写「二维码过期了」，二维码收起", async () => {
  script = [{ error: "expired_token" }];
  const log = captureLog();
  try {
    await channel.createAppStart();
    const st = await waitDone();
    assert.match(st.error, /二维码过期了/);
    assert.equal(st.qr, null);
  } finally {
    log.restore();
  }
});

test("品牌矛盾：飞书报告 lark 租户、却在 lark 域名上又说 feishu → 报错，不保存任何凭证", async () => {
  rmSync(join(DIR, "profile"), { force: true }); rmSync(join(DIR, "profiles.json"), { force: true });
  // 第一次 poll 报 lark → 立即切到 lark 域名；最终凭证上的品牌却是 feishu：矛盾
  script = [{ error: "authorization_pending", user_info: { tenant_brand: "lark" } }, done({ user_info: { open_id: "ou_x", tenant_brand: "feishu" } })];
  const log = captureLog();
  let paired = false;
  try {
    await channel.createAppStart({ onDone: () => (paired = true) });
    const st = await waitDone();
    assert.match(st.error, /品牌.*对不上/);
    assert.equal(st.configured, false, "矛盾时不保存应用");
    assert.equal(paired, false);
    assert.ok(!log.lines.join("\n").includes(SECRET));
  } finally {
    log.restore();
  }
});

test("注册结果没有 open_id：报错，不静默地接一个发不出去的机器人", async () => {
  rmSync(join(DIR, "profile"), { force: true }); rmSync(join(DIR, "profiles.json"), { force: true });
  script = [done({ user_info: { tenant_brand: "feishu" } })];
  const log = captureLog();
  try {
    await channel.createAppStart();
    const st = await waitDone();
    assert.match(st.error, /open_id/);
    assert.equal(st.configured, false);
  } finally {
    log.restore();
  }
});

test("用户在页面上取消：停掉轮询，不留错误、不保存", async () => {
  rmSync(join(DIR, "profile"), { force: true }); rmSync(join(DIR, "profiles.json"), { force: true });
  script = [pending];
  await channel.createAppStart();
  assert.equal(channel.createAppStatus().running, true);
  channel.createAppCancel();
  const st = channel.createAppStatus();
  assert.equal(st.running, false);
  assert.equal(st.error, null);
  assert.equal(st.qr, null);
  await delay(200);
  assert.equal(channel.createAppStatus().configured, false);
});

test("已建应用、没配对的发布机点「重新接」：直接再走一遍注册，覆盖旧应用，不要求先删", async () => {
  writeFileSync(join(DIR, "profiles.json"), JSON.stringify({ versekit: "cli_old" }));
  script = [done({ client_id: "cli_new" })];
  const log = captureLog();
  let paired = null;
  try {
    await channel.createAppStart({ onDone: (r) => (paired = r) });
    const st = await waitDone();
    assert.equal(st.appId, "cli_new");
    assert.equal(paired.openId, "ou_owner");
    assert.deepEqual(JSON.parse(readFileSync(join(DIR, "profiles.json"), "utf8")), { versekit: "cli_new" });
  } finally {
    log.restore();
  }
});

test("轮询超过 expire_in：报过期，不无限等", async () => {
  script = [pending];
  await assert.rejects(pollRegistration({ deviceCode: "d", expiresIn: 1, interval: 1 }, { intervalScale: 0.02 }), (e) => e.code === "timeout");
});

test("vk 守护进程没有第二次授权入口：channel 不再导出 authStart/authFinish", () => {
  assert.equal(channel.authStart, undefined);
  assert.equal(channel.authFinish, undefined);
  assert.equal(existsSync(join(DIR, "audit.log")), true);
});
