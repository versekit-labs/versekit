// #100：钉住「登录态落盘」。用临时 VK_HOME 下的 profile 和 CDP 写测试 cookie。
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
// 用 default 账号的首选端口，避开 CI 的临时 TCP 端口范围以及并行浏览器测试的端口带。
process.env.VK_CDP_PORT = String(10_000 + (process.pid % 10_000));

const driver = await import("../src/index.mjs");
const { DEFAULT_ACCOUNT, chromeArgs, cookiePersistenceCheck, accountProfile, openAccount, closeAccount, findChrome } = driver;

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

test("ACC-browser-login-01/03：写入持久 cookie → closeAccount → Cookies 表有行、重开仍在", { timeout: 120_000 }, async () => {
  const chrome = findChrome();
  assert.ok(chrome, "本测试需要本机有 Chrome/Chromium");
  process.env.VK_CHROME_BIN = chrome;
  const id = DEFAULT_ACCOUNT;
  const profile = accountProfile(id);
  const cookie = { name: "vk_test", value: "x", url: "https://example.com/", expires: Math.floor(Date.now() / 1000) + 30 * 86400 };
  try {
    const tab = await openAccount({ accountId: id, headless: true });
    const { pid, port } = JSON.parse(readFileSync(join(profile, ".vk-driver.json"), "utf8"));
    assert.equal(tab.port, port);
    assert.equal((await tab.send("Network.setCookie", cookie)).success, true);
    assert.equal(await closeAccount(id), true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "读 Cookies 前 Chrome 进程应已退出");

    const db = join(profile, "Default", "Cookies");
    assert.ok(existsSync(db) && statSync(db).size > 0, "Cookies 文件应已落盘");
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const { n } = conn.prepare("SELECT COUNT(*) n FROM cookies WHERE name = ? AND host_key = ?").get(cookie.name, "example.com");
      assert.equal(n, 1, "Cookies 表应有 vk_test 的记录");
    } finally {
      conn.close();
    }

    const reopened = await openAccount({ accountId: id, headless: true });
    const { cookies } = await reopened.send("Network.getCookies", { urls: [cookie.url] });
    const found = cookies.find(({ name }) => name === cookie.name);
    assert.ok(found, "重开后 vk_test cookie 仍在");
    assert.equal(found.value, cookie.value);
    assert.equal(found.expires, cookie.expires);
  } finally {
    await closeAccount(id).catch(() => {});
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
