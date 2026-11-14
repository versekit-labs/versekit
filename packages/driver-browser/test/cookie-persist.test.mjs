// #100：钉住「登录态落盘」。临时 VK_HOME + 临时账号 id + CDP 写测试 cookie，不碰真实账号。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "vk-cookie-"));
process.env.VK_HOME = HOME;
delete process.env.VK_CHROME_MOCK_KEYCHAIN;
delete process.env.VK_CHROME_PROFILE;
delete process.env.VK_CDP_PORT;

const driver = await import("../src/index.mjs");
const { chromeArgs, cookiePersistenceCheck, accountProfile, openAccount, closeAccount, findChrome } = driver;

test("ACC-browser-login-01：启动参数带 --use-mock-keychain，可用 VK_CHROME_MOCK_KEYCHAIN=0 关掉", () => {
  const a = { port: 9400, profile: "/tmp/p" };
  assert.ok(chromeArgs(a, {}).includes("--use-mock-keychain"));
  assert.ok(chromeArgs({ ...a, headless: true }, {}).includes("--use-mock-keychain"));
  assert.ok(!chromeArgs(a, { VK_CHROME_MOCK_KEYCHAIN: "0" }).includes("--use-mock-keychain"));
});

test("ACC-browser-login-02：后台会话 + 关掉修复 → 用人话报「登录不会被保存」", () => {
  const bad = cookiePersistenceCheck({ env: { VK_CHROME_MOCK_KEYCHAIN: "0" }, managername: "Background" });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /登录不会被保存/);
  assert.ok(bad.next);
  assert.equal(cookiePersistenceCheck({ env: {}, managername: "Background" }).ok, true);
  assert.equal(cookiePersistenceCheck({ env: { VK_CHROME_MOCK_KEYCHAIN: "0" }, managername: "Aqua" }).ok, true);
});

async function browserCdp(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("cdp connect"));
  });
  let n = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
  };
  const call = (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { call, close: () => ws.close() };
}

// 只信 profile 里的标记：绝不扫端口，免得把测试 cookie 写进用户正在用的真实账号 Chrome。
function portOf(profile) {
  const marker = JSON.parse(readFileSync(join(profile, ".vk-driver.json"), "utf8"));
  assert.ok(Number.isInteger(marker.port), "标记里应有端口");
  return marker.port;
}

test("ACC-browser-login-01/03：写入持久 cookie → closeAccount → Cookies 表有行、重开仍在", { timeout: 120_000 }, async () => {
  assert.ok(findChrome(), "本测试需要本机有 Chrome/Chromium");
  const id = `acc_cookie_test_${process.pid}`;
  const profile = accountProfile(id);
  try {
    const tab = await openAccount({ accountId: id, headless: true, url: "about:blank" });
    await tab.close().catch(() => {});
    const port = portOf(profile);
    const cdp = await browserCdp(port);
    const expires = Math.floor(Date.now() / 1000) + 30 * 86400;
    const set = await cdp.call("Storage.setCookies", {
      cookies: [{ name: "vk_test", value: "x", domain: "example.com", path: "/", expires }],
    });
    assert.ok(!set.error, JSON.stringify(set.error));
    cdp.close();

    assert.equal(await closeAccount(id), true);

    const db = join(profile, "Default", "Cookies");
    assert.ok(existsSync(db) && statSync(db).size > 0, "Cookies 文件应已落盘");
    const conn = new DatabaseSync(db, { readOnly: true });
    const n = conn.prepare("SELECT COUNT(*) n FROM cookies").get().n;
    conn.close();
    assert.ok(n > 0, `cookies 表行数应 > 0，实际 ${n}`);

    await openAccount({ accountId: id, headless: true, url: "about:blank" });
    const c = await browserCdp(portOf(profile));
    const r = await c.call("Storage.getCookies");
    const found = (r.result?.cookies ?? []).some((k) => k.name === "vk_test");
    c.close();
    assert.ok(found, "重开后 vk_test cookie 仍在");
  } finally {
    await closeAccount(id).catch(() => {});
    rmSync(HOME, { recursive: true, force: true });
  }
});
