// YouTube 官方接口适配器：对本地 mock 的 Google 授权服务器和 YouTube API 服务端，跑通授权、可续传上传、
// 预约发、回读核实、强制私享、配额与错误处理、采集，并逐个钉住错误处理。
// 全程只连 127.0.0.1 的 mock，不连 googleapis.com / accounts.google.com，不用真实 OAuth 客户端。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HOME = mkdtempSync(join(tmpdir(), "vk-yt-"));
process.env.VK_HOME = HOME;
process.env.VK_NO_BROWSER = "1";
process.env.VK_YOUTUBE_BACKOFF_MS = "1";
process.env.VK_YOUTUBE_CHUNK_BYTES = String(256 * 1024);

const core = await import("../../core/src/index.mjs");
const store = await import("../../core/src/store.mjs");
const { loadAdapters, buildHandlers, checkAccount } = await import("../../core/src/adapters.mjs");
const { createCoreHandlers } = await import("../../core/src/handlers.mjs");
const { createRunner } = await import("../../core/src/runner.mjs");
const { validateAdapter } = await import("../../core/src/contract.mjs");
const { publishInputFor } = await import("../../core/src/publish-flow.mjs");
const { codeChallenge, newCodeVerifier, newState } = await import("../src/pkce.mjs");
const { startMock, ALL_SCOPES } = await import("./mock-youtube.mjs");
const adapterModule = await import("../src/index.mjs");
const quota = await import("../src/quota.mjs");
const { credentialPath } = await import("../src/settings.mjs");
const { mp4Info, shortsVerdict } = await import("../src/mp4.mjs");
const { findCommand } = await import("../../core/src/commands.mjs");

core.migrate();
const db = () => core.open();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHUNK = 256 * 1024;

let mock;
let adapters;
let coreHandlers;
let n = 0;

before(async () => {
  mock = await startMock();
  process.env.YOUTUBE_API_BASE = mock.base;
  process.env.GOOGLE_AUTH_BASE = mock.base;
  process.env.GOOGLE_TOKEN_BASE = mock.base;
  process.env.YOUTUBE_ANALYTICS_BASE = mock.base;
  process.env.YOUTUBE_CLIENT_ID = mock.state.clientId;
  process.env.YOUTUBE_CLIENT_SECRET = mock.state.clientSecret;
  adapters = (await loadAdapters({ only: ["youtube"] })).adapters;
  coreHandlers = createCoreHandlers({ adapters, log: () => {} });
});
after(() => mock.close());

const DEFAULTS = {
  insertStatuses: [], listStatuses: [], dropAfterChunk: null, forcePrivate: false, quotaExceeded: false, uploadLimit: false, sessionExpired: false,
  uploadStatus: "uploaded", rejectionReason: null, failureReason: null, missingAfterUpload: 0, failThumbnail: false, failCaptions: false, failPlaylistItem: false,
  tokenRefreshFails: false, unauthorized: false, analyticsFails: false, scope: ALL_SCOPES.join(" "), noRefreshToken: false,
};
const reset = (patch = {}) => {
  mock.state.requests.length = 0;
  mock.state.puts.length = 0;
  Object.assign(mock.state, DEFAULTS, patch);
  adapterModule.hooks.onRead = null;
  delete process.env.VK_YOUTUBE_DAILY_INSERTS;
  delete process.env.VK_YOUTUBE_DAILY_UNITS;
  // 记账与暂停按项目记在凭证目录里：每个用例从干净状态开始。
  const f = credentialPath("youtube/_quota.json");
  if (existsSync(f)) writeFileSync(f, JSON.stringify({ version: 1, projects: {} }));
};
const calls = (path, method = null) => mock.state.requests.filter((r) => r.path === path && (!method || r.method === method));
const inserts = () => calls("/upload/youtube/v3/videos").length;

const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type), body]); };
/** 最小的 mp4：ftyp + moov{mvhd, trak{tkhd}}，时长与画面宽高可指定；尾部补到 size 字节（内容是伪随机，好对哈希）。 */
function fakeMp4(seconds, { size = 600 * 1024, width = 1920, height = 1080, rotate = false } = {}) {
  const mvhd = box("mvhd", Buffer.concat([u32(0), u32(0), u32(0), u32(1000), u32(Math.round(seconds * 1000)), Buffer.alloc(80)]));
  const matrix = rotate ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  const tkhd = box("tkhd", Buffer.concat([u32(0), u32(0), u32(0), u32(1), u32(0), u32(1000), Buffer.alloc(8), Buffer.alloc(8), ...matrix.map(u32), u32(width * 65536), u32(height * 65536)]));
  const head = Buffer.concat([box("ftyp", Buffer.from("isom"), u32(0)), box("moov", mvhd, box("trak", tkhd))]);
  const pad = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < pad.length; i++) pad[i] = (i * 31 + 7) & 0xff;
  const file = join(mkdtempSync(join(tmpdir(), "vk-yt-vid-")), `v${++n}.mp4`);
  writeFileSync(file, Buffer.concat([head, pad]));
  return file;
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** 授权一个新账号：走真实的 account.connect 两段式流程。 */
async function connectedAccount(handle = null) {
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "youtube", handle: handle ?? `@yt${n}`, displayName: `号${n}`, groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: id });
  assert.equal(first.state, "waiting");
  await mock.approve(first.url, { code: `code_${n}` });
  const done = await coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 });
  assert.equal(done.state, "connected");
  return { accountId: id, groupId: group.id };
}

