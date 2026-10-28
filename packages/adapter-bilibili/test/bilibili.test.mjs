// B站适配器测试：不碰真网络、不碰真 biliup —— 用一个假的 biliup 脚本 + 一个假的 archives 接口。
//
// 这里验的是**契约**，不是平台：适配器只返回结果或抛 AdapterError，绝不自己写 publish 状态、
// 快照、事件。落库是 core 的事（packages/core/src/publish-flow.mjs），所以断言的是「什么都没写」。
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-bili-"));

const core = await import("../../core/src/index.mjs");
const { AdapterError } = await import("../../core/src/errors.mjs");
const adapter = (await import("../src/index.mjs")).default;

const db = () => core.open();
let seq = 0;

/** 一个只会照剧本说话的 biliup：STYLE 决定是成功、登录失效还是拿不到 BV 号。 */
function fakeBiliup() {
  const dir = mkdtempSync(join(tmpdir(), "vk-biliup-"));
  const bin = join(dir, "biliup");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.STYLE || "ok";
if (mode === "auth") { console.error("请先登录：cookie 已失效"); process.exit(1); }
if (mode === "nobv" && args.includes("list")) { console.log("BV1xx411c7mD  固定标题"); process.exit(0); }
if (mode === "nobv") { console.log("上传完成"); process.exit(0); }
if (args.includes("list")) { console.log("BV1zz411c7mE  标题"); process.exit(0); }
console.log(JSON.stringify({ argv: args, id: "BV1yy411c7mF" }));
`,
  );
  chmodSync(bin, 0o755);
  process.env.VK_BILIUP_BIN = bin;
  return bin;
}

function seed({ state = "queued", credential = true, scheduledAt = null, title = null } = {}) {
  const n = ++seq;
  const credPath = `${process.env.VK_HOME}/cookies-${n}.json`;
  if (credential) {
    writeFileSync(credPath, JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "y" }] } }));
  }
  const asset = `${process.env.VK_HOME}/cut-${n}.mp4`;
  writeFileSync(asset, "fake video");
  db().prepare("INSERT INTO work (id, title, asset_path, meta_json, created_at) VALUES (?,?,?,?,?)").run(
    `w${n}`,
    `第 ${n} 期`,
    asset,
    JSON.stringify({ title: title ?? `测试标题 ${n}`, description: "描述", tags: ["AI", "效率"] }),
    Date.now(),
  );
  db().prepare("INSERT INTO account (id, platform, handle, credential_ref, created_at) VALUES (?,?,?,?,?)").run(`a${n}`, "bilibili", `@bili${n}`, credential ? credPath : null, Date.now());
  db()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, scheduled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(`p${n}`, `w${n}`, `a${n}`, state, scheduledAt, Date.now(), Date.now());
  return { publishId: `p${n}`, accountId: `a${n}`, credPath };
}

before(() => {
  core.migrate();
  fakeBiliup();
});

beforeEach(() => {
  db().exec("DELETE FROM snapshot; DELETE FROM followup; DELETE FROM publish; DELETE FROM work; DELETE FROM account; DELETE FROM run; DELETE FROM event;");
  process.env.STYLE = "ok";
});

test("publish 返回 BV 号与 published，但自己不落库", async () => {
  const { publishId } = seed();
  const res = await adapter.publish({ publishId });

  assert.match(res.id, /^BV[0-9A-Za-z]{10}$/);
  assert.equal(res.state, "published");
  assert.match(res.url, /bilibili\.com\/video\//);
  assert.equal(res.visibility, "public");

  const row = db().prepare("SELECT state, external_id FROM publish WHERE id=?").get(publishId);
  assert.equal(row.state, "queued", "状态迁移必须由 core 做");
  assert.equal(row.external_id, null);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM run WHERE target_id=?").get(publishId).n, 0, "排采集也是 core 的事");
});

test("publish 把平台要求补做的事作为 followup 返回，而不是写库", async () => {
  const { publishId } = seed();
  const res = await adapter.publish({ publishId });
  const kinds = res.followups.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["declare_ai_generated", "upload_captions"]);
  assert.equal(res.followups.find((f) => f.kind === "upload_captions").verify, "captions");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM followup").get().n, 0);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM event").get().n, 0);
});

test("合集是可选 followup：配置了才返回，并带核实方式", async () => {
  const { publishId } = seed();
  db().prepare("UPDATE publish SET overrides_json=? WHERE id=?").run(JSON.stringify({ collection: "出海合规" }), publishId);
  const res = await adapter.publish({ publishId });
  const collection = res.followups.find((f) => f.kind === "add_to_collection");
  assert.ok(collection);
  assert.equal(collection.verify, "collection");
});

test("延时发布不足 4 小时就不传 --dtime（平台怪癖归适配器）", async () => {
  const soon = seed({ scheduledAt: Date.now() + 30 * 60e3 });
  const later = seed({ scheduledAt: Date.now() + 6 * 3600e3 });
  const a = await adapter.publish({ publishId: soon.publishId, dryRun: true });
  const b = await adapter.publish({ publishId: later.publishId, dryRun: true });
  assert.ok(!a.args.includes("--dtime"));
  assert.ok(b.args.includes("--dtime"));
});

test("dry-run 不触碰平台状态，也不调用 biliup", async () => {
  const { publishId } = seed();
  const res = await adapter.publish({ publishId, dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "queued");
});

test("输出里没有 BV 号时回退到 biliup list 找", async () => {
  process.env.STYLE = "nobv";
  const { publishId } = seed({ title: "固定标题" });
  const res = await adapter.publish({ publishId });
  assert.equal(res.id, "BV1xx411c7mD");
});

test("登录失效抛 auth，交给 core 去 block 和过期账号", async () => {
  process.env.STYLE = "auth";
  const { publishId } = seed();
  await assert.rejects(
    () => adapter.publish({ publishId }),
    (err) => err instanceof AdapterError && err.code === "auth",
  );
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "queued");
});

test("没有凭证时立刻报人话，不去调 biliup", async () => {
  const { publishId } = seed({ credential: false });
  await assert.rejects(
    () => adapter.publish({ publishId }),
    (err) => err instanceof AdapterError && err.code === "auth",
  );
});

test("collect 返回指标与来源，不写快照", async () => {
  const { publishId } = seed();
  db().prepare("UPDATE publish SET state='published', external_id='BV1yy411c7mF' WHERE id=?").run(publishId);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({
      code: 0,
      data: { arc_audits: [{ Archive: { bvid: "BV1yy411c7mF" }, stat: { view: 1234, like: 56, favorite: 7, coin: 8, share: 9, reply: 10 } }] },
    }),
  });
  let res;
  try {
    res = await adapter.collect({ publishId });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(res.metrics, { play: 1234, like: 56, fav: 7, coin: 8, share: 9, comment: 10 });
  assert.equal(res.source, "intercept");
  assert.equal(res.status, "ok");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM snapshot").get().n, 0, "快照由 core 落库");
});

test("collect 遇到登录失效抛 auth，不自己发事件", async () => {
  const { publishId } = seed();
  db().prepare("UPDATE publish SET state='published', external_id='BV1yy411c7mF' WHERE id=?").run(publishId);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: -101, message: "账号未登录" }) });
  try {
    await assert.rejects(
      () => adapter.collect({ publishId }),
      (err) => err instanceof AdapterError && err.code === "auth",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(db().prepare("SELECT COUNT(*) n FROM event").get().n, 0);
});

test("同一账号里找不到稿件时，错误里带 external_id 便于排障", async () => {
  const { publishId } = seed();
  db().prepare("UPDATE publish SET state='published', external_id='BV_not_there' WHERE id=?").run(publishId);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0, data: { arc_audits: [] } }) });
  try {
    await assert.rejects(() => adapter.collect({ publishId }), /BV_not_there/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ready() 按 PATH 找 biliup，而不是只看 cwd 的相对路径", () => {
  const saved = { bin: process.env.VK_BILIUP_BIN, path: process.env.PATH };
  try {
    delete process.env.VK_BILIUP_BIN;
    process.env.PATH = mkdtempSync(join(tmpdir(), "vk-emptypath-"));
    assert.match(adapter.ready(), /未配置/);

    const dir = mkdtempSync(join(tmpdir(), "vk-path-"));
    const bin = join(dir, "biliup");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    process.env.PATH = dir;
    assert.equal(adapter.ready(), null);
  } finally {
    if (saved.bin === undefined) delete process.env.VK_BILIUP_BIN;
    else process.env.VK_BILIUP_BIN = saved.bin;
    process.env.PATH = saved.path;
  }
});
