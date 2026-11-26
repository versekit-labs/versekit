// ACC-v2-confirm-07：平台稿用自己那支成片、那个语言版本的文件发布。
//
// 作品表的素材列只跟着第一支成片的第一个版本走。要是适配器读它，确认一支短片，发出去的
// 是长片——比发不出去更糟。这里钉住：素材路径由 core 按平台稿的 version_id 解析后传给
// 适配器；解析不到就报 asset_invalid + 人话，不调适配器，也不退回作品表静默兜底。
// 只用 stub 适配器与 fixture，不碰任何真实平台。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIFABU_HOME = mkdtempSync(join(tmpdir(), "vk-pub-asset-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { loadAdapters, buildHandlers } = await import("../src/adapters.mjs");
const { createRunner } = await import("../src/runner.mjs");
const { resolvePublishAsset, publishInputFor } = await import("../src/publish-flow.mjs");
const { assertPublishInput } = await import("../src/contract.mjs");

core.migrate();
const db = () => core.open();

// stub 适配器：只记下 core 交给它的入参，不做任何对外动作。
const root = mkdtempSync(join(tmpdir(), "vk-pkg-"));
mkdirSync(join(root, "adapter-stub", "src"), { recursive: true });
writeFileSync(
  join(root, "adapter-stub", "package.json"),
  JSON.stringify({ name: "adapter-stub", type: "module", exports: { ".": { import: "./src/index.mjs" } } }),
);
writeFileSync(
  join(root, "adapter-stub", "src", "index.mjs"),
  `export default {
    platform: "stub",
    capabilities: { publish: "web", collect: "none" },
    ready: () => null,
    async publish(input) {
      (globalThis.__stubCalls ??= []).push({ publishId: input.publishId, asset: input.asset });
      return { id: "ext_" + input.publishId, url: "https://stub.test/" + input.publishId, visibility: "public", state: "published" };
    },
  };`,
);
const { adapters } = await loadAdapters({ root });
const handlers = buildHandlers(adapters);
const calls = () => globalThis.__stubCalls ?? [];

const dir = mkdtempSync(join(tmpdir(), "vk-assets-"));
const file = (name) => {
  const p = join(dir, name);
  writeFileSync(p, `fixture ${name}`);
  return p;
};
const LONG_ZH = file("long-zh.mp4");
const LONG_EN = file("long-en.mp4");
const SHORT_ZH = file("short-zh.mp4");

db().prepare("INSERT INTO account (id, platform, handle, state, created_at) VALUES ('acc_stub','stub','@stub','ok',1)").run();

const work = store.upsertWork({
  title: "长短片作品",
  source: LONG_ZH,
  cuts: [
    { title: "长片", versions: [{ language: "zh", asset: LONG_ZH }, { language: "en", asset: LONG_EN }] },
    { title: "短片", versions: [{ language: "zh", asset: SHORT_ZH }] },
  ],
});
const workId = work.id ?? work.workId;
const cuts = db().prepare("SELECT id, title FROM cut WHERE work_id = ? ORDER BY position, created_at").all(workId);
const cutOf = (title) => cuts.find((c) => c.title === title).id;
const versionOf = (cutId, language) => db().prepare("SELECT id FROM cut_version WHERE cut_id = ? AND language = ?").get(cutId, language).id;

async function runPublish(publishId) {
  core.enqueue({ kind: "publish", targetType: "publish", targetId: publishId, lane: "acc_stub" });
  await createRunner({ handlers, log: () => {} }).tick();
}

test("作品表素材列确实是长片：不按版本解析就会发错片（前提）", () => {
  assert.equal(db().prepare("SELECT asset_path FROM work WHERE id = ?").get(workId).asset_path, LONG_ZH);
});

test("ACC-v2-confirm-07：同一作品长片、短片各一条平台稿，发短片那条时适配器拿到的是短片文件", async () => {
  const long = store.createPublish({ workId, accountId: "acc_stub", cutId: cutOf("长片") });
  const short = store.createPublish({ workId, accountId: "acc_stub", cutId: cutOf("短片") });
  assert.equal(short.versionId, versionOf(cutOf("短片"), "zh"));

  store.approvePublishes({ cutId: cutOf("短片") });
  const before = calls().length;
  await runPublish(short.id);
  const seen = calls().slice(before);
  assert.deepEqual(seen, [{ publishId: short.id, asset: SHORT_ZH }], "发短片时传给适配器的必须是短片文件，不是长片");
  assert.equal(db().prepare("SELECT state FROM publish WHERE id = ?").get(short.id).state, "published");

  // 长片那条也拿自己的文件，互不串。
  store.approvePublishes({ cutId: cutOf("长片") });
  const mark = calls().length;
  await runPublish(long.id);
  assert.deepEqual(calls().slice(mark), [{ publishId: long.id, asset: LONG_ZH }]);
});

test("同一支成片的另一个语言版本：适配器拿到那个语言的文件", () => {
  db().prepare("INSERT INTO account (id, platform, handle, state, created_at) VALUES ('acc_stub_en','stub','@stub_en','ok',1)").run();
  const en = store.createPublish({ workId, accountId: "acc_stub_en", cutId: cutOf("长片"), versionId: versionOf(cutOf("长片"), "en") });
  const r = resolvePublishAsset(en.id);
  assert.equal(r.asset, LONG_EN);
  assert.equal(r.language, "en");
  assert.equal(publishInputFor(en.id, { dryRun: true }).asset, LONG_EN);
});

test("version_id 为空：报 asset_invalid + 人话，不调适配器，不退回作品表", async () => {
  db().prepare("INSERT INTO account (id, platform, handle, state, created_at) VALUES ('acc_stub_x','stub','@stub_x','ok',1)").run();
  const now = Date.now();
  db()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES ('pub_noversion', ?, 'acc_stub_x', 'queued', ?, ?)")
    .run(workId, now, now);

  assert.throws(() => resolvePublishAsset("pub_noversion"), (err) => err.code === "asset_invalid" && /version_id 为空/.test(err.message));

  const before = calls().length;
  await runPublish("pub_noversion");
  assert.equal(calls().length, before, "解析不到素材时不能调用适配器");
  const row = db().prepare("SELECT state, error_code, error_message FROM publish WHERE id = 'pub_noversion'").get();
  assert.equal(row.state, "failed");
  assert.equal(row.error_code, "asset_invalid");
  assert.match(row.error_message, /没有挂语言版本/);
});

test("适配器入参契约：缺 asset 直接拒绝", () => {
  assert.throws(() => assertPublishInput({ publishId: "p1" }), /缺少 asset/);
  assert.throws(() => assertPublishInput({ publishId: "p1", asset: "  " }), /缺少 asset/);
  assert.throws(() => assertPublishInput({ asset: "/a.mp4" }), /缺少 publishId/);
  assert.deepEqual(assertPublishInput({ publishId: "p1", asset: "/a.mp4" }), { publishId: "p1", asset: "/a.mp4" });
});
