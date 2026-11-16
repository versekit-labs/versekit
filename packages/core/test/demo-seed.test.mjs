// #180 · vk demo seed：只写临时 VK_HOME，造出今天页的几种典型状态。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { seedDemoAsync } = await import("../../../scripts/demo-seed.mjs");

test("没有 VK_HOME 就拒绝，不写真实家目录", async () => {
  const saved = process.env.VK_HOME;
  delete process.env.VK_HOME;
  try {
    await assert.rejects(() => seedDemoAsync(), /VK_HOME/);
  } finally {
    if (saved) process.env.VK_HOME = saved;
  }
});

test("造出待确认（长片+短片）、已发布（好/平/差）、出问题", async () => {
  process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-demo-"));
  const res = await seedDemoAsync();
  assert.equal(res.pending_confirm, 4);
  const core = await import("../src/index.mjs");
  const rows = core.open().prepare("SELECT state, COUNT(*) n FROM publish GROUP BY state").all();
  const by = Object.fromEntries(rows.map((r) => [r.state, r.n]));
  assert.equal(by.pending_confirm, 4);
  assert.equal(by.failed, 1);
  assert.ok(by.published >= 3);
  const unchecked = core.open().prepare("SELECT COUNT(*) n FROM account WHERE last_checked_at IS NULL").get().n;
  assert.equal(unchecked, 0, "假账号不该被体检排单");
  core.close();
});

test("CLI：vk demo seed 退出码 0，并在 VK_HOME 里造出数据", async () => {
  const { spawnSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "vk-demo-cli-"));
  const r = spawnSync(process.execPath, [new URL("../../cli/src/vk.mjs", import.meta.url).pathname, "demo", "seed"], {
    env: { ...process.env, VK_HOME: home },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).pending_confirm, 4);
});
