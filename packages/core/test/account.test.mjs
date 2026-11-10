// 账号生命周期（issue #21）：account.add 必填组、account.remove（换号前移除）、
// 同组同平台唯一（ACC-add-01 / ACC-account-01）。
//
// 口径不是「接口能跑」，而是：
//   · 账号永远属于一个组；添加页能拿到「谁占了这个平台槽位」；
//   · account.list --group 只返回该组在用的账号；
//   · 移除不删历史行，只让槽位空出来，之后同平台可以换号；
//   · 旧库（#11 的表结构）升级后同样成立。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "vk-account-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { findCommand, parseArgs } = await import("../src/commands.mjs");
const { startDaemon } = await import("../src/daemon.mjs");

const h = createCoreHandlers();
let daemon = null;

before(() => core.migrate());
after(async () => {
  await daemon?.close();
  core.close();
});

test("account.add 必填 group：命令表、handler、store 三层都不允许无组账号", () => {
  assert.throws(() => parseArgs(findCommand("account.add"), { platform: "tiktok", name: "无组" }), /缺少参数：group/);
  assert.throws(() => h["account.add"]({ platform: "tiktok", name: "无组" }), /必须带 --group/);
  assert.throws(() => store.addAccount({ platform: "tiktok", handle: "@无组" }), /必须带 --group/);

  const g = h["group.add"]({ name: "必填组" });
  const added = h["account.add"]({ platform: "tiktok", name: "一号", group: g.id });
  assert.equal(added.group.id, g.id);
  assert.match(added.next, /vk account reauth/);
});

test("ACC-add-01：组已锁定；已接入平台返回占用者，不能重复占槽位", () => {
  const g = h["group.add"]({ name: "添加账号组" }).id;
  const first = h["account.add"]({ platform: "bilibili", name: "一号", group: g });

  const list = h["account.list"]({ group: g });
  assert.deepEqual(list.group, { id: g, name: "添加账号组" }, "组由命令参数锁定，读回来的还是同一个组");
  assert.deepEqual(list.occupants.bilibili, { accountId: first.id, handle: "一号", name: "一号" }, "核心返回占用者信息，页面据此灰掉平台");

  assert.throws(
    () => h["account.add"]({ platform: "bilibili", name: "二号", group: g }),
    (err) => /每个平台只能有一个/.test(err.message) && err.message.includes("一号") && err.message.includes(first.id) && /vk account remove/.test(err.message),
    "冲突错误要说清被谁占用，并给出换号路径",
  );

  // 不同组各自有 bilibili 槽位，互不影响（ACC-account-01 的反向断言）。
  const other = h["group.add"]({ name: "另一组" }).id;
  h["account.add"]({ platform: "bilibili", name: "三号", group: other });
  assert.deepEqual(h["account.list"]({ group: g }).accounts.map((a) => a.handle), ["一号"]);
  assert.deepEqual(h["account.list"]({ group: other }).accounts.map((a) => a.handle), ["三号"]);
  assert.equal(h["account.list"]({ group: other }).occupants.bilibili.handle, "三号");
});

test("ACC-account-01：account.list --group 只返回当前组在用账号；不带组时不混入其它组", () => {
  const h2 = createCoreHandlers();
  const a = h2["group.add"]({ name: "只看 A 组" }).id;
  const b = h2["group.add"]({ name: "只看 B 组" }).id;
  const inA = h2["account.add"]({ platform: "tiktok", name: "@A", group: a });
  const inB = h2["account.add"]({ platform: "tiktok", name: "@B", group: b });

  // 先切到 A 组，读 A 组；B 组的同平台账号不能出现。
  h2["group.use"]({ group: a });
  const aOnly = h2["account.list"]({ group: a });
  assert.deepEqual(aOnly.accounts.map((x) => x.id), [inA.id]);
  assert.equal(aOnly.accounts.some((x) => x.platform === "tiktok" && x.handle === "@B"), false);
  assert.deepEqual(Object.keys(aOnly.occupants), ["tiktok"]);

  const bOnly = h2["account.list"]({ group: b });
  assert.deepEqual(bOnly.accounts.map((x) => x.id), [inB.id]);

  const all = h2["account.list"]().accounts;
  assert.ok(all.some((x) => x.id === inA.id) && all.some((x) => x.id === inB.id));
});

