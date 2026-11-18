// v3 第 3 单：通用文案按字段覆盖、cut.edit、现在发 / 预约发、建议时间顺延
// （ACC-v3-edit-01/02/06/07、ACC-v3-time-01/02/03/04/09）。只用 fixture，不碰任何真实账号或平台。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-cut-edit-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { updateConfig } = await import("../src/config.mjs");
const { COMMANDS, findCommand, parseArgs } = await import("../src/commands.mjs");

const adapters = ["bilibili", "xiaohongshu", "tiktok"].map((platform) => ({ platform }));
const h = createCoreHandlers({ adapters, log: () => {} });
const HOUR = 3600e3;
let seq = 0;
before(() => core.migrate());

const dir = mkdtempSync(join(tmpdir(), "vk-cut-edit-assets-"));
const file = (name) => {
  const p = join(dir, name);
  writeFileSync(p, `fixture ${name}`);
  return p;
};

/** 一个账号组（B站、小红书各一个号）+ 一个有通用文案和 B站单独标题的作品，已生成平台稿。 */
function fixture({ copy } = {}) {
  const group = store.addGroup({ name: `改内容组 ${++seq}` });
  store.useGroup(group.id);
  const bili = store.addAccount({ platform: "bilibili", handle: `@b${seq}`, groupId: group.id });
  const red = store.addAccount({ platform: "xiaohongshu", handle: `@x${seq}`, groupId: group.id });
  const asset = file(`v-${seq}.mp4`);
  const manifest = (c) => ({
    title: `作品 ${seq}`,
    source: asset,
    cuts: [{ title: "成片", copy: c, versions: [{ language: "zh", asset }] }],
  });
  const ingest = (c) => store.upsertWork(manifest(c));
  const { id } = ingest(copy ?? { title: "通用标题", body: "通用正文", tags: ["通用"], bilibili: { title: "B站专属标题" } });
  const cut = () => store.showWork(id).cuts[0];
  const applied = h["plan.apply"]({ cutId: cut().id, group: group.id });
  const pub = Object.fromEntries(applied.created.map((c) => [c.platform, c.publishId]));
  const copyOf = (platform) => store.resolvePublishCopy(pub[platform]);
  return { group, bili, red, workId: id, cut, pub, copyOf, ingest, applied };
}

test("命令表有 cut.edit（CLI、HTTP 由它派生），approve 多了 when 参数", () => {
  const c = findCommand("cut.edit");
  assert.ok(c);
  assert.equal(c.http.path, "/api/cuts/:cutId/edit");
  assert.match(c.cli.usage, /vk cut edit <cutId> --rev/);
  assert.ok(COMMANDS.find((x) => x.name === "publish.approve").args.when);
  assert.deepEqual(parseArgs(c, { cutId: "c", rev: 0, generic: { title: "x" } }), { cutId: "c", rev: 0, generic: { title: "x" } });
  assert.throws(() => parseArgs(c, { cutId: "c", rev: 0, generic: ["x"] }), /必须是对象/);
});

test("ACC-v3-edit-01：改通用标题，跟通用的平台稿发出去的是新标题，单独写过标题的不变", () => {
  const f = fixture();
  assert.equal(f.copyOf("xiaohongshu").title, "通用标题");
  assert.equal(f.copyOf("bilibili").title, "B站专属标题");
  // 平台稿只存「单独写的」字段，不抄通用文案。
  assert.deepEqual(JSON.parse(store.getPublish(f.pub.xiaohongshu).overrides_json ?? "null"), null);
  assert.deepEqual(JSON.parse(store.getPublish(f.pub.bilibili).overrides_json).copy, { title: "B站专属标题" });

  const done = h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, generic: { title: "新的通用标题", body: "新正文", tags: ["新"] } });
  assert.equal(f.copyOf("xiaohongshu").title, "新的通用标题");
  assert.equal(f.copyOf("xiaohongshu").body, "新正文");
  assert.deepEqual(f.copyOf("xiaohongshu").tags, ["新"]);
  assert.equal(f.copyOf("bilibili").title, "B站专属标题", "单独写过标题的不变");
  assert.equal(f.copyOf("bilibili").body, "新正文", "没单独写正文的跟通用");
  assert.deepEqual(done.editedFields.sort(), ["body", "tags", "title"]);

  // 页面读到的也是同一个值，并标出哪些字段是单独写的。
  const view = f.cut().publishes;
  assert.equal(view.find((p) => p.platform === "xiaohongshu").title, "新的通用标题");
  assert.deepEqual(view.find((p) => p.platform === "bilibili").ownFields, ["title"]);
  assert.deepEqual(view.find((p) => p.platform === "xiaohongshu").ownFields, []);
});