/** 建作品 + 平台稿；language 是成片版本的语言；youtube 是逐条平台稿参数；at 是预约时间。返回平台稿 id。 */
function plan({ accountId }, { video = fakeMp4(5), meta = null, language = "default", youtube = null, at = null, approve = true, title = null } = {}) {
  const work = store.upsertWork({ title: title ?? `作品 ${++n}`, cuts: [{ title: title ?? `作品 ${n}`, versions: [{ language, asset: video }] }], meta });
  const pub = store.createPublish({ workId: work.id, accountId });
  if (youtube) db().prepare("UPDATE publish SET overrides_json = ? WHERE id = ?").run(JSON.stringify({ youtube }), pub.id);
  if (at != null) db().prepare("UPDATE publish SET scheduled_at = ? WHERE id = ?").run(at, pub.id);
  if (approve) store.approvePublishes({ publishId: pub.id });
  return pub.id;
}

async function drain() {
  const runner = createRunner({ handlers: buildHandlers(adapters, { log: () => {} }), log: () => {} });
  for (let i = 0; i < 5; i++) await runner.tick();
}
const row = (id) => db().prepare("SELECT * FROM publish WHERE id = ?").get(id);
const acct = (id) => db().prepare("SELECT * FROM account WHERE id = ?").get(id);
const events = (publishId, type) => db().prepare("SELECT * FROM event WHERE publish_id = ? AND type = ?").all(publishId, type).map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));
const vid = (id) => mock.state.videos.get(row(id).external_id);

// ------------------------------------------------------------------ ACC-youtube-01：结构、移植、剥离、dry-run

test("契约：能力声明合法，不引入运行时依赖，文件头写明出处", () => {
  const info = validateAdapter(adapterModule.default, "adapter-youtube");
  assert.equal(info.platform, "youtube");
  assert.equal(info.publish, "api");
  assert.equal(info.collect, "api");
  assert.equal(info.requiresQualification, true);
  assert.deepEqual(info.assetTypes, ["video"]);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(!pkg.dependencies && !pkg.devDependencies, "不引入运行时依赖");
  assert.match(readFileSync(join(ROOT, "src/index.mjs"), "utf8"), /^\/\/ ported from trustbridge@1f9c92f videos\/factory\/publishers\/youtube\.mjs/);
});

test("剥离：工厂里为某个频道写死的东西，适配器源码里一个都没有", () => {
  const forbidden = [
    /Overseas Compliance Explained/,
    /categoryId:\s*['"]28['"]/,
    /defaultLanguage:\s*['"]en['"]/,
    /learnontiktok|techtok/i,
    /filesOf\s*\(/,
    /\bepisode\b/,
    /assurelane/i,
    /youtube-(client|token)\.json/,
    /containsSyntheticMedia:\s*true/,
    /#Shorts/,
    /en\/tiktok\.json/,
  ];
  for (const f of readdirSync(join(ROOT, "src"))) {
    const text = readFileSync(join(ROOT, "src", f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // 注释里讲「剥掉了什么」不算
    for (const re of forbidden) assert.ok(!re.test(text), `${f} 里不该出现 ${re}`);
  }
});

test("dry-run：不联网、不改库，产出真发会提交的元数据（标题、简介、标签、类目、预约、Shorts、预估配额）", async () => {
  reset();
  const a = await connectedAccount();
  const file = fakeMp4(30, { width: 1080, height: 1920 });
  const id = plan(a, { video: file, language: "en", meta: { body: "正文一段", tags: ["数据合规", "gdpr"] }, title: "一支竖版短片", youtube: { category_id: "27", playlist: "My List" }, approve: false });
  const before = { row: row(id), events: db().prepare("SELECT COUNT(*) n FROM event").get().n };
  mock.state.requests.length = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("dry-run 不应联网"); };
  let out;
  try {
    out = await adapterModule.default.publish(publishInputFor(id, { dryRun: true }));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(out.dryRun, true);
  assert.equal(mock.state.requests.length, 0);
  assert.deepEqual(row(id), before.row);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM event").get().n, before.events);
  const r = out.request;
  assert.equal(r.resource.snippet.title, "一支竖版短片");
  assert.equal(r.resource.snippet.description, "正文一段\n\n#数据合规 #gdpr");
  assert.deepEqual(r.resource.snippet.tags, ["数据合规", "gdpr"]);
  assert.equal(r.resource.snippet.categoryId, "27");
  assert.equal(r.resource.status.privacyStatus, "public");
  assert.equal(r.shorts.short, true);
  assert.equal(r.file.chunks, 3);
  assert.deepEqual(r.steps.playlist, { name: "My List" });
  assert.equal(r.estimatedQuota.inserts, 1);
  assert.ok(r.estimatedQuota.units >= 52, "预估包含回读 + 播放列表（查 + 加）的单位");
});

// ------------------------------------------------------------------ ACC-youtube-02：授权

test("PKCE：code_challenge 是 verifier 的 SHA256 的 base64url（RFC 7636 S256），每次授权新生成", () => {
  assert.equal(codeChallenge("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  const v = newCodeVerifier();
  assert.equal(codeChallenge(v), createHash("sha256").update(v).digest("base64url"));
  const vs = new Set(Array.from({ length: 20 }, newCodeVerifier));
  assert.equal(vs.size, 20);
  for (const x of vs) assert.match(x, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.notEqual(newState(), newState());
});

test("授权：回调在 127.0.0.1 临时端口的 /callback/youtube/，链接带 state + PKCE S256，拿到 code 立刻关端口", async () => {
  reset();
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "youtube", handle: "@portcheck", groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: id });
  const url = new URL(first.url);
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), mock.state.clientId);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.ok(url.searchParams.get("state"));
  const scopes = url.searchParams.get("scope").split(" ");
  assert.ok(scopes.includes("https://www.googleapis.com/auth/youtube.upload"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/yt-analytics.readonly"));
  const redirect = new URL(url.searchParams.get("redirect_uri"));
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(redirect.pathname, "/callback/youtube/");
  assert.equal((await fetch(`${redirect.origin}/other`)).status, 404);
  await mock.approve(first.url, { code: "code_port" });
  const done = await coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 });
  assert.equal(done.state, "connected");
  assert.equal(done.displayName, "Mock Channel");
  await assert.rejects(fetch(redirect.origin + redirect.pathname), /fetch failed/, "拿到 code 后端口已关");
});

test("授权：state 不符 → 拒绝并给人话、不用其中的 code、端口也关；用户取消也给人话", async () => {
  reset();
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "youtube", handle: "@csrf", groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: id });
  const redirect = new URL(new URL(first.url).searchParams.get("redirect_uri"));
  assert.equal((await mock.approve(first.url, { state: "forged", code: "code_csrf" })).status, 400);
  await assert.rejects(coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 }), /state 对不上/);
  assert.equal(calls("/token").length, 0, "state 不符时不能拿 code 去换 token");
  await assert.rejects(fetch(redirect.origin + redirect.pathname), /fetch failed/);
  assert.equal(acct(id).credential_ref, null);

  const second = await coreHandlers["account.connect"]({ accountId: id });
  await mock.approve(second.url, { error: "access_denied" });
  await assert.rejects(coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 }), /取消了授权/);
});

