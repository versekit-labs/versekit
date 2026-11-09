// 账号组（issue #11 · docs/design/HANDOFF.md §3）：产品第一层导航。
// 钉住四件事：旧库迁移幂等且不丢数据；同组同平台唯一；未分组账号行为不变；
// group.* 三条命令在 handler 与 HTTP 两端都能用（HTTP 由命令表派生，不是第二套实现）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LEGACY_HOME = mkdtempSync(join(tmpdir(), "vk-group-legacy-"));
const HOME = mkdtempSync(join(tmpdir(), "vk-group-"));
process.env.VK_HOME = LEGACY_HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { startDaemon } = await import("../src/daemon.mjs");

let daemon = null;
after(async () => {
  await daemon?.close();
  core.close();
});

test("ACC-groups 迁移：引入账号组之前的旧库升级两次，不报错、不丢账号、group_id 为 null", () => {
  // 手工造一个「今天之前」的 account 表：没有 group_id，也没有 account_group。
  const { db } = core.ensureDirs();
  const legacy = new DatabaseSync(db);
  legacy.exec(`CREATE TABLE account (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, handle TEXT NOT NULL, display_name TEXT,
    credential_ref TEXT, state TEXT NOT NULL DEFAULT 'ok', is_manual INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER, last_ok_at INTEGER, created_at INTEGER NOT NULL, UNIQUE (platform, handle))`);
  legacy.prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('old1','tiktok','@old',1)").run();
  legacy.prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('old2','tiktok','@old2',2)").run();
  legacy.close();

  core.migrate();
  core.migrate(); // 幂等

  const conn = core.open();
  const cols = conn.prepare("PRAGMA table_info(account)").all().map((c) => c.name);
  assert.ok(cols.includes("group_id"), "account 应补上 group_id 列");
  assert.ok(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_group'").get());
  assert.ok(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_account_group_platform'").get());

  const rows = store.listAccounts();
  assert.deepEqual(rows.map((r) => r.id).sort(), ["old1", "old2"], "旧账号一个都不能少");
  assert.ok(rows.every((r) => r.group_id === null));
  // 未分组的两个同平台账号共存：唯一索引只约束有组的行。
  assert.equal(rows.filter((r) => r.platform === "tiktok").length, 2);

  core.close();
  process.env.VK_HOME = HOME;
  core.migrate();
});

test("group.add / group.list：新建组后进入空组不报错（ACC-groups-02）", () => {
  const h = createCoreHandlers();
  const empty = h["group.list"]();
  assert.deepEqual(empty, { groups: [], current: null }, "首次进入没有当前组（ACC-groups-01 落点）");

  const a = h["group.add"]({ name: "主矩阵" });
  assert.equal(a.existed, false);
  assert.match(a.id, /^grp_/);
  assert.deepEqual(a.current, { id: a.id, name: "主矩阵" }, "新建组即进入：不需要再发一次 group.use（ACC-groups-02）");
  assert.deepEqual(h["group.list"]().current, { id: a.id, name: "主矩阵" }, "新建后当前组已经切过去，页面直接进空组");
  const again = h["group.add"]({ name: "主矩阵" });
  assert.equal(again.existed, true, "同名重复新建返回已有的组，而不是抛约束错误");
  assert.equal(again.id, a.id);
  assert.deepEqual(again.current, { id: a.id, name: "主矩阵" }, "重复新建也停在这个组");

  const list = h["group.list"]();
  assert.equal(list.groups.length, 1);
  assert.equal(list.groups[0].account_count, 0);
  assert.deepEqual(list.current, { id: a.id, name: "主矩阵" });

  const accounts = h["account.list"]({ group: a.id });
  assert.deepEqual(accounts.accounts, [], "空组返回空列表，不是错误");
});

test("group.use 可以用名字，切换后当前组跟着变；不存在的组给人话", () => {
  const h = createCoreHandlers();
  const b = h["group.add"]({ name: "副号组" });
  assert.deepEqual(h["group.use"]({ group: "副号组" }).current, { id: b.id, name: "副号组" });
  assert.equal(h["group.list"]().current.id, b.id);
  assert.throws(() => h["group.use"]({ group: "不存在" }), /没有这个账号组/);
  assert.throws(() => h["group.add"]({ name: "   " }), /组名 不能为空/);
});

test("同组同平台只能有一个账号；不同组互不影响；未分组照旧", () => {
  const h = createCoreHandlers();
  const g1 = h["group.add"]({ name: "唯一性一" }).id;
  const g2 = h["group.add"]({ name: "唯一性二" }).id;

  h["account.add"]({ platform: "bilibili", name: "一号", group: g1 });
  assert.throws(() => h["account.add"]({ platform: "bilibili", name: "二号", group: g1 }), /每个平台只能有一个/);
  h["account.add"]({ platform: "bilibili", name: "三号", group: g2 });
  h["account.add"]({ platform: "bilibili", name: "散号" });
  h["account.add"]({ platform: "bilibili", name: "散号二" });

  // 数据库层同样兜底：绕过 store 直接写也会被唯一索引拦下。
  assert.throws(
    () =>
      core
        .open()
        .prepare("INSERT INTO account (id, platform, handle, created_at, group_id) VALUES ('raw','bilibili','@raw',1,?)")
        .run(g1),
    /UNIQUE/,
  );

  const inG1 = h["account.list"]({ group: "唯一性一" });
  assert.equal(inG1.group.id, g1);
  assert.deepEqual(inG1.accounts.map((a) => a.handle), ["一号"], "只看当前组（ACC-account-01）");
  assert.equal(h["account.list"]({ group: g2 }).accounts.length, 1);
  assert.ok(h["account.list"]().accounts.length >= 4, "不带 --group 时返回全部账号，与今天一致");
  assert.equal(h["group.list"]().groups.find((g) => g.id === g1).account_count, 1);
  assert.throws(() => h["account.add"]({ platform: "tiktok", name: "x", group: "没有的组" }), /没有这个账号组/);
});

test("三条命令走 HTTP（由命令表派生的路由）", async () => {
  daemon = await startDaemon({ runQueue: false, port: 0, socketPath: join(HOME, "vk.sock"), handlers: createCoreHandlers() });
  const base = `http://127.0.0.1:${daemon.port}`;
  const post = (path, body) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const created = await post("/api/groups", { name: "HTTP 组" });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  const { id } = createdBody;
  assert.equal(createdBody.current.id, id, "一次 POST /api/groups 就进入新组，页面不必再补一次切组");

  const listed = await (await fetch(`${base}/api/groups`)).json();
  assert.equal(listed.current.id, id);
  assert.ok(listed.groups.some((g) => g.name === "HTTP 组"));

  const accounts = await (await fetch(`${base}/api/accounts?group=${encodeURIComponent(id)}`)).json();
  assert.deepEqual(accounts.accounts, [], "空组读取返回 []，不报错（ACC-groups-02）");

  const used = await post("/api/groups/current", { group: id });
  assert.equal(used.status, 200);
  assert.equal((await used.json()).current.id, id);

  const missing = await post("/api/groups/current", {});
  assert.equal(missing.status, 400, "缺参数是 400，不是 500");
});