test("ACC-v3-edit-01：平台字段给 null = 改回跟通用；给值 = 单独写", () => {
  const f = fixture();
  h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.xiaohongshu]: { title: "小红书专属" } } });
  assert.equal(f.copyOf("xiaohongshu").title, "小红书专属");
  h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.xiaohongshu]: { title: null }, [f.pub.bilibili]: { title: null } } });
  assert.equal(f.copyOf("xiaohongshu").title, "通用标题");
  assert.equal(f.copyOf("bilibili").title, "通用标题", "入库时单独写的标题也能改回跟通用");
});

test("ACC-v3-edit-01：旧库里整份抄进平台稿的通用文案，迁移后重新跟通用", () => {
  const f = fixture();
  // 模拟旧版 plan.apply：把合并后的整份文案存进 overrides.copy。
  core.open().prepare("UPDATE publish SET overrides_json = ? WHERE id = ?").run(JSON.stringify({ copy: { title: "通用标题", body: "通用正文", tags: ["通用"] } }), f.pub.xiaohongshu);
  core.migrate();
  assert.equal(store.getPublish(f.pub.xiaohongshu).overrides_json, null);
  core.open().prepare("UPDATE publish SET overrides_json = ? WHERE id = ?").run(JSON.stringify({ copy: { title: "B站专属标题", body: "通用正文" } }), f.pub.bilibili);
  core.migrate();
  assert.deepEqual(JSON.parse(store.getPublish(f.pub.bilibili).overrides_json).copy, { title: "B站专属标题" }, "入库时给 B站单独写的标题保留");
});

test("ACC-v3-edit-02：带 rev 一次提交；别处先改过就拒绝；失败整体不存", () => {
  const f = fixture();
  const rev0 = f.cut().rev;
  const ok = h["cut.edit"]({ cutId: f.cut().id, rev: rev0, generic: { body: "第一次" } });
  assert.equal(ok.rev, rev0 + 1);
  assert.equal(f.cut().rev, rev0 + 1);

  assert.throws(
    () => h["cut.edit"]({ cutId: f.cut().id, rev: rev0, generic: { body: "旧页面里改的" } }),
    (e) => e.code === "E_REV_CONFLICT" && e.message === "这支成片刚在别处改过，重新打开再改",
  );
  assert.equal(f.copyOf("xiaohongshu").body, "第一次", "冲突时一个字都没存");

  // 通用合法 + 小红书标题超限（> 20 字）：整个提交都不存，rev 也不动。
  const rev1 = f.cut().rev;
  assert.throws(
    () => h["cut.edit"]({ cutId: f.cut().id, rev: rev1, generic: { body: "不该存上" }, platforms: { [f.pub.xiaohongshu]: { title: "这是一个远远超过二十个字的小红书标题标题标题标题" } } }),
    (e) => e.code === "E_COPY_LIMIT" && /小红书 标题最多 20 字/.test(e.message),
  );
  assert.equal(f.copyOf("xiaohongshu").body, "第一次");
  assert.equal(f.cut().rev, rev1);

  // 别处（publish.edit）改过，也让旧 rev 失效。
  h["publish.edit"]({ publishId: f.pub.xiaohongshu, title: "单条改的" });
  assert.throws(() => h["cut.edit"]({ cutId: f.cut().id, rev: rev1, generic: { body: "x" } }), (e) => e.code === "E_REV_CONFLICT");
});