test("授权成功：token 只在本机凭证目录（0600），账号表只有 credential_ref，库与日志里没有 secret / token", async () => {
  reset();
  const { accountId } = await connectedAccount();
  const a = acct(accountId);
  assert.equal(a.display_name, "Mock Channel");
  assert.match(a.credential_ref, /^youtube\/.+\.json$/);
  const file = credentialPath(a.credential_ref);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  assert.match(rec.access_token, /^at_/);
  assert.equal(rec.profile.channel_id, "UC_mock_1");
  // 整个库（所有表）里都没有 token 与 secret
  const tables = db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  const dump = tables.map((t) => JSON.stringify(db().prepare(`SELECT * FROM ${t}`).all())).join("\n");
  for (const secret of [rec.access_token, rec.refresh_token, mock.state.clientSecret]) assert.ok(!dump.includes(secret));
  const list = coreHandlers["account.list"]({});
  assert.ok(!JSON.stringify(list).includes(rec.access_token));
  // 换 token 的请求带了 verifier 与 redirect_uri
  assert.match(calls("/token").at(-1).body, /code_verifier=/);
});

test("授权：没勾上传权限、没拿到长期授权 → 拒绝并说清楚，不存凭证", async () => {
  reset({ scope: "https://www.googleapis.com/auth/yt-analytics.readonly" });
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "youtube", handle: "@noscope", groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: id });
  await mock.approve(first.url, { code: "code_noscope" });
  await assert.rejects(coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 }), /没有勾选「上传视频」权限/);
  assert.equal(acct(id).credential_ref, null);

  reset({ noRefreshToken: true });
  const second = await coreHandlers["account.connect"]({ accountId: id });
  await mock.approve(second.url, { code: "code_norefresh" });
  await assert.rejects(coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 }), /长期授权/);
});

test("续期：access_token 过期前用 refresh_token 换新并写回", async () => {
  reset();
  const { accountId } = await connectedAccount();
  const file = credentialPath(acct(accountId).credential_ref);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...rec, expires_at: Date.now() + 60_000 }), { mode: 0o600 });
  const res = await checkAccount(adapters, accountId);
  assert.equal(res.state, "ok");
  const next = JSON.parse(readFileSync(file, "utf8"));
  assert.notEqual(next.access_token, rec.access_token);
  assert.equal(next.refresh_token, rec.refresh_token, "Google 续期不给新的 refresh_token：沿用旧的");
  assert.equal(calls("/youtube/v3/channels").at(-1).headers.authorization, `Bearer ${next.access_token}`);
});

test("续期失败（授权被撤销）：账号变「需要重新登录」并发事件", async () => {
  reset({ tokenRefreshFails: true });
  const { accountId } = await connectedAccount();
  const file = credentialPath(acct(accountId).credential_ref);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), expires_at: Date.now() - 1000 }), { mode: 0o600 });
  await assert.rejects(checkAccount(adapters, accountId), (err) => err.code === "auth" && /重新授权/.test(err.message));
  assert.equal(acct(accountId).state, "expired");
  assert.equal(db().prepare("SELECT * FROM event WHERE type='account.expired' AND payload_json LIKE ?").all(`%${accountId}%`).length, 1);
});

test("没授权过的账号：check 报需要重新登录，不联网；探测遇到 401 同样转需要重新登录", async () => {
  reset();
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "youtube", handle: "@fresh", groupId: group.id });
  await assert.rejects(checkAccount(adapters, id), (err) => err.code === "auth" && /还没有授权/.test(err.message));
  assert.equal(mock.state.requests.length, 0);
  const { accountId } = await connectedAccount();
  mock.state.unauthorized = true;
  await assert.rejects(checkAccount(adapters, accountId), (err) => err.code === "auth");
  assert.equal(acct(accountId).state, "expired");
});

test("应用凭证：只从环境变量或本机配置读；ready() 说清楚；platform.list / account.credentials 不返回 secret，保存只留不含凭证的事件", () => {
  const saved = { id: process.env.YOUTUBE_CLIENT_ID, s: process.env.YOUTUBE_CLIENT_SECRET };
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
  try {
    assert.match(adapterModule.default.ready(), /应用凭证/);
    const before = coreHandlers["platform.list"]().platforms.find((p) => p.platform === "youtube");
    assert.equal(before.credentials.configured, false);
    const cmd = findCommand("account.credentials");
    assert.equal(cmd.audit, "never", "凭证命令不进审计");
    const out = coreHandlers["account.credentials"]({ platform: "youtube", clientKey: "my-id.apps.example", clientSecret: "SECRET-VALUE-XYZ" });
    assert.equal(out.configured, true);
    assert.equal(out.clientKey, "my-id.apps.example");
    assert.ok(!JSON.stringify(out).includes("SECRET-VALUE-XYZ"));
    assert.equal(adapterModule.default.ready(), null);
    assert.ok(!JSON.stringify(coreHandlers["platform.list"]()).includes("SECRET-VALUE-XYZ"));
    const evs = db().prepare("SELECT payload_json FROM event WHERE type='account.credentials_saved'").all();
    assert.ok(evs.length >= 1 && evs.every((e) => !e.payload_json.includes("SECRET-VALUE-XYZ")));
    assert.throws(() => coreHandlers["account.credentials"]({ platform: "youtube", clientKey: "a b", clientSecret: "s" }), /空格/);
    writeFileSync(core.paths().configFile, "{}");
  } finally {
    process.env.YOUTUBE_CLIENT_ID = saved.id;
    process.env.YOUTUBE_CLIENT_SECRET = saved.s;
  }
});

