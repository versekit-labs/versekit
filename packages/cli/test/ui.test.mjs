// 真浏览器里打开控制台：这一条测的不是「HTML 有没有返回」，而是「人打开它能不能用」。
// CI 没有 Chrome 会自动跳过；开发机上有 Chrome 就会真跑，防止 JS 报错却没人发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-ui-"));
process.env.VK_HOME = HOME;

const core = await import("../../core/src/index.mjs");
const { startDaemon } = await import("../../core/src/daemon.mjs");
const { createCoreHandlers } = await import("../../core/src/handlers.mjs");
const { doctorReport } = await import("../../core/src/doctor.mjs");
const { loadAdapters, buildHandlers } = await import("../../core/src/adapters.mjs");
const driver = await import("../../driver-browser/src/index.mjs");

const missing = driver.browserReady();

test("控制台在真浏览器里能打开：五页都在、没有横向溢出、没有 JS 错误", { skip: missing ?? false }, async () => {
  core.migrate();
  core.open()
    .prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a_ui','bilibili','@uitest',1)")
    .run();

  const adapters = (await loadAdapters()).adapters;
  const handlers = {
    ...buildHandlers(adapters, { log: () => {} }),
    ...createCoreHandlers({ adapters, log: () => {} }),
    doctor: () => doctorReport({ browserReady: () => null, browser: { profile: HOME, port: 0 }, adapters }),
    "channel.status": () => ({ ready: "飞书应用未配置：在「接入」页填写你自己的 app_id 与 app_secret", configured: false, authorized: false, bound: false, profile: "versekit", appId: null }),
  };
  const daemon = await startDaemon({ handlers, runQueue: false, port: 0, socketPath: join(HOME, "ui.sock") });
  const base = `http://127.0.0.1:${daemon.port}`;
  const tab = await driver.openAccount({ accountId: "ui-check", url: `${base}/#overview` });
  try {
    await tab.waitFor(`document.querySelector("#view h1")?.innerText`, [], { timeout: 20e3, what: "控制台首页" });
    await tab.eval(`window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message)))`);

    assert.equal(await tab.eval(`document.querySelectorAll(".tabs a").length`), 7);
    assert.equal(await tab.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`), false);

    const seen = [];
    for (const name of ["setup", "accounts", "publish", "works", "overview", "tasks", "doctor"]) {
      await tab.eval(`location.hash = "#${name}"`);
      await tab.waitFor(`document.querySelector("#view h1")?.innerText`, [], { timeout: 10e3, what: `${name} 视图` });
      seen.push(await tab.eval(`document.querySelector("#view h1").innerText`));
      assert.equal(await tab.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`), false, `${name} 出现横向溢出`);
    }
    assert.deepEqual(seen, ["接入", "账号墙", "发布台", "作品", "总览", "任务与日志", "自检"]);
    assert.deepEqual(await tab.eval(`window.__errors`), [], "页面不应有未捕获的 JS 错误");

    // 没有账号时，打开根地址应该直接落在「接入」，而不是空的总览。
    core.open().prepare("DELETE FROM account").run();
    await tab.goto(`${base}/`);
    await tab.waitFor(`document.querySelector("#view h1")?.innerText === "接入"`, [], { timeout: 15e3, what: "无账号首启落在接入页" });
    assert.equal(await tab.eval(`location.hash`), "#setup");
  } finally {
    await tab.close();
    // 浏览器验收最容易漏的一步：只关标签页会留下一个空 Chrome，堆在用户屏幕上。
    await driver.closeAccount("ui-check");
    await daemon.close();
  }
});
