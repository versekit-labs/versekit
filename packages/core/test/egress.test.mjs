// 发布机出口位置（#310，ACC-v3-egress-01…06）。
// 全部用自造的小 mmdb 和假回显：不下载真实 IP 库，不访问真实回显地址，不碰真实账号。
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

// #325：不注册任何钩子（不起 vk serve），登录成功三条路径各自走到 notifyLogin，都要记下 CN 基线，
// 之后第一次探测在 JP → 暂停。
const withFakePage = async (exit, fn) => {
  egress.setPageText(fakeBrowser(exit).getText);
  try {
    return await fn();
  } finally {
    egress.setPageText(null);
  }
};
const assertCnThenJpPaused = async () => {
  assert.equal(store.getEgressBaselines().xhs.country, "CN");
  assert.equal(store.getEgressBaselines().xhs.source, "login");
  const r = await probe({ cn: TYO, intl: LA });
  assert.deepEqual(r.paused, ["xhs"], "CN 登录、首次探测 JP → 暂停");
};

test("ACC-v3-egress-03 命令行单独登录（没有 vk serve、没有钩子）：notifyLogin 直接记 CN 基线", async () => {
  adaptersMod.setLoginHook(null);
  await withFakePage({ cn: BJ, intl: LA }, () => adaptersMod.notifyLogin("xhs"));
  await assertCnThenJpPaused();
});

test("ACC-v3-egress-03 网页登录（handlers 的 account.connect 成功）也直接记 CN 基线", async () => {
  adaptersMod.setLoginHook(null);
  const src = readFileSync(new URL("../src/handlers.mjs", import.meta.url), "utf8");
  assert.match(src, /applyAccountConnection\([^)]*\);\s*await notifyLogin\(accountId\)/, "网页授权成功后调 notifyLogin");
  await withFakePage({ cn: BJ, intl: LA }, () => adaptersMod.notifyLogin("xhs"));
  await assertCnThenJpPaused();
});

test("ACC-v3-egress-03 体检从掉线恢复为正常算一次登录：直接记 CN 基线；平时检查正常不重记", async () => {
  adaptersMod.setLoginHook(null);
  const adapters = [{ platform: "xiaohongshu", adapter: { check: async () => ({ state: "ok" }) } }];
  core.open().prepare("UPDATE account SET state='expired', last_ok_at=NULL WHERE id='xhs'").run();
  await withFakePage({ cn: BJ, intl: LA }, () => adaptersMod.checkAccount(adapters, "xhs"));
  await assertCnThenJpPaused();
  // 正常 → 正常：不再探测
  const b = fakeBrowser({ cn: BJ, intl: LA });
  egress.setPageText(b.getText);
  try {
    await adaptersMod.checkAccount(adapters, "xhs");
  } finally {
    egress.setPageText(null);
  }
  assert.deepEqual(b.calls, [], "正常 → 正常：不探测、不重记");
});

test("ACC-v3-egress-03 登录时探测失败：不记基线、留 egress.probe_failed 事件，登录不失败", async () => {
  adaptersMod.setLoginHook(null);
  await withFakePage({ cn: new Error("断网"), intl: new Error("断网") }, () => adaptersMod.notifyLogin("xhs"));
  assert.equal(store.getEgressBaselines().xhs, undefined);
  const ev = core.open().prepare("SELECT payload_json FROM event WHERE type='egress.probe_failed'").all();
  assert.ok(ev.length >= 1, "留了事件");
});

