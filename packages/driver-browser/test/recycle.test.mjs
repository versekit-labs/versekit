// #91 账号 Chrome 回收：用假 Chrome 验证「退出即关」「接管孤儿」「用户页面不强关」「池上限」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "vk-recycle-"));
process.env.VK_HOME = HOME;
process.env.VK_CHROME_BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-chrome.mjs");
process.env.VK_CDP_PORT = String(30000 + (process.pid % 5000));
process.env.VK_BROWSER_POOL = "2";
process.env.VK_BROWSER_IDLE_MS = "400";
delete process.env.VK_CHROME_PROFILE;

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
  process.env.VK_BROWSER_IDLE_MS = "60000";
  await pidOf("acc_a");
  await pidOf("acc_b");
  const pids = ["acc_a", "acc_b"].map((id) => JSON.parse(readFileSync(join(d.accountProfile(id), ".vk-driver.json"), "utf8")).pid);
  assert.ok(pids.every(alive));
  assert.equal(await d.closeAllAccounts(), 2);
  await sleep(300);
  assert.ok(pids.every((p) => !alive(p)), "进程应已退出");
  process.env.VK_BROWSER_IDLE_MS = "400";
});

test("ACC-browser-mem-04：池上限 2，第 3 个排队不报错", async () => {
  process.env.VK_BROWSER_IDLE_MS = "60000";
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
  process.env.VK_BROWSER_IDLE_MS = "400";
});

test("ACC-browser-mem-02：接管孤儿，空白的空闲后被关；有用户页面的不强关", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const start = (id, port, pages) => {
    const profile = d.accountProfile(id);
    mkdirSync(profile, { recursive: true });
    const child = spawn(process.env.VK_CHROME_BIN, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, FAKE_CHROME_PAGES: JSON.stringify(pages) },
    });
    child.unref();
    writeFileSync(join(profile, ".vk-driver.json"), JSON.stringify({ accountId: id, port, pid: child.pid, headless: false }));
    return child.pid;
  };
  const base = Number(process.env.VK_CDP_PORT) + 200;
  const blank = start("acc_orphan_blank", base, ["about:blank"]);
  const busy = start("acc_orphan_busy", base + 1, ["https://passport.bilibili.com/login"]);
  await sleep(800);

  const adopted = await d.adoptOrphanAccounts();
  assert.deepEqual(adopted.sort(), ["acc_orphan_blank", "acc_orphan_busy"]);

  await sleep(2500); // > 空闲时限 400ms 数个周期
  assert.ok(!alive(blank), "空白孤儿空闲后应被关");
  assert.ok(alive(busy), "有用户页面的窗口不能被强关");

  await d.closeAllAccounts(); // 退出时一并收掉
  await sleep(300);
  assert.ok(!alive(busy));
});

test("closeLoginWindow：无头/未知账号不动，有头账号延时后关闭", async () => {
  assert.equal(await d.closeLoginWindow("acc_nobody"), false);
  process.env.VK_BROWSER_IDLE_MS = "60000";
  const tab = await d.openAccount({ accountId: "acc_login", headless: false });
  assert.equal(await d.closeLoginWindow("acc_login", { delayMs: 50 }), true);
  await sleep(1500);
  assert.equal(d.hasLiveBrowser("acc_login"), false);
  void tab;
  await d.closeAllAccounts();
});
