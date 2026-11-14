// #101 小红书扫码登录 + #112 CLI 参数解析的回归测试。
//
//   · ACC-account-08：`vk account login <id> --phone <手机号>` / `--code <验证码>` 必须被正确解析
//     （#112：两者不在带值参数表里，被当成布尔，值丢了）。这里只测解析与分派，绝不真的发短信。
//   · ACC-account-06/07：扫码页面操作（切到扫码、取码、过期换新、已扫待确认、风控）在假页面上跑，
//     假页面复刻 2026-11-14 真机看到的结构：右上角 64px 的 data:image 图标、160px 的二维码图片。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME ??= mkdtempSync(join(tmpdir(), "vk-xhs-qr-"));
const { parseArgv, loginCommandOf, VALUE_FLAGS } = await import("../src/argv.mjs");
const { qrProbe, switchToQr, readQr, refreshQr, qrStateOf } = await import("../src/login-xhs.mjs");
const { COMMANDS } = await import("../../core/src/commands.mjs");
const { loginHint } = await import("../../core/src/handlers.mjs");
const { openAccount, closeAccount, browserReady } = await import("../../driver-browser/src/index.mjs");

// ---------------------------------------------------------------- 参数解析（ACC-account-08）

test("parseArgv：--phone / --code 是带值参数，值不会掉成位置参数（#112）", () => {
  const a = parseArgv(["account", "login", "acc_1", "--phone", "13800000000"]);
  assert.equal(a.flags["--phone"], "13800000000");
  assert.deepEqual(a.pos, ["account", "login", "acc_1"]);

  const b = parseArgv(["account", "login", "acc_1", "--code", "123456", "--human"]);
  assert.equal(b.flags["--code"], "123456");
  assert.equal(b.flags["--human"], true);
  assert.deepEqual(b.pos, ["account", "login", "acc_1"]);

  // 顺序无关：flag 在 id 前面也一样
  const c = parseArgv(["account", "login", "--phone", "13800000000", "acc_1"]);
  assert.equal(c.flags["--phone"], "13800000000");
  assert.deepEqual(c.pos, ["account", "login", "acc_1"]);

  assert.ok(VALUE_FLAGS.has("--phone") && VALUE_FLAGS.has("--code"));
});

test("parseArgv：带值参数缺值时不吞掉下一个 --flag", () => {
  const a = parseArgv(["account", "login", "acc_1", "--phone", "--human"]);
  assert.equal(a.flags["--phone"], undefined);
  assert.equal(a.flags["--human"], true);
  const b = parseArgv(["account", "login", "acc_1", "--code"]);
  assert.equal(b.flags["--code"], undefined);
});

test("parseArgv：原有的带值参数行为不变", () => {
  const a = parseArgv(["account", "list", "--group", "主力组", "--human"]);
  assert.equal(a.flags["--group"], "主力组");
  const b = parseArgv(["publish", "a.mp4", "--to", "tiktok,bilibili", "--dry-run"]);
  assert.equal(b.flags["--to"], "tiktok,bilibili");
  assert.equal(b.flags["--dry-run"], true);
  assert.deepEqual(b.pos, ["publish", "a.mp4"]);
});

test("loginCommandOf：每种登录参数分派到对应命令，载荷带上值", () => {
  const of = (argv) => loginCommandOf("acc_1", parseArgv(argv).flags);
  assert.deepEqual(of(["--phone", "13800000000"]), { name: "account.login.start", args: { accountId: "acc_1", phone: "13800000000" } });
  assert.deepEqual(of(["--code", "654321"]), { name: "account.login.verify", args: { accountId: "acc_1", code: "654321" } });
  assert.deepEqual(of(["--qr"]), { name: "account.login.qr", args: { accountId: "acc_1" } });
  assert.deepEqual(of(["--open"]), { name: "account.login.open", args: { accountId: "acc_1" } });
  assert.deepEqual(of(["--status"]), { name: "account.login.status", args: { accountId: "acc_1" } });
  assert.deepEqual(of(["--resend"]), { name: "account.login.resend", args: { accountId: "acc_1" } });
  assert.deepEqual(of(["--cancel"]), { name: "account.login.cancel", args: { accountId: "acc_1" } });
  // 缺值 / 没参数：交给调用方报用法，而不是发一个空号码出去
  assert.equal(of(["--phone"]), null);
  assert.equal(of([]), null);
});

test("每个登录分派目标都在命令表里，CLI 用法与参数一致（三端一致）", () => {
  const names = new Set(COMMANDS.map((c) => c.name));
  for (const argv of [["--qr"], ["--phone", "1"], ["--code", "1"], ["--open"], ["--status"], ["--resend"], ["--cancel"]]) {
    const cmd = loginCommandOf("x", parseArgv(argv).flags);
    assert.ok(names.has(cmd.name), `${cmd.name} 不在 commands.mjs`);
  }
  const qr = COMMANDS.find((c) => c.name === "account.login.qr");
  assert.equal(qr.http.method, "POST");
  assert.equal(qr.http.path, "/api/accounts/:accountId/login/qr");
  assert.match(qr.cli.usage, /--qr/);
  assert.equal(qr.remote, false, "扫码要人在场，不能从卡片远程触发");
});