test("ACC-v3-egress-03 登录时没有 IP 库：不记基线、留事件", async () => {
  adaptersMod.setLoginHook(null);
  const { rmSync } = await import("node:fs");
  rmSync(GEO, { recursive: true, force: true });
  try {
    await withFakePage({ cn: BJ, intl: LA }, () => adaptersMod.notifyLogin("xhs"));
    assert.equal(store.getEgressBaselines().xhs?.source === "login", false);
    assert.equal(core.open().prepare("SELECT 1 FROM event WHERE type='egress.login_baseline'").all().length, 0);
    assert.ok(core.open().prepare("SELECT 1 FROM event WHERE type='egress.probe_failed' AND dedupe_key LIKE 'egress.login_baseline_skipped:%'").all().length >= 1, "留了事件");
  } finally {
    installDbs();
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
    assert.ok(v.notes.some((n) => /位置库还没下载/.test(n) && /不会因为位置暂停发布/.test(n)), "说明原因");
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

// ---------------------------------------------------------------- #333 IP 库在慢网络上也能下载（ACC-v3-egress-09）
// 假下载源：按块、按间隔吐数据；可中途停住、可不认 Range。全程不访问真实网络。

const SRC = [{ kind: "city", name: "DB-IP City Lite", url: "https://example.invalid/city.mmdb.gz", gz: true }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 假时钟：idle 超时用它的计时器，不依赖真实时间；机器再卡也不会误判。
 * advance(ms) 把假时间往前推，到点的计时器按顺序触发。夹具里「等 delay」「卡住」都靠它推进。
 */
const fakeClock = () => {
  let now = 0, seq = 0;
  const timers = new Map();
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  return {
    get now() { return now; },
    advance,
    setTimer: (fn, ms) => { timers.set(++seq, { at: now + ms, fn }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
  };
};

/** @param {Buffer} buf  @param {{chunk?:number, delay?:number, stallAfter?:number, noRange?:boolean, headers?:object[]}} o */
const fakeSource = (buf, { chunk = 16, delay = 0, stallAfter = Infinity, noRange = false, clock } = {}) => {
  const requests = [];
  const fetchImpl = async (url, { signal, headers = {} } = {}) => {
    requests.push(headers);
    const m = /bytes=(\d+)-/.exec(headers.Range ?? "");
    const start = m && !noRange ? Number(m[1]) : 0;
    let sent = 0;
    const body = new ReadableStream({
      async pull(ctrl) {
        if (signal?.aborted) return ctrl.error(signal.reason);
        const pos = start + sent;
        if (pos >= buf.length) return ctrl.close();
        if (sent >= stallAfter) {
          // 卡住：不再有数据，直到调用方放弃（超时）。假时钟把时间推过去，idle 计时器立刻到点。
          const stuck = new Promise((_, rej) => signal?.addEventListener("abort", () => rej(signal.reason)));
          clock?.advance(1e9);
          await stuck;
        }
        if (delay) { if (clock) clock.advance(delay); else await sleep(delay); } // 有假时钟就推进假时间，不真等
        const n = Math.min(chunk, buf.length - pos, stallAfter - sent);
        ctrl.enqueue(buf.subarray(pos, pos + n));
        sent += n;
      },
    });
    const partial = m && !noRange;
    return new Response(body, {
      status: partial ? 206 : 200,
      headers: partial ? { "content-range": `bytes ${start}-${buf.length - 1}/${buf.length}`, "content-length": String(buf.length - start) } : { "content-length": String(buf.length) },
    });
  };
  return { fetchImpl, requests };
};

const freshDir = () => mkdtempSync(join(tmpdir(), "vk-geo9-"));
const resetGeoMeta = () => store.setEgressGeoDb({});
const gzCity = () => gzipSync(cityDb());

test("ACC-v3-egress-09 慢但一直有数据的下载能成功：超时按「连续没数据」算，不按总时长", async () => {
  resetGeoMeta();
  const dir = freshDir();
  const gz = gzCity();
  const idleMs = 120;
  const chunk = 8, delay = 20; // 每块都在 idle 之内，总时长远超 idle
  assert.ok((gz.length / chunk) * delay > idleMs * 2, "夹具要够慢，才能证明不是按总时长");
  const clock = fakeClock();
  const src = fakeSource(gz, { chunk, delay, clock });
  const r = await egress.refreshGeoDb({ dir, now: Date.UTC(2026, 10, 22), sources: SRC, fetchImpl: src.fetchImpl, idleMs, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.ok(clock.now > idleMs, "总时长超过了 idle 超时");
  assert.deepEqual(r.updated, ["DB-IP City Lite"]);
  assert.equal(r.error, null);
  assert.equal(egress.openMmdb(readFileSync(join(dir, egress.GEO_FILES.city))).lookup(TYO).country.iso_code, "JP");
  assert.deepEqual(readdirSync(dir).filter((n) => /\.(part|tmp)$/.test(n)), [], "成功后没有临时文件残留");
  assert.equal(store.getEgressGeoDb().attempts, 0);
  assert.equal(store.getEgressGeoDb().nextAt, null);
});

test("ACC-v3-egress-09 中途断开：留下已收到的部分，下次用 Range 续传成功", async () => {
  resetGeoMeta();
  const dir = freshDir();
  const gz = gzCity();
  const now = Date.UTC(2026, 10, 22);
  const c1 = fakeClock();
  const stalled = fakeSource(gz, { chunk: 8, stallAfter: 40, clock: c1 });
  const first = await egress.refreshGeoDb({ dir, now, sources: SRC, fetchImpl: stalled.fetchImpl, idleMs: 80, setTimer: c1.setTimer, clearTimer: c1.clearTimer });
  assert.match(first.error, /连续 \d+ 秒没有收到数据|连续 0 秒没有收到数据/);
  assert.match(first.error, /已收到/);
  assert.equal(existsSync(join(dir, egress.GEO_FILES.city)), false, "没下完不出库");
  const parts = readdirSync(dir).filter((n) => n.endsWith(".part"));
  assert.equal(parts.length, 1, "已收到的部分留着续传");
  assert.equal(statSync(join(dir, parts[0])).size, 40);

  const ok = fakeSource(gz, { chunk: 16 });
  const c2 = fakeClock();
  const second = await egress.refreshGeoDb({ dir, now: now + 1000, sources: SRC, fetchImpl: ok.fetchImpl, idleMs: 80, setTimer: c2.setTimer, clearTimer: c2.clearTimer });
  assert.equal(second.error, null);
  assert.equal(ok.requests[0].Range, "bytes=40-", "从断点接着要");
  assert.equal(egress.openMmdb(readFileSync(join(dir, egress.GEO_FILES.city))).lookup(LA).city.names.en, "Los Angeles");
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".part")), []);
});

test("ACC-v3-egress-09 服务器不支持断点：从头下载并说明，下完照样换库", async () => {
  resetGeoMeta();
  const dir = freshDir();
  const gz = gzCity();
  const logs = [];
  const clock = fakeClock();
  const timers = { setTimer: clock.setTimer, clearTimer: clock.clearTimer };
  await egress.refreshGeoDb({ dir, now: 1, sources: SRC, fetchImpl: fakeSource(gz, { chunk: 8, stallAfter: 24, clock }).fetchImpl, idleMs: 60, log: (m) => logs.push(m), ...timers });
  const noRange = fakeSource(gz, { noRange: true });
  const r = await egress.refreshGeoDb({ dir, now: 2, sources: SRC, fetchImpl: noRange.fetchImpl, idleMs: 60, log: (m) => logs.push(m), ...timers });
  assert.equal(r.error, null);
  assert.equal(noRange.requests[0].Range, "bytes=24-", "先尝试续传");
  assert.ok(logs.some((m) => /不支持断点续传，从头下载/.test(m)));
  assert.equal(existsSync(join(dir, egress.GEO_FILES.city)), true);
});

test("ACC-v3-egress-09 解压或校验不过的下载不换旧库，也不留着坏的续传文件", async () => {
  resetGeoMeta();
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, egress.GEO_FILES.city), cityDb());
  const before = readFileSync(join(dir, egress.GEO_FILES.city));
  const r = await egress.refreshGeoDb({ dir, now: 1, sources: SRC, fetchImpl: fakeSource(Buffer.from("this is not gzip at all")).fetchImpl, idleMs: 60, setTimer: fakeClock().setTimer, clearTimer: () => {} });
  assert.ok(r.error);
  assert.deepEqual(readFileSync(join(dir, egress.GEO_FILES.city)), before);
  assert.deepEqual(readdirSync(dir).filter((n) => /\.(part|tmp)$/.test(n)), []);
});

test("ACC-v3-egress-09 连续失败：重试间隔 10 分钟、1 小时、6 小时，之后每 6 小时；退避期内不下载；成功后回到每月一次", async () => {
  resetGeoMeta();
  const dir = freshDir();
  const t0 = Date.UTC(2026, 10, 22, 8);
  const down = async () => new Response("x", { status: 503 });
  const deltas = [];
  for (let i = 0; i < 5; i++) {
    const now = t0 + i * 7 * 3600e3;
    await egress.refreshGeoDb({ dir, now, sources: SRC, fetchImpl: down });
    const m = store.getEgressGeoDb();
    assert.equal(m.attempts, i + 1);
    deltas.push(m.nextAt - now);
  }
  assert.deepEqual(deltas, [600e3, 3600e3, 6 * 3600e3, 6 * 3600e3, 6 * 3600e3]);

  const failedAt = t0 + 4 * 7 * 3600e3;
  const nextAt = store.getEgressGeoDb().nextAt;
  assert.equal(egress.geoDbDue({ now: failedAt + 3600e3, dir }), false, "6 小时的退避期内，每 10 分钟的探测不会再下一整份");
  assert.equal(egress.geoDbDue({ now: nextAt - 1, dir }), false);
  assert.equal(egress.geoDbDue({ now: nextAt, dir }), true, "到点才再试");

  const ok = await egress.refreshGeoDb({ dir, now: nextAt, sources: SRC, fetchImpl: fakeSource(gzCity()).fetchImpl });
  assert.equal(ok.error, null);
  const m = store.getEgressGeoDb();
  assert.equal(m.attempts, 0);
  assert.equal(m.nextAt, null);
  assert.equal(egress.geoDbDue({ now: nextAt + 864e5, dir }), false, "成功后回到每月一次");
  assert.equal(egress.geoDbDue({ now: Date.now() + 40 * 864e5, dir }), true);
});

test("ACC-v3-egress-09 系统页两种说法：从来没成功过 / 有旧库才写「继续用」", async () => {
  resetGeoMeta();
  const empty = freshDir();
  const t = Date.UTC(2026, 10, 22, 8);
  const clock = fakeClock();
  const timeout = async (_url, { signal }) => { const w = new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason))); clock.advance(1e9); await w; };
  const timers = { setTimer: clock.setTimer, clearTimer: clock.clearTimer };
  await egress.refreshGeoDb({ dir: empty, now: t, sources: SRC, fetchImpl: timeout, idleMs: 30, ...timers });
  await egress.refreshGeoDb({ dir: empty, now: t + 700e3, sources: SRC, fetchImpl: timeout, idleMs: 30, ...timers });
  const never = egress.geoDbNote(egress.geoDbStatus(empty));
  assert.match(never, /^位置库还没下载下来：连续 \d+ 秒没有收到数据/);
  assert.match(never, /已试 2 次，下次 /);
  assert.ok(never.includes(`下次 ${egress.fmtAt(store.getEgressGeoDb().nextAt)}`), "写了下次时间");
  assert.doesNotMatch(never, /继续用/);
  assert.doesNotMatch(never, /aborted due to timeout/, "不再把英文原话甩给用户");

  const old = freshDir();
  writeFileSync(join(old, egress.GEO_FILES.city), cityDb());
  resetGeoMeta();
  await egress.refreshGeoDb({ dir: old, now: t, sources: SRC, fetchImpl: async () => new Response("x", { status: 503 }) });
  const withOld = egress.geoDbNote(egress.geoDbStatus(old));
  assert.match(withOld, /这次更新位置库没成功：HTTP 503，已试 1 次，下次 /);
  assert.match(withOld, /继续用 \S+ 的库/);
  assert.doesNotMatch(withOld, /还没下载下来/);

  resetGeoMeta();
  await egress.refreshGeoDb({ dir: old, now: t, sources: SRC, fetchImpl: fakeSource(gzCity()).fetchImpl });
  assert.equal(egress.geoDbNote(egress.geoDbStatus(old)), null, "没失败就没有提示");
});