test("ACC-v3-edit-02/08：通用文案超过跟通用平台的限制拒绝、不截断；入库时就有的问题不拦无关保存；通用标题不能空", () => {
  const f = fixture();
  const long = "一二三四五六七八九十一二三四五六七八九十一"; // 21 字，小红书标题限 20
  assert.throws(
    () => h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, generic: { title: long } }),
    (e) => e.code === "E_COPY_LIMIT" && e.problems.some((p) => p.platform === "xiaohongshu"),
  );
  assert.equal(f.copyOf("xiaohongshu").title, "通用标题", "没有被截断存上");
  assert.throws(() => h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, generic: { title: "  " } }), /标题 不能为空|不能为空/);

  // 给小红书单独写短标题后，通用标题再长也不影响它。
  h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.xiaohongshu]: { title: "小红书短标题" } } });
  h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, generic: { title: long } });
  assert.equal(f.copyOf("xiaohongshu").title, "小红书短标题");

  // 入库时就超限的平台稿（模拟：直接写库），只改别的字段不被拦。
  core.open().prepare("UPDATE publish SET overrides_json = ? WHERE id = ?").run(JSON.stringify({ title: long }), f.pub.xiaohongshu);
  h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, generic: { body: "只改正文" } });
  assert.equal(f.copyOf("xiaohongshu").body, "只改正文");
});

test("ACC-v3-edit-06：已确认、还没发的（按时间发的）也能改，保存后仍已确认、仍按原来的时间发；发出去的和正在发的不能改", () => {
  const f = fixture();
  h["publish.approve"]({ publishId: f.pub.bilibili });
  const before = store.getPublish(f.pub.bilibili);
  assert.equal(before.state, "queued");
  const runBefore = core.open().prepare("SELECT run_after FROM run WHERE target_id = ?").get(f.pub.bilibili);

  const done = h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.bilibili]: { title: "确认后改的标题" } } });
  const after = store.getPublish(f.pub.bilibili);
  assert.equal(after.state, "queued", "仍是已确认");
  assert.equal(after.scheduled_at, before.scheduled_at, "仍按原来的时间发");
  assert.equal(core.open().prepare("SELECT run_after FROM run WHERE target_id = ?").get(f.pub.bilibili).run_after, runBefore.run_after);
  assert.equal(f.copyOf("bilibili").title, "确认后改的标题");
  assert.equal(done.note, "已确认的仍按原来的时间发");

  // 通用文案改动也跟到已确认的平台稿，且不动它的时间。
  h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, generic: { body: "通用正文改了" } });
  assert.equal(f.copyOf("bilibili").body, "通用正文改了");
  assert.equal(store.getPublish(f.pub.bilibili).scheduled_at, before.scheduled_at);

  // 正在发（现在发）和已发出去的不能改。
  const now = h["publish.approve"]({ publishId: f.pub.xiaohongshu, when: "now" });
  assert.equal(now.approved[0].state, "queued");
  assert.throws(() => h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.xiaohongshu]: { title: "晚了" } } }), /不能改/);
  core.open().prepare("UPDATE publish SET state = 'published' WHERE id = ?").run(f.pub.bilibili);
  assert.throws(() => h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.bilibili]: { title: "晚了" } } }), /已经发出去了/);
});

test("ACC-v3-edit-07：Claude 再次入库同一个作品，不覆盖人改过的字段，没改过的照常更新", () => {
  const f = fixture();
  h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, generic: { title: "人改的标题" } });
  const again = f.ingest({ title: "Claude 又写的标题", body: "Claude 新写的正文", tags: ["新话题"], bilibili: { title: "B站专属标题" } });
  assert.equal(again.existed, true);
  const row = core.open().prepare("SELECT meta_json, edited_fields FROM cut_version WHERE cut_id = ?").get(f.cut().id);
  const def = JSON.parse(row.meta_json).copy.default;
  assert.equal(def.title, "人改的标题", "人改过的字段保留");
  assert.equal(def.body, "Claude 新写的正文", "没改过的字段照常更新");
  assert.deepEqual(def.tags, ["新话题"]);
  assert.deepEqual(JSON.parse(row.edited_fields), ["title"]);
  assert.equal(f.copyOf("xiaohongshu").title, "人改的标题");
  assert.equal(f.copyOf("xiaohongshu").body, "Claude 新写的正文");
});

test("ACC-v3-time-01：现在发 / 预约发二选一；现在发没有时间字段，建议时间过期也不报错", () => {
  const f = fixture();
  core.open().prepare("UPDATE publish SET scheduled_at = ? WHERE id = ?").run(Date.now() - 5 * HOUR, f.pub.bilibili);
  assert.throws(() => h["publish.approve"]({ cutId: f.cut().id, when: "later" }), /scheduled（预约发）或 now（现在发）/);
  const r = h["publish.approve"]({ cutId: f.cut().id, when: "now" });
  assert.equal(r.when, "now");
  assert.equal(r.approved.length, 1, "小红书逐条决定，不被整支带上");
  assert.equal(r.approved[0].platform, "bilibili");
  const row = store.getPublish(f.pub.bilibili);
  assert.equal(row.state, "queued");
  assert.ok(row.scheduled_at <= Date.now() + 1000, "现在发 = 马上排，不看旧的建议时间");
  assert.equal(r.approved[0].runAfter, null);
  assert.equal(store.getPublish(f.pub.xiaohongshu).state, "pending_confirm");
});

