// ACC-test-cleanup-01 (b)：`vk serve` 收到 SIGTERM / SIGINT 时，先把自己管着的账号 Chrome 关掉再退出。
// Chrome 是 detached 起的，守护进程一退就成孤儿——这条测试用假 Chrome 钉住「退出即关」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const VK = fileURLToPath(new URL("../src/vk.mjs", import.meta.url));
const FAKE_CHROME = fileURLToPath(new URL("../../driver-browser/test/fixtures/fake-chrome.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(pred, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  assert.fail(`等不到：${what}`);
}

async function scenario(signal) {
  const home = mkdtempSync(join(tmpdir(), "vk-shut-"));
  const port = await freePort();
  const env = {
    ...process.env,
    HIFABU_HOME: home,
    HIFABU_CHROME_BIN: FAKE_CHROME,
    HIFABU_CDP_PORT: String(40000 + Math.floor(Math.random() * 15000)),
    HIFABU_NO_BROWSER: "",
  };
  delete env.HIFABU_CHROME_PROFILE;
  const init = spawn(process.execPath, [VK, "init"], { env, stdio: "ignore" });
  await new Promise((r) => init.on("close", r));
  const serve = spawn(process.execPath, [VK, "serve", "--offline", "--port", String(port)], { env, stdio: "ignore" });
  const exited = new Promise((r) => serve.on("exit", (code, sig) => r({ code, sig })));
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, body: JSON.stringify(body ?? {}) });
    return res.json().catch(() => ({}));
  };
  try {
    await until(async () => (await fetch(`${base}/api/bootstrap`).catch(() => null))?.ok, "守护进程起来");
    await call("POST", "/api/groups", { name: "g" }).catch(() => {});
    const added = await call("POST", "/api/accounts", { platform: "tiktok", name: "n", group: "g" });
    const accountId = added.data?.id ?? added.id ?? added.data?.accountId;
    assert.ok(accountId, `应该建出账号：${JSON.stringify(added)}`);
    await call("POST", `/api/accounts/${accountId}/reauth`);
    const { execFileSync } = await import("node:child_process");
    const chromePid = await until(() => {
      const ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
      const line = ps.split("\n").find((l) => l.includes("fake-chrome.mjs") && l.includes(`--user-data-dir=${home}`));
      return line ? Number(line.trim().split(/\s+/)[0]) : 0;
    }, "账号 Chrome 起来");
    assert.ok(alive(chromePid));
    serve.kill(signal);
    const r = await Promise.race([exited, sleep(20000).then(() => assert.fail("守护进程没有在 20 秒内退出"))]);
    assert.equal(r.code, 0, `收到 ${signal} 应当正常退出：${JSON.stringify(r)}`);
    await until(() => !alive(chromePid), `账号 Chrome(${chromePid}) 随守护进程关掉`, 5000);
  } finally {
    serve.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("vk serve 收到 SIGTERM：先关账号 Chrome 再退出", () => scenario("SIGTERM"));
test("vk serve 收到 SIGINT：先关账号 Chrome 再退出", () => scenario("SIGINT"));
