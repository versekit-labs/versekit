// 接入进度必须跟当前账号组走（issue #24 · ACC-groups-01 / ACC-groups-02）。
// 打回原因：`/api/setup` 的账号步骤直接数了全局账号，空组 C 会借用组 A 的账号显示「完成」。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-setup-group-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");

after(() => core.close());

const accountStep = (setup) => setup.steps.find((s) => s.id === "account");

test("setup.status 的账号步骤只数当前组：空组不能借用别组的账号", async () => {
  core.migrate();
  const h = createCoreHandlers();

  const a = h["group.add"]({ name: "验收组A" });
  h["account.add"]({ platform: "bilibili", name: "验收A号", group: a.id });
  // group.add 创建即进入：C 是当前组，且没有任何账号（验收里的空组场景）。
  const c = h["group.add"]({ name: "验收组C" });

  const bootstrap = h["bootstrap"]();
  assert.deepEqual(bootstrap.current, { id: c.id, name: "验收组C" });
  assert.equal(bootstrap.groups.find((g) => g.id === c.id).account_count, 0, "空组 account_count 必须是 0");

  const setup = await h["setup.status"]();
  const step = accountStep(setup);
  assert.equal(step.status, "blocked", "空组的账号步骤是待做/未完成，不能显示 ok");
  assert.equal(step.done, false);
  assert.match(step.checks.find((check) => check.id === "account.exists").detail, /还没有添加任何平台账号/);

  // 作用域是「当前组」，不是固定只看 C：切回有账号的 A，步骤恢复完成。
  h["group.use"]({ group: a.id });
  assert.equal(accountStep(await h["setup.status"]()).status, "ok");
});