test("ACC-v3-time-02：只改文案的保存不提交时间——建议时间已过的待确认平台稿，只改标题能保存成功", () => {
  const f = fixture();
  core.open().prepare("UPDATE publish SET scheduled_at = ? WHERE id = ?").run(Date.now() - 2 * HOUR, f.pub.bilibili);
  const done = h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.bilibili]: { title: "只改标题" } } });
  assert.equal(f.copyOf("bilibili").title, "只改标题");
  assert.equal(done.publishes[0].changes.at, undefined);
  assert.ok(store.getPublish(f.pub.bilibili).scheduled_at < Date.now(), "没提交时间，库里的时间不动");
  h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, generic: { body: "只改通用" } });
});

test("ACC-v3-time-03：过期的建议时间读出来时顺延并带原定时间；确认不会因为时间过期而失败", () => {
  const f = fixture();
  const original = Date.now() - 3 * HOUR;
  core.open().prepare("UPDATE publish SET scheduled_at = ? WHERE id = ?").run(original, f.pub.bilibili);
  const shown = f.cut().publishes.find((p) => p.platform === "bilibili");
  assert.equal(shown.shifted, true);
  assert.equal(shown.originalAt, original);
  assert.ok(shown.scheduledAt > Date.now(), "读出来是将来的、合规的时间");
  assert.equal(store.getPublish(f.pub.bilibili).scheduled_at, original, "读出来不写库");
  // 没过期的原样，不带顺延标记。
  const fine = f.cut().publishes.find((p) => p.platform === "xiaohongshu");
  assert.equal(fine.shifted, undefined);

  const done = h["publish.approve"]({ cutId: f.cut().id });
  const a = done.approved.find((x) => x.platform === "bilibili");
  assert.equal(a.shifted, true);
  assert.equal(a.originalAt, original);
  assert.equal(store.getPublish(f.pub.bilibili).scheduled_at, a.scheduledAt, "确认时把顺延后的时间存下来");
  assert.equal(store.getPublish(f.pub.bilibili).state, "queued");
});

test("ACC-v3-time-03：顺延守平台规则（最小间隔）", () => {
  const f = fixture();
  const taken = Date.now() + 60e3;
  // 同账号另一条已占着「一分钟后」，顺延不能落在它的最小间隔内。
  const other = store.createWork({ title: `占位 ${seq}`, assetPath: "/tmp/x.mp4" });
  store.createPublish({ workId: other.id, accountId: f.bili.id, scheduledAt: taken });
  core.open().prepare("UPDATE publish SET scheduled_at = ? WHERE id = ?").run(Date.now() - HOUR, f.pub.bilibili);
  const shown = f.cut().publishes.find((p) => p.platform === "bilibili");
  assert.ok(Math.abs(shown.scheduledAt - taken) >= 10 * 60e3, `顺延后的时间离已排的至少 10 分钟：${shown.scheduledAt - taken}`);
});

test("ACC-v3-time-04：预约的时间选到过去或碰到平台规则，说原因和最近能排的时间", () => {
  const f = fixture();
  const err = (() => {
    try {
      h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.bilibili]: { at: Date.now() - HOUR } } });
    } catch (e) {
      return e;
    }
  })();
  assert.equal(err.code, "E_TIME_PAST");
  assert.match(err.message, /已经过去了；最近能排：(今天|明天) \d\d:\d\d/);
  assert.ok(err.suggestedAt > Date.now());

  // 合规的未来时间可以改，且和文案一起提交。
  const at = Date.now() + 5 * HOUR;
  const ok = h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.bilibili]: { at, title: "改时间也改标题" } } });
  assert.equal(ok.publishes[0].scheduledAt, at);
  assert.equal(store.getPublish(f.pub.bilibili).scheduled_at, at);

  // 碰到最小间隔：和 B站这条（at）隔 1 分钟再放一条。
  const other = store.createWork({ title: `间隔 ${seq}`, assetPath: "/tmp/y.mp4" });
  const o = store.createPublish({ workId: other.id, accountId: f.bili.id, scheduledAt: at + 3 * HOUR });
  const gap = (() => {
    try {
      h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.bilibili]: { at: at + 3 * HOUR + 60e3 } } });
    } catch (e) {
      return e;
    }
  })();
  assert.equal(gap.code, "plan_min_gap");
  assert.match(gap.message, /最小间隔 10 分钟；最近能排：/);
  assert.ok(o.id);
});