test("loginHint：小红书默认指向扫码，其他平台照旧", () => {
  assert.match(loginHint("xiaohongshu", "acc_1"), /vk account login acc_1 --qr/);
  assert.match(loginHint("xiaohongshu", "acc_1"), /--phone/);
  assert.match(loginHint("tiktok", "acc_2"), /vk account reauth acc_2/);
});

// ---------------------------------------------------------------- 状态归类（纯函数）

test("qrStateOf：离开 /login=ok，风控=failed，过期优先于已扫，没码=failed", () => {
  const base = { path: "/login", qrMode: true, qr: "data:image/png;base64,AA", expired: false, scanned: false, risk: null };
  assert.equal(qrStateOf(base), "waiting");
  assert.equal(qrStateOf({ ...base, scanned: true }), "scanned");
  assert.equal(qrStateOf({ ...base, expired: true, scanned: true }), "expired");
  assert.equal(qrStateOf({ ...base, risk: "请完成安全验证" }), "failed");
  assert.equal(qrStateOf({ ...base, qr: null }), "failed");
  assert.equal(qrStateOf({ ...base, qrMode: false }), "failed");
  assert.equal(qrStateOf({ ...base, path: "/new/home" }), "ok");
});

// ---------------------------------------------------------------- 假登录页（真 Chrome）

const skipNoChrome = browserReady() ?? (process.env.CI === "true" ? "CI 不跑真浏览器用例（实例竞态）" : false);

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const PAGE = `<!doctype html><meta charset="utf-8"><body>
<div class="card" style="position:relative;width:420px;height:420px;margin:40px auto">
  <img class="css-wemwzq" id="corner" src="${PNG}" style="position:absolute;right:0;top:0;width:64px;height:64px">
  <div id="body"><div>短信登录</div><input placeholder="手机号"><div>发送验证码</div></div>
</div>
<script>
  let n = 0;
  const qrHtml = (extra) => '<div>APP扫一扫登录</div><img class="css-1lhmg90" id="qr" src="${PNG}#' + (++n) + '" style="width:160px;height:160px">' + (extra || '') + '<div>扫码即同意</div>';
  document.querySelector('#corner').addEventListener('click', () => {
    setTimeout(() => { document.querySelector('#body').innerHTML = qrHtml(); }, 150);
  });
  window.__expire = () => {
    document.querySelector('#body').innerHTML = qrHtml('<div>二维码已失效，请刷新</div><span id="refresh" style="cursor:pointer">刷新</span>');
    document.querySelector('#refresh').addEventListener('click', () => {
      setTimeout(() => { document.querySelector('#body').innerHTML = qrHtml(); }, 150);
    });
  };
  window.__scan = () => { document.querySelector('#body').insertAdjacentHTML('beforeend', '<div>请在手机上确认登录</div>'); };
  window.__risk = () => { document.querySelector('#body').innerHTML = '<div>请完成安全验证后再试</div>'; };
</script>
</body>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
let base;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/login`;
});
after(() => server.close());

const ACCOUNT = "xhs-qr-fixture";
async function open() {
  const tab = await openAccount({ accountId: ACCOUNT, url: base, headless: true });
  await tab.waitFor(`!!document.querySelector('#corner')`, [], { timeout: 15e3, what: "假登录页" });
  return tab;
}

test("switchToQr + readQr：点右上角图标切到扫码，并取到 data:image 二维码", { skip: skipNoChrome }, async () => {
  const tab = await open();
  try {
    assert.equal((await qrProbe(tab)).qrMode, false, "起始是短信登录");
    const probe = await switchToQr(tab);
    assert.equal(probe.qrMode, true);
    const qr = await readQr(tab);
    assert.match(qr, /^data:image\/png;base64,/);
    assert.equal(qrStateOf(await qrProbe(tab)), "waiting");
    // 已在扫码模式时再调一次是空操作
    assert.equal((await switchToQr(tab)).qrMode, true);
  } finally {
    await closeAccount(ACCOUNT);
  }
});

test("过期 → refreshQr 换新码（新码与旧码不同）；已扫 → scanned", { skip: skipNoChrome }, async () => {
  const tab = await open();
  try {
    await switchToQr(tab);
    const first = await readQr(tab);
    await tab.eval(`window.__expire()`);
    assert.equal(qrStateOf(await qrProbe(tab)), "expired");
    const second = await refreshQr(tab, first);
    assert.notEqual(second, first, "换的必须是新码");
    assert.equal(qrStateOf(await qrProbe(tab)), "waiting");
    await tab.eval(`window.__scan()`);
    assert.equal(qrStateOf(await qrProbe(tab)), "scanned");
  } finally {
    await closeAccount(ACCOUNT);
  }
});

test("风控页：归为 failed 并带出页面原话（调用方据此给备用入口）", { skip: skipNoChrome }, async () => {
  const tab = await open();
  try {
    await switchToQr(tab);
    await tab.eval(`window.__risk()`);
    const probe = await qrProbe(tab);
    assert.equal(qrStateOf(probe), "failed");
    assert.match(probe.risk, /安全验证/);
  } finally {
    await closeAccount(ACCOUNT);
  }
});

test("页面改版（没有切换图标）：switchToQr 抛出人话，不静默", { skip: skipNoChrome }, async () => {
  const tab = await open();
  try {
    await tab.eval(`document.querySelector('#corner').remove()`);
    await assert.rejects(switchToQr(tab), /页面可能改版/);
  } finally {
    await closeAccount(ACCOUNT);
  }
});