test("同组同平台唯一约束有数据库层兜底；移除后槽位空出可换号，历史发布仍在", () => {
  const g = h["group.add"]({ name: "换号组" }).id;
  const old = h["account.add"]({ platform: "xiaohongshu", name: "@旧号", group: g });
  assert.throws(
    () =>
      core
        .open()
        .prepare("INSERT INTO account (id, platform, handle, created_at, group_id) VALUES ('raw1','xiaohongshu','@raw1',1,?)")
        .run(g),
    /UNIQUE/,
    "绕过 store 直接写也会被 (group_id, platform) 唯一索引拦下",
  );

  // 先留下一条已发布历史：移除账号不能把这条数据删掉。
  const work = store.createWork({ title: "换号前的作品", assetPath: "/tmp/a.mp4" });
  const { id: publishId } = store.createPublish({ workId: work.id, accountId: old.id });
  core.transitionPublish(publishId, "auto_running");
  core.transitionPublish(publishId, "published");

  const removed = h["account.remove"]({ accountId: old.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.historyKept, 1);
  assert.deepEqual(removed.group, { id: g, name: "换号组" });

  assert.deepEqual(h["account.list"]({ group: g }).accounts, [], "移除后这个组读不到旧账号");
  assert.deepEqual(h["account.list"]({ group: g }).occupants, {});
  assert.equal(h["account.list"]().accounts.some((a) => a.id === old.id), false, "全局在用账号里也不应出现");
  assert.equal(store.getAccount(old.id), null, "getAccount 只返回在用账号");

  const row = core.open().prepare("SELECT removed_at FROM account WHERE id = ?").get(old.id);
  assert.ok(row.removed_at > 0, "行保留，removed_at 有值");
  assert.equal(store.getPublish(publishId).state, "published", "历史发布仍能通过 account_id 追到");
  assert.equal(store.getPublish(publishId).handle, "@旧号");

  // 同平台换号：唯一索引只约束在用账号，新号可以进同一个槽位。
  const next = h["account.add"]({ platform: "xiaohongshu", name: "@新号", group: g });
  assert.notEqual(next.id, old.id);
  assert.equal(next.existed, false);
  assert.deepEqual(h["account.list"]({ group: g }).accounts.map((a) => a.handle), ["@新号"]);

  assert.throws(
    () =>
      core
        .open()
        .prepare("INSERT INTO account (id, platform, handle, created_at, group_id) VALUES ('raw2','xiaohongshu','@raw2',1,?)")
        .run(g),
    /UNIQUE/,
    "换号后同组同平台仍然是唯一",
  );

  assert.throws(() => h["account.remove"]({ accountId: old.id }), /已经移除/);
  assert.throws(() => h["account.remove"]({ accountId: "acc_nope" }), /没有这个账号/);
});

test("同一个 handle 移除后重新接入：复活原行，保留历史，不撞 UNIQUE(platform, handle)", () => {
  const g = h["group.add"]({ name: "复活组" }).id;
  const first = h["account.add"]({ platform: "youtube", name: "@revive", group: g });
  h["account.remove"]({ accountId: first.id });

  const again = h["account.add"]({ platform: "youtube", name: "@revive", group: g });
  assert.equal(again.id, first.id, "同一个 handle 不新造一行，旧历史不割裂");
  assert.equal(again.revived, true);
  assert.equal(store.getAccount(first.id).group_id, g);
  assert.ok(store.getAccount(first.id));
});

test("账号还有排队/在跑的发布时拒绝移除，避免移除后仍在后台发出去", () => {
  const g = h["group.add"]({ name: "排队组" }).id;
  const account = h["account.add"]({ platform: "tiktok", name: "@排队", group: g });
  const work = store.createWork({ title: "还没发的作品", assetPath: "/tmp/a.mp4" });
  const { id: publishId } = store.createPublish({ workId: work.id, accountId: account.id });

  assert.throws(() => h["account.remove"]({ accountId: account.id }), /在队列里或正在跑/);

  core.transitionPublish(publishId, "canceled", { reason: "test_cleanup" });
  const removed = h["account.remove"]({ accountId: account.id });
  assert.equal(removed.removed, true);
});

test("HTTP 派生：POST 缺 group 是 400；DELETE /api/accounts/:id 移除；GET 返回占用者", async () => {
  daemon = await startDaemon({ runQueue: false, port: 0, socketPath: join(HOME, "vk-account.sock"), handlers: h });
  const base = `http://127.0.0.1:${daemon.port}`;
  const json = async (res) => ({ status: res.status, body: await res.json() });
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const group = (await json(await post("/api/groups", { name: "HTTP 账号组" }))).body;
  const missingGroup = await json(await post("/api/accounts", { platform: "tiktok", name: "无组" }));
  assert.equal(missingGroup.status, 400);
  assert.match(missingGroup.body.error.message, /group/);

  const added = await json(await post("/api/accounts", { platform: "tiktok", name: "@HTTP", group: group.id }));
  assert.equal(added.status, 200);
  assert.equal(added.body.id.startsWith("acc_"), true);

  const listed = await (await fetch(`${base}/api/accounts?group=${encodeURIComponent(group.id)}`)).json();
  assert.deepEqual(listed.accounts.map((a) => a.handle), ["@HTTP"]);
  assert.equal(listed.occupants.tiktok.handle, "@HTTP", "ACC-add-01：HTTP 也返回占用者");

  const removed = await json(await fetch(`${base}/api/accounts/${encodeURIComponent(added.body.id)}`, { method: "DELETE" }));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, true);

  const empty = await (await fetch(`${base}/api/accounts?group=${encodeURIComponent(group.id)}`)).json();
  assert.deepEqual(empty.accounts, []);
  assert.deepEqual(empty.occupants, {});
});