// ------------------------------------------------------------------ ACC-youtube-03：发布

test("发布：分块读文件（单次读取不超过分块大小）+ 可续传上传；回读核实后落到已发布；内容与上传一致", async () => {
  reset();
  const a = await connectedAccount();
  const file = fakeMp4(5, { size: 600 * 1024 }); // 3 块：256K、256K、剩余
  const reads = [];
  adapterModule.hooks.onRead = (len) => reads.push(len);
  const id = plan(a, { video: file, language: "en", meta: { body: "正文", tags: ["a", "b"] } });
  await drain();

  const p = row(id);
  assert.equal(p.state, "published");
  assert.equal(p.external_id, [...mock.state.videos.keys()].at(-1));
  assert.equal(p.external_url, `https://youtu.be/${p.external_id}`);
  assert.ok(p.published_at);
  assert.equal(inserts(), 1);
  assert.ok(reads.length >= 3 && reads.every((len) => len <= CHUNK), `单次读取都不超过分块大小：${reads}`);
  assert.deepEqual(mock.state.puts.filter((x) => x.kind === "chunk").map((x) => x.range), [`bytes 0-${CHUNK - 1}/${600 * 1024}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${600 * 1024}`, `bytes ${2 * CHUNK}-${600 * 1024 - 1}/${600 * 1024}`]);
  assert.equal(vid(id).sha, sha(file), "服务端收到的字节和文件一模一样");
  // 回读：用 videos.list 核实，不信任上传返回；在上传之后调用
  const order = mock.state.requests.map((r) => r.path);
  assert.ok(order.lastIndexOf("/youtube/v3/videos") > order.lastIndexOf(order.filter((x) => x.startsWith("/upload/session/")).at(-1)));
  assert.equal(calls("/youtube/v3/videos", "GET").at(-1).query.part, "snippet,status");
});

test("发布：连接断了从服务端报告的偏移续传，已经收下的块不重发", async () => {
  reset({ dropAfterChunk: 2 });
  const a = await connectedAccount();
  const file = fakeMp4(5, { size: 700 * 1024 });
  const id = plan(a, { video: file });
  await drain();
  assert.equal(row(id).state, "published");
  const chunks = mock.state.puts.filter((x) => x.kind === "chunk").map((x) => x.range);
  assert.equal(new Set(chunks).size, chunks.length, `没有重发已收下的块：${chunks}`);
  assert.equal(mock.state.puts.filter((x) => x.kind === "query").length, 1, "断线后问了一次服务端偏移");
  assert.equal(inserts(), 1, "续传不是重传：只起了一次会话");
  assert.equal(vid(id).sha, sha(file));
});

test("发布：标题、描述、标签来自平台稿，语言来自成片的语言版本；类目 / AI 声明 / 播放列表是平台稿参数，默认都不加", async () => {
  reset();
  const a = await connectedAccount();
  const id = plan(a, { language: "zh", meta: { body: "这是正文", tags: ["#合规", "出海"] }, title: "出海合规第一讲" });
  await drain();
  const { resource } = mock.state.lastInsert;
  assert.equal(resource.snippet.title, "出海合规第一讲");
  assert.equal(resource.snippet.description, "这是正文\n\n#合规 #出海");
  assert.deepEqual(resource.snippet.tags, ["合规", "出海"]);
  assert.equal(resource.snippet.defaultLanguage, "zh");
  assert.equal(resource.snippet.defaultAudioLanguage, "zh");
  assert.equal(resource.snippet.categoryId, "22", "没指定类目用默认值，不是某个频道写死的");
  assert.ok(!("containsSyntheticMedia" in resource.status), "没声明就不替人声明 AI 合成");
  assert.equal(resource.status.selfDeclaredMadeForKids, false);
  assert.equal(resource.status.privacyStatus, "public");
  assert.equal(calls("/youtube/v3/playlists").length + calls("/youtube/v3/playlistItems").length, 0, "默认不加播放列表");
  assert.ok(!resource.snippet.description.includes("#Shorts"));

  const other = plan(a, { language: "default", youtube: { category_id: "27", contains_synthetic_media: true, made_for_kids: false }, meta: { ai_generated: false } });
  await drain();
  const second = mock.state.lastInsert.resource;
  assert.equal(second.snippet.categoryId, "27");
  assert.equal(second.status.containsSyntheticMedia, true);
  assert.ok(!("defaultLanguage" in second.snippet), "语言版本是 default 时不传语言");
  assert.equal(row(other).state, "published");
});

