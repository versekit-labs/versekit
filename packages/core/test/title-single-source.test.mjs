// issue #163 · ACC-v2-title-01
// 同一条平台稿的标题，workView、确认卡片、适配器三处必须是同一个值：
// 都来自 store.effectiveTitle（= resolvePublishCopy 交给适配器的 title），notify.mjs 不再自带回退链。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-title-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");

before(() => core.migrate());
after(() => core.close());

// 与 notify.mjs loadCut 同形的查询行：卡片就是拿这种行去算标题的。
const cardRow = (publishId) =>
  core
    .open()
    .prepare(
      `SELECT p.overrides_json, c.title AS cut_title, w.title AS work_title, w.meta_json AS work_meta_json, v.meta_json AS version_meta
         FROM publish p JOIN cut c ON c.id = p.cut_id JOIN work w ON w.id = p.work_id
         LEFT JOIN cut_version v ON v.id = p.version_id WHERE p.id = ?`,
    )
    .get(publishId);

test("ACC-v2-title-01 workView、确认卡片、适配器拿到的标题三者相等（含 copy.title、成片标题）", () => {
  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  const g = handlers["group.add"]({ name: "标题单源组" });
  const acc = handlers["account.add"]({ platform: "xiaohongshu", name: "@单源", group: g.name }).id;
  const asset = join(HOME, "a.mp4");
  writeFileSync(asset, "x");
  const w = store.upsertWork({ title: "作品标题", cuts: [{ title: "成片标题", versions: [{ language: "中文", asset }] }] });
  const cutId = store.showWork(w.id).cuts[0].id;
  const pub = store.createPublish({ workId: w.id, accountId: acc, cutId });
  const set = (overrides) => core.open().prepare("UPDATE publish SET overrides_json = ? WHERE id = ?").run(overrides && JSON.stringify(overrides), pub.id);

  const cases = [
    [null, "成片标题"], // 没有任何改写：成片标题先于作品标题
    [{ copy: { title: "生成平台稿时写的" } }, "生成平台稿时写的"], // vk plan apply 写入的
    [{ copy: { title: "生成平台稿时写的" }, title: "确认前改的" }, "确认前改的"], // 人改的优先
  ];
  for (const [overrides, expected] of cases) {
    set(overrides);
    const view = store.showWork(w.id).cuts[0].publishes[0].title;
    const card = store.effectiveTitle(cardRow(pub.id));
    const adapter = store.resolvePublishCopy(pub.id).title;
    assert.equal(adapter, expected);
    assert.equal(view, adapter, "workView 与适配器一致");
    assert.equal(card, adapter, "确认卡片与适配器一致");
  }
});

test("ACC-v2-title-01 notify.mjs 不再自带标题回退链", () => {
  const src = readFileSync(new URL("../src/notify.mjs", import.meta.url), "utf8");
  assert.ok(!/\browTitle\b/.test(src), "rowTitle 已删除");
  assert.match(src, /effectiveTitle/);
});
