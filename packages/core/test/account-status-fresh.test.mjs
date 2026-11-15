// issue #102 / ACC-account-09：状态不冒充。
//   - 账号带「上次检查时间」，超过 24 小时未检查的 ok 显示「待确认」
//   - 发布创建时对目标账号做一次真实检查，掉线直接拦下，不落到执行阶段
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-acct-fresh-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers, withCheckStatus, CHECK_STALE_AFTER_MS } = await import("../src/handlers.mjs");
const { AdapterError } = await import("../src/errors.mjs");

const asset = join(HOME, "a.mp4");
writeFileSync(asset, "x");
const db = () => core.open();
const count = (sql) => db().prepare(sql).get().n;

before(() => core.migrate());
after(() => core.close());

test("ok 且最近检查过 → 仍是正常；超过 24 小时或从未检查 → 待确认", () => {
  const now = 10 * CHECK_STALE_AFTER_MS;
  const fresh = withCheckStatus({ id: "a", state: "ok", last_checked_at: now - 1000 }, now);
  assert.equal(fresh.displayState, "ok");
  assert.equal(fresh.lastCheckedAt, now - 1000);
  const old = withCheckStatus({ id: "a", state: "ok", last_checked_at: now - CHECK_STALE_AFTER_MS - 1 }, now);
  assert.equal(old.displayState, "unconfirmed");
  assert.equal(old.displayStateLabel, "待确认");
  assert.equal(withCheckStatus({ id: "a", state: "ok", last_checked_at: null }, now).displayState, "unconfirmed");
  // 明确的坏状态不被「待确认」盖住
  assert.equal(withCheckStatus({ id: "a", state: "expired", last_checked_at: null }, now).displayState, "expired");
});

test("account.list 返回上次检查时间与展示状态", () => {
  const h = createCoreHandlers({ adapters: [] });
  const g = h["group.add"]({ name: "FRESH 列表" });
  const id = h["account.add"]({ platform: "xiaohongshu", name: "@fresh-list", group: g.name }).id;
  const row = h["account.list"]({ group: g.name }).accounts.find((a) => a.id === id);
  assert.equal(row.lastCheckedAt, null);
  assert.equal(row.displayState, "unconfirmed");
});

function adapterWith(check) {
  return { platform: "xiaohongshu", adapter: { platform: "xiaohongshu", check } };
}

test("发布创建时真实检查：掉线直接拦下，不写 work / publish", async () => {
  const h = createCoreHandlers({ adapters: [adapterWith(async () => ({ state: "expired" }))] });
  const g = h["group.add"]({ name: "FRESH 掉线" });
  h["account.add"]({ platform: "xiaohongshu", name: "@fresh-dead", group: g.name });
  const before = count("SELECT COUNT(*) n FROM publish");
  await assert.rejects(async () => h["publish.create"]({ asset, to: ["xiaohongshu"], group: g.name }), /掉线.*重新登录|重新登录/);
  assert.equal(count("SELECT COUNT(*) n FROM publish"), before, "拦在创建阶段，没有落队列");
});

test("发布创建时检查通过 → 正常创建，并刷新 last_checked_at", async () => {
  const h = createCoreHandlers({ adapters: [adapterWith(async () => ({ state: "ok" }))] });
  const g = h["group.add"]({ name: "FRESH 正常" });
  const id = h["account.add"]({ platform: "xiaohongshu", name: "@fresh-ok", group: g.name }).id;
  const created = await h["publish.create"]({ asset, to: ["xiaohongshu"], group: g.name });
  assert.equal(created.publishes.length, 1);
  assert.ok(store.getAccount(id).last_checked_at > 0);
});

test("检查本身出错（非登录问题）不当成掉线：放行并标注未确认", async () => {
  const h = createCoreHandlers({
    adapters: [adapterWith(async () => { throw new AdapterError("network", "连不上创作平台"); })],
  });
  const g = h["group.add"]({ name: "FRESH 网络" });
  h["account.add"]({ platform: "xiaohongshu", name: "@fresh-net", group: g.name });
  const created = await h["publish.create"]({ asset, to: ["xiaohongshu"], group: g.name });
  assert.equal(created.publishes.length, 1);
  assert.equal(created.unconfirmed.length, 1);
});

test("检查返回 auth 错误 → 账号被标为 expired 并拦下", async () => {
  const h = createCoreHandlers({
    adapters: [adapterWith(async () => { throw new AdapterError("auth", "登录已过期"); })],
  });
  const g = h["group.add"]({ name: "FRESH auth" });
  const id = h["account.add"]({ platform: "xiaohongshu", name: "@fresh-auth", group: g.name }).id;
  await assert.rejects(async () => h["publish.create"]({ asset, to: ["xiaohongshu"], group: g.name }), /重新登录/);
  assert.equal(store.getAccount(id).state, "expired");
});
