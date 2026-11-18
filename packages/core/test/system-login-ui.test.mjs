// 系统页在真浏览器里走一遍：网页上扫码、短信、窗口三种登录，发布机不在线，现在更新。
//
// 全部用测试替身：登录和更新的 handler 是脚本化的假数据，不打开任何真实平台、不登录任何真实账号
// （开发机红线）。真机上扫码和短信是否真的通，列在 PR 的「待人工」里。
// 没有 Chrome 时自动跳过；CI 不跑真浏览器用例（实例竞态），由设计闸门和下面的静态用例兜底。
//
// 设置 VK_SHOT_DIR 会顺带把每个状态截图（视口高度等于页面高度）放到那个目录，作为实现证据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-sys-login-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { startDaemon } = await import("../src/daemon.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const driver = await import("../../driver-browser/src/index.mjs");

const missing = driver.browserReady();
const skipBrowser = missing ?? (process.env.CI === "true" ? "CI 不跑真浏览器用例（实例竞态）" : false);
const SHOTS = process.env.VK_SHOT_DIR || null;

const PHONE = "13812345678";
const CODE = "246810";
const QR = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#fff"/><path d="M10 10h30v30H10zM80 10h30v30H80zM10 80h30v30H10zM50 50h20v20H50zM80 80h10v30H80z" fill="#111"/></svg>');

