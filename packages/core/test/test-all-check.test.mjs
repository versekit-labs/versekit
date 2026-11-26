// 全量测试后的残留检查本身要能抓到「躲在独占根目录之外」的残留（ACC-test-cleanup-01 口径 (c)）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runner = join(repo, "scripts", "ci", "test-all.mjs");
const pluginRunner = join(repo, "plugins", "hifabu", "test", "run-tests.mjs");
const fixture = join(repo, "scripts", "ci", "fixtures", "leave-outside-tmp.test.mjs");
// NODE_TEST_CONTEXT 是外层 node --test 塞进来的；留着的话内层的 --test 会当成「递归」直接跳过。
const { NODE_TEST_CONTEXT: _skip, ...baseEnv } = process.env;
// 扫描目录换成本测试自己的沙盒：不在真 /tmp 里留 vk* 目录，别的并发全量测试撞不见。
const sandbox = mkdtempSync(join(tmpdir(), "chk-"));
const run = (leave, entry = runner) =>
  spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    env: { ...baseEnv, HIFABU_TEST_ALL_FILES: fixture, HIFABU_TEST_ALL_SCAN: sandbox, HIFABU_LEAVE_DIR: leave },
  });

test("扫描目录下留 vk* 目录：残留检查列出来、退出码非 0、并清掉", () => {
  const leave = join(sandbox, `vk-leave-${process.pid}`);
  const r = run(leave);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /测试残留检查失败/);
  assert.ok(r.stderr.includes(`临时目录 ${leave}`) || r.stderr.includes(leave.replace(/^\/var\//, "/private/var/")), r.stderr);
  assert.ok(!existsSync(leave), "检查失败的同时把残留收掉");
});

test("没有残留：检查通过、退出码 0", () => {
  const r = run(join(sandbox, "not-a-vk-dir"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /测试残留检查：通过/);
});

test("ACC-brand-05 已发布的插件测试入口支持新文件筛选变量", () => {
  const r = run(join(sandbox, "not-a-vk-dir"), pluginRunner);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# tests 1$/m);
});

test("收尾", () => rmSync(sandbox, { recursive: true, force: true }));
