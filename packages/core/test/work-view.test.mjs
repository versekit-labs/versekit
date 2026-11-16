// issue #149 · ACC-v2-web-04 的数据面：work.show 的平台稿带 publishedAt 与和平时比的倍数，
// work.list 带平台列表与封面 versionId，且都按账号组过滤。只用临时库和假数据。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-workview-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
after(() => core.close());

const handlers = createCoreHandlers({ adapters: ["tiktok", "bilibili"].map((platform) => ({ platform })), log: () => {} });
const asset = join(HOME, "a.mp4");
writeFileSync(asset, "fake video");
const DAY = 24 * 3600e3;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
let seq = 0;
core.migrate();
const conn = () => core.open();

function insertPublish({ workId, cutId, accountId, state = "published", publishedAt = null, play = null }) {
  const pid = `pub_wv${++seq}`;
  conn()
    .prepare(
      `INSERT INTO publish (id, work_id, account_id, state, published_at, cut_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(pid, workId, accountId, state, publishedAt, cutId, 1 + seq, 1 + seq);
  if (play != null) {
    conn()
      .prepare("INSERT INTO snapshot (id, publish_id, captured_at, source, status, metrics_json) VALUES (?,?,?,?,?,?)")
      .run(`snap_wv${++seq}`, pid, publishedAt + DAY, "api", "ok", JSON.stringify({ play }));
  }
  return pid;
}
const newWork = (title) =>
  handlers["work.add"]({ title, source: join(HOME, `${title}.json`), cuts: [{ title, versions: [{ language: "zh", asset }] }] });

test("ACC-v2-web-04 work.show：发过的平台稿带 publishedAt 与倍数，数据不足的给 reason，没发的不带倍数", () => {
  const g = handlers["group.add"]({ name: "视图组" });
  const acc = handlers["account.add"]({ platform: "tiktok", name: "@wv", group: g.name }).id;
  const acc2 = handlers["account.add"]({ platform: "bilibili", name: "@wv2", group: g.name }).id;
  const g3 = handlers["group.add"]({ name: "视图组三" });
  const acc3 = handlers["account.add"]({ platform: "tiktok", name: "@wv3", group: g3.name }).id;
  for (let i = 0; i < 6; i++) {
    const hist = newWork(`历史${i}`);
    const hcut = conn().prepare("SELECT id FROM cut WHERE work_id = ?").get(hist.id).id;
    insertPublish({ workId: hist.id, cutId: hcut, accountId: acc, publishedAt: NOW - (20 - i) * DAY, play: 1000 });
  }
  const w = newWork("主角");
  const cut = conn().prepare("SELECT id FROM cut WHERE work_id = ?").get(w.id).id;
  const hit = insertPublish({ workId: w.id, cutId: cut, accountId: acc, publishedAt: NOW - 5 * DAY, play: 3000 });
  const fresh = insertPublish({ workId: w.id, cutId: cut, accountId: acc2, publishedAt: NOW - 1000 });
  const waiting = insertPublish({ workId: w.id, cutId: cut, accountId: acc3, state: "pending_confirm" });

  const shown = handlers["work.show"]({ workId: w.id, group: g.name }).work;
  const other = handlers["work.show"]({ workId: w.id, group: g3.name }).work;
  const by = Object.fromEntries([...shown.cuts[0].publishes, ...other.cuts[0].publishes].map((p) => [p.id, p]));
  assert.equal(by[hit].multiple, 3);
  assert.equal(by[hit].publishedAt, NOW - 5 * DAY);
  assert.equal(by[hit].verdictLabel, "比平时好");
  assert.equal(by[fresh].multiple, null);
  assert.match(by[fresh].reason, /24 小时/);
  assert.equal("multiple" in by[waiting], false, "没发过的不带倍数字段");
  assert.equal(by[waiting].publishedAt, null);
  assert.equal("accountId" in by[hit], false, "accountId 是内部键，不外泄");

  const listed = handlers["work.list"]({ group: g.name }).works.find((x) => x.id === w.id);
  assert.deepEqual(listed.platformList.map((p) => p.platform), ["tiktok", "bilibili"]);
  assert.equal(listed.coverVersionId, shown.cuts[0].versions[0].id);
  assert.deepEqual(listed.compared.map((c) => [c.publishId, c.multiple]), [[hit, 3]]);
});

test("ACC-v2-web-04 work.list 的平台列表和倍数按账号组过滤，不带别的组的", () => {
  const g1 = handlers["group.add"]({ name: "甲组" });
  const g2 = handlers["group.add"]({ name: "乙组" });
  const a1 = handlers["account.add"]({ platform: "tiktok", name: "@jia", group: g1.name }).id;
  const a2 = handlers["account.add"]({ platform: "bilibili", name: "@yi", group: g2.name }).id;
  const w = newWork("跨组");
  const cut = conn().prepare("SELECT id FROM cut WHERE work_id = ?").get(w.id).id;
  insertPublish({ workId: w.id, cutId: cut, accountId: a1, publishedAt: NOW - 3 * DAY });
  insertPublish({ workId: w.id, cutId: cut, accountId: a2, publishedAt: NOW - 3 * DAY });
  const jia = handlers["work.list"]({ group: g1.name }).works.find((x) => x.id === w.id);
  assert.deepEqual(jia.platformList.map((p) => p.platform), ["tiktok"]);
  const yi = handlers["work.list"]({ group: g2.name }).works.find((x) => x.id === w.id);
  assert.deepEqual(yi.platformList.map((p) => p.platform), ["bilibili"]);
});