test("ACC-v3-egress-09 「现在重新下载」是一条命令（egress.geodb）：开始下载、显示进度、已在下载不重复开始", async () => {
  resetGeoMeta();
  const cmd = (await import("../src/commands.mjs")).COMMANDS.find((c) => c.name === "egress.geodb");
  assert.ok(cmd, "命令在 commands.mjs 里定义，CLI / HTTP 由它派生");
  assert.equal(cmd.http.path, "/api/egress/geodb");
  assert.match(cmd.cli.usage, /vk egress geodb/);

  const gz = gzCity();
  let release;
  const gate = new Promise((r) => (release = r));
  const inner = fakeSource(gz, { chunk: 8 });
  let fetches = 0;
  egress.setGeoFetch(async (url, opts) => {
    fetches++;
    await gate;
    return inner.fetchImpl(url, opts);
  });
  try {
    const h = createCoreHandlers({ adapters: [], log: () => {} });
    const first = await h["egress.geodb"]({ group: "g1" });
    assert.equal(first.started, true);
    assert.ok(first.geoDb.downloading, "下载中带进度");
    assert.match(first.notes.join("\n"), /正在下载位置库/);

    const second = await h["egress.geodb"]({ group: "g1" });
    assert.equal(second.started, false, "已经在下载，不重复开始");
    assert.equal(second.alreadyRunning, true);
    assert.equal(fetches, 1);

    release();
    while (egress.geoDbDownloading()) await sleep(10);
    const done = h["egress.status"]({ group: "g1" });
    assert.equal(done.geoDb.downloading, null);
    assert.equal(done.geoDb.error, null);
    assert.equal(egress.geoDbDue({ now: Date.now() }), false);
  } finally {
    egress.setGeoFetch(null);
    release();
  }
});

test("ACC-v3-egress-09 下载进度：按收到的字节写进度（含总大小）", async () => {
  resetGeoMeta();
  const dir = freshDir();
  const gz = gzCity();
  const seen = [];
  const inner = fakeSource(gz, { chunk: 8, delay: 5 });
  let watch;
  const p = egress.refreshGeoDb({
    dir, now: 1, sources: SRC, idleMs: 200, progressMs: 0, setTimer: fakeClock().setTimer, clearTimer: () => {}, // 真实间隔只用来采样进度，idle 超时不走真实时钟
    fetchImpl: async (url, opts) => {
      watch = setInterval(() => { const d = store.getEgressGeoDb()?.downloading; if (d) seen.push(d); }, 10);
      return inner.fetchImpl(url, opts);
    },
  });
  await p;
  clearInterval(watch);
  assert.ok(seen.some((d) => d.total === gz.length && d.received > 0 && d.received < gz.length), "中途读到过 已收到/总大小");
  assert.equal(store.getEgressGeoDb().downloading, null);
});