test("系统页：扫码自己走到正常、短信转给发布机且不落痕迹、窗口登录才有「我登录好了」、发布机不在线时登录按钮不可用、现在更新", { skip: skipBrowser, timeout: 120e3 }, async () => {
  core.migrate();
  const group = store.addGroup({ name: "出海合规" });
  store.useGroup(group.id);
  const db = core.open();
  const add = (id, platform, handle, state) => db.prepare("INSERT INTO account (id, platform, handle, state, created_at, group_id, last_checked_at) VALUES (?,?,?,?,?,?,?)").run(id, platform, handle, state, 1, group.id, Date.now() - 3600e3);
  add("a_xhs", "xiaohongshu", "@出海合规", "expired");
  add("a_dy", "douyin", "@出海合规", "expired");
  add("a_bili", "bilibili", "@出海合规", "ok");
  store.recordHeartbeat();

  // ── 脚本化的假发布机 ──────────────────────────────────────────────────
  const script = { qr: "waiting", polls: 0, qrCalls: 0, seen: [], opened: 0, updating: 0, updated: false };
  const logs = [];
  const markOk = (id) => db.prepare("UPDATE account SET state='ok', last_checked_at=? WHERE id=?").run(Date.now(), id);
  const adapters = ["xiaohongshu", "douyin", "bilibili"].map((platform) => ({ platform, adapter: { ready: () => null } }));
  const core_ = createCoreHandlers({ adapters, log: (l) => logs.push(String(l)) });
  const handlers = {
    ...core_,
    "machine.status": (args) => ({ ...core_["machine.status"](args), name: "书房的 Mac" }), // 截图里不放真实主机名
    "account.login.qr": async ({ accountId }) => { script.qrCalls++; script.qr = "waiting"; script.polls = 0; script.seen.push({ cmd: "qr", accountId }); return { mode: "qr", state: "waiting", qr: QR }; },
    "account.login.status": async ({ accountId }) => {
      script.polls++;
      if (accountId === "a_dy") return script.manualOk ? (markOk(accountId), { state: "ok", mode: "manual" }) : { state: "pending", mode: "manual" };
      if (script.qr === "ok") { markOk(accountId); return { mode: "qr", state: "ok", persisted: true }; }
      if (script.qr === "scanned") return { mode: "qr", state: "scanned", note: "已扫码，请在手机上确认登录" };
      if (script.qr === "expired") return { mode: "qr", state: "expired", qr: null };
      return { mode: "qr", state: "waiting", qr: QR };
    },
    "account.login.start": async ({ accountId, phone }) => { script.seen.push({ cmd: "start", accountId, phone }); return { mode: "sms", phone: `${phone.slice(0, 3)}****${phone.slice(-4)}`, sent: true }; },
    "account.login.resend": async ({ accountId }) => { script.seen.push({ cmd: "resend", accountId }); return { sent: true }; },
    "account.login.verify": async ({ accountId, code }) => { script.seen.push({ cmd: "verify", accountId, code }); if (code !== CODE) throw new Error("登录失败：验证码不正确"); markOk(accountId); return { ok: true, state: "ok" }; },
    "account.login.open": async ({ accountId }) => { script.opened++; script.seen.push({ cmd: "open", accountId }); return { opened: true }; },
    "account.login.cancel": async () => ({ canceled: true }),
    "account.check": async ({ accountId }) => ({ accountId, state: "ok" }),
    "account.logout": async ({ accountId }) => { db.prepare("UPDATE account SET state='expired' WHERE id=?").run(accountId); return { accountId, state: "expired" }; },
    "update.status": () => script.updated
      ? { version: "0.9.2", display: "0.9.2+bbbbbbb", commit: "b".repeat(40), short: "bbbbbbb", auto: true, intervalHours: 6, lastCheckAt: Date.now(), lastCheck: { up_to_date: true, message: "已是最新" }, lastUpdate: { at: Date.now(), display: "0.9.2+bbbbbbb", commits: ["通用文案按字段覆盖", "现在发和预约发"] }, lastFailure: null, inProgress: false }
      : { version: "0.9.1", display: "0.9.1+aaaaaaa", commit: "a".repeat(40), short: "aaaaaaa", auto: true, intervalHours: 6, lastCheckAt: Date.now() - 600e3, lastCheck: { up_to_date: false, behind: 2, message: "有新版本：2 个提交" }, lastUpdate: null, lastFailure: null, inProgress: script.updating > 0 && script.updating < 3 && (script.updating++, true) },
    update: async (args) => {
      if (args?.auto) return { auto: args.auto === "on" };
      script.seen.push({ cmd: "update" });
      script.updating = 1;
      setTimeout(() => { script.updated = true; }, 600);
      return { started: true };
    },
  };

  const daemon = await startDaemon({ handlers, runQueue: false, port: 0, socketPath: join(HOME, "sys.sock"), log: (l) => logs.push(String(l)) });
  const base = `http://127.0.0.1:${daemon.port}`;
  let tab = null;
  const text = () => tab.eval(`document.querySelector("main").innerText`);
  const click = (sel) => tab.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("找不到 ${sel.replace(/"/g, "'")}"); e.click(); return true; })()`);
  const waitText = (re, what, timeout = 15e3) => tab.waitFor(`new RegExp(${JSON.stringify(re.source)}).test(document.querySelector("main").innerText)`, [], { timeout, every: 150, what });
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const h = await tab.eval(`Math.ceil(document.documentElement.scrollHeight)`);
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1360, height: h, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(join(SHOTS, name), await tab.screenshot());
  };
  // 每次整页导航都会换 document，错误收集器要在新页面上重新装；之前页面收到的错误并进 errors。
  const errors = [];
  const watch = async () => {
    errors.push(...((await tab.eval(`window.__errors || []`).catch(() => [])) ?? []));
    await tab.eval(`window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message))); window.addEventListener("unhandledrejection", (e) => window.__errors.push("rejection:" + String((e.reason && e.reason.message) || e.reason)))`);
  };
  const row = (id) => `tr[data-acc="${id}"]`;
  const rowText = (id) => tab.eval(`(() => { const r = document.querySelector(${JSON.stringify(row(id))}); return r ? r.innerText + "\\n" + (r.nextElementSibling?.classList.contains("subrow") ? r.nextElementSibling.innerText : "") : ""; })()`);

  try {
    tab = await driver.openAccount({ accountId: "sys-login-ui", url: `${base}/system#pollms=200`, headless: process.env.CI === "true" });
    await tab.waitFor(`document.querySelector("main table")`, [], { timeout: 25e3, what: "系统页" });
    await watch();

    // 界面上没有命令（ACC-v3-nocli-01 的运行时版）
    assert.doesNotMatch(await text(), /\bvk [a-z]|npm |curl |config\.json/);
    assert.equal(await tab.eval(`document.querySelectorAll("main code").length`), 0, "不用 <code> 包命令");
    await shot("system-accounts.png");

    // ── 扫码：二维码在账号那一行下面，状态自己往前走，不需要人点「我登录好了」 ──
    await click(`${row("a_xhs")} [data-login]`);
    await waitText(/等你扫码/, "等你扫码");
    assert.equal(await tab.eval(`!!document.querySelector(${JSON.stringify(row("a_xhs"))}).nextElementSibling.querySelector(".qr img")`), true, "二维码显示在这一行下面");
    assert.match(await rowText("a_xhs"), /用小红书 App 扫这个码/);
    assert.match(await rowText("a_xhs"), /改用短信验证码/);
    assert.match(await rowText("a_xhs"), /在发布机上打开登录窗口/);
    assert.doesNotMatch(await rowText("a_xhs"), /我登录好了|我扫好了/, "扫码没有「我登录好了」");
    await shot("system-qr-waiting.png");
    script.qr = "scanned";
    await waitText(/已扫码，在手机上点确认/, "已扫码");
    await shot("system-qr-scanned.png");
    script.qr = "expired";
    await waitText(/二维码过期了/, "二维码过期了");
    assert.match(await rowText("a_xhs"), /换一个/);
    await shot("system-qr-expired.png");
    await click(`${row("a_xhs")} + tr [data-loginmode="qr"]`); // 换一个
    await waitText(/等你扫码/, "换了新码");
    assert.equal(script.qrCalls, 2, "换一个 = 再取一次码");
    script.qr = "ok";
    await tab.waitFor(`/正常/.test(document.querySelector(${JSON.stringify(row("a_xhs"))}).innerText)`, [], { timeout: 15e3, every: 150, what: "扫完自己变成正常" });
    assert.doesNotMatch(await rowText("a_xhs"), /等你扫码/);

    // ── 短信：网页上填手机号、填验证码，转给发布机；痕迹里没有 ──
    db.prepare("UPDATE account SET state='expired' WHERE id='a_xhs'").run();
    await tab.goto(`${base}/system?r=1#pollms=200`);
    await tab.waitFor(`document.querySelector(${JSON.stringify(row("a_xhs"))})`, [], { timeout: 15e3, what: "刷新后的系统页" });
    await watch();
    await click(`${row("a_xhs")} [data-login]`);
    await waitText(/等你扫码/, "又是扫码");
    await click(`${row("a_xhs")} + tr [data-loginmode="sms"]`);
    await waitText(/用短信验证码登录小红书/, "短信第一步");
    assert.match(await rowText("a_xhs"), /手机号只用来登录这一次，不会存下来/);
    await shot("system-sms-phone.png");
    await tab.eval(`(() => { const i = document.getElementById("sms-phone"); i.value = "123"; document.querySelector("[data-smssend]").click(); })()`);
    await waitText(/手机号要填 11 位数字/, "手机号校验");
    await tab.eval(`(() => { const i = document.getElementById("sms-phone"); i.value = ${JSON.stringify(PHONE)}; document.querySelector("[data-smssend]").click(); })()`);
    await waitText(/填收到的验证码/, "短信第二步");
    assert.match(await rowText("a_xhs"), /已发到 138\*\*\*\*5678/, "页面上只显示打了码的手机号");
    assert.doesNotMatch(await tab.eval(`document.documentElement.outerHTML`), new RegExp(PHONE), "完整手机号不留在页面里");
    await shot("system-sms-code.png");
    await tab.eval(`(() => { document.getElementById("sms-code").value = "000000"; document.querySelector("[data-smsgo]").click(); })()`);
    await waitText(/验证码不正确/, "验证码错了有话说");
    await tab.eval(`(() => { document.getElementById("sms-code").value = ${JSON.stringify(CODE)}; document.querySelector("[data-smsgo]").click(); })()`);
    await tab.waitFor(`/正常/.test(document.querySelector(${JSON.stringify(row("a_xhs"))}).innerText)`, [], { timeout: 15e3, every: 150, what: "短信登录后变成正常" });
    assert.ok(script.seen.some((s) => s.cmd === "start" && s.phone === PHONE), "手机号转给了发布机");
    assert.ok(script.seen.some((s) => s.cmd === "verify" && s.code === CODE), "验证码转给了发布机");
    // 不落库、不进日志、不进审计
    const everything = JSON.stringify([
      logs,
      db.prepare("SELECT * FROM command_audit").all(),
      db.prepare("SELECT * FROM event").all(),
      db.prepare("SELECT * FROM meta").all(),
    ]);
    assert.ok(!everything.includes(PHONE) && !everything.includes(CODE), "手机号和验证码不在日志、审计、事件、库里");
    assert.equal(await tab.eval(`JSON.stringify([localStorage, sessionStorage, location.href])`).then((s) => s.includes(PHONE) || s.includes(CODE)), false, "也不在浏览器存储和地址里");

    // ── 窗口：第三种方式，只有这种有「我登录好了」；没有无头登录的平台只有这一种 ──
    await click(`${row("a_dy")} [data-login]`);
    await waitText(/在打开的窗口里登录抖音/, "窗口登录");
    const dyRow = await rowText("a_dy");
    assert.match(dyRow, /我登录好了/);
    assert.doesNotMatch(dyRow, /改用短信验证码|改用扫码/, "抖音发布机取不了二维码，只给窗口");
    assert.equal(script.opened, 1);
    await shot("system-window.png");
    script.manualOk = true;
    await tab.waitFor(`/正常/.test(document.querySelector(${JSON.stringify(row("a_dy"))}).innerText)`, [], { timeout: 15e3, every: 150, what: "窗口里登录好了自己认出来" });

    // ── 退出登录：行内确认 ──
    await click(`${row("a_xhs")} [data-logout]`);
    await waitText(/退出后会清掉这个账号/, "行内确认");
    assert.equal(await tab.eval(`!!document.querySelector("[role=dialog]")`), false, "不弹窗");
    await shot("system-logout-confirm.png");
    await click("[data-logoutno]");

    // ── 发布机不在线：登录按钮不可用并说明原因 ──
    store.recordHeartbeat(Date.now() - 3600e3);
    await tab.goto(`${base}/system?r=2#pollms=200`);
    await tab.waitFor(`document.querySelector(${JSON.stringify(row("a_bili"))})`, [], { timeout: 15e3, what: "不在线时的系统页" });
    await watch();
    await waitText(/发布机不在线，登录要它在线/, "不在线的说明");
    assert.equal(await tab.eval(`[...document.querySelectorAll("[data-login]")].every((b) => b.disabled)`), true, "每个登录按钮都不可用");
    assert.equal(await tab.eval(`document.querySelectorAll("[data-login]").length > 0`), true);
    await shot("system-offline.png");
    store.recordHeartbeat();

    // ── 设备：现在更新 ──
    await tab.goto(`${base}/system?r=3#tab=devices&pollms=200`);
    await tab.waitFor(`document.querySelector("table.dev")`, [], { timeout: 15e3, what: "设备分段" });
    await watch();
    await waitText(/有新版本：2 个提交/, "有新版本");
    assert.match(await text(), /自动更新开着/);
    assert.doesNotMatch(await text(), /看更新了什么/, "更新内容没更新过时不展开也不出现");
    await shot("system-devices.png");
    await click("[data-updnow]");
    await waitText(/正在更新…/, "正在更新…");
    await shot("system-updating.png");
    await waitText(/0\.9\.2\+bbbbbbb/, "版本变了", 20e3);
    assert.match(await text(), /已是最新/);
    assert.ok(script.seen.some((s) => s.cmd === "update"));
    // 更新内容默认收起，点了才展开
    assert.doesNotMatch(await text(), /通用文案按字段覆盖/);
    await click("[data-notes]");
    await waitText(/通用文案按字段覆盖/, "展开更新内容");
    await shot("system-devices-notes.png");

    await watch();
    assert.deepEqual(errors, [], "不应有未捕获的 JS 错误");
  } finally {
    if (tab) await tab.close().catch(() => {});
    await driver.closeAccount("sys-login-ui").catch(() => {});
    await daemon.close();
  }
});

