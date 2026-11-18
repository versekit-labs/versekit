// issue #145 · ACC-v2-cut-01 / ACC-v2-cut-02 / ACC-v2-work-01
// 作品 → 成片 → 语言版本 → 平台稿。钉住：单文件入库、多成片多语言入库、重复入库是更新、
// 同一账号发同一作品的多支成片、旧库升级（跑两次）后数据还在、状态由平台稿推出。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LEGACY_HOME = mkdtempSync(join(tmpdir(), "vk-work-legacy-"));
const HOME = mkdtempSync(join(tmpdir(), "vk-work-"));
process.env.VK_HOME = LEGACY_HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");

after(() => core.close());

const file = (name) => {
  const p = join(HOME, name);
  writeFileSync(p, "fake video");
  return p;
};
const count = (sql, ...params) => core.open().prepare(sql).get(...params).n;

// ---------------------------------------------------------------- 旧库升级

test("ACC-v2-cut-02 旧库升级：publish 的 UNIQUE 去掉，成片补齐，快照/任务/发布 id 不变；跑两次不重复建成片", () => {
  const { db } = core.ensureDirs();
  const old = new DatabaseSync(db);
  // 升级前的真实表结构：publish 带 UNIQUE(work_id, account_id)，snapshot/followup 引用 publish(id)。
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE account (id TEXT PRIMARY KEY, platform TEXT NOT NULL, handle TEXT NOT NULL, display_name TEXT,
      credential_ref TEXT, state TEXT NOT NULL DEFAULT 'ok', is_manual INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER, last_ok_at INTEGER, created_at INTEGER NOT NULL, UNIQUE (platform, handle));
    CREATE TABLE work (id TEXT PRIMARY KEY, title TEXT NOT NULL, asset_path TEXT NOT NULL, asset_sha TEXT, meta_json TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE publish (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work(id), account_id TEXT NOT NULL REFERENCES account(id),
      mode TEXT NOT NULL DEFAULT 'auto', visibility TEXT NOT NULL DEFAULT 'public', state TEXT NOT NULL DEFAULT 'queued',
      scheduled_at INTEGER, overrides_json TEXT, external_id TEXT, external_url TEXT, fallback_reason TEXT, error_code TEXT,
      error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      published_at INTEGER, UNIQUE (work_id, account_id));
    CREATE INDEX idx_publish_state ON publish(state, scheduled_at);
    CREATE TABLE snapshot (id TEXT PRIMARY KEY, publish_id TEXT NOT NULL REFERENCES publish(id), captured_at INTEGER NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL, metrics_json TEXT NOT NULL, UNIQUE (publish_id, captured_at));
    CREATE TABLE followup (id TEXT PRIMARY KEY, publish_id TEXT NOT NULL REFERENCES publish(id), kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open', verify_hint TEXT, done_at INTEGER);
    CREATE TABLE run (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, lane TEXT,
      state TEXT NOT NULL DEFAULT 'queued', priority INTEGER NOT NULL DEFAULT 100, run_after INTEGER, lease_until INTEGER,
      heartbeat_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL);
  `);
  old.exec(`
    INSERT INTO account (id, platform, handle, created_at) VALUES ('acc1','tiktok','@old',1), ('acc2','bilibili','@oldb',1);
    INSERT INTO work (id, title, asset_path, meta_json, created_at) VALUES ('w1','旧作品一','/m/one.mp4','{"body":"hi"}',10), ('w2','旧作品二','/m/two.mp4',NULL,20);
    INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES
      ('p1','w1','acc1','published',11,11), ('p2','w1','acc2','failed',12,12), ('p3','w2','acc1','queued',21,21);
    INSERT INTO snapshot VALUES ('s1','p1',100,'api','ok','{"views":5}');
    INSERT INTO followup (id, publish_id, kind) VALUES ('f1','p1','collect');
    INSERT INTO run (id, kind, target_type, target_id, created_at) VALUES ('r1','publish','publish','p3',30);
  `);
  old.close();

  core.migrate();
  core.migrate(); // 幂等：第二遍不报错、不重复建成片

  const conn = core.open();
  // 约束：旧的 UNIQUE(work_id, account_id) 没了，新的每成片每账号一条在。
  assert.equal(
    conn.prepare("PRAGMA index_list(publish)").all().filter((i) => i.origin === "u").length,
    0,
    "publish 表上不应再有表内 UNIQUE 约束",
  );
  assert.ok(conn.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_publish_cut_account'").get());
  assert.ok(conn.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_publish_state'").get(), "原有索引不能丢");

  // 数据：行与 id 原样保留，下游引用没断。
  assert.deepEqual(conn.prepare("SELECT id FROM publish ORDER BY id").all().map((r) => r.id), ["p1", "p2", "p3"]);
  assert.equal(conn.prepare("SELECT state FROM publish WHERE id='p2'").get().state, "failed");
  assert.equal(count("SELECT COUNT(*) n FROM snapshot WHERE publish_id='p1'"), 1);
  assert.equal(count("SELECT COUNT(*) n FROM followup WHERE publish_id='p1'"), 1);
  assert.equal(conn.prepare("SELECT target_id FROM run WHERE id='r1'").get().target_id, "p3");
  assert.deepEqual(conn.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(conn.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "迁移完要把外键开回去");
  // 外键仍然指向 publish（没被改名带偏）。
  assert.ok(conn.prepare("PRAGMA foreign_key_list(snapshot)").all().some((f) => f.table === "publish"));

  // 每个旧作品恰好一支成片 + 一个版本，旧平台稿都挂上了。
  assert.equal(count("SELECT COUNT(*) n FROM cut"), 2);
  assert.equal(count("SELECT COUNT(*) n FROM cut_version"), 2);
  assert.equal(count("SELECT COUNT(*) n FROM publish WHERE cut_id IS NULL OR version_id IS NULL"), 0);
  const w1 = store.showWork("w1");
  assert.equal(w1.cuts.length, 1);
  assert.equal(w1.cuts[0].versions[0].asset, "/m/one.mp4");
  assert.deepEqual(w1.cuts[0].publishes.map((p) => p.id).sort(), ["p1", "p2"]);
  assert.equal(w1.status.key, "problem", "有一条失败 → 出了问题");

  // 升级后同一账号可以在同一作品下再挂另一支成片的平台稿。
  const r = store.upsertWork({ title: "旧作品一", source: "/m/one.mp4", cuts: [{ title: "旧作品一", versions: [{ language: "default", asset: "/m/one.mp4" }] }] });
  assert.equal(r.existed, false, "旧作品没有 source，不会被误认成同一个作品");
});

// ---------------------------------------------------------------- 新库

test("ACC-v2-cut-01 单文件入库 = 1 作品 1 成片 1 版本；重复入库是更新，不新建", () => {
  process.env.VK_HOME = HOME;
  core.close();
  core.migrate();
  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  const video = file("long.mp4");

  const first = handlers["work.add"]({ asset: video });
  assert.equal(first.existed, false);
  assert.equal(first.work.cuts.length, 1);
  assert.equal(first.work.cuts[0].versions.length, 1);
  assert.equal(first.work.title, "long");
  assert.equal(first.work.asset, video);

  const again = handlers["work.add"]({ asset: video });
  assert.equal(again.id, first.id, "同一来源同一标题是同一个作品");
  assert.equal(again.updated, true);
  assert.equal(count("SELECT COUNT(*) n FROM work WHERE source = ?", video), 1);
  assert.equal(count("SELECT COUNT(*) n FROM cut WHERE work_id = ?", first.id), 1);
  assert.equal(count("SELECT COUNT(*) n FROM cut_version WHERE cut_id = ?", first.work.cuts[0].id), 1);

  // 同一来源换个标题 = 另一个作品。
  const other = handlers["work.add"]({ asset: video, title: "另一个标题" });
  assert.notEqual(other.id, first.id);

  assert.throws(() => handlers["work.add"]({ asset: join(HOME, "不存在.mp4") }), /找不到素材/);
  assert.throws(() => handlers["work.add"]({}), /素材路径/);
});

test("ACC-v2-cut-01 多支成片、多语言入库；重复入库按标题/语言更新，不删没提到的", () => {
  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  const cuts = [
    { title: "长片", versions: [{ language: "zh", asset: file("long-zh.mp4") }, { language: "en", asset: file("long-en.mp4") }] },
    { title: "短片 A", versions: [{ language: "zh", asset: file("a-zh.mp4") }] },
    { title: "短片 B", versions: [{ language: "zh", asset: file("b-zh.mp4") }] },
  ];
  const added = handlers["work.add"]({ title: "系列", cuts });
  assert.equal(added.cuts.created, 3);
  assert.equal(added.versions.created, 4);
  assert.deepEqual(added.work.cuts.map((c) => c.title), ["长片", "短片 A", "短片 B"]);
  assert.deepEqual(added.work.cuts[0].versions.map((v) => v.language).sort(), ["en", "zh"]);
  assert.equal(added.work.asset, cuts[0].versions[0].asset, "work.asset_path 跟第一支成片的第一个版本，适配器还读这一列");

  // 再来一遍：换掉一个版本的素材，加一个新语言；其余不动。
  const newEn = file("long-en-v2.mp4");
  const newJa = file("long-ja.mp4");
  const redo = handlers["work.add"]({
    title: "系列",
    source: cuts[0].versions[0].asset,
    cuts: [{ title: "长片", versions: [{ language: "en", asset: newEn }, { language: "ja", asset: newJa }] }],
  });
  assert.equal(redo.id, added.id);
  assert.deepEqual([redo.cuts.created, redo.cuts.updated, redo.versions.created, redo.versions.updated], [0, 1, 1, 1]);
  const long = redo.work.cuts.find((c) => c.title === "长片");
  assert.equal(long.versions.find((v) => v.language === "en").asset, newEn);
  assert.equal(long.versions.length, 3);
  assert.equal(redo.work.cuts.length, 3, "没提到的成片还在");
  assert.equal(count("SELECT COUNT(*) n FROM work WHERE id = ?", added.id), 1);

  // 校验在写任何行之前做完：重名成片整单拒绝，不留半个作品。
  const before = count("SELECT COUNT(*) n FROM work");
  assert.throws(() => handlers["work.add"]({ title: "坏的", cuts: [cuts[1], cuts[1]] }), /成片标题重复/);
  assert.throws(() => handlers["work.add"]({ title: "坏的", cuts: [{ title: "x", versions: [] }] }), /至少要有一个语言版本/);
  assert.throws(() => handlers["work.add"]({ cuts }), /必须有标题/);
  assert.equal(count("SELECT COUNT(*) n FROM work"), before);
});

test("ACC-v2-cut-02 平台稿挂在成片下并记录语言版本：同一账号同一作品可有多条（每支成片最多一条）", () => {
  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  const g = handlers["group.add"]({ name: "v2 组" });
  const acc = handlers["account.add"]({ platform: "tiktok", name: "@v2", group: g.name }).id;
  const w = handlers["work.add"]({
    title: "同号多条",
    cuts: [
      { title: "长片", versions: [{ language: "zh", asset: file("m-long-zh.mp4") }, { language: "en", asset: file("m-long-en.mp4") }] },
      { title: "短 1", versions: [{ language: "zh", asset: file("m-s1.mp4") }] },
      { title: "短 2", versions: [{ language: "zh", asset: file("m-s2.mp4") }] },
      { title: "短 3", versions: [{ language: "zh", asset: file("m-s3.mp4") }] },
    ],
  }).work;

  const long = w.cuts[0];
  const en = long.versions.find((v) => v.language === "en");
  const p0 = store.createPublish({ workId: w.id, cutId: long.id, versionId: en.id, accountId: acc, mode: "manual" });
  for (const c of w.cuts.slice(1)) store.createPublish({ workId: w.id, cutId: c.id, accountId: acc, mode: "manual" });
  assert.equal(count("SELECT COUNT(*) n FROM publish WHERE work_id = ? AND account_id = ?", w.id, acc), 4, "长片 1 条 + 短片 3 条发同一个账号");
  assert.equal(p0.versionId, en.id);

  // 同一支成片同一个账号第二条：拒绝。
  assert.throws(() => store.createPublish({ workId: w.id, cutId: long.id, accountId: acc, mode: "manual" }), /同一支成片对同一账号只能有一条/);
  // 版本/成片必须属于这个作品。
  assert.throws(() => store.createPublish({ workId: w.id, cutId: w.cuts[1].id, versionId: en.id, accountId: acc, mode: "manual" }), /不属于成片/);

  const shown = handlers["work.show"]({ workId: w.id }).work;
  const longPub = shown.cuts[0].publishes[0];
  assert.equal(longPub.language, "en", "平台稿记录用的是哪个语言版本");
  assert.equal(shown.cuts.flatMap((c) => c.publishes).length, 4);
});

test("publish.create 仍是快捷方式：1 作品 1 成片 1 版本，每次新建；同一素材再发一次不被新约束拦下", () => {
  const handlers = createCoreHandlers({ adapters: [{ platform: "tiktok" }], log: () => {} });
  const g = handlers["group.add"]({ name: "快捷方式组" });
  handlers["account.add"]({ platform: "tiktok", name: "@quick", group: g.name });
  const asset = file("quick.mp4");
  const one = handlers["publish.create"]({ asset, to: ["tiktok"] });
  const two = handlers["publish.create"]({ asset, to: ["tiktok"] });
  assert.notEqual(one.workId, two.workId);
  const w = store.showWork(one.workId);
  assert.equal(w.cuts.length, 1);
  assert.equal(w.cuts[0].versions.length, 1);
  assert.equal(w.cuts[0].publishes.length, 1);
  assert.equal(w.cuts[0].publishes[0].id, one.publishes[0].publishId);
});

test("ACC-v2-work-01 作品状态只取最要紧的一个：出了问题 > 等确认 > 已确认等时间 > 都发完了", () => {
  assert.equal(store.deriveStatus([]).key, "none");
  assert.equal(store.deriveStatus(["canceled"]).key, "canceled");
  assert.equal(store.deriveStatus(["published", "published_limited"]).key, "done");
  assert.equal(store.deriveStatus(["published", "queued"]).key, "scheduled");
  assert.equal(store.deriveStatus(["published", "queued", "notify_pending"]).key, "awaiting_confirm");
  assert.equal(store.deriveStatus(["published", "queued", "notify_pending", "failed"]).key, "problem");
  for (const s of ["failed", "blocked", "expired"]) assert.equal(store.deriveStatus(["notify_pending", s]).key, "problem", s);
  assert.equal(store.deriveStatus(["canceled", "published"]).key, "done", "已取消的不参与");
  // 每个真实的 publish 状态都必须归到某一档（新增状态忘了归类会在这里报）。
  const unmapped = Object.keys(core.PUBLISH_TRANSITIONS).filter((s) => s !== "canceled" && !(s in store.PUBLISH_STATE_GROUP));
  assert.deepEqual(unmapped, []);
});

test("work.list / work.show：JSON 里有作品、成片、每条平台稿的状态；未知作品给带下一步的错", () => {
  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  // ACC-v2-group-01：默认只看当前组。「v2 组」里的作品要显式 --group，或先切过去。
  const { works } = handlers["work.list"]({ group: "v2 组" });
  assert.ok(works.length >= 1);
  for (const w of works) {
    assert.ok(w.id && w.title && w.status.key && Number.isInteger(w.cuts) && Number.isInteger(w.versions) && Number.isInteger(w.publishes));
  }
  const series = works.find((w) => w.title === "同号多条");
  assert.equal(series.cuts, 4);
  assert.equal(series.publishes, 4);
  // #146：新建平台稿先停在待确认 → 等确认；人确认每支成片后，manual 模式的平台稿在 queued → 已确认等时间。
  assert.equal(series.status.key, "awaiting_confirm", "未确认的平台稿 → 等确认");
  for (const c of handlers["work.show"]({ workId: series.id, group: "v2 组" }).work.cuts) handlers["publish.approve"]({ cutId: c.id });
  const confirmed = handlers["work.list"]({ group: "v2 组" }).works.find((w) => w.title === "同号多条");
  assert.equal(confirmed.status.key, "scheduled", "manual 模式的平台稿在 queued 状态 → 已确认等时间");
  assert.throws(() => handlers["work.show"]({ workId: "work_nope" }), (e) => /没有这个作品/.test(e.message) && /vk work list/.test(e.hint), "报错是人话，命令放 hint");
});

test("ACC-v2-confirm-04 平台稿标题：work.show 给的就是「现在点确认会发出去」的那一个", async () => {
  // #148：今天页要显示并能预填每条平台稿的标题。回退链只有 core 一份（effectiveTitle），
  // 页面和卡片都读它；这里把它和适配器真正用的取值对上。
  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  const g = handlers["group.add"]({ name: "标题组" });
  const acc = handlers["account.add"]({ platform: "xiaohongshu", name: "@标题", group: g.name }).id;
  const w = store.upsertWork({
    title: "作品标题",
    cuts: [{ title: "长片", versions: [{ language: "中文", asset: file("title.mp4") }] }],
    // 改写结果落在作品 meta 上；确认前改的标题落在平台稿上。
    meta: { title: "改写后的标题" },
  });
  const pub = store.createPublish({ workId: w.id, accountId: acc, cutId: store.showWork(w.id).cuts[0].id });
  const adapterRow = () =>
    core
      .open()
      .prepare(
        `SELECT p.*, a.platform, a.handle, a.id AS account_id, w.title AS work_title, w.meta_json
           FROM publish p JOIN account a ON a.id = p.account_id JOIN work w ON w.id = p.work_id
          WHERE p.id = ?`,
      )
      .get(pub.id);
  const { planNote } = await import("../../adapter-xiaohongshu/src/index.mjs");

  const before = store.showWork(w.id).cuts[0].publishes[0];
  assert.equal(before.title, "改写后的标题", "没改过时用作品 meta 里的改写结果");
  assert.equal(before.titleEdited, false);
  assert.equal(before.title, planNote(adapterRow()).title, "work.show 的值必须和适配器拿到的一致");

  store.editPublish({ publishId: pub.id, title: "确认前改的标题" });
  const after = store.showWork(w.id).cuts[0].publishes[0];
  assert.equal(after.title, "确认前改的标题", "改过之后 work.show 立刻给新标题");
  assert.equal(after.titleEdited, true);
  assert.equal(after.title, planNote(adapterRow()).title, "改过之后也和适配器拿到的一致");
  assert.equal(after.scheduledAt, store.getPublish(pub.id).scheduled_at, "时间是改后的那一份");
});
