// #220 账号浏览器隔离：B 的标记指向 A 的 Chrome 正在用的端口时，B 必须起自己的 Chrome，A 不受影响。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const HOME = mkdtempSync(join(tmpdir(), "vk-iso-"));
process.env.VK_HOME = HOME;
process.env.VK_CHROME_BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-chrome.mjs");
// accountPort() 在 [基准, 65000) 里按账号哈希取端口；基准随机落在 20000–40000，减少与并行文件的重叠。
process.env.VK_CDP_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.VK_BROWSER_POOL = "4";
process.env.VK_BROWSER_IDLE_MS = "60000";
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
/** 向内核要一个此刻空闲的端口，避免和并行跑的其他测试文件撞端口。 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
/** 等到 port 上的 Chrome 真的在监听、且 lsof/ps 能读出它的 profile——取代固定 sleep，全量并行时 node 启动可能很慢。 */
async function waitReady(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (d.chromeUserDataDirOnPort(port)) return;
    await sleep(50);
  }
  throw new Error(`端口 ${port} 上的假 Chrome 在 ${timeoutMs}ms 内没起来`);
}
const markerOf = (id) => JSON.parse(readFileSync(join(d.accountProfile(id), ".vk-driver.json"), "utf8"));

/** 手动起一个「别人的」Chrome：用 id 的 profile 监听 port，但不写标记（或由调用方写）。 */
function startChromeFor(id, port) {
  const profile = d.accountProfile(id);
  mkdirSync(profile, { recursive: true });
  const child = spawn(process.env.VK_CHROME_BIN, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

test("chromeUserDataDirOnPort 能读出监听端口上 Chrome 的 --user-data-dir", async () => {
  const port = await freePort();
  const pid = startChromeFor("acc_probe", port);
  await waitReady(port);
  assert.equal(d.chromeUserDataDirOnPort(port), d.accountProfile("acc_probe"));
  assert.equal(d.chromeUserDataDirOnPort(await freePort()), null, "没人监听的端口查不出");
  process.kill(pid);
});

test("ACC-acct-iso-01：B 的标记指向 A 的 Chrome 的端口 → B 起自己的 Chrome，A 不受影响，B 过期标记被清", async () => {
  const portA = d.accountPort("acc_b_iso"); // 让 A 的 Chrome 占着 B 的首选端口：最坏情形
  const pidA = startChromeFor("acc_a_iso", portA);
  writeFileSync(join(d.accountProfile("acc_a_iso"), ".vk-driver.json"), JSON.stringify({ accountId: "acc_a_iso", port: portA, pid: pidA, headless: false }));
  // B 的标记过期，却写着 A 占着的端口
  mkdirSync(d.accountProfile("acc_b_iso"), { recursive: true });
  writeFileSync(join(d.accountProfile("acc_b_iso"), ".vk-driver.json"), JSON.stringify({ accountId: "acc_b_iso", port: portA, pid: 999999, headless: false }));
  await waitReady(portA);

  const tab = await d.openAccount({ accountId: "acc_b_iso" });
  const m = markerOf("acc_b_iso");
  assert.notEqual(m.port, portA, "B 不能连到 A 的端口");
  assert.notEqual(m.pid, pidA);
  assert.equal(tab.port, m.port);
  assert.equal(d.chromeUserDataDirOnPort(m.port), d.accountProfile("acc_b_iso"), "B 的端口上跑的是 B 自己的 profile");
  assert.ok(alive(pidA), "A 的 Chrome 不受影响");
  assert.equal(d.chromeUserDataDirOnPort(portA), d.accountProfile("acc_a_iso"));
  await tab.close();

  await d.closeAccount("acc_b_iso");
  assert.ok(alive(pidA), "关 B 不会动 A");
  process.kill(pidA);
});

test("ACC-acct-iso-01：adoptOrphanAccounts 不认领端口上是别人 Chrome 的过期标记，并清掉它", async () => {
  const port = await freePort();
  const pidA = startChromeFor("acc_a_orph", port);
  mkdirSync(d.accountProfile("acc_b_orph"), { recursive: true });
  const markerFile = join(d.accountProfile("acc_b_orph"), ".vk-driver.json");
  writeFileSync(markerFile, JSON.stringify({ accountId: "acc_b_orph", port, pid: 999999, headless: false }));
  await waitReady(port);

  const adopted = await d.adoptOrphanAccounts();
  assert.ok(!adopted.includes("acc_b_orph"), "不能把 A 的 Chrome 认领给 B");
  assert.equal(existsSync(markerFile), false, "过期标记被清掉");
  assert.ok(alive(pidA));
  process.kill(pidA);
});

test("ACC-acct-iso-01：closeAccount 对着过期标记不会去关别人的 Chrome", async () => {
  const port = await freePort();
  const pidA = startChromeFor("acc_a_close", port);
  mkdirSync(d.accountProfile("acc_b_close"), { recursive: true });
  writeFileSync(join(d.accountProfile("acc_b_close"), ".vk-driver.json"), JSON.stringify({ accountId: "acc_b_close", port, pid: pidA, headless: false }));
  await waitReady(port);
  assert.equal(await d.closeAccount("acc_b_close"), false);
  await sleep(300);
  assert.ok(alive(pidA), "标记里的 pid/端口是 A 的 Chrome，不能被 B 关掉");
  process.kill(pidA);
});

test("ACC-acct-iso-03：logoutAccount 关掉浏览器、只删这个账号自己的 profile，别的账号与凭证文件不动", async () => {
  const ta = await d.openAccount({ accountId: "acc_lo_a" });
  const tb = await d.openAccount({ accountId: "acc_lo_b" });
  const pidA = markerOf("acc_lo_a").pid;
  const pidB = markerOf("acc_lo_b").pid;
  writeFileSync(join(d.accountProfile("acc_lo_a"), "Cookies"), "a-cookie");
  writeFileSync(join(d.accountProfile("acc_lo_b"), "Cookies"), "b-cookie");
  const credDir = join(HOME, ".local", "state", "versekit", "credentials");
  mkdirSync(credDir, { recursive: true });
  writeFileSync(join(credDir, "bili.json"), "{}");
  await ta.close();
  await tb.close();

  const r = await d.logoutAccount("acc_lo_a");
  assert.equal(r.removed, true);
  await sleep(500);
  assert.equal(existsSync(d.accountProfile("acc_lo_a")), false, "A 的 profile 目录已删");
  assert.ok(!alive(pidA), "A 的 Chrome 已关");
  assert.ok(alive(pidB), "B 的 Chrome 不动");
  assert.equal(readFileSync(join(d.accountProfile("acc_lo_b"), "Cookies"), "utf8"), "b-cookie", "B 的 profile 不动");
  assert.equal(existsSync(join(credDir, "bili.json")), true, "凭证文件不动");
  assert.equal((await d.logoutAccount("acc_lo_a")).removed, false, "重复退出不报错");
  await d.closeAllAccounts();
});
