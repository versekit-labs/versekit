// #220 账号隔离：平台用户标识防串号（ACC-acct-iso-02）、退出登录命令（ACC-acct-iso-03）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-identity-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { findCommand } = await import("../src/commands.mjs");
const h = createCoreHandlers();

before(() => core.migrate());
after(() => core.close());

const mk = (groupName, name) => {
  const g = h["group.add"]({ name: groupName });
  return { g, id: h["account.add"]({ platform: "xiaohongshu", name, group: g.id }).id };
};

test("ACC-acct-iso-02：同一个小红书号接在另一个组的账号上 → 不标正常，行内给人话", () => {
  const a = mk("AssureLane", "主号");
  const b = mk("Test", "测试号");
  store.setAccountState(a.id, "ok");
  assert.deepEqual(store.recordPlatformUid(a.id, "creator-123"), { ok: true, uid: "creator-123" });
  assert.equal(store.getPlatformUid(a.id), "creator-123");

  store.setAccountState(b.id, "ok");
  const r = store.recordPlatformUid(b.id, "creator-123");
  assert.equal(r.ok, false);
  assert.equal(
    r.message,
    "这个小红书号已经接在「AssureLane」的 主号 上；要接另一个号，先点「退出登录」，再扫码或短信登录另一个号",
  );
  assert.notEqual(store.getAccount(b.id).state, "ok", "冲突的账号不能是正常");
  const row = h["account.list"]({ group: b.g.id }).accounts.find((x) => x.id === b.id);
  assert.equal(row.identityConflict, r.message);
  assert.equal(h["account.list"]({ group: a.g.id }).accounts[0].identityConflict, undefined, "A 不受影响");
  assert.equal(store.getAccount(a.id).state, "ok");
});

test("ACC-acct-iso-02：退出登录后换一个不同的号能登上，冲突与旧标识都清掉", () => {
  const a = mk("甲组", "甲");
  const b = mk("乙组", "乙");
  store.recordPlatformUid(a.id, "uid-A");
  assert.equal(store.recordPlatformUid(b.id, "uid-A").ok, false);
  store.markAccountLoggedOut(b.id);
  assert.equal(store.getIdentityConflict(b.id), null);
  assert.equal(store.getAccount(b.id).state, "expired", "退出后是没连上，不是正常");
  assert.equal(store.recordPlatformUid(b.id, "uid-B").ok, true);
  assert.equal(store.getPlatformUid(b.id), "uid-B");
  // 同一个账号重复登录同一个号不算冲突
  assert.equal(store.recordPlatformUid(b.id, "uid-B").ok, true);
});

test("ACC-acct-iso-02：已移除的账号不再占着标识", () => {
  const a = mk("丙组", "丙");
  const b = mk("丁组", "丁");
  store.recordPlatformUid(a.id, "uid-gone");
  h["account.remove"]({ accountId: a.id });
  assert.equal(store.recordPlatformUid(b.id, "uid-gone").ok, true);
});

test("ACC-acct-iso-03：account.logout 在命令表里只定义一次，CLI 用法是 vk account logout", () => {
  const c = findCommand("account.logout");
  assert.ok(c);
  assert.equal(c.cli.usage, "vk account logout <accountId>");
  assert.equal(c.http.path, "/api/accounts/:accountId/logout");
  assert.equal(c.card, null, "退出登录会删资料，不给卡片按钮");
});

test("ACC-acct-iso-05：account.switch 在命令表里只定义一次，CLI 用法是 vk account switch，不给卡片按钮", () => {
  const c = findCommand("account.switch");
  assert.ok(c);
  assert.equal(c.cli.usage, "vk account switch <accountId>");
  assert.equal(c.http.path, "/api/accounts/:accountId/switch");
  assert.equal(c.card, null);
  assert.equal(c.audit, "always");
});