test("发布：竖版且在 Shorts 时长内的按 Shorts 处理（看比例与时长，不靠话题）；横版、过长的不算", async () => {
  reset();
  const a = await connectedAccount();
  const short = plan(a, { video: fakeMp4(45, { width: 1080, height: 1920 }), meta: { tags: ["x"] } });
  const wide = plan(a, { video: fakeMp4(45, { width: 1920, height: 1080 }) });
  const longVertical = plan(a, { video: fakeMp4(400, { width: 1080, height: 1920 }) });
  const rotated = plan(a, { video: fakeMp4(30, { width: 1920, height: 1080, rotate: true }) });
  await drain();
  assert.match(row(short).external_url, /youtube\.com\/shorts\//);
  assert.match(row(wide).external_url, /^https:\/\/youtu\.be\//);
  assert.match(row(longVertical).external_url, /^https:\/\/youtu\.be\//);
  assert.match(row(rotated).external_url, /youtube\.com\/shorts\//, "手机竖拍存成横版 + 旋转矩阵也认得");
  for (const req of mock.state.requests.filter((r) => r.path === "/upload/youtube/v3/videos")) assert.ok(!req.body.includes("#Shorts"));
  assert.equal(shortsVerdict({ durationSec: null, width: null, height: null }).short, false);
  assert.deepEqual(mp4Info(fakeMp4(12, { width: 720, height: 720 })).width, 720);
  assert.equal(shortsVerdict(mp4Info(fakeMp4(12, { width: 720, height: 720 }))).short, true, "方形也算");
});

test("预约发：私享上传 + publishAt，到点由 YouTube 公开；确认后立刻开始上传，不等到预约时间", async () => {
  reset();
  const a = await connectedAccount();
  const at = Date.now() + 3 * 3600e3;
  const id = plan(a, { at, approve: false });
  const approved = coreHandlers["publish.approve"]({ publishId: id });
  assert.equal(approved.approved[0].runAfter, at, "store 按预约时间排的 run");
  const run = db().prepare("SELECT run_after FROM run WHERE target_id = ? AND kind = 'publish'").get(id);
  assert.equal(run.run_after, null, "平台自己能按时公开的，确认后马上开始上传");
  await drain();
  const { resource } = mock.state.lastInsert;
  assert.equal(resource.status.privacyStatus, "private");
  assert.equal(resource.status.publishAt, new Date(at).toISOString());
  assert.equal(row(id).state, "published");
  assert.equal(events(id, "publish.needs_followup").length, 0, "预约成功不是锁私享，不打扰人");
  assert.equal(row(id).fallback_reason, null);
});

test("现在发：按平台稿的可见性直接发；离现在不到 15 分钟的「预约」按现在发", async () => {
  reset();
  const a = await connectedAccount();
  const unlisted = plan(a);
  db().prepare("UPDATE publish SET visibility = 'private' WHERE id = ?").run(unlisted);
  const soon = plan(a, { at: Date.now() + 5 * 60e3, approve: false });
  coreHandlers["publish.approve"]({ publishId: soon });
  await drain();
  const reqs = mock.state.requests.filter((r) => r.path === "/upload/youtube/v3/videos").map((r) => JSON.parse(r.body).status);
  assert.equal(reqs.length, 2);
  assert.ok(reqs.some((s) => s.privacyStatus === "private" && !s.publishAt), "平台稿可见性 private 就直接发私享");
  assert.ok(reqs.some((s) => s.privacyStatus === "public" && !s.publishAt), "15 分钟内按现在发，不带 publishAt");
  assert.equal(row(unlisted).state, "published");
  assert.equal(row(soon).state, "published");
});

// ------------------------------------------------------------------ ACC-youtube-04：不静默的私享；视频在之后的尽力而为

test("强制私享：回读的 privacyStatus 和请求的不一致 → published_limited + visibility_forced_private + 人话 + 事件，不算悄悄成功", async () => {
  reset({ forcePrivate: true });
  const a = await connectedAccount();
  const id = plan(a);
  await drain();
  const p = row(id);
  assert.equal(p.state, "published_limited");
  assert.equal(p.fallback_reason, "visibility_forced_private");
  assert.equal(p.error_code, "visibility_forced_private");
  assert.equal(p.error_message, "YouTube 把这条锁成了私享：接入用的 Google 项目还没过审，需要在 YouTube Studio 里手动改成公开");
  assert.ok(p.external_id && p.external_url, "视频确实在 YouTube 上");
  const fu = db().prepare("SELECT kind, state, verify_hint FROM followup WHERE publish_id = ?").all(id);
  assert.deepEqual(fu.map((f) => f.kind), ["set_visibility_public"]);
  assert.match(fu[0].verify_hint, /手动改成公开/);
  const ev = events(id, "publish.needs_followup");
  assert.equal(ev.length, 1);
  assert.match(ev[0].payload.hint, /锁成了私享/);
  assert.equal(inserts(), 1, "不重传");
  // 成片面板读得到：error 里带着码和人话
  const cut = store.workView?.(row(id).work_id)?.cuts?.[0]?.publishes?.find((x) => x.id === id);
  if (cut) assert.equal(cut.error.code, "visibility_forced_private");
});

test("强制私享（预约发）：YouTube 丢了 publishAt，到点不会公开 → 同样不静默", async () => {
  reset({ forcePrivate: true });
  const a = await connectedAccount();
  const id = plan(a, { at: Date.now() + 2 * 3600e3, approve: false });
  coreHandlers["publish.approve"]({ publishId: id });
  await drain();
  const p = row(id);
  assert.equal(p.state, "published_limited");
  assert.equal(p.fallback_reason, "visibility_forced_private");
  assert.match(p.error_message, /没有保留预约时间/);
});

test("视频已在 YouTube 上后，缩略图、字幕、播放列表失败只写进 notes（事件），不重传、不翻成失败", async () => {
  reset({ failThumbnail: true, failCaptions: true });
  const a = await connectedAccount();
  const cover = join(mkdtempSync(join(tmpdir(), "vk-yt-cover-")), "c.png");
  writeFileSync(cover, Buffer.from("png-bytes"));
  const srt = join(mkdtempSync(join(tmpdir(), "vk-yt-srt-")), "c.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
  const id = plan(a, { meta: { cover }, youtube: { playlist: "不存在的列表", captions: { path: srt, language: "en", name: "English" } } });
  await drain();
  const p = row(id);
  assert.equal(p.state, "published", "视频已发出，尽力而为的步骤失败不改变结果");
  assert.equal(inserts(), 1, "不重传视频");
  const ev = events(id, "publish.needs_followup").find((e) => e.payload.kind === "notes");
  assert.ok(ev, "没做成的步骤不静默：留事件");
  assert.match(ev.payload.hint, /缩略图失败/);
  assert.match(ev.payload.hint, /字幕失败/);
  assert.match(ev.payload.hint, /没有加入播放列表.*不存在的列表/);
  assert.equal(calls("/youtube/v3/playlistItems").length, 0, "找不到播放列表不新建、不乱加");
});

test("尽力而为的步骤成功时：按名字找已有播放列表加入，封面与字幕上传；不留 notes 事件", async () => {
  reset();
  const a = await connectedAccount();
  const cover = join(mkdtempSync(join(tmpdir(), "vk-yt-cover-")), "c.jpg");
  writeFileSync(cover, Buffer.from("jpg-bytes"));
  const id = plan(a, { meta: { cover }, youtube: { playlist: "Existing List" } });
  await drain();
  assert.equal(row(id).state, "published");
  assert.equal(mock.state.thumbnail.type, "image/jpeg");
  assert.equal(mock.state.playlistItem.snippet.playlistId, "PL_mock_1");
  assert.equal(mock.state.playlistItem.snippet.resourceId.videoId, row(id).external_id);
  assert.equal(events(id, "publish.needs_followup").length, 0);
});

test("回读读不到 / 被 YouTube 拒绝：视频已在，绝不重传——转待人确认并留带码的事件", async () => {
  reset({ missingAfterUpload: 99 });
  const a = await connectedAccount();
  const lost = plan(a);
  await drain();
  assert.equal(row(lost).state, "notify_pending");
  assert.equal(row(lost).error_code, "result_unconfirmed");
  assert.match(row(lost).error_message, /已上传.*没有重传/);
  assert.equal(inserts(), 1);

  reset({ rejectionReason: "copyright", uploadStatus: "rejected" });
  const rejected = plan(a);
  await drain();
  const p = row(rejected);
  assert.equal(p.state, "notify_pending");
  assert.equal(p.error_code, "platform_reject");
  assert.match(p.error_message, /版权问题/);
  assert.match(p.error_message, new RegExp(`视频 vid_`));
  assert.equal(inserts(), 1);
  assert.equal(events(rejected, "publish.needs_human").find((e) => e.payload.platform_error === "rejected_copyright")?.payload.error_code, "platform_reject");
});

// ------------------------------------------------------------------ ACC-youtube-05：错误与配额

test("429 / 5xx：指数退避重试后成功；一直 429 则退避用尽，转可稍后重试的 quota（不计次数）", async () => {
  reset({ insertStatuses: [429, 503, 500] });
  const a = await connectedAccount();
  const id = plan(a);
  await drain();
  assert.equal(row(id).state, "published");
  assert.equal(inserts(), 4, "三次可重试的失败 + 一次成功");

  reset({ insertStatuses: [429, 429, 429, 429, 429, 429] });
  const stuck = plan(a);
  await drain();
  const p = row(stuck);
  assert.equal(p.error_code, "quota");
  assert.match(p.error_message, /持续限流/);
  assert.equal(p.state, "auto_running", "quota 不是失败：队列稍后再试");
  assert.equal(acct(a.accountId).is_manual, 0, "429 不暂停账号");
});

test("quotaExceeded：立即停下、不重试，暂停到太平洋时间次日零点并发事件；暂停期内这个项目的发布不联网；到点后放开", async () => {
  reset({ quotaExceeded: true });
  const a = await connectedAccount();
  const id = plan(a);
  const t0 = Date.now();
  await drain();
  assert.equal(inserts(), 1, "quotaExceeded 不重试");
  const p = row(id);
  assert.equal(p.state, "notify_pending");
  assert.equal(p.error_code, "platform_reject");
  assert.match(p.error_message, /配额用完.*不会重试/);
  assert.match(p.error_message, /太平洋时间/);
  assert.equal(acct(a.accountId).is_manual, 1, "账号暂停");
  const until = quota.nextPtMidnight(t0);
  const ev = events(id, "publish.needs_human").find((e) => e.payload.platform_error === "quotaExceeded");
  assert.ok(ev, "发事件");
  assert.equal(ev.payload.accountPaused, true);
  assert.ok(Math.abs(ev.payload.pausedUntil - until) <= 1000);
  assert.ok(until > t0 && until - t0 <= 25 * 3600e3);

  // 暂停期内：同账号再发 → 不调适配器；别的账号（同一个 Google 项目）→ 适配器不联网直接停
  mock.state.requests.length = 0;
  mock.state.quotaExceeded = false;
  const again = plan(a);
  await drain();
  assert.equal(row(again).state, "notify_pending");
  assert.match(row(again).error_message ?? "", /暂停|配额/);
  assert.equal(inserts(), 0, "暂停期内不联网");
  const b = await connectedAccount();
  mock.state.requests.length = 0;
  const other = plan(b);
  await drain();
  assert.equal(inserts(), 0, "配额按 Google 项目计：同项目的别的账号也不能撞");
  assert.equal(row(other).state, "notify_pending");

  // 到点：记账里的暂停过期 → core 放开账号
  const f = credentialPath("youtube/_quota.json");
  const all = JSON.parse(readFileSync(f, "utf8"));
  for (const proj of Object.values(all.projects)) proj.paused_until = Date.now() - 1000;
  writeFileSync(f, JSON.stringify(all));
  await checkAccount(adapters, a.accountId);
  assert.equal(acct(a.accountId).is_manual, 0, "到点自动放开");
  const retry = plan(a);
  await drain();
  assert.equal(row(retry).state, "published");
});

test("uploadLimitExceeded：platform_reject + 人话 + 带原码的事件，不重试、不暂停账号", async () => {
  reset({ uploadLimit: true });
  const a = await connectedAccount();
  const id = plan(a);
  await drain();
  const p = row(id);
  assert.equal(inserts(), 1);
  assert.equal(p.state, "notify_pending");
  assert.equal(p.error_code, "platform_reject");
  assert.match(p.error_message, /今天上传的视频数到上限/);
  assert.ok(events(id, "publish.needs_human").some((e) => e.payload.platform_error === "uploadLimitExceeded"));
  assert.equal(acct(a.accountId).is_manual, 0);
});

test("token 失效（401）：转「需要重新登录」+ error_code=auth + 事件，不重试", async () => {
  reset();
  const a = await connectedAccount();
  mock.state.unauthorized = true;
  const id = plan(a);
  await drain();
  const p = row(id);
  assert.equal(p.state, "blocked");
  assert.equal(p.error_code, "auth");
  assert.match(p.error_message, /重新授权/);
  assert.equal(acct(a.accountId).state, "expired");
  assert.ok(events(id, "account.expired").length >= 1);
  assert.equal(mock.state.puts.length, 0, "一个字节都没传，不会留下半截视频");
  assert.equal(inserts(), 1, "起会话被 401 挡回，没有重试");
});

test("授权里缺「管理账号」权限：授权时就拒绝；之后权限被收回的，上传之前就拦下（回读读不了就不要传）", async () => {
  reset({ scope: "https://www.googleapis.com/auth/youtube.upload" });
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id: noManage } = store.addAccount({ platform: "youtube", handle: "@nomanage", groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: noManage });
  await mock.approve(first.url, { code: "code_nomanage" });
  await assert.rejects(coreHandlers["account.connect"]({ accountId: noManage, timeoutMs: 5000 }), /管理 YouTube 账号.*权限/);

  reset();
  const a = await connectedAccount();
  const file = credentialPath(acct(a.accountId).credential_ref);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), scope: "https://www.googleapis.com/auth/youtube.upload" }), { mode: 0o600 });
  const id = plan(a);
  await drain();
  assert.equal(inserts(), 0, "没有起上传会话");
  assert.equal(row(id).error_code, "auth");
  assert.match(row(id).error_message, /管理账号.*没有上传/);
});