test("迁移 #11 旧库：补 removed_at，并把唯一索引换成只约束在用账号", () => {
  const oldHome = mkdtempSync(join(tmpdir(), "vk-account-migrate-"));
  process.env.VK_HOME = oldHome;
  core.close();

  const { db } = core.ensureDirs();
  const legacy = new DatabaseSync(db);
  legacy.exec(`
    CREATE TABLE account_group (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE account (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, handle TEXT NOT NULL, display_name TEXT,
      credential_ref TEXT, state TEXT NOT NULL DEFAULT 'ok', is_manual INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER, last_ok_at INTEGER, last_checked_at INTEGER, created_at INTEGER NOT NULL,
      group_id TEXT REFERENCES account_group(id), UNIQUE (platform, handle));
    CREATE UNIQUE INDEX idx_account_group_platform ON account(group_id, platform) WHERE group_id IS NOT NULL;
    INSERT INTO account (id, platform, handle, created_at) VALUES ('old1','tiktok','@old',1);
  `);
  legacy.close();

  core.migrate();
  core.migrate(); // 幂等

  const conn = core.open();
  const cols = conn.prepare("PRAGMA table_info(account)").all().map((c) => c.name);
  assert.ok(cols.includes("removed_at"), "旧库要补 removed_at 列");
  const index = conn.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_account_group_platform'").get();
  assert.match(index.sql, /removed_at/, "旧索引谓词必须被替换，否则移除后换号会被旧索引拦下");
  assert.equal(store.listAccounts().length, 1, "旧账号一个都不能少");

  core.close();
  process.env.VK_HOME = HOME;
});