test("ACC-v3-time-09：现在发照样过每日上限；小红书当天已发 1 条时选现在发，这条不发并说明原因，留在待确认", () => {
  updateConfig({ plan: { rules: { platforms: { xiaohongshu: { daily_cap: 1, min_gap_minutes: 10 } } } } });
  try {
    const f = fixture();
    // 小红书这个号今天已经发了 1 条。
    const earlier = store.createWork({ title: `已发 ${seq}`, assetPath: "/tmp/z.mp4" });
    const done = store.createPublish({ workId: earlier.id, accountId: f.red.id });
    core.open().prepare("UPDATE publish SET state = 'published', published_at = ? WHERE id = ?").run(Date.now() - 11 * 60e3, done.id);

    // 逐条现在发：抛出带原因的错误，状态不变。
    assert.throws(
      () => h["publish.now"]({ publishId: f.pub.xiaohongshu }),
      (e) => e.code === "plan_daily_cap" && /小红书 今天已经排了 1 条，每日上限 1 条/.test(e.message) && /最近能发：/.test(e.message),
    );
    assert.equal(store.getPublish(f.pub.xiaohongshu).state, "pending_confirm");
    assert.throws(() => h["publish.approve"]({ publishId: f.pub.xiaohongshu, when: "now" }), (e) => e.code === "plan_daily_cap");
    assert.equal(store.getPublish(f.pub.xiaohongshu).state, "pending_confirm");

    // 按成片整批现在发：B站照发，被拦的列在 held 里（写原因），不静默。B站没被牵连。
    core.open().prepare("UPDATE publish SET state = 'pending_confirm' WHERE id = ?").run(f.pub.xiaohongshu);
    const batch = h["publish.approve"]({ cutId: f.cut().id, when: "now" });
    assert.equal(batch.approved.length, 1);
    assert.equal(batch.approved[0].platform, "bilibili");
  } finally {
    updateConfig({ plan: { rules: { platforms: { xiaohongshu: null } } } });
  }
});

test("ACC-v3-time-09：整批现在发时，过不了的平台留在待确认并写原因和最近能发的时间；账号登录失效也不发", () => {
  updateConfig({ plan: { rules: { platforms: { bilibili: { daily_cap: 1, min_gap_minutes: 10 } } } } });
  try {
    const f = fixture();
    const earlier = store.createWork({ title: `B站已发 ${seq}`, assetPath: "/tmp/w.mp4" });
    const done = store.createPublish({ workId: earlier.id, accountId: f.bili.id });
    core.open().prepare("UPDATE publish SET state = 'published', published_at = ? WHERE id = ?").run(Date.now() - 11 * 60e3, done.id);
    const r = h["publish.approve"]({ cutId: f.cut().id, when: "now" });
    assert.equal(r.approved.length, 0);
    assert.equal(r.held.length, 1);
    assert.equal(r.held[0].platform, "bilibili");
    assert.equal(r.held[0].code, "plan_daily_cap");
    assert.match(r.held[0].reason, /每日上限 1 条.*最近能发：/);
    assert.ok(r.held[0].nextAt > Date.now());
    assert.equal(store.getPublish(f.pub.bilibili).state, "pending_confirm");
    assert.equal(core.open().prepare("SELECT COUNT(*) n FROM run WHERE target_id = ?").get(f.pub.bilibili).n, 0, "没排队，没发");
  } finally {
    updateConfig({ plan: { rules: { platforms: { bilibili: null } } } });
  }
  const g = fixture();
  core.open().prepare("UPDATE account SET state = 'expired' WHERE id = ?").run(g.bili.id);
  const r = h["publish.approve"]({ cutId: g.cut().id, when: "now" });
  assert.equal(r.held[0].code, "account_unusable");
  assert.match(r.held[0].reason, /已失效/);
  assert.equal(store.getPublish(g.pub.bilibili).state, "pending_confirm");
});

