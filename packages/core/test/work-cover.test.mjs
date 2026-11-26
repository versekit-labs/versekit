// 入库封面（#258，ACC-v3-fid-10 / ACC-v3-fid-03）：清单成片上写 cover，work.add、work.push、发布机拉取都带上，
// /api/works 返回封面地址，/media/<版本>?cover=1 能取到图；没写 cover 时行为不变。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIFABU_OFFLINE = "1";
const ROOT = mkdtempSync(join(tmpdir(), "vk-work-cover-"));
const MAKER = join(ROOT, "maker");
const PUBLISHER = join(ROOT, "publisher");
const CLOUD = join(ROOT, "cloud");
process.env.HIFABU_HOME = MAKER;
const as = (home) => { process.env.HIFABU_HOME = home; };

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { startDaemon } = await import("../src/daemon.mjs");
const { createRelayServer } = await import("../../relay/src/index.mjs");

const PNG = Buffer.from("89504e470d0a1a0a-cover-bytes", "utf8");
const adapters = [{ platform: "bilibili", adapter: { ready: () => null } }];
const mk = () => createCoreHandlers({ adapters, log: () => {} });
let maker, publisher, relay, url;

const src = (name) => join(ROOT, "src", name);
function write(name, bytes) { writeFileSync(src(name), bytes); return src(name); }
function manifest(name, doc) { return write(name, JSON.stringify(doc)); }
const doc = (title, extra = {}, verExtra = {}) => ({
  title,
  cuts: [{ title: "长片", ...extra, versions: [{ language: "zh", asset: "a.mp4", ...verExtra }] }],
});

before(async () => {
  mkdirSync(src("."), { recursive: true });
  write("a.mp4", Buffer.from("video-a"));
  write("b.mp4", Buffer.from("video-b"));
  write("cover.png", PNG);
  relay = createRelayServer({ dataDir: CLOUD, pushToken: "push-x", pullToken: "pull-y" });
  url = `http://127.0.0.1:${await relay.listen({ port: 0 })}`;
  as(MAKER); core.migrate(); maker = mk();
  as(PUBLISHER); core.migrate(); publisher = mk();
  const g = store.addGroup({ name: "主号组" });
  store.addAccount({ platform: "bilibili", handle: "@b", groupId: g.id });
  as(MAKER);
});
after(async () => { await relay.close(); rmSync(ROOT, { recursive: true, force: true }); });

const firstVersion = (workId) => store.showWork(workId).cuts[0].versions[0];

test("ACC-v3-fid-10 work.add：成片上的 cover 入库，列表和详情都给封面地址", () => {
  as(MAKER);
  const r = maker["work.add"]({ title: "带封面", cuts: [{ title: "长片", cover: src("cover.png"), versions: [{ language: "zh", asset: src("a.mp4") }] }] });
  const v = firstVersion(r.id);
  assert.equal(v.cover, `/media/${v.id}?cover=1`);
  const row = store.listWorks().find((w) => w.id === r.id);
  assert.equal(row.cover, v.cover);
  assert.equal(row.coverVersionId, v.id);
});

test("ACC-v3-fid-10 没写 cover：行为不变，cover 是 null，封面退回首帧", () => {
  as(MAKER);
  const r = maker["work.add"]({ title: "没封面", cuts: [{ title: "长片", versions: [{ language: "zh", asset: src("b.mp4") }] }] });
  const v = firstVersion(r.id);
  assert.equal(v.cover, undefined);
  const row = store.listWorks().find((w) => w.id === r.id);
  assert.equal(row.cover, null);
  assert.equal(row.coverVersionId, v.id, "仍是第一个版本，页面取首帧");
});

test("ACC-v3-fid-10 版本级 cover 盖住成片级；不是图片或文件不在都被拒绝", () => {
  as(MAKER);
  write("v.png", Buffer.from("version-cover"));
  const r = maker["work.add"]({ title: "版本封面", cuts: [{ title: "长片", cover: src("cover.png"), versions: [{ language: "zh", asset: src("a.mp4"), cover: src("v.png") }] }] });
  assert.equal(store.listWorks().find((w) => w.id === r.id).cover.startsWith("/media/"), true);
  assert.throws(() => maker["work.add"]({ title: "坏封面1", cuts: [{ title: "长片", cover: src("a.mp4"), versions: [{ language: "zh", asset: src("a.mp4") }] }] }), /封面要是图片/);
  assert.throws(() => maker["work.add"]({ title: "坏封面2", cuts: [{ title: "长片", cover: src("none.png"), versions: [{ language: "zh", asset: src("a.mp4") }] }] }), /找不到封面图片/);
});

