// 视频号在命令行：`vk account show` 的登录时长、`vk account checktime` 设每天检查的钟点（ACC-shipinhao-04/05）。
// 真实 vk 子进程 + 真实守护进程；视频号的登录记录用假时钟写进事件，不碰任何平台。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "vks-"));
process.env.VK_HOME = HOME;
process.env.VK_NO_BROWSER = "1";

const VK = fileURLToPath(new URL("../src/vk.mjs", import.meta.url));
const core = await import("../../core/src/index.mjs");
const store = await import("../../core/src/store.mjs");
const { checkAccount } = await import("../../core/src/adapters.mjs");
const { createCoreHandlers } = await import("../../core/src/handlers.mjs");
const { startDaemon } = await import("../../core/src/daemon.mjs");

let daemon;
before(async () => {
  core.migrate();
  daemon = await startDaemon({ handlers: createCoreHandlers({ adapters: [], log: () => {} }), runQueue: false, port: 0 });
});
after(async () => {
  await daemon.close();
  rmSync(HOME, { recursive: true, force: true });
});

function vk(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VK, ...args], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("vk account show：视频号带登录时长，数字和系统页是同一份", async () => {
  const group = store.addGroup({ name: "视频号组" });
  const id = store.addAccount({ platform: "shipinhao", handle: "@sph", groupId: group.id }).id;
  const stub = [{ platform: "shipinhao", adapter: { check: async () => ({ state: "ok" }) } }];
  await checkAccount(stub, id, { now: () => Date.now() - 9 * 3600e3 });

  const r = await vk(["account", "show", id]);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.account.id, id);
  assert.equal(data.loginClock.label, "这次登录已 9 小时 · 还在记录");

  const human = await vk(["account", "show", id, "--human"]);
  assert.match(human.stdout, /登录时长：这次登录已 9 小时 · 还在记录/);

  const listed = JSON.parse((await vk(["account", "list", "--group", "视频号组"])).stdout).accounts.find((a) => a.id === id);
  assert.equal(listed.loginClock.label, data.loginClock.label);

  const missing = await vk(["account", "show", "acc_nope"]);
  assert.notEqual(missing.code, 0);
});

test("vk account checktime：看和改视频号每天检查登录的钟点", async () => {
  const show = JSON.parse((await vk(["account", "checktime"])).stdout);
  assert.equal(show.time, "08:00");
  const set = await vk(["account", "checktime", "07:45"]);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).time, "07:45");
  assert.equal(JSON.parse((await vk(["account", "checktime"])).stdout).time, "07:45");
  const bad = await vk(["account", "checktime", "99:99"]);
  assert.notEqual(bad.code, 0);
});
