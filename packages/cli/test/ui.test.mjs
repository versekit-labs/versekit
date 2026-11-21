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
const store = await import("../../core/src/store.mjs");
const { startDaemon } = await import("../../core/src/daemon.mjs");
const { createCoreHandlers } = await import("../../core/src/handlers.mjs");
const { doctorReport } = await import("../../core/src/doctor.mjs");
const { loadAdapters, buildHandlers } = await import("../../core/src/adapters.mjs");
const driver = await import("../../driver-browser/src/index.mjs");

const missing = driver.browserReady();
// CI 上的 Chrome 实例开关存在竞态（同一 profile 复用时会拿到正在退出的实例），
// 真浏览器验收只在开发机跑；CI 由 design:check 的静态门禁兜底。
const skipBrowser = missing ?? (process.env.CI === "true" ? "CI 不跑真浏览器用例（实例竞态），本地跑 design:check" : false);

test("控制台在新设计下能打开：四个页面都在、没有横向溢出、没有 JS 错误", { skip: skipBrowser }, async () => {
  core.migrate();
  const group = store.addGroup({ name: "UI 验收组" });
  store.useGroup(group.id);
  core.open()
    .prepare("INSERT INTO account (id, platform, handle, created_at, group_id) VALUES ('a_ui','bilibili','@uitest',1,?)")
    .run(group.id);

  const adapters = (await loadAdapters()).adapters;
  const handlers = {
    ...buildHandlers(adapters, { log: () => {} }),
    ...createCoreHandlers({ adapters, log: () => {} }),
    doctor: () => doctorReport({ browserReady: () => null, browser: { profile: HOME, port: 0 }, adapters }),
    "channel.status": () => ({ ready: "飞书应用未配置：在「接入」页填写你自己的 app_id 与 app_secret", configured: false, authorized: false, bound: false, profile: "versekit", appId: null }),
  };
  const daemon = await startDaemon({ handlers, runQueue: false, port: 0, socketPath: join(HOME, "ui.sock") });
  const base = `http://127.0.0.1:${daemon.port}`;
  let tab = null;
  try {
    tab = await driver.openAccount({ accountId: `ui-check-${process.pid}`, url: `${base}/today`, headless: process.env.CI === "true" });
    await tab.waitFor(`document.querySelector("main .hd h1")?.innerText`, [], { timeout: 25e3, what: "今天页" });

    // v2 外壳：#148 之后只有四个页面（今天是首页），导航也只有这一份来源。
    const pages = [
      ["/today", "今天"],
      ["/works", "作品"],
      ["/work", "作品详情"],
      ["/data", "数据"],
      ["/system", "系统"],
    ];
    const seen = [];
    for (const [path, title] of pages) {
      await tab.goto(`${base}${path}`);
      // 每次整页导航都会换 document，错误收集器要在新页面上重新装一次。
      await tab.eval(`window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message))); window.addEventListener("unhandledrejection", (e) => window.__errors.push("rejection:" + String((e.reason && e.reason.message) || e.reason)))`);
      await tab.waitFor(`document.querySelector("main .hd h1")?.innerText === ${JSON.stringify(title)}`, [], { timeout: 25e3, what: `${title} 页` });
      await new Promise((r) => setTimeout(r, 800));
      seen.push(await tab.eval(`document.querySelector("main .hd h1").innerText`));
      assert.equal(await tab.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`), false, `${title} 出现横向溢出`);
      assert.equal(await tab.eval(`document.querySelectorAll("nav.nav a.nv").length`), 4, `${title} 的导航必须来自共享外壳`);
      assert.deepEqual(await tab.eval(`window.__errors`), [], `${title} 不应有未捕获的 JS 错误`);
    }
    assert.deepEqual(seen, ["今天", "作品", "作品详情", "数据", "系统"]);

    // 侧栏能一路点过去，不回旧单页（#setup 那套旧 tab 已经不存在）。
    await tab.goto(`${base}/today`);
    await tab.waitFor(`document.querySelector("main .hd h1")?.innerText === "今天"`, [], { timeout: 25e3, what: "今天页" });
    await tab.eval(`document.querySelector('nav.nav a.nv[href="/works"]').click()`);
    await tab.waitFor(`document.querySelector("main .hd h1")?.innerText === "作品"`, [], { timeout: 25e3, what: "点导航到作品" });
    assert.equal(await tab.eval(`location.hash`), "", "导航不能退回 #setup 旧路由");
  } finally {
    if (tab) await tab.close().catch(() => {});
    await driver.closeAccount(`ui-check-${process.pid}`).catch(() => {});
    await daemon.close();
  }
});
