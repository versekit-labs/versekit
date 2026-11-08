// 驱动测试只覆盖纯函数与参数校验：不启动 Chrome、不联网。
// 真实浏览器行为（点击、上传、shadow DOM）由人工环境里的契约测试兜底。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

// 必须在 import 之前指好状态目录，否则 PROFILE/PORT 会落在真实 HOME 下。
const HOME = mkdtempSync(join(tmpdir(), "vk-driver-"));
process.env.VK_HOME = HOME;
delete process.env.VK_CHROME_PROFILE;
delete process.env.VK_CDP_PORT;
delete process.env.VK_BROWSER_POOL;

const driver = await import("../src/index.mjs");
const { accountProfile, accountPort, evidencePath, poolLimit } = driver;

const STATE = join(HOME, ".local", "state", "versekit");

test("账号 profile 互相隔离，且都在 state/browser/<accountId> 下", () => {
  const a = accountProfile("acc_a");
  const b = accountProfile("acc_b");
  assert.equal(a, join(STATE, "browser", "acc_a"));
  assert.equal(b, join(STATE, "browser", "acc_b"));
  assert.notEqual(a, b);
  assert.ok(a.startsWith(join(STATE, "browser") + sep));
});

test("accountId 是目录名：空值、分隔符、.. 一律拒绝", () => {
  for (const bad of ["", "   ", ".", "..", "../escape", "a/b", "a\\b", "a\0b", null, undefined, 42, {}]) {
    assert.throws(() => accountProfile(bad), TypeError, `应当拒绝 ${String(bad)}`);
  }
  assert.throws(() => accountProfile("x".repeat(129)), /太长/);
});

test("默认账号兼容单例时代的导出：PROFILE/PORT 指向 default", () => {
  assert.equal(driver.PROFILE, accountProfile("default"));
  assert.equal(driver.PORT, accountPort("default"));
  assert.equal(driver.PORT, 9333);
  assert.equal(typeof driver.openTab, "function");
  assert.equal(typeof driver.openAccount, "function");
  assert.equal(typeof driver.closeAccount, "function");
  assert.equal(typeof driver.evidencePath, "function");
});

test("端口分配是纯函数：同账号恒定、不同账号不撞、从 9333 起", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `acc_${i}`);
  const first = ids.map(accountPort);
  const again = ids.map(accountPort);

  assert.deepEqual(again, first, "同一 accountId 多次调用必须相同");
  assert.equal(new Set(first).size, ids.length, "不同 accountId 不应该拿到同一个端口");
  assert.equal(accountPort("default"), 9333);
  for (const [i, port] of first.entries()) {
    assert.ok(Number.isInteger(port), `${ids[i]} 的端口应是整数`);
    assert.ok(port >= 9333 && port <= 65535, `${ids[i]} 的端口越界：${port}`);
    assert.notEqual(port, 9333, "9333 留给 default，其他账号不能占");
  }
});

test("端口分配不需要进程内状态，重复导入结果一致（可持久化）", () => {
  // 纯函数：只要 accountId 相同，进程重启前后端口就相同，daemon 重启不会把登录态挪走。
  assert.equal(accountPort("acc_stable"), accountPort("acc_stable"));
});

test("池上限默认 4，只允许调小，坏配置回落默认值", () => {
  assert.equal(driver.MAX_POOL, 4);
  assert.equal(driver.POOL_LIMIT, 4);
  assert.equal(poolLimit(undefined), 4);
  assert.equal(poolLimit(""), 4);
  assert.equal(poolLimit("2"), 2);
  assert.equal(poolLimit(3), 3);
  // 产品上限是硬约束：配置写大了也不能真的开 8 个 Chrome。
  assert.equal(poolLimit("8"), 4);
  assert.equal(poolLimit("0"), 4);
  assert.equal(poolLimit("-1"), 4);
  assert.equal(poolLimit("abc"), 4);
  assert.equal(poolLimit("2.5"), 4);
});

test("evidencePath 形状：state/evidence/<accountId>/<tag>-<ts>.png", () => {
  const p = evidencePath("acc_a", "publish-fail");
  assert.ok(isAbsolute(p));
  assert.equal(join(p, ".."), join(STATE, "evidence", "acc_a"));
  assert.match(p, /publish-fail-\d+\.png$/);
  // 目录 0700：截图里可能有登录态，别的用户可以读就是事故。
  assert.equal(statSync(join(STATE, "evidence", "acc_a")).mode & 0o777, 0o700);
});

test("evidencePath 同一毫秒连续调用也不覆盖", () => {
  const a = evidencePath("acc_a", "same-tag");
  const b = evidencePath("acc_a", "same-tag");
  assert.notEqual(a, b);
});

test("evidencePath 清洗 tag，不允许跑出账号目录", () => {
  const p = evidencePath("acc_a", "../../evil/../shot");
  assert.equal(join(p, ".."), join(STATE, "evidence", "acc_a"));
  assert.ok(!p.includes("/evil/"), `tag 被拼进了路径：${p}`);
  assert.match(p, /\.png$/);

  const empty = evidencePath("acc_a", "");
  assert.match(empty, /evidence-\d+\.png$/);
  assert.equal(join(empty, ".."), join(STATE, "evidence", "acc_a"));
});

test("evidencePath 也拒绝会穿越的 accountId", () => {
  assert.throws(() => evidencePath("../acc", "x"), TypeError);
  assert.throws(() => evidencePath("", "x"), TypeError);
});

test("openAccount 的参数校验在碰 Chrome 之前就失败", async () => {
  await assert.rejects(() => driver.openAccount(), /accountId/);
  await assert.rejects(() => driver.openAccount(null), /openAccount/);
  await assert.rejects(() => driver.openAccount({ accountId: "" }), /accountId/);
  await assert.rejects(() => driver.openAccount({ accountId: "../x" }), /accountId/);
  await assert.rejects(() => driver.openAccount({ accountId: "acc_a", url: "not a url" }), /url/);
  await assert.rejects(() => driver.openAccount({ accountId: "acc_a", url: "file:///etc/passwd" }), /http/);
  await assert.rejects(() => driver.openAccount({ accountId: "acc_a", url: "" }), /url/);
});

test("closeAccount 同样校验 accountId", async () => {
  await assert.rejects(() => driver.closeAccount(""), /accountId/);
  await assert.rejects(() => driver.closeAccount("../x"), /accountId/);
});

test("没有 Chrome 时 browserReady 给出人能照做的原因", () => {
  const message = driver.browserReady();
  assert.ok(message === null || typeof message === "string");
});