test("迁移：旧库补上 cut.rev / cut_version.edited_fields（只加不减，带 CHECK），幂等，旧数据不丢", () => {
  const oldHome = mkdtempSync(join(tmpdir(), "vk-cut-edit-migrate-"));
  const keep = process.env.VK_HOME;
  process.env.VK_HOME = oldHome;
  core.close();
  const { db } = core.ensureDirs();
  const legacy = new DatabaseSync(db);
  legacy.exec(`
    CREATE TABLE work (id TEXT PRIMARY KEY, title TEXT NOT NULL, asset_path TEXT NOT NULL, asset_sha TEXT, meta_json TEXT, created_at INTEGER NOT NULL, source TEXT);
    CREATE TABLE cut (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work(id) ON DELETE CASCADE, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE (work_id, title));
    CREATE TABLE cut_version (id TEXT PRIMARY KEY, cut_id TEXT NOT NULL REFERENCES cut(id) ON DELETE CASCADE, language TEXT NOT NULL, asset_path TEXT NOT NULL, asset_sha TEXT, meta_json TEXT, created_at INTEGER NOT NULL, UNIQUE (cut_id, language));
    INSERT INTO work (id, title, asset_path, created_at) VALUES ('w1','旧作品','/a.mp4',1);
    INSERT INTO cut (id, work_id, title, created_at) VALUES ('c1','w1','旧成片',1);
    INSERT INTO cut_version (id, cut_id, language, asset_path, meta_json, created_at) VALUES ('v1','c1','zh','/a.mp4','{"copy":{"default":{"title":"旧标题"}}}',1);
  `);
  legacy.close();

  core.migrate();
  core.migrate();
  const conn = core.open();
  assert.ok(conn.prepare("PRAGMA table_info(cut)").all().some((c) => c.name === "rev"));
  assert.ok(conn.prepare("PRAGMA table_info(cut_version)").all().some((c) => c.name === "edited_fields"));
  assert.equal(conn.prepare("SELECT rev FROM cut WHERE id = 'c1'").get().rev, 0);
  assert.equal(conn.prepare("SELECT edited_fields FROM cut_version WHERE id = 'v1'").get().edited_fields, null);
  assert.match(conn.prepare("SELECT meta_json FROM cut_version WHERE id = 'v1'").get().meta_json, /旧标题/);
  assert.throws(() => conn.prepare("UPDATE cut SET rev = -1 WHERE id = 'c1'").run(), /CHECK/);
  assert.throws(() => conn.prepare("UPDATE cut_version SET edited_fields = 'not json' WHERE id = 'v1'").run(), /CHECK/);
  // 旧库能直接用新命令改内容。
  const done = store.editCut({ cutId: "c1", rev: 0, generic: { title: "新标题" } });
  assert.equal(done.rev, 1);

  core.close();
  process.env.VK_HOME = keep;
});

// ---- #245：改内容的界面要读的东西（只增字段）
test("ACC-v3-edit-03/04：work.show 的语言版本带通用文案和各平台文案限制，数字只来自 COPY_LIMITS", () => {
  const f = fixture();
  const v = store.showWork(f.workId).cuts[0].versions[0];
  assert.deepEqual(v.generic, { title: "通用标题", body: "通用正文", tags: ["通用"] });
  assert.equal(v.copyLimit.bilibili.title, store.COPY_LIMITS.bilibili.title);
  assert.equal(v.copyLimit.xiaohongshu.title, store.COPY_LIMITS.xiaohongshu.title);
  assert.equal(v.copyLimit.tiktok, undefined, "这支成片没有 TikTok 平台稿，就不带它的限制");
  // 已有字段没动
  assert.ok(v.id && v.language === "zh" && "asset" in v);
});

test("ACC-v3-time-04：时间错误带 publishId，页面才知道是哪条平台稿的时间框", () => {
  const f = fixture();
  const err = (() => {
    try {
      h["cut.edit"]({ cutId: f.cut().id, rev: f.cut().rev, platforms: { [f.pub.bilibili]: { at: Date.now() - HOUR } } });
    } catch (e) {
      return e;
    }
  })();
  assert.equal(err.publishId, f.pub.bilibili);
});