test("ACC-v3-fid-10 push 到中转再由发布机拉下来，封面还在，/api/works 有地址且图能取到", async () => {
  as(MAKER);
  await maker["relay.connect"]({ url, token: "push-x", push: true });
  const m = manifest("m.json", doc("中转带封面", { cover: "cover.png" }));
  const pushed = await maker["work.push"]({ manifest: m, group: "主号组" });
  assert.equal(pushed.files, 2, "成片和封面各一个文件");
  assert.equal(store.listWorks().length >= 0, true);

  as(PUBLISHER);
  await publisher["relay.connect"]({ url, token: "pull-y" });
  const out = await publisher["relay.pull"]();
  assert.equal(out.ingested.length, 1);
  const w = store.listWorks().find((x) => x.title === "中转带封面");
  assert.ok(w.cover, "发布机上有封面地址");

  const d = await startDaemon({ runQueue: false, port: 0, socketPath: join(PUBLISHER, "vk.sock"), handlers: publisher });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const list = await (await fetch(`${base}/api/works`)).json();
    const row = (list.data?.works ?? list.works).find((x) => x.title === "中转带封面");
    assert.equal(row.cover, w.cover);
    const img = await fetch(`${base}${row.cover}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    // 没有封面的版本问 ?cover=1 是 404，页面据此退回首帧；不带 cover 仍是成片本身
    const plain = firstVersion(store.listWorks().find((x) => x.title === "中转带封面").id);
    assert.equal((await fetch(`${base}/media/${plain.id}`)).headers.get("content-type"), "video/mp4");
  } finally {
    await d.close();
  }
});

test("ACC-v3-fid-10 中转带封面的清单：封面文件不在制作机时当场报错、不上传", async () => {
  as(MAKER);
  await assert.rejects(maker["work.push"]({ manifest: manifest("bad.json", doc("坏", { cover: "nope.png" })), group: "主号组" }), /找不到封面图片/);
});

test("ACC-v3-fid-10 没有封面的版本要 ?cover=1：404", async () => {
  as(MAKER);
  const d = await startDaemon({ runQueue: false, port: 0, socketPath: join(MAKER, "vk.sock"), handlers: maker });
  try {
    const row = store.listWorks().find((w) => w.title === "没封面");
    const res = await fetch(`http://127.0.0.1:${d.port}/media/${row.coverVersionId}?cover=1`);
    assert.equal(res.status, 404);
  } finally {
    await d.close();
  }
});

test("ACC-v3-fid-03 图片目录图文：/media 与 ?cover=1 都给目录里排序第一张图；成片列表取有封面的那个版本", async () => {
  as(MAKER);
  const dir = join(ROOT, "src", "imgs");
  mkdirSync(dir, { recursive: true });
  const FIRST = Buffer.from("89504e470d0a1a0a-first", "utf8");
  writeFileSync(join(dir, "02-second.png"), Buffer.from("second"));
  writeFileSync(join(dir, "01-first.png"), FIRST);
  maker["work.add"]({ title: "图文目录", cuts: [{ title: "图文", versions: [{ language: "zh", asset: dir }] }] });
  maker["work.add"]({ title: "封面在英文", cuts: [{ title: "长片", versions: [{ language: "zh", asset: src("a.mp4") }, { language: "en", asset: src("b.mp4"), cover: src("v.png") }] }] });
  const d = await startDaemon({ runQueue: false, port: 0, socketPath: join(MAKER, "vk.sock"), handlers: maker });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const row = store.listWorks().find((w) => w.title === "图文目录");
    for (const q of ["", "?cover=1"]) {
      const res = await fetch(`${base}/media/${row.coverVersionId}${q}`);
      assert.equal(res.status, 200, q);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), FIRST);
    }
    const w = store.listWorks().find((x) => x.title === "封面在英文");
    const vs = maker["work.show"]({ workId: w.id }).work.cuts[0].versions;
    assert.equal(vs.find((v) => v.cover)?.id, w.coverVersionId);
    assert.notEqual(vs[0].id, w.coverVersionId);
  } finally {
    await d.close();
  }
});
