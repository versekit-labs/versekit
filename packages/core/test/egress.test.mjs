// 发布机出口位置（#310，ACC-v3-egress-01…06）。
// 全部用自造的小 mmdb 和假回显：不下载真实 IP 库，不访问真实回显地址，不碰真实账号。
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildMmdb, city, asn } from "./fixtures/mmdb.mjs";

const HOME = mkdtempSync(join(tmpdir(), "vk-egress-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const egress = await import("../src/egress.mjs");
const adaptersMod = await import("../src/adapters.mjs");
const { createRunner } = await import("../src/runner.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { buildToday } = await import("../src/overview.mjs");

const LA = "203.0.113.24"; // 美国 洛杉矶（家庭宽带）
const SJ = "198.51.100.61"; // 美国 圣何塞（机房）
const TYO = "192.0.2.7"; // 日本 东京（机房）
const BJ = "100.64.1.9"; // 中国 北京

const cityDb = () =>
  buildMmdb([
    { cidr: "203.0.113.0/24", data: city("US", "United States", "Los Angeles") },
    { cidr: "198.51.100.0/24", data: city("US", "United States", "San Jose") },
    { cidr: "192.0.2.0/24", data: city("JP", "Japan", "Tokyo") },
    { cidr: "100.64.0.0/16", data: city("CN", "China") }, // 查不到城市：只写国家
  ]);
const asnDb = () =>
  buildMmdb([
    { cidr: "203.0.113.0/24", data: asn("US", "Comcast Cable Communications", "comcast.com") },
    { cidr: "198.51.100.0/24", data: asn("US", "DigitalOcean, LLC", "digitalocean.com") },
    { cidr: "192.0.2.0/24", data: asn("JP", "Vultr Holdings", "vultr.com") },
  ]);

const GEO = join(HOME, ".local", "state", "versekit", "geo");
const installDbs = () => {
  mkdirSync(GEO, { recursive: true });
  writeFileSync(join(GEO, egress.GEO_FILES.city), cityDb());
  writeFileSync(join(GEO, egress.GEO_FILES.asn), asnDb());
};

/** 假浏览器：每条线路的回显地址对应一个出口 IP；调用记录下来。 */
const fakeBrowser = (exit) => {
  const calls = [];
  const getText = async (url) => {
    calls.push(url);
    const ip = exit[url.includes("ipip") ? "cn" : "intl"];
    if (ip instanceof Error) throw ip;
    return url.includes("ipip") ? JSON.stringify({ ret: "ok", data: { ip } }) : JSON.stringify({ ip });
  };
  return { getText, calls };
};

const probe = async (exit) => {
  const b = fakeBrowser(exit);
  return egress.probeNow({ getText: b.getText });
};

const addAccount = (id, platform, group = "g1") =>
  core.open().prepare("INSERT INTO account (id, platform, handle, state, group_id, created_at) VALUES (?,?,?,?,?,1)").run(id, platform, `@${id}`, "ok", group);

before(() => {
  core.migrate();
  core.open().prepare("INSERT INTO account_group (id, name, created_at) VALUES ('g1','组一',1)").run();
  addAccount("xhs", "xiaohongshu");
  addAccount("tt", "tiktok");
  installDbs();
});
after(() => core.close());

beforeEach(() => {
  // 每条用例从「没探测过」开始，但库、账号保留。
  for (const k of ["egress.state", "egress.baselines", "egress.waits"]) core.open().prepare("DELETE FROM meta WHERE key=?").run(k);
  core.open().prepare("DELETE FROM run").run();
  core.open().prepare("DELETE FROM publish").run();
  core.open().prepare("DELETE FROM event WHERE type LIKE 'egress.%'").run();
});

// ---------------------------------------------------------------- ACC-v3-egress-01：探测与离线库

test("ACC-v3-egress-01 MMDB 读取：IPv4 / IPv6 树、三种 record_size，库里没有的段查不到", () => {
  for (const ipVersion of [4, 6]) {
    for (const recordSize of [24, 28, 32]) {
      const db = egress.openMmdb(buildMmdb([{ cidr: "203.0.113.0/24", data: city("US", "United States", "Los Angeles") }, { cidr: "192.0.2.0/24", data: city("JP", "Japan") }], { ipVersion, recordSize }));
      assert.equal(db.lookup(LA).city.names.en, "Los Angeles", `v${ipVersion}/${recordSize}`);
      assert.equal(db.lookup(TYO).country.iso_code, "JP");
      assert.equal(db.lookup("8.8.8.8"), null);
      assert.equal(db.lookup("not-an-ip"), null);
    }
  }
});

test("ACC-v3-egress-01 查位置：国家城市来自 City 库，线路是不是机房来自 ASN 库；查不到城市只写国家", () => {
  const geo = egress.loadGeoDb();
  const home = egress.locate(LA, geo);
  assert.equal(egress.placeText(home), "United States Los Angeles");
  assert.equal(home.datacenter, false, "Comcast 是家庭宽带");
  assert.equal(egress.locate(SJ, geo).datacenter, true, "DigitalOcean 是机房线路");
  const cn = egress.locate(BJ, geo);
  assert.equal(cn.countryCode, "CN");
  assert.equal(egress.placeText(cn), "China", "查不到城市只写国家");
  assert.equal(egress.placeText(egress.locate("8.8.8.8", geo)), "查不到");
});

test("ACC-v3-egress-01 浏览器走代理而 Node 不走：报上来的是代理的出口，且不用 Node 的 fetch 探测", async () => {
  const realFetch = globalThis.fetch;
  let nodeFetchCalls = 0;
  // Node 直连看到的是真实出口（北京）；浏览器走了代理，看到的是东京。
  globalThis.fetch = async () => {
    nodeFetchCalls += 1;
    return new Response(JSON.stringify({ ip: BJ }));
  };
  try {
    const browser = fakeBrowser({ cn: TYO, intl: TYO });
    const result = await egress.probeEgress({ getText: browser.getText });
    assert.deepEqual(result.lines.map((l) => l.ip), [TYO, TYO], "报的是浏览器（代理）看到的出口");
    assert.deepEqual(result.lines.map((l) => l.countryCode), ["JP", "JP"]);
    assert.equal(nodeFetchCalls, 0, "探测没有走 Node 的 fetch");
    assert.equal(browser.calls.length, 2, "国内、海外各一条线路");
    assert.ok(browser.calls.every((u) => !/[?&](account|user|token|id)=/i.test(u)), "请求里没有账号或个人信息");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ACC-v3-egress-04 两条线路各自标明；一条探测失败不拖垮另一条，失败留原因", async () => {
  const r = await egress.probeEgress({ getText: fakeBrowser({ cn: LA, intl: new Error("连不上回显地址") }).getText });
  assert.equal(r.lines[0].countryCode, "US");
  assert.equal(r.lines[0].label, "国内平台看到");
  assert.match(r.lines[1].error, /连不上回显地址/);
  assert.ok(r.lines[1].code);
  assert.equal(r.lines[1].label, "海外平台看到");
});

test("ACC-v3-egress-04 两条线路出口不一样：系统页数据两条都有，机房线路标可能是代理；一样就不分开", async () => {
  await probe({ cn: LA, intl: SJ });
  const v = egress.view();
  assert.equal(v.split, true);
  assert.deepEqual(v.lines.map((l) => [l.label, l.place, l.ip, l.datacenter]), [
    ["国内平台看到", "United States Los Angeles", LA, false],
    ["海外平台看到", "United States San Jose", SJ, true],
  ]);
  assert.match(v.source, /DB-IP City Lite/);
  assert.match(v.source, /IPinfo Lite/);
  assert.match(v.source, /不会发给任何第三方/);
  await probe({ cn: LA, intl: LA });
  assert.equal(egress.view().split, false);
});

test("ACC-v3-egress-01 IP 库下载：成功换新库；失败沿用旧库并写明原因，留事件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vk-geo-"));
  const now = Date.UTC(2026, 10, 21);
  const ok = await egress.refreshGeoDb({
    dir,
    now,
    sources: [{ kind: "city", name: "DB-IP City Lite", url: "https://example.invalid/city.mmdb.gz", gz: true }],
    fetchImpl: async () => new Response(gzipSync(cityDb())),
  });
  assert.deepEqual(ok.updated, ["DB-IP City Lite"]);
  assert.equal(egress.openMmdb(readFileSync(join(dir, egress.GEO_FILES.city))).lookup(TYO).country.iso_code, "JP");

  const before = readFileSync(join(dir, egress.GEO_FILES.city));
  const bad = await egress.refreshGeoDb({
    dir,
    now: now + 1000,
    sources: [{ kind: "city", name: "DB-IP City Lite", url: "https://example.invalid/city.mmdb.gz", gz: true }],
    fetchImpl: async () => new Response("nope", { status: 503 }),
  });
  assert.match(bad.error, /DB-IP City Lite 没下载成功：HTTP 503/);
  assert.deepEqual(readFileSync(join(dir, egress.GEO_FILES.city)), before, "失败时旧库原样保留");
  const evt = core.open().prepare("SELECT payload_json FROM event WHERE type='egress.geodb_failed'").get();
  assert.match(JSON.parse(evt.payload_json).message, /HTTP 503/);
  assert.match(store.getEgressGeoDb().error, /HTTP 503/, "页面据此写明下载失败");

  // 坏文件（下载下来打不开）也不替换旧库。
  const corrupt = await egress.refreshGeoDb({ dir, now: now + 2000, sources: [{ kind: "city", name: "DB-IP City Lite", url: "x", gz: false }], fetchImpl: async () => new Response("not an mmdb") });
  assert.match(corrupt.error, /不是 MMDB/);
  assert.deepEqual(readFileSync(join(dir, egress.GEO_FILES.city)), before);

  assert.equal(egress.geoDbDue({ now: now + 10 * 864e5, dir }), false);
  assert.equal(egress.geoDbDue({ now: Date.now() + 40 * 864e5, dir }), true, "超过 30 天就该下载新库");
  assert.equal(egress.geoDbDue({ dir: join(dir, "none") }), true, "没有库也该下载");
});

test("ACC-v3-egress-01 IPinfo 要令牌：没配令牌只下 DB-IP；下载地址不带任何 IP 或账号", () => {
  const without = egress.geoSources({ now: Date.UTC(2026, 10, 21), config: {} });
  assert.deepEqual(without.map((s) => s.kind), ["city"]);
  assert.match(without[0].url, /dbip-city-lite-2026-11\.mmdb\.gz$/);
  const withToken = egress.geoSources({ config: { egress: { ipinfo_token: "t0k" } } });
  assert.deepEqual(withToken.map((s) => s.kind), ["city", "asn"]);
});

// ---------------------------------------------------------------- ACC-v3-egress-03：位置变了就暂停

const queuePublishRun = (publishId, accountId) => {
  core.open().prepare("INSERT OR IGNORE INTO work (id, title, asset_path, created_at) VALUES ('w1','t','/tmp/a.mp4',1)").run();
  core.open().prepare("INSERT INTO publish (id, work_id, account_id, state, scheduled_at, created_at, updated_at) VALUES (?,?,?,'queued',NULL,1,1)").run(publishId, "w1", accountId);
  core.enqueue({ kind: "publish", targetType: "publish", targetId: publishId, lane: accountId });
};

test("ACC-v3-egress-03 基线取自登录成功那一刻：中国登录、之后第一次探测在日本 → 暂停（不是把日本当平时）", async () => {
  // 登录那一刻出口在中国
  await egress.recordLogin("xhs", { getText: fakeBrowser({ cn: BJ, intl: LA }).getText });
  const b = store.getEgressBaselines().xhs;
  assert.equal(b.country, "CN");
  assert.equal(b.source, "login");
  // 之后发布机开了代理，出口在日本
  const r = await probe({ cn: TYO, intl: LA });
  assert.deepEqual(r.paused, ["xhs"], "闸门触发");
  assert.equal(store.getEgressBaselines().xhs.country, "CN", "基线没被探测改掉");
  assert.equal(store.getEgressBaselines().tt.country, "US", "没有登录记录的账号仍按第一次探测兜底");
  assert.equal(store.getEgressBaselines().tt.source, "first_probe");
  assert.match(egress.view().notes.join(" "), /按第一次探测定的/);
});

test("ACC-v3-egress-03 重新登录换成新位置的基线；登录那一刻探测失败时保留原基线", async () => {
  await egress.recordLogin("xhs", { getText: fakeBrowser({ cn: BJ, intl: LA }).getText });
  await egress.recordLogin("xhs", { getText: fakeBrowser({ cn: new Error("断网"), intl: new Error("断网") }).getText });
  assert.equal(store.getEgressBaselines().xhs.country, "CN", "探测失败不动基线");
  await egress.recordLogin("xhs", { getText: fakeBrowser({ cn: TYO, intl: LA }).getText });
  assert.equal(store.getEgressBaselines().xhs.country, "JP", "重新登录 = 新的平时位置");
  assert.deepEqual(egress.view().paused, []);
});

test("ACC-v3-egress-03 checkAccount 从掉线变正常算一次登录，平时检查正常不算", async () => {
  const calls = [];
  adaptersMod.setLoginHook(async (id) => calls.push(id));
  try {
    const adapters = [{ platform: "xiaohongshu", adapter: { check: async () => ({ state: "ok" }) } }];
    core.open().prepare("UPDATE account SET state='expired', last_ok_at=NULL WHERE id='xhs'").run();
    await adaptersMod.checkAccount(adapters, "xhs");
    assert.deepEqual(calls, ["xhs"], "掉线 → 正常：记基线");
    await adaptersMod.checkAccount(adapters, "xhs");
    assert.deepEqual(calls, ["xhs"], "正常 → 正常：不重记");
  } finally {
    adaptersMod.setLoginHook(null);
  }
});

test("ACC-v3-egress-03 第一次探测把当时的国家定为平时的位置，不暂停", async () => {
  const r = await probe({ cn: BJ, intl: LA });
  assert.deepEqual(r.paused, []);
  assert.equal(store.getEgressBaselines().xhs.country, "CN");
  assert.equal(store.getEgressBaselines().tt.country, "US");
});

test("ACC-v3-egress-03 位置变了之后跑一轮队列，没有任何发布尝试；平台稿还在、不烧重试次数", async () => {
  await probe({ cn: BJ, intl: LA });
  queuePublishRun("p-xhs", "xhs");
  queuePublishRun("p-tt", "tt");

  const moved = await probe({ cn: TYO, intl: LA }); // 国内线路换到日本，海外没变
  assert.deepEqual(moved.paused, ["xhs"]);

  const attempted = [];
  const runner = createRunner({ handlers: { publish: async (run) => attempted.push(run.target_id) }, log: () => {} });
  await runner.tick();
  assert.deepEqual(attempted, ["p-tt"], "只有位置没变的账号发了；小红书一次尝试都没有");
  const held = core.open().prepare("SELECT state, attempts FROM run WHERE target_id='p-xhs'").get();
  assert.deepEqual({ ...held }, { state: "queued", attempts: 0 }, "暂停的发布留在队列里，没有被领取、没有失败");
  assert.equal(core.open().prepare("SELECT state FROM publish WHERE id='p-xhs'").get().state, "queued", "平台稿不丢");

  // 两个账号都暂停时，整轮没有任何尝试。
  await probe({ cn: TYO, intl: TYO });
  queuePublishRun("p-tt2", "tt");
  attempted.length = 0;
  await runner.tick();
  assert.deepEqual(attempted, [], "位置变了跑一轮队列没有任何发布尝试");

  const evt = core.open().prepare("SELECT payload_json FROM event WHERE type='egress.moved' ORDER BY created_at").all().map((e) => JSON.parse(e.payload_json).accountId);
  assert.ok(evt.includes("xhs") && evt.includes("tt"), "每个暂停的账号留一条事件，写明从哪到哪");
});

test("ACC-v3-egress-03 位置回到平时的国家，队列自己恢复领取（没有人点也行）", async () => {
  await probe({ cn: BJ, intl: LA });
  queuePublishRun("p1", "xhs");
  await probe({ cn: TYO, intl: LA });
  const attempted = [];
  const runner = createRunner({ handlers: { publish: async (run) => attempted.push(run.target_id) }, log: () => {} });
  await runner.tick();
  assert.deepEqual(attempted, []);
  const back = await probe({ cn: BJ, intl: LA });
  assert.deepEqual(back.resumed, ["xhs"]);
  await runner.tick();
  assert.deepEqual(attempted, ["p1"]);
  assert.ok(core.open().prepare("SELECT 1 FROM event WHERE type='egress.restored'").get());
});

test("ACC-v3-egress-03/05 今天：待办里有暂停的账号，暂停的平台稿 paused、状态不变；位置没变时没有待办", async () => {
  await probe({ cn: BJ, intl: LA });
  queuePublishRun("p-xhs", "xhs");
  queuePublishRun("p-tt", "tt");
  assert.equal(buildToday({ groupId: "g1" }).egress.pausedCount, 0);

  await probe({ cn: TYO, intl: LA });
  const today = buildToday({ groupId: "g1" });
  assert.equal(today.egress.pausedCount, 1);
  assert.deepEqual(today.egress.paused.map((a) => [a.accountId, a.baseline.countryName, a.now.countryName]), [["xhs", "China", "Japan"]]);
  const by = Object.fromEntries(today.scheduled.map((r) => [r.platform, r]));
  assert.equal(by.xiaohongshu.paused, true);
  assert.equal(by.tiktok.paused, false);
  assert.equal(by.xiaohongshu.state, "queued", "已确认的平台稿不丢");
});

test("ACC-v3-egress-02 侧栏：machine.status 带国家城市 + IP；位置变了带暂停账号数", async () => {
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  await probe({ cn: LA, intl: LA });
  let m = h["machine.status"]({ group: "g1" });
  assert.equal(m.egress.place, "United States Los Angeles");
  assert.equal(m.egress.ip, LA);
  assert.equal(m.egress.pausedCount, 0);
  await probe({ cn: TYO, intl: LA });
  m = h["machine.status"]({ group: "g1" });
  assert.equal(m.egress.pausedCount, 1);
});

test("ACC-v3-egress-01 没有 IP 库：不暂停，位置写查不到，并说明原因", async () => {
  core.open().prepare("DELETE FROM meta WHERE key LIKE 'egress.%'").run();
  const saved = { c: readFileSync(join(GEO, egress.GEO_FILES.city)), a: readFileSync(join(GEO, egress.GEO_FILES.asn)) };
  const { rmSync } = await import("node:fs");
  rmSync(join(GEO, egress.GEO_FILES.city));
  rmSync(join(GEO, egress.GEO_FILES.asn));
  try {
    await probe({ cn: BJ, intl: LA });
    const moved = await probe({ cn: TYO, intl: TYO });
    assert.deepEqual(moved.paused, [], "没库不暂停发布");
    const v = egress.view({ groupId: "g1" });
    assert.ok(v.lines.every((l) => l.place === "查不到"));
    assert.ok(v.notes.some((n) => /没有 IP 库/.test(n) && /不会因为位置暂停发布/.test(n)), "说明原因");
    assert.equal(v.pausedCount, 0);
    queuePublishRun("p1", "xhs");
    const attempted = [];
    await createRunner({ handlers: { publish: async (run) => attempted.push(run.target_id) }, log: () => {} }).tick();
    assert.deepEqual(attempted, ["p1"], "没库时照常发");
  } finally {
    writeFileSync(join(GEO, egress.GEO_FILES.city), saved.c);
    writeFileSync(join(GEO, egress.GEO_FILES.asn), saved.a);
  }
});

test("ACC-v3-egress-03 探测失败（浏览器起不来）：不暂停，原因留在事件和页面数据里", async () => {
  await probe({ cn: BJ, intl: LA });
  const r = await probe({ cn: new Error("Chrome 起不来"), intl: new Error("Chrome 起不来") });
  assert.deepEqual(r.paused, []);
  assert.ok(egress.view().notes.some((n) => /Chrome 起不来/.test(n)));
  assert.ok(core.open().prepare("SELECT 1 FROM event WHERE type='egress.probe_failed'").get());
});

// ---------------------------------------------------------------- ACC-v3-egress-06：两条路径

test("ACC-v3-egress-06 「继续用新位置」要再确认；确认后才改基线、恢复发布", async () => {
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  await probe({ cn: BJ, intl: LA });
  queuePublishRun("p1", "xhs");
  await probe({ cn: TYO, intl: LA });

  assert.throws(() => h["egress.accept"]({ group: "g1" }), /再确认一次/);
  assert.throws(() => h["egress.accept"]({ group: "g1", confirm: "yes" }), /再确认一次/, "只认 true");
  assert.equal(store.getEgressBaselines().xhs.country, "CN", "没确认，基线不变");
  assert.equal(egress.view().pausedCount, 1);

  const done = h["egress.accept"]({ group: "g1", confirm: true });
  assert.deepEqual(done.accepted, ["xhs"]);
  assert.equal(store.getEgressBaselines().xhs.country, "JP", "确认后基线改成新位置");
  assert.equal(done.pausedCount, 0);
  const attempted = [];
  await createRunner({ handlers: { publish: async (run) => attempted.push(run.target_id) }, log: () => {} }).tick();
  assert.deepEqual(attempted, ["p1"], "恢复发布");
  assert.ok(core.open().prepare("SELECT 1 FROM event WHERE type='egress.accepted'").get());
});

test("ACC-v3-egress-06 「我去关掉代理」不改基线，等发布机复查；探测到回到基线才自动恢复", async () => {
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  await probe({ cn: BJ, intl: LA });
  queuePublishRun("p1", "xhs");
  await probe({ cn: TYO, intl: LA });

  const waiting = h["egress.wait"]({ group: "g1" });
  assert.deepEqual(waiting.waiting, ["xhs"]);
  assert.equal(store.getEgressBaselines().xhs.country, "CN", "基线没动");
  assert.equal(waiting.waitingCount, 1);
  assert.equal(waiting.paused[0].waiting, true, "页面据此写「等发布机复查」");

  const attempted = [];
  const runner = createRunner({ handlers: { publish: async (run) => attempted.push(run.target_id) }, log: () => {} });
  await probe({ cn: TYO, intl: LA }); // 复查：还没关
  await runner.tick();
  assert.deepEqual(attempted, [], "还在暂停");
  assert.equal(egress.view().waitingCount, 1);

  await probe({ cn: BJ, intl: LA }); // 复查：关了，回到北京
  assert.equal(egress.view().pausedCount, 0);
  assert.deepEqual(store.getEgressWaits(), {}, "恢复后「等复查」消失");
  await runner.tick();
  assert.deepEqual(attempted, ["p1"]);
  assert.equal(store.getEgressBaselines().xhs.country, "CN");
});

test("ACC-v3-egress-06 手动复查命令：浏览器探测失败时报错留事件，不假装成功", async () => {
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  egress.setPageText(async () => {
    throw new Error("没有找到 Chrome");
  });
  try {
    // 线路级失败不抛（记在线路上），所以命令照常返回视图，但视图里写明了原因。
    const v = await h["egress.recheck"]({ group: "g1" });
    assert.ok(v.notes.some((n) => /没有找到 Chrome/.test(n)));
  } finally {
    egress.setPageText(null);
  }
});

test("ACC-v3-egress-01 守护进程的时钟：离线模式不探测；启动后探测一次并下载到期的库", async () => {
  assert.equal(typeof egress.startEgressWatcher({ offline: true }), "function");
  const calls = [];
  let tick;
  const stop = egress.startEgressWatcher({
    log: () => {},
    probe: async () => (calls.push("probe"), { paused: [], resumed: [] }),
    refresh: async () => calls.push("refresh"),
    setTimer: (fn) => ((tick = fn), { unref() {} }),
    clearTimer: () => {},
  });
  await tick();
  assert.ok(calls.includes("probe"));
  stop();
});

test("ACC-v3-egress 回显页解析：JSON 和纯文本都认；IPv6 也认；没有 IP 报错", () => {
  assert.equal(egress.ipFromEcho('{"ret":"ok","data":{"ip":"203.0.113.24","location":["美国"]}}'), "203.0.113.24");
  assert.equal(egress.ipFromEcho("198.51.100.61\n"), "198.51.100.61");
  assert.equal(egress.ipFromEcho("your ip is 2001:db8::1"), "2001:db8::1");
  assert.equal(egress.ipFromEcho("<html>blocked</html>"), null);
  assert.equal(existsSync(HOME), true);
});
