// #91 账号 Chrome 回收：用假 Chrome 验证「退出即关」「接管孤儿」「用户页面不强关」「池上限」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const HOME = mkdtempSync(join(tmpdir(), "vk-recycle-"));
process.env.HIFABU_HOME = HOME;
process.env.HIFABU_CHROME_BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-chrome.mjs");
// accountPort() 在 [基准, 65000) 里按账号哈希取端口；基准随机落在 40000–55000，与 isolation（20000–40000）错开，减少并行文件撞端口。
process.env.HIFABU_CDP_PORT = String(40000 + Math.floor(Math.random() * 15000));
process.env.HIFABU_BROWSER_POOL = "2";
process.env.HIFABU_BROWSER_IDLE_MS = "400";
delete process.env.HIFABU_CHROME_PROFILE;

const d = await import("../src/index.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** 向内核要一个此刻空闲的端口。 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
/** 等假 Chrome 真的在监听（取代固定 sleep：全量并行时 node 冷启动可能很慢）。 */
async function waitUp(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`端口 ${port} 上的假 Chrome 在 ${timeoutMs}ms 内没起来`);
}
/** 轮询直到 cond() 为真，超时则返回最后一次结果。 */
async function until(cond, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return cond();
}
const pidOf = async (id) => {
  const t = await d.openAccount({ accountId: id });
  await t.close();
  return t;
};

test("idleCloseMs 读环境变量，非法值回落 10 分钟", () => {
  assert.equal(d.idleCloseMs("250"), 250);
  assert.equal(d.idleCloseMs("abc"), 600000);
  assert.equal(d.idleCloseMs(null), 600000);
});

test("ACC-browser-mem-01：closeAllAccounts 关掉所有账号 Chrome", async () => {
  const { readFileSync } = await import("node:fs");
  process.env.HIFABU_BROWSER_IDLE_MS = "60000";
  await pidOf("acc_a");
  await pidOf("acc_b");
  const pids = ["acc_a", "acc_b"].map((id) => JSON.parse(readFileSync(join(d.accountProfile(id), ".vk-driver.json"), "utf8")).pid);
  assert.ok(pids.every(alive));
  assert.equal(await d.closeAllAccounts(), 2);
  await until(() => pids.every((p) => !alive(p)));
  assert.ok(pids.every((p) => !alive(p)), "进程应已退出");
  process.env.HIFABU_BROWSER_IDLE_MS = "400";
});

test("ACC-browser-mem-04：池上限 2，第 3 个排队不报错", async () => {
  process.env.HIFABU_BROWSER_IDLE_MS = "60000";
  const tabs = [];
  for (const id of ["acc_p1", "acc_p2"]) tabs.push(await d.openAccount({ accountId: id }));
  let third = null;
  const p = d.openAccount({ accountId: "acc_p3" }).then((t) => (third = t));
  await sleep(1500);
  assert.equal(third, null, "池满时应排队");
  await d.closeAccount("acc_p1"); // 释放槽位
  await p;
  assert.ok(third, "槽位释放后第 3 个应拿到实例");
  await d.closeAllAccounts();
  process.env.HIFABU_BROWSER_IDLE_MS = "400";
});

test("ACC-browser-mem-02：接管孤儿，空白的空闲后被关；有用户页面的不强关", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const start = (id, port, pages) => {
    const profile = d.accountProfile(id);
    mkdirSync(profile, { recursive: true });
    const child = spawn(process.env.HIFABU_CHROME_BIN, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, FAKE_CHROME_PAGES: JSON.stringify(pages) },
    });
    child.unref();
    writeFileSync(join(profile, ".vk-driver.json"), JSON.stringify({ accountId: id, port, pid: child.pid, headless: false }));
    return child.pid;
  };
  const [portBlank, portBusy] = [await freePort(), await freePort()];
  const blank = start("acc_orphan_blank", portBlank, ["about:blank"]);
  const busy = start("acc_orphan_busy", portBusy, ["https://passport.bilibili.com/login"]);
  await Promise.all([waitUp(portBlank), waitUp(portBusy)]);

  const adopted = await d.adoptOrphanAccounts();
  assert.deepEqual(adopted.sort(), ["acc_orphan_blank", "acc_orphan_busy"]);

  await until(() => !alive(blank), 15000); // 空闲时限 400ms，等到空白孤儿被关
  await sleep(1000); // 再留几个周期，确认有用户页面的没被强关
  assert.ok(!alive(blank), "空白孤儿空闲后应被关");
  assert.ok(alive(busy), "有用户页面的窗口不能被强关");

  await d.closeAllAccounts(); // 退出时一并收掉
  await until(() => !alive(busy));
  assert.ok(!alive(busy));
});

test("closeLoginWindow：无头/未知账号不动，有头账号延时后关闭", async () => {
  assert.equal(await d.closeLoginWindow("acc_nobody"), false);
  process.env.HIFABU_BROWSER_IDLE_MS = "60000";
  const tab = await d.openAccount({ accountId: "acc_login", headless: false });
  assert.equal(await d.closeLoginWindow("acc_login", { delayMs: 50 }), true);
  await sleep(1500);
  assert.equal(d.hasLiveBrowser("acc_login"), false);
  void tab;
  await d.closeAllAccounts();
});
