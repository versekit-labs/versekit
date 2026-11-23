// #375 登录窗口只等 DOM 就绪：永不触发 load 的页面 → 打开成功；导航失败 → 报打不开 + errorText。
// 假 Chrome 对正常页面永不发 load/DOM 事件（等价于「重页面一直不 load」）；.invalid 域名返回 errorText。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-login-win-"));
process.env.VK_CHROME_BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-chrome.mjs");
process.env.VK_CDP_PORT = String(55500 + Math.floor(Math.random() * 4000));
delete process.env.VK_CHROME_PROFILE;

const d = await import("../src/index.mjs");
after(() => d.closeAllAccounts?.());

test("登录窗口：页面永不触发 load/DOM 事件也打开成功，不报错、不关窗口", async () => {
  const t0 = Date.now();
  const tab = await d.openAccount({ accountId: "acc_login_slow", url: "https://creator.example.test/", loginWindow: true, gotoTimeout: 300 });
  assert.ok(tab, "返回了 tab");
  assert.ok(Date.now() - t0 >= 250, "确实等过一小会儿才放行");
  assert.ok(d.hasLiveBrowser("acc_login_slow"), "窗口还开着");
});

test("非登录窗口：同样的页面仍按原样等 load 并超时报错（发布流程不变）", async () => {
  await assert.rejects(
    async () => {
      const tab = await d.openAccount({ accountId: "acc_pub_slow" });
      await tab.goto("https://creator.example.test/", { timeout: 300 });
    },
    /等不到页面加载/,
  );
});

test("登录窗口：导航本身失败 → 报打不开并写出 errorText", async () => {
  await assert.rejects(
    d.openAccount({ accountId: "acc_login_bad", url: "https://nope.invalid/", loginWindow: true, gotoTimeout: 300 }),
    /打不开 https:\/\/nope\.invalid\/：net::ERR_NAME_NOT_RESOLVED/,
  );
});
