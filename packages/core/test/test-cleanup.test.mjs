// ACC-test-cleanup-01 (a)(c)：收尾工具只关「--user-data-dir 在登记的临时目录下」的进程，不碰别的；并会删目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { cleanupNow, chromeUnder, trackDir } from "../../../scripts/ci/test-cleanup.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 起一个带 --user-data-dir 的假「Chrome」，detached + unref，和 driver-browser 起真 Chrome 的方式一样。 */
const fakeChrome = (dir) => {
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", `--user-data-dir=${dir}`], { detached: true, stdio: "ignore" });
  c.unref();
  return c.pid;
};

test("mkdtemp 建的目录被自动登记；收尾时只关它下面的 Chrome、删目录", async () => {
  const mine = mkdtempSync(join(tmpdir(), "vk-cleanup-mine-"));
  const other = mkdtempSync(join(tmpdir(), "vk-cleanup-other-"));
  writeFileSync(join(mine, "x"), "1");
  // other 下的进程用来对照：chromeUnder([mine]) 不该看到它。
  const pidMine = fakeChrome(join(mine, "state", "browser", "acc_1"));
  const pidOther = fakeChrome(join(other, "profile"));
  try {
    await sleep(300);
    const found = chromeUnder([mine]).map((p) => p.pid);
    assert.deepEqual(found, [pidMine], "只认落在登记目录下的进程");
    assert.equal(chromeUnder([mine + "-x"]).length, 0, "前缀相同的兄弟目录不算");
    cleanupNow();
    assert.equal(existsSync(mine), false, "目录被删");
    for (let i = 0; i < 40 && alive(pidMine); i++) await sleep(50);
    assert.equal(alive(pidMine), false, "登记目录下的 Chrome 被关掉");
  } finally {
    for (const p of [pidMine, pidOther]) try { process.kill(p, "SIGKILL"); } catch {}
  }
});

test("trackDir 登记手工建的目录；未登记目录下的进程不会被 chromeUnder 看到", async () => {
  const stranger = mkdtempSync(join(tmpdir(), "vk-cleanup-stranger-"));
  const pid = fakeChrome(join(stranger, "p"));
  try {
    await sleep(300);
    const tracked = join(tmpdir(), "vk-cleanup-tracked");
    trackDir(tracked);
    assert.equal(chromeUnder([tracked]).length, 0);
    assert.deepEqual(chromeUnder([stranger]).map((p) => p.pid), [pid]);
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
});
