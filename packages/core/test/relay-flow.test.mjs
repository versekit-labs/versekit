// 制作机 → 云端中转 → 发布机（#226，ACC-relay-02/03/04）。
// 制作机和发布机是两个临时 VK_HOME，中转是本机 127.0.0.1 上起的真服务；
// 不碰 volc1，不碰任何平台账号，视频是几个字节的假文件。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

process.env.VERSEKIT_OFFLINE = "1";
const ROOT = mkdtempSync(join(tmpdir(), "vk-relay-flow-"));
const MAKER = join(ROOT, "maker");
const PUBLISHER = join(ROOT, "publisher");
const CLOUD = join(ROOT, "cloud");
process.env.VK_HOME = MAKER;
const as = (home) => { process.env.VK_HOME = home; };

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { startDaemon } = await import("../src/daemon.mjs");
const { findCommand } = await import("../src/commands.mjs");
const { updateConfig, readConfig } = await import("../src/config.mjs");
const { createRelayServer } = await import("../../relay/src/index.mjs");

const PUSH = "push-secret-xyz";
const PULL = "pull-secret-abc";
const logs = [];
const adapters = [
  { platform: "bilibili", adapter: { ready: () => null } },
  { platform: "xiaohongshu", adapter: { ready: () => null } },
];
const mk = () => createCoreHandlers({ adapters, log: (l) => logs.push(String(l)) });
let maker, publisher, relay, url;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function video(name, bytes) {
  const path = join(ROOT, "src", name);
  writeFileSync(path, bytes);
  return path;
}
function manifestFile(name, doc) {
  const path = join(ROOT, "src", name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}
const goodDoc = (asset = "a.mp4") => ({
  title: "中转测试作品",
  cuts: [
    {
      title: "长片",
      copy: { bilibili: { title: "B站标题", body: "B站正文", tags: ["中转"] }, xiaohongshu: { title: "小红书标题", body: "小红书正文", tags: ["中转"] } },
      versions: [{ language: "zh", asset }],
    },
  ],
});
const cloudBlobs = () => readdirSync(join(CLOUD, "blobs"));
const cloudDeliveries = () => readdirSync(join(CLOUD, "deliveries"));

before(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(ROOT, "src"), { recursive: true });
  relay = createRelayServer({ dataDir: CLOUD, pushToken: PUSH, pullToken: PULL });
  url = `http://127.0.0.1:${await relay.listen({ port: 0 })}`;

  as(MAKER);
  core.migrate();
  maker = mk();
  as(PUBLISHER);
  core.migrate();
  publisher = mk();
  const g = store.addGroup({ name: "主号组" });
  store.addAccount({ platform: "bilibili", handle: "@b", groupId: g.id });
  store.addAccount({ platform: "xiaohongshu", handle: "@x", groupId: g.id });
  store.addGroup({ name: "空组" });
  as(MAKER);
});
after(async () => {
  await relay.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const works = (home) => { as(home); return store.listWorks(); };

test("ACC-relay-02 work.push / relay.* 都在命令表里（三端一致），--group 必填", () => {
  for (const name of ["work.push", "relay.status", "relay.connect", "relay.pull"]) assert.ok(findCommand(name), name);
  assert.equal(findCommand("work.push").http.method, "POST");
});

test("ACC-relay-02 没配中转时 push 说人话；connect 校验 token 种类，写配置权限 600，token 不进日志", async () => {
  as(MAKER);
  const m = manifestFile("m0.json", goodDoc());
  video("a.mp4", Buffer.from("aaaa"));
  await assert.rejects(maker["work.push"]({ manifest: m, group: "主号组" }), /还没有配置中转/);

  // 拉取 token 当推送 token 用：拒绝
  await assert.rejects(maker["relay.connect"]({ url, token: PULL, push: true }), /拉取 token/);
  await assert.rejects(maker["relay.connect"]({ url, token: "wrong", push: true }), /不认这个 token/);
  assert.equal(readConfig().relay, undefined, "没连成功就不写配置");

  const r = await maker["relay.connect"]({ url: `${url}/`, token: PUSH, push: true });
  assert.equal(r.connected, true);
  assert.ok(!JSON.stringify(r).includes(PUSH));
  assert.equal(readConfig().relay.url, url, "地址去掉结尾斜杠");
  assert.equal(statSync(core.paths().configFile).mode & 0o777, 0o600);
  assert.ok(!logs.some((l) => l.includes(PUSH) || l.includes(PULL)), "token 不进日志");
});

test("ACC-relay-02 清单不合格当场报错、不上传（云端一个字节都没有）", async () => {
  as(MAKER);
  const before = [cloudBlobs().length, cloudDeliveries().length];
  const cases = [
    [manifestFile("bad1.json", goodDoc("不存在.mp4")), /找不到成片/],
    [manifestFile("bad2.json", { ...goodDoc(), cuts: [{ title: "长片", copy: { 微博: { title: "x" } }, versions: [{ language: "zh", asset: "a.mp4" }] }] }), /不认识的平台/],
    [manifestFile("bad3.json", { ...goodDoc(), cuts: [{ title: "长片", copy: { xiaohongshu: { title: "这个标题肯定超过了小红书的二十个字的限制所以要被拒绝" } }, versions: [{ language: "zh", asset: "a.mp4" }] }] }), /小红书/],
    [manifestFile("bad4.json", { title: "没有成片", cuts: [] }), /至少要有一支成片/],
    [join(ROOT, "src", "nope.json"), /找不到清单/],
  ];
  for (const [manifest, re] of cases) await assert.rejects(maker["work.push"]({ manifest, group: "主号组" }), re);
  await assert.rejects(maker["work.push"]({ manifest: manifestFile("ok.json", goodDoc()), group: " " }), /--group/);
  assert.deepEqual([cloudBlobs().length, cloudDeliveries().length], before);
});

let deliveryId;
test("ACC-relay-02 push 成功：输出投递 id 和「等发布机拉取」，制作机本地不建作品", async () => {
  as(MAKER);
  const r = await maker["work.push"]({ manifest: manifestFile("good.json", goodDoc()), group: "主号组" });
  deliveryId = r.id;
  assert.match(r.id, /^dl_[0-9a-f]+$/);
  assert.match(r.message, /等发布机拉取/);
  assert.equal(r.files, 1);
  assert.equal(store.listWorks().length, 0, "制作机本地不建作品");
  assert.ok(cloudBlobs().includes(sha(Buffer.from("aaaa"))));
  const d = JSON.parse(readFileSync(join(CLOUD, "deliveries", `${deliveryId}.json`)));
  assert.equal(d.state, "pending");
  assert.equal(d.group, "主号组");
});

test("ACC-relay-03 发布机 connect 后 pull：下载、核对、入库，平台稿全部待确认，回报「已入库」", async () => {
  as(PUBLISHER);
  assert.equal(publisher["relay.status"]().connection, "not_configured");
  await assert.rejects(publisher["relay.pull"](), /还没有连中转/);
  await assert.rejects(publisher["relay.connect"]({ url, token: PUSH }), /推送 token/);
  await publisher["relay.connect"]({ url, token: PULL });

  const r = await publisher["relay.pull"]();
  assert.deepEqual(r.ingested, [deliveryId]);
  const list = store.listWorks();
  assert.equal(list.length, 1);
  const w = store.showWork(list[0].id);
  assert.equal(w.title, "中转测试作品");
  const pubs = w.cuts.flatMap((c) => c.publishes);
  assert.deepEqual(pubs.map((p) => p.platform).sort(), ["bilibili", "xiaohongshu"]);
  assert.ok(pubs.every((p) => p.state === "pending_confirm"), "一律待确认");
  assert.equal(pubs.find((p) => p.platform === "bilibili").title, "B站标题", "文案跟着清单走");
  // 文件落在发布机本地、哈希一致
  const asset = w.cuts[0].versions[0].asset;
  assert.ok(asset.startsWith(join(PUBLISHER, ".local", "state", "versekit", "relay-inbox")));
  assert.equal(sha(readFileSync(asset)), sha(Buffer.from("aaaa")));
  // 回报了「已入库」
  assert.equal(JSON.parse(readFileSync(join(CLOUD, "deliveries", `${deliveryId}.json`))).state, "ingested");
  // 没有任何发布任务被排进队列：没确认的到时间也不会发
  assert.equal(core.open().prepare("SELECT COUNT(*) n FROM run WHERE kind='publish'").get().n, 0);
  assert.equal(core.open().prepare("SELECT COUNT(*) n FROM publish WHERE state != 'pending_confirm'").get().n, 0);
});

test("ACC-relay-04 新作品出现在「今天」等确认；vk relay status 给出连接状态与上次拉取时间", async () => {
  as(PUBLISHER);
  const today = publisher["today"]({});
  assert.ok(JSON.stringify(today).includes("中转测试作品"));
  const s = publisher["relay.status"]();
  assert.equal(s.connection, "ok");
  assert.equal(s.configured, true);
  assert.ok(s.lastPullAt > Date.now() - 60e3);
  assert.equal(s.intervalMinutes, 5);
  assert.deepEqual(s.downloading, []);
  assert.equal(s.recent[0].state, "ingested");
  assert.ok(!JSON.stringify(s).includes(PULL), "状态里没有 token");
});

test("ACC-relay-03 同一投递 id 只入库一次：重复拉取、中转状态丢了、服务重启都不重复", async () => {
  as(PUBLISHER);
  await publisher["relay.pull"]();
  assert.equal(store.listWorks().length, 1, "重复拉取");

  // 模拟「回报没送到」：中转还把它当待拉取
  const f = join(CLOUD, "deliveries", `${deliveryId}.json`);
  const d = JSON.parse(readFileSync(f));
  writeFileSync(f, JSON.stringify({ ...d, state: "pending", ingested_at: undefined }));
  const restarted = mk(); // 服务重启 = 新的 handlers，记录在库里
  const r = await restarted["relay.pull"]();
  assert.deepEqual(r.skipped, [deliveryId]);
  assert.equal(store.listWorks().length, 1, "没有重复作品");
  assert.equal(core.open().prepare("SELECT COUNT(*) n FROM publish").get().n, 2, "没有重复平台稿");
  assert.equal(JSON.parse(readFileSync(f)).state, "ingested", "补报了「已入库」");
});

test("ACC-relay-03 组不存在：不入库，系统页「最近出的问题」有人话原因，回报中转「失败」", async () => {
  as(MAKER);
  video("g.mp4", Buffer.from("gggg"));
  const r = await maker["work.push"]({ manifest: manifestFile("g.json", { ...goodDoc("g.mp4"), title: "没有这个组" }), group: "不存在的组" });
  as(PUBLISHER);
  const before = store.listWorks().length;
  const out = await publisher["relay.pull"]();
  assert.equal(out.failed.length, 1);
  assert.equal(store.listWorks().length, before, "不入库");
  const s = publisher["relay.status"]();
  assert.match(s.failures[0].message, /没有账号组「不存在的组」/);
  assert.equal(s.failures[0].id, r.id);
  assert.equal(JSON.parse(readFileSync(join(CLOUD, "deliveries", `${r.id}.json`))).state, "failed");
  assert.match(JSON.parse(readFileSync(join(CLOUD, "deliveries", `${r.id}.json`))).reason, /没有账号组/);
  // 再拉一轮不会反复失败、反复入库
  await publisher["relay.pull"]();
  assert.equal(publisher["relay.status"]().failures.length, 1);
});

test("ACC-relay-03 空账号组 / 清单不合法：同样不入库并回报失败", async () => {
  as(MAKER);
  video("e.mp4", Buffer.from("eeee"));
  const empty = await maker["work.push"]({ manifest: manifestFile("e.json", { ...goodDoc("e.mp4"), title: "空组作品" }), group: "空组" });
  // 清单不合法：绕过制作机的校验，直接往中转投一条坏清单
  const blob = sha(Buffer.from("eeee"));
  const badId = "dl_" + "b".repeat(16);
  const res = await fetch(`${url}/v1/deliveries`, {
    method: "POST",
    headers: { authorization: `Bearer ${PUSH}`, "content-type": "application/json" },
    body: JSON.stringify({ id: badId, group: "主号组", manifest: { title: "坏清单", cuts: [{ title: "长片", copy: { 微博: { title: "x" } }, versions: [{ language: "zh", asset: `blob:${blob}` }] }] }, blobs: [{ sha256: blob, size: 4, name: "e.mp4" }] }),
  });
  assert.equal(res.status, 201);
  as(PUBLISHER);
  const before = store.listWorks().length;
  const out = await publisher["relay.pull"]();
  assert.equal(out.failed.length, 2);
  assert.equal(store.listWorks().length, before);
  const f = publisher["relay.status"]().failures;
  assert.ok(f.some((x) => x.id === empty.id && /还没有账号/.test(x.message)));
  assert.ok(f.some((x) => x.id === badId && /不认识的平台/.test(x.message)));
});

/** 一个假中转：列表里的文件内容和声明的 sha256 对不上；或者慢速下载，给进度用。 */
function fakeRelay({ bytes, declared, slowMs = 0, id }) {
  const server = createServer((req, res) => {
    if (req.url.startsWith("/v1/deliveries/") && req.method === "POST") {
      req.resume();
      res.setHeader("content-type", "application/json");
      return res.end("{}");
    }
    if (req.url.startsWith("/v1/deliveries")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ deliveries: [{ id, group: "主号组", state: "pending", manifest: { title: "假作品", cuts: [{ title: "长片", versions: [{ language: "zh", asset: `blob:${declared}` }] }] }, blobs: [{ sha256: declared, size: bytes.length, name: "x.mp4" }] }] }));
    }
    res.writeHead(200, { "content-length": bytes.length });
    let i = 0;
    const step = Math.ceil(bytes.length / 8);
    const tick = () => {
      if (i >= bytes.length) return res.end();
      res.write(bytes.subarray(i, i + step));
      i += step;
      setTimeout(tick, slowMs);
    };
    tick();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test("ACC-relay-03 哈希不符：不入库，写人话原因", async () => {
  const bytes = Buffer.from("actual-bytes-differ");
  const fake = await fakeRelay({ bytes, declared: sha(Buffer.from("declared-bytes")), id: "dl_" + "c".repeat(16) });
  try {
    as(PUBLISHER);
    updateConfig({ relay: { url: fake.url } });
    const before = store.listWorks().length;
    const out = await publisher["relay.pull"]();
    assert.equal(out.failed.length, 1);
    assert.match(out.failed[0].reason, /sha256 不符/);
    assert.equal(store.listWorks().length, before);
    assert.match(publisher["relay.status"]().failures[0].message, /x\.mp4.*校验不过/);
  } finally {
    fake.server.closeAllConnections?.();
    fake.server.close();
    updateConfig({ relay: { url } });
  }
});

test("ACC-relay-04 下载中：系统页/状态里看得见正在下载的投递和进度；下载不阻塞别的请求", async () => {
  const bytes = Buffer.alloc(80_000, 3);
  const fake = await fakeRelay({ bytes, declared: sha(bytes), slowMs: 60, id: "dl_" + "d".repeat(16) });
  try {
    as(PUBLISHER);
    updateConfig({ relay: { url: fake.url } });
    const pulling = publisher["relay.pull"]();
    let seen = null;
    for (let i = 0; i < 100 && !seen; i++) {
      await sleep(20);
      const d = publisher["relay.status"]().downloading[0];
      if (d && d.percent > 0 && d.percent < 100) seen = d;
    }
    assert.ok(seen, "下载过程中能读到进度");
    assert.equal(seen.name, "x.mp4");
    assert.ok(publisher["relay.status"]().pulling);
    assert.ok(typeof publisher["today"]({}) === "object", "后台下载时别的命令照常响应");
    assert.equal(publisher["relay.status"]().round.total, 1, "状态里有这一轮的投递数");
    assert.equal(publisher["relay.status"]().round.items[0].state, "downloading");
    await pulling;
    assert.deepEqual(publisher["relay.status"]().downloading, []);
    const rd = publisher["relay.status"]().round;
    assert.ok(rd.finishedAt);
    assert.ok(["ingested", "failed"].includes(rd.items[0].state), "ACC-relay-06 结束后留着每个投递的结果");
  } finally {
    fake.server.closeAllConnections?.();
    fake.server.close();
    updateConfig({ relay: { url } });
  }
});

test("ACC-relay-03 守护进程后台自动拉取：不用手动 pull，入库自己发生", async () => {
  as(MAKER);
  video("bg.mp4", Buffer.from("background-bytes"));
  const r = await maker["work.push"]({ manifest: manifestFile("bg.json", { ...goodDoc("bg.mp4"), title: "后台拉取作品" }), group: "主号组" });
  as(PUBLISHER);
  process.env.VERSEKIT_RELAY_START_DELAY_MS = "30";
  const daemon = await startDaemon({ handlers: mk(), port: 0, socketPath: join(ROOT, "d.sock"), runQueue: false, offline: true });
  try {
    // 等状态落定再断言：入库和回报「已入库」不是同一刻发生，不靠固定时长
    const stateOf = () => JSON.parse(readFileSync(join(CLOUD, "deliveries", `${r.id}.json`))).state;
    for (let i = 0; i < 400 && stateOf() !== "ingested"; i++) await sleep(30);
    assert.ok(store.listWorks().some((w) => w.title === "后台拉取作品"), "后台拉取入库了");
    assert.equal(stateOf(), "ingested");
  } finally {
    delete process.env.VERSEKIT_RELAY_START_DELAY_MS;
    await daemon.close();
  }
});

test("ACC-relay-04 系统页「发布机」一块显示中转，「最近出的问题」显示没入库的投递", () => {
  const html = readFileSync(new URL("../../web/public/system.html", import.meta.url), "utf8");
  assert.match(html, /\/api\/relay/);
  assert.match(html, /relayRows\(\)/);
  assert.match(html, /上次拉取/);
  assert.match(html, /正在下载/);
  assert.match(html, /ui\.relay\?\.failures/);
  assert.match(html, /vk relay status/);
});