test("文件被 YouTube 判为损坏（failureReason）：asset_invalid 终态 + 人话，不重试", async () => {
  reset({ uploadStatus: "failed", failureReason: "invalidFile" });
  const a = await connectedAccount();
  const id = plan(a);
  await drain();
  const p = row(id);
  assert.equal(p.state, "failed");
  assert.equal(p.error_code, "asset_invalid");
  assert.match(p.error_message, /处理不了这个视频文件/);
  assert.equal(inserts(), 1);
});

test("发布前预估配额：今天剩的不够就不开始上传，并说明原因", async () => {
  reset();
  process.env.VK_YOUTUBE_DAILY_INSERTS = "1";
  const a = await connectedAccount();
  const first = plan(a);
  await drain();
  assert.equal(row(first).state, "published");
  mock.state.requests.length = 0;
  const second = plan(a);
  await drain();
  assert.equal(inserts(), 0, "没有开始上传");
  assert.equal(calls("/token").length, 0, "连授权都没碰");
  const p = row(second);
  assert.equal(p.state, "notify_pending");
  assert.match(p.error_message, /上传配额不够.*已上传 1\/1 次.*没有开始上传.*重置/);

  delete process.env.VK_YOUTUBE_DAILY_INSERTS;
  process.env.VK_YOUTUBE_DAILY_UNITS = "3";
  const third = plan(a, { youtube: { playlist: "Existing List" } });
  await drain();
  assert.match(row(third).error_message, /接口配额不够.*预计还要/);
  delete process.env.VK_YOUTUBE_DAILY_UNITS;
});