// ── 静态用例：不需要 Chrome，CI 也跑 ─────────────────────────────────────────

const page = readFileSync(new URL("../../web/public/system.html", import.meta.url), "utf8");

test("ACC-v3-login-01/03/05：页面里三种登录方式、「我登录好了」只在窗口方式、发布机不在线的话术", () => {
  assert.match(page, /login\/qr/);
  assert.match(page, /login\/start/);
  assert.match(page, /login\/verify/);
  assert.match(page, /login\/open/);
  assert.match(page, /发布机不在线，登录要它在线/);
  // 「我登录好了」只出现在 win 这一种方式的分支里
  const hits = [...page.matchAll(/我登录好了/g)].length;
  assert.equal(hits, 1, "「我登录好了」只在窗口登录一处出现");
  assert.match(page, /case "win":[\s\S]*?我登录好了/);
});

test("ACC-v3-login-06：写「这台电脑」的地方换成发布机的名字，扫码或短信的提示保留", () => {
  assert.match(page, /发布机「\$\{m\}」/);
  assert.match(page, /要接另一个号，先在 App 里切换账号，或者改用短信验证码/);
  assert.doesNotMatch(page, /保存在这台电脑|登录在这台电脑/);
});

test("ACC-v3-login-02：手机号和验证码不写进页面状态、不进浏览器存储", () => {
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  // 手机号只在发送那一刻从输入框读出，页面状态里只留打了码的号
  assert.match(page, /masked: `\$\{phone\.slice\(0, 3\)\}\*\*\*\*\$\{phone\.slice\(-4\)\}`/);
});

test("login 命令不进审计：手机号、验证码经过命令层时不写 command_audit", async () => {
  const { findCommand } = await import("../src/commands.mjs");
  for (const name of ["account.login.start", "account.login.verify", "account.login.resend", "account.login.qr", "account.login.status", "account.login.open", "account.login.cancel"]) {
    assert.equal(findCommand(name).audit, "never", `${name} 的参数里可能有手机号或验证码，不能进审计`);
  }
});
