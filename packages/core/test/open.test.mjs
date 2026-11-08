// The first-run path is the one every new user walks, and it used to create an empty database
// just by asking "am I initialised?" — which then made the answer permanently yes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const core = await import("../src/index.mjs");

const freshHome = () => {
  const home = mkdtempSync(join(tmpdir(), "vk-open-"));
  process.env.VK_HOME = home;
  return home;
};

test("只读打开绝不创建数据库文件", () => {
  freshHome();
  const p = core.paths();
  assert.throws(() => core.open({ readonly: true }), /还没有初始化/);
  assert.equal(existsSync(p.db), false, "doctor 跑一次就留下空库，会把 isInitialised 变成谎话");
});

test("未初始化时 getMeta 返回 null，而不是抛 no such table", () => {
  freshHome();
  assert.equal(core.getMeta("schema_version"), null);
  assert.equal(existsSync(core.paths().db), false);
});

test("空文件不算已初始化：认 schema，不认文件存在", () => {
  freshHome();
  const p = core.paths();
  mkdirSync(dirname(p.db), { recursive: true });
  writeFileSync(p.db, "");
  assert.equal(core.isInitialised(), false);
  assert.equal(core.getMeta("schema_version"), null);
});

test("迁移之后读写连接可以并存，schema_version 可读", () => {
  freshHome();
  core.migrate();
  assert.equal(core.isInitialised(), true);
  assert.equal(core.getMeta("schema_version"), "1");
  const w = core.open();
  const r = core.open({ readonly: true });
  assert.equal(w.prepare("SELECT COUNT(*) n FROM meta").get().n > 0, true);
  assert.equal(r.prepare("SELECT COUNT(*) n FROM meta").get().n > 0, true);
});

test("换一个 VK_HOME 不会沿用上一个库的连接", () => {
  freshHome();
  core.migrate();
  assert.equal(core.getMeta("schema_version"), "1");

  freshHome();
  assert.equal(core.isInitialised(), false);
  assert.equal(core.getMeta("schema_version"), null);
});

test("close() 之后重新打开仍然可用", () => {
  freshHome();
  core.migrate();
  core.close();
  assert.equal(core.isInitialised(), true);
  assert.equal(core.getMeta("schema_version"), "1");
});

test("重复 open() 返回同一个写连接（单进程单写入口）", () => {
  freshHome();
  core.migrate();
  assert.equal(core.open(), core.open());
});