test("太平洋时间：次日零点（含夏令时切换日）、配额日按太平洋时间切", () => {
  const z = (s) => Date.parse(s);
  assert.equal(quota.nextPtMidnight(z("2026-11-21T10:00:00Z")), z("2026-11-22T08:00:00Z")); // PST = UTC-8
  assert.equal(quota.nextPtMidnight(z("2026-07-01T10:00:00Z")), z("2026-07-02T07:00:00Z")); // PDT = UTC-7
  assert.equal(quota.nextPtMidnight(z("2026-03-08T20:00:00Z")), z("2026-03-09T07:00:00Z")); // 夏令时开始日（23 小时）
  assert.equal(quota.nextPtMidnight(z("2026-11-01T20:00:00Z")), z("2026-11-02T08:00:00Z")); // 夏令时结束日（25 小时）
  assert.equal(quota.nextPtMidnight(z("2026-11-01T06:00:00Z")), z("2026-11-01T07:00:00Z")); // 前一天 23:00 PDT
  assert.equal(quota.ptDay(z("2026-11-22T07:59:00Z")), "2026-11-21");
  assert.equal(quota.ptDay(z("2026-11-22T08:00:00Z")), "2026-11-22");
});

// ------------------------------------------------------------------ ACC-youtube-06：采集

test("collect：videos.list(statistics) 回填播放、点赞、评论；授权里有 Analytics 权限时再取观看时长", async () => {
  reset();
  const a = await connectedAccount();
  const id = plan(a);
  await drain();
  const handlers = buildHandlers(adapters, { log: () => {} });
  const snap = await handlers.collect({ target_id: id });
  assert.equal(snap.duplicate, false);
  const metrics = JSON.parse(db().prepare("SELECT metrics_json, source, status FROM snapshot WHERE publish_id = ?").get(id).metrics_json);
  assert.equal(metrics.play, 1234, "和别的平台一样用 play 这个键，倍数口径才一致");
  assert.equal(metrics.like, 56);
  assert.equal(metrics.comment, 7);
  assert.equal(metrics.watch_minutes, 42);
  assert.equal(metrics.avg_view_seconds, 61);
  const row0 = db().prepare("SELECT source, status FROM snapshot WHERE publish_id = ?").get(id);
  assert.deepEqual({ ...row0 }, { source: "api", status: "ok" });
  assert.equal(calls("/youtube/v3/videos", "GET").at(-1).query.part, "statistics");
});

test("collect：授权里没有 Analytics 权限、或 Analytics 接口出错时不报错，只是没有观看时长", async () => {
  reset({ scope: ALL_SCOPES.slice(0, 2).join(" ") });
  const a = await connectedAccount();
  const id = plan(a);
  await drain();
  const res = await adapterModule.default.collect({ publishId: id });
  assert.equal(res.status, "ok");
  assert.equal(res.metrics.play, 1234);
  assert.ok(!("watch_minutes" in res.metrics));
  assert.equal(calls("/v2/reports").length, 0, "没有权限就不请求");

  reset({ analyticsFails: true });
  const b = await connectedAccount();
  const id2 = plan(b);
  await drain();
  const res2 = await adapterModule.default.collect({ publishId: id2 });
  assert.equal(res2.metrics.play, 1234);
  assert.ok(!("watch_minutes" in res2.metrics));
});

test("collect：视频读不到（被删或还是私享）→ 带人话的错，不是静默的零", async () => {
  reset();
  const a = await connectedAccount();
  const id = plan(a);
  await drain();
  mock.state.videos.clear();
  await assert.rejects(adapterModule.default.collect({ publishId: id }), /读不到视频/);
});

// ------------------------------------------------------------------ 返工：CLI dry-run 真走到适配器；强制私享在今天页和作品页看得到

test("ACC-youtube-01 vk publish <素材> --to youtube --dry-run：走到适配器彩排，给出标题/简介/标签/类目/可见性/预约/预计配额，且不写库不联网", async () => {
  reset();
  const a = await connectedAccount();
  const file = fakeMp4(20);
  const when = Date.now() + 3 * 3600e3;
  const counts = () => ["work", "publish", "event"].map((t) => db().prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  const before = counts();
  mock.state.requests.length = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("dry-run 不应联网"); };
  let out;
  try {
    out = await coreHandlers["publish.create"]({ asset: file, to: ["youtube"], group: a.groupId, title: "预演标题", body: "预演正文", tags: ["a", "b"], schedule: when, visibility: "public", dryRun: true });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(out.dryRun, true);
  assert.deepEqual(counts(), before, "没有写任何行");
  assert.equal(mock.state.requests.length, 0);
  const v = out.publishes[0].preview;
  assert.equal(v.resource.snippet.title, "预演标题");
  assert.match(v.resource.snippet.description, /预演正文/);
  assert.deepEqual(v.resource.snippet.tags, ["a", "b"]);
  assert.ok(v.resource.snippet.categoryId);
  assert.equal(v.resource.status.privacyStatus, "private", "预约发先私享");
  assert.equal(v.resource.status.publishAt, new Date(when).toISOString());
  assert.ok(v.estimatedQuota.inserts >= 1 && v.estimatedQuota.units >= 1);
});

test("ACC-youtube-01 dry-run 里就发不出去的（没有标题）照实写进预览，不吞掉", async () => {
  reset();
  const a = await connectedAccount();
  const out = await coreHandlers["publish.create"]({ asset: fakeMp4(5), to: ["youtube"], group: a.groupId, title: "   ", dryRun: true });
  assert.equal(out.publishes[0].preview.error.code, "asset_invalid");
});

test("ACC-youtube-04 强制私享：今天页列出、作品状态算出了问题、作品页有人话，不再是「都发完了」", async () => {
  reset({ forcePrivate: true });
  const a = await connectedAccount();
  const id = plan(a, { title: "被锁私享" });
  await drain();
  assert.equal(row(id).state, "published_limited");
  assert.equal(row(id).error_code, "visibility_forced_private");
  const overview = await import("../../core/src/overview.mjs");
  const today = overview.buildToday({ groupId: a.groupId });
  const hit = today.problems.find((p) => p.publishId === id);
  assert.ok(hit, "今天页的 problems 里有这条");
  assert.equal(hit.error.code, "visibility_forced_private");
  assert.match(hit.error.message, /锁成了私享/);
  const work = overview.showWorkInScope(row(id).work_id, a.groupId);
  assert.equal(work.status.key, "problem");
  assert.equal(work.cuts[0].status.key, "problem");
  const html = readFileSync(join(ROOT, "../web/public/work.html"), "utf8");
  assert.match(html, /forcedPrivate/);
  assert.match(readFileSync(join(ROOT, "../web/public/today.html"), "utf8"), /published_limited/);
});

test("ACC-acct-iso-05/06：官方接口换号清授权令牌：这个账号的令牌文件没了、check 判没连上，别的账号的令牌还在", async () => {
  const a = await connectedAccount();
  const b = await connectedAccount();
  const refOf = (id) => db().prepare("SELECT credential_ref FROM account WHERE id=?").get(id).credential_ref;
  const refA = refOf(a.accountId);
  const refB = refOf(b.accountId);
  assert.ok(existsSync(credentialPath(refA)) && existsSync(credentialPath(refB)));
  const out = adapterModule.default.logout({ accountId: a.accountId, credentialRef: refA });
  assert.equal(out.removed, true);
  assert.equal(existsSync(credentialPath(refA)), false, "这个账号的令牌文件已删");
  assert.equal(existsSync(credentialPath(refB)), true, "别的账号的令牌不动");
  assert.equal(adapterModule.default.logout({ accountId: a.accountId, credentialRef: refA }).removed, false, "重复清不报错");
  db().prepare("UPDATE account SET credential_ref = NULL WHERE id=?").run(a.accountId); // vk 的 logout 同步清账号行
  await assert.rejects(checkAccount(adapters, a.accountId), (err) => err.code === "auth", "清掉令牌后 check 判需要重新登录");
  assert.equal(db().prepare("SELECT state FROM account WHERE id=?").get(a.accountId).state, "expired", "状态变没连上");
  assert.equal((await checkAccount(adapters, b.accountId)).state, "ok", "别的账号照常");
});
