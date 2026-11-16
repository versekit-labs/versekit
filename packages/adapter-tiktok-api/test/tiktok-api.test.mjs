// TikTok 官方接口适配器：对本地 mock 服务端跑通授权、Direct Post、草稿箱，并逐个钉住错误处理。
// 全程只连 127.0.0.1 的 mock，不连 open.tiktokapis.com，不用真实 client_key。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const HOME = mkdtempSync(join(tmpdir(), "vk-tta-"));
process.env.VK_HOME = HOME;
process.env.VK_NO_BROWSER = "1";
process.env.VK_TIKTOK_BACKOFF_MS = "1";
process.env.VK_TIKTOK_POLL_MS = "1";

const core = await import("../../core/src/index.mjs");
const store = await import("../../core/src/store.mjs");
const { loadAdapters, buildHandlers, checkAccount } = await import("../../core/src/adapters.mjs");
const { createCoreHandlers } = await import("../../core/src/handlers.mjs");
const { createRunner } = await import("../../core/src/runner.mjs");
const { validateAdapter } = await import("../../core/src/contract.mjs");
const { codeChallenge, newCodeVerifier, newState } = await import("../src/pkce.mjs");
const { mp4DurationSeconds } = await import("../src/mp4.mjs");
const { startMock } = await import("./mock-tiktok.mjs");
const adapterModule = await import("../src/index.mjs");
const { credentialPath } = await import("../src/settings.mjs");

core.migrate();
const db = () => core.open();

let mock;
let adapters;
let coreHandlers;
let n = 0;

before(async () => {
  mock = await startMock();
  process.env.TIKTOK_API_BASE = mock.base;
  process.env.TIKTOK_AUTH_BASE = mock.base;
  process.env.TIKTOK_CLIENT_KEY = mock.state.clientKey;
  process.env.TIKTOK_CLIENT_SECRET = mock.state.clientSecret;
  adapters = (await loadAdapters({ only: ["tiktok-api"] })).adapters;
  coreHandlers = createCoreHandlers({ adapters, log: () => {} });
});
after(() => mock.close());

const reset = (patch = {}) => {
  mock.state.requests.length = 0;
  mock.state.uploads.length = 0;
  mock.state.pollCount = 0;
  Object.assign(mock.state, {
    initError: null,
    creatorError: null,
    tooManyRequests: 0,
    statusSequence: ["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"],
    failReason: null,
    privacyOptions: ["SELF_ONLY"],
    commentDisabled: false,
    duetDisabled: true,
    stitchDisabled: false,
    maxDuration: 600,
    accessTokenInvalid: false,
    tokenRefreshFails: false,
    ...patch,
  });
};
const calls = (path) => mock.state.requests.filter((r) => r.path === path);

/** 做一个最小 mp4：ftyp + moov{mvhd}，时长可指定；尾部补零到 size 字节。 */
function fakeMp4(seconds, size = 3000) {
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type), body]); };
  const mvhd = box("mvhd", Buffer.concat([u32(0), u32(0), u32(0), u32(1000), u32(Math.round(seconds * 1000)), Buffer.alloc(80)]));
  const head = Buffer.concat([box("ftyp", Buffer.from("isom"), u32(0)), box("moov", mvhd)]);
  const pad = Math.max(0, size - head.length);
  const file = join(mkdtempSync(join(tmpdir(), "vk-tta-vid-")), `v${++n}.mp4`);
  writeFileSync(file, Buffer.concat([head, Buffer.alloc(pad, 7)]));
  return file;
}

/** 授权一个新账号：走真实的 account.connect 两段式流程。 */
async function connectedAccount() {
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "tiktok-api", handle: `@mock${n}`, displayName: `号${n}`, groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: id });
  assert.equal(first.state, "waiting");
  await mock.approve(first.url, { code: `code_${n}` });
  const done = await coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 });
  assert.equal(done.state, "connected");
  return { accountId: id, groupId: group.id };
}

/** 建作品 + 平台稿，按需填发布设置，确认后返回平台稿 id。 */
function plan({ accountId }, { video = fakeMp4(5), meta = null, edit = null, approve = true } = {}) {
  const work = store.upsertWork({ title: `作品 ${++n}`, cuts: [{ title: `作品 ${n}`, versions: [{ language: "default", asset: video }] }], meta });
  const pub = store.createPublish({ workId: work.id, accountId });
  if (edit) store.editPublish({ publishId: pub.id, ...edit });
  if (approve) store.approvePublishes({ publishId: pub.id });
  return pub.id;
}

async function drain() {
  const runner = createRunner({ handlers: buildHandlers(adapters, { log: () => {} }), log: () => {} });
  for (let i = 0; i < 5; i++) await runner.tick();
}
const row = (id) => db().prepare("SELECT * FROM publish WHERE id = ?").get(id);
const events = (publishId, type) => db().prepare("SELECT * FROM event WHERE publish_id = ? AND type = ?").all(publishId, type).map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));

// ------------------------------------------------------------------ ACC-tiktok-api-01：PKCE / 回调 / state

test("PKCE：code_challenge 是 verifier 的 SHA256 hex，不是 base64url", () => {
  // SHA256("abc") 的标准向量
  assert.equal(codeChallenge("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const v = newCodeVerifier();
  assert.equal(codeChallenge(v), createHash("sha256").update(v).digest("hex"));
  assert.match(codeChallenge(v), /^[0-9a-f]{64}$/);
  assert.notEqual(codeChallenge(v), createHash("sha256").update(v).digest("base64url"));
});

test("PKCE：每次授权新生成 verifier 与 state，长度合规", () => {
  const vs = new Set(Array.from({ length: 20 }, newCodeVerifier));
  assert.equal(vs.size, 20);
  for (const v of vs) assert.match(v, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.notEqual(newState(), newState());
});

test("授权：回调在 127.0.0.1 临时端口的 /callback/tiktok/，拿到 code 后立刻关端口，授权链接带 hex challenge", async () => {
  reset();
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "tiktok-api", handle: "@portcheck", groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: id });
  const url = new URL(first.url);
  assert.equal(url.searchParams.get("client_key"), "mock_key");
  assert.equal(url.searchParams.get("scope"), "user.info.basic,video.publish,video.upload");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge"), /^[0-9a-f]{64}$/);
  const redirect = new URL(url.searchParams.get("redirect_uri"));
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(redirect.pathname, "/callback/tiktok/");
  // 别的路径不接
  assert.equal((await fetch(`${redirect.origin}/other`)).status, 404);
  await mock.approve(first.url, { code: "code_port" });
  const done = await coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 });
  assert.equal(done.state, "connected");
  // 端口已关：再连会被拒
  await assert.rejects(fetch(redirect.origin + redirect.pathname), /fetch failed/);
});

test("授权：state 不符时拒绝并给人话，不用其中的 code，端口也关掉", async () => {
  reset();
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "tiktok-api", handle: "@csrf", groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: id });
  const redirect = new URL(new URL(first.url).searchParams.get("redirect_uri"));
  const res = await mock.approve(first.url, { state: "forged", code: "code_csrf" });
  assert.equal(res.status, 400);
  await assert.rejects(coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 }), /state 对不上/);
  assert.equal(calls("/v2/oauth/token/").length, 0, "state 不符时不能拿 code 去换 token");
  await assert.rejects(fetch(redirect.origin + redirect.pathname), /fetch failed/);
  assert.equal(db().prepare("SELECT credential_ref FROM account WHERE id=?").get(id).credential_ref, null);
});

test("授权：用户在 TikTok 页面上取消，给人话", async () => {
  reset();
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "tiktok-api", handle: "@deny", groupId: group.id });
  const first = await coreHandlers["account.connect"]({ accountId: id });
  await mock.approve(first.url, { error: "access_denied" });
  await assert.rejects(coreHandlers["account.connect"]({ accountId: id, timeoutMs: 5000 }), /取消了授权/);
});

// ------------------------------------------------------------------ ACC-tiktok-api-02：user.info / 凭证 / 续期

test("授权成功：头像昵称存到账号，token 只在本机凭证目录（0600），账号表只有 credential_ref", async () => {
  reset();
  const { accountId } = await connectedAccount();
  const acc = db().prepare("SELECT * FROM account WHERE id = ?").get(accountId);
  assert.equal(acc.display_name, "Mock Creator");
  assert.match(acc.credential_ref, /^tiktok-api\/.+\.json$/);
  const file = credentialPath(acc.credential_ref);
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  assert.match(rec.access_token, /^at_/);
  assert.equal(rec.profile.avatar_url, "https://mock.test/a.jpg");
  // 账号表任何一列都不含 token
  assert.ok(!JSON.stringify(acc).includes(rec.access_token));
  assert.ok(!JSON.stringify(acc).includes(rec.refresh_token));
  // 界面：account.list 带头像
  const list = coreHandlers["account.list"]({});
  const view = list.accounts.find((a) => a.id === accountId);
  assert.equal(view.avatar_url, "https://mock.test/a.jpg");
  assert.ok(!JSON.stringify(list).includes(rec.access_token), "account.list 不能带出 token");
  // 授权时调了 user.info.basic，换 token 时带了 verifier 和 redirect_uri
  assert.ok(calls("/v2/user/info/").length >= 1);
});

test("续期：access_token 过期前用 refresh_token 换新并写回；公开接口用的是新 token", async () => {
  reset();
  const acct = await connectedAccount();
  const ref = db().prepare("SELECT credential_ref FROM account WHERE id=?").get(acct.accountId).credential_ref;
  const file = credentialPath(ref);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  const old = rec.access_token;
  writeFileSync(file, JSON.stringify({ ...rec, expires_at: Date.now() + 60_000 }), { mode: 0o600 }); // 一分钟后过期 < 5 分钟边界
  const info = await adapterModule.default.creatorInfo({ accountId: acct.accountId });
  assert.deepEqual(info.privacyLevelOptions, ["SELF_ONLY"]);
  const next = JSON.parse(readFileSync(file, "utf8"));
  assert.notEqual(next.access_token, old);
  assert.ok(next.expires_at > Date.now() + 3600_000);
  assert.equal(calls("/v2/post/publish/creator_info/query/").at(-1).headers.authorization, `Bearer ${next.access_token}`);
});

test("续期失败：账号变「需要重新登录」并发事件", async () => {
  reset({ tokenRefreshFails: true });
  const acct = await connectedAccount();
  const ref = db().prepare("SELECT credential_ref FROM account WHERE id=?").get(acct.accountId).credential_ref;
  const file = credentialPath(ref);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), expires_at: Date.now() - 1000 }), { mode: 0o600 });
  await assert.rejects(checkAccount(adapters, acct.accountId), (err) => err.code === "auth");
  assert.equal(db().prepare("SELECT state FROM account WHERE id=?").get(acct.accountId).state, "expired");
  const ev = db().prepare("SELECT * FROM event WHERE type='account.expired' AND payload_json LIKE ?").all(`%${acct.accountId}%`);
  assert.equal(ev.length, 1);
});

test("没授权过的账号：check 报需要重新登录，不联网", async () => {
  reset();
  const group = store.addGroup({ name: `组 ${++n}` });
  const { id } = store.addAccount({ platform: "tiktok-api", handle: "@fresh", groupId: group.id });
  await assert.rejects(checkAccount(adapters, id), (err) => err.code === "auth" && /还没有授权/.test(err.message));
  assert.equal(mock.state.requests.length, 0);
});

test("client_key / client_secret 只从环境变量或本地配置读：都没有时 ready() 说清楚", () => {
  const saved = { k: process.env.TIKTOK_CLIENT_KEY, s: process.env.TIKTOK_CLIENT_SECRET };
  delete process.env.TIKTOK_CLIENT_KEY;
  delete process.env.TIKTOK_CLIENT_SECRET;
  try {
    assert.match(adapterModule.default.ready(), /TIKTOK_CLIENT_KEY/);
    core.ensureDirs();
    writeFileSync(core.paths().configFile, JSON.stringify({ tiktok: { client_key: "k", client_secret: "s" } }));
    assert.equal(adapterModule.default.ready(), null, "本地配置也算");
    writeFileSync(core.paths().configFile, "{}");
  } finally {
    process.env.TIKTOK_CLIENT_KEY = saved.k;
    process.env.TIKTOK_CLIENT_SECRET = saved.s;
  }
});

// ------------------------------------------------------------------ ACC-tiktok-api-03：Direct Post / 草稿箱

test("契约：能力声明合法，dry-run 不联网", async () => {
  const info = validateAdapter(adapterModule.default, "adapter-tiktok-api");
  assert.equal(info.platform, "tiktok-api");
  assert.equal(info.publish, "api");
  assert.equal(info.draft, true);
  assert.deepEqual(info.visibility, [], "隐私级别不在适配器里硬编码");
  reset();
  assert.deepEqual(await adapterModule.default.publish({ publishId: "x", asset: "/nonexistent", dryRun: true }), { dryRun: true });
  assert.equal(mock.state.requests.length, 0);
});

test("Direct Post：creator_info → init(FILE_UPLOAD 分片) → 上传 → 轮询 → 已发布", async () => {
  reset();
  process.env.VK_TIKTOK_CHUNK_BYTES = "1024";
  try {
    const acct = await connectedAccount();
    const video = fakeMp4(5, 3000);
    const id = plan(acct, { video, edit: { privacy: "SELF_ONLY", caption: "我的第一条" } });
    await drain();

    const p = row(id);
    assert.equal(p.state, "published");
    assert.equal(p.external_id, mock.state.postId);
    assert.ok(p.published_at);
    assert.equal(p.visibility, "public", "平台稿原本的可见性字段不被适配器改写");

    // 调用顺序：creator_info 在 init 之前
    const order = mock.state.requests.map((r) => r.path).filter((x) => x.startsWith("/v2/post/") || x.startsWith("/upload/"));
    assert.equal(order[0], "/v2/post/publish/creator_info/query/");
    assert.equal(order[1], "/v2/post/publish/video/init/");
    assert.ok(order.indexOf("/upload/v_pub_1") > 1);
    assert.equal(order.at(-1), "/v2/post/publish/status/fetch/");

    const init = mock.state.lastInit.body;
    assert.equal(init.source_info.source, "FILE_UPLOAD");
    assert.equal(init.source_info.video_size, 3000);
    assert.equal(init.source_info.chunk_size, 1024);
    assert.equal(init.source_info.total_chunk_count, 2);
    assert.equal(init.post_info.title, "我的第一条");
    assert.equal(init.post_info.privacy_level, "SELF_ONLY");
    // 评论、合拍、拼接默认全关（disable_* = true）；没有 AI 标记、没有水印相关字段
    assert.equal(init.post_info.disable_comment, true);
    assert.equal(init.post_info.disable_duet, true);
    assert.equal(init.post_info.disable_stitch, true);
    assert.ok(!("is_aigc" in init.post_info));
    assert.ok(!JSON.stringify(init).toLowerCase().includes("watermark"));

    // 分片：0-1023 与 1024-2999，合起来就是整个文件
    assert.deepEqual(mock.state.uploads.map((u) => u.range), ["bytes 0-1023/3000", "bytes 1024-2999/3000"]);
    assert.equal(mock.state.uploads.reduce((s, u) => s + u.length, 0), 3000);
    assert.equal(mock.state.uploads[0].type, "video/mp4");
  } finally {
    delete process.env.VK_TIKTOK_CHUNK_BYTES;
  }
});

test("Direct Post：人打开的开关、AI 生成标记都进请求", async () => {
  reset({ duetDisabled: false });
  const acct = await connectedAccount();
  const id = plan(acct, { meta: { ai_generated: true }, edit: { privacy: "SELF_ONLY", comment: true, duet: true } });
  await drain();
  assert.equal(row(id).state, "published");
  const post = mock.state.lastInit.body.post_info;
  assert.equal(post.is_aigc, true, "AI 生成的作品要带 is_aigc");
  assert.equal(post.disable_comment, false);
  assert.equal(post.disable_duet, false);
  assert.equal(post.disable_stitch, true);
});

test("草稿箱：inbox/video/init，状态是「已送到草稿箱」(draft_pending)，不算已发布，且说清是你的选择", async () => {
  reset({ statusSequence: ["PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"] });
  const acct = await connectedAccount();
  const id = plan(acct, { edit: { draft: true } });
  await drain();
  const p = row(id);
  assert.equal(p.state, "draft_pending");
  assert.equal(p.published_at, null);
  assert.equal(mock.state.lastInit.path, "/v2/post/publish/inbox/video/init/");
  assert.equal(calls("/v2/post/publish/video/init/").length, 0);
  assert.equal(calls("/v2/post/publish/creator_info/query/").length, 0, "草稿箱不需要隐私级别，也不查 creator_info");
  assert.ok(!("post_info" in mock.state.lastInit.body));
  const [ev] = events(id, "publish.needs_human");
  assert.equal(ev.payload.kind, "draft_sent");
  assert.match(ev.payload.message, /草稿箱.*TikTok App.*不是发布失败/);
  assert.equal(p.error_code, null);
});

test("隐私级别没选：适配器拒绝，没有任何上传；核心在确认时就拦下并给人话", async () => {
  reset();
  const acct = await connectedAccount();
  const work = store.upsertWork({ title: `作品 ${++n}`, cuts: [{ title: "c", versions: [{ language: "default", asset: fakeMp4(5) }] }] });
  const pub = store.createPublish({ workId: work.id, accountId: acct.accountId });
  assert.throws(() => store.approvePublishes({ publishId: pub.id }), /没选不会发.*--privacy.*account creator/s);
  assert.throws(() => store.publishNow({ publishId: pub.id }), /没选不会发/);
  assert.equal(row(pub.id).state, "pending_confirm");
  // 绕过确认直接进队列（不该发生，但防线要在）：适配器也不发
  db().prepare("UPDATE publish SET state='queued' WHERE id=?").run(pub.id);
  core.enqueue({ kind: "publish", targetType: "publish", targetId: pub.id, lane: acct.accountId });
  await drain();
  assert.equal(calls("/v2/post/publish/video/init/").length, 0);
  assert.match(row(pub.id).error_message, /还没选 TikTok 隐私级别/);
});

test("隐私选项只来自 creator_info：未审核阶段只给 SELF_ONLY，选 PUBLIC 被拒", async () => {
  reset({ privacyOptions: ["SELF_ONLY"] });
  const acct = await connectedAccount();
  const id = plan(acct, { edit: { privacy: "PUBLIC_TO_EVERYONE" } });
  await drain();
  assert.notEqual(row(id).state, "published");
  assert.match(row(id).error_message, /PUBLIC_TO_EVERYONE 现在不可选.*SELF_ONLY/);
  assert.equal(calls("/v2/post/publish/video/init/").length, 0);

  // creator_info 放开后同样的代码就能发公开：选项不是硬编码的
  reset({ privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] });
  const id2 = plan(acct, { edit: { privacy: "PUBLIC_TO_EVERYONE" } });
  await drain();
  assert.equal(row(id2).state, "published");
  assert.equal(row(id2).visibility, "public");
  assert.equal(mock.state.lastInit.body.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
});

test("creator_info 不允许的开关被打开：发布前就报错", async () => {
  reset({ duetDisabled: true });
  const acct = await connectedAccount();
  const id = plan(acct, { edit: { privacy: "SELF_ONLY", duet: true } });
  await drain();
  assert.match(row(id).error_message, /合拍/);
  assert.equal(calls("/v2/post/publish/video/init/").length, 0);
});

test("时长超过 creator_info 上限：在上传前就报错（asset_invalid）", async () => {
  reset({ maxDuration: 60 });
  const acct = await connectedAccount();
  const video = fakeMp4(125, 2000);
  assert.equal(Math.round(mp4DurationSeconds(video)), 125);
  const id = plan(acct, { video, edit: { privacy: "SELF_ONLY" } });
  await drain();
  const p = row(id);
  assert.equal(p.state, "failed");
  assert.equal(p.error_code, "asset_invalid");
  assert.match(p.error_message, /125 秒.*最长 60 秒/);
  assert.equal(calls("/v2/post/publish/video/init/").length, 0);
  assert.equal(mock.state.uploads.length, 0);
});

test("TikTok 处理失败（fail_reason）：留现场，error_code + 人话", async () => {
  reset({ statusSequence: ["PROCESSING_UPLOAD", "FAILED"], failReason: "duration_check_failed" });
  const acct = await connectedAccount();
  const id = plan(acct, { edit: { privacy: "SELF_ONLY" } });
  await drain();
  assert.equal(row(id).state, "failed");
  assert.equal(row(id).error_code, "asset_invalid");
  assert.match(row(id).error_message, /duration_check_failed/);
});

// ------------------------------------------------------------------ ACC-tiktok-api-04：错误处理

test("429：指数退避后重试，最终成功", async () => {
  reset({ tooManyRequests: 2 });
  const acct = await connectedAccount();
  const id = plan(acct, { edit: { privacy: "SELF_ONLY" } });
  await drain();
  assert.equal(row(id).state, "published");
  assert.equal(calls("/v2/post/publish/video/init/").length, 3, "两次 429 + 一次成功");
});

test("429 一直不停：退避用尽后是 quota（可由队列稍后重试），不是静默失败", async () => {
  reset({ tooManyRequests: 99 });
  const acct = await connectedAccount();
  const id = plan(acct, { edit: { privacy: "SELF_ONLY" } });
  await drain();
  assert.equal(calls("/v2/post/publish/video/init/").length, 5, "1 次 + 4 次退避重试");
  assert.equal(row(id).error_code, "quota");
  assert.match(row(id).error_message, /持续限流/);
  assert.notEqual(row(id).state, "published");
});

for (const code of ["spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap"]) {
  test(`${code}：立即暂停账号、推事件、不重试`, async () => {
    reset({ initError: { status: 403, code } });
    const acct = await connectedAccount();
    const id = plan(acct, { edit: { privacy: "SELF_ONLY" } });
    // 同一账号还有一条排着的：暂停后它不能绕过去
    const id2 = plan(acct, { edit: { privacy: "SELF_ONLY" } });
    await drain();

    assert.equal(calls("/v2/post/publish/video/init/").length, 1, "不重试：init 只被调了一次");
    const p = row(id);
    assert.equal(p.state, "notify_pending");
    assert.equal(p.error_code, "platform_reject");
    assert.ok(p.error_message.includes(code), "人话里带着 TikTok 的原始码");
    assert.equal(db().prepare("SELECT state FROM run WHERE target_id=?").get(id).state, "done", "run 正常结束，不再排重试");

    const acc = db().prepare("SELECT is_manual, state FROM account WHERE id=?").get(acct.accountId);
    assert.equal(acc.is_manual, 1, "账号已暂停");
    assert.equal(acc.state, code === "spam_risk_user_banned_from_posting" ? "banned" : "ok");

    const [ev] = events(id, "publish.needs_human");
    assert.equal(ev.severity, "critical");
    assert.equal(ev.payload.platform_error, code);
    assert.equal(ev.payload.accountPaused, true);
    assert.equal(events(id, "account.banned").length, code === "spam_risk_user_banned_from_posting" ? 1 : 0);

    // 另一条没有被发出去：暂停是真的
    const q = row(id2);
    assert.equal(q.state, "notify_pending");
    assert.equal(calls("/v2/post/publish/video/init/").length, 1);
    assert.ok(events(id2, "publish.needs_human").some((e) => e.payload.error_code === "account_paused"), "暂停挡下的这条要留事件");
    assert.equal(mock.state.uploads.length, 0);
  });
}

test("token 失效（access_token_invalid）：转「需要重新登录」，不重试", async () => {
  reset();
  const acct = await connectedAccount();
  mock.state.accessTokenInvalid = true; // 授权之后 token 被用户在 TikTok 里撤销
  const id = plan(acct, { edit: { privacy: "SELF_ONLY" } });
  await drain();
  const p = row(id);
  assert.equal(p.state, "blocked");
  assert.equal(p.error_code, "auth");
  assert.equal(db().prepare("SELECT state FROM account WHERE id=?").get(acct.accountId).state, "expired");
  assert.equal(events(id, "account.expired").length, 1);
  assert.equal(calls("/v2/post/publish/creator_info/query/").length, 1);
});

test("account.creator：展示 creator_info（隐私选项、开关、最长时长）", async () => {
  reset({ privacyOptions: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"], maxDuration: 180 });
  const acct = await connectedAccount();
  const info = await coreHandlers["account.creator"]({ accountId: acct.accountId });
  assert.deepEqual(info.privacyLevelOptions, ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"]);
  assert.equal(info.duetDisabled, true);
  assert.equal(info.maxVideoPostDurationSec, 180);
});

test("未审核应用被拒：提示要求账号设为私密，不再说只能发仅自己可见", async () => {
  const { classifyError } = await import("../src/api.mjs");
  const err = classifyError("unaudited_client_can_only_post_to_private_accounts", "x");
  assert.equal(err.code, "platform_reject");
  assert.match(err.message, /设置和隐私 → 隐私 → 私密账号/);
  assert.match(err.message, /再重试/);
  assert.match(err.message, /通过审核后就没有这个限制/);
  assert.doesNotMatch(err.message, /只能发「仅自己可见」/);
});

// ---- ACC-tiktok-api-07：代理 ----
const { proxiedFetch, proxyFor } = await import("../src/proxy.mjs");
const { callApi } = await import("../src/api.mjs");
const { createServer: createHttpServer } = await import("node:http");
const { connect: netConnect } = await import("node:net");

const startFakeProxy = async () => {
  const seen = [];
  const server = createHttpServer((req, res) => {
    // 明文 http 请求：路径是完整 URL，转发给真正的目标。
    seen.push({ method: req.method, url: req.url });
    const u = new URL(req.url);
    const up = createHttpServer;
    void up;
    import("node:http").then(({ request }) => {
      const r = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      req.pipe(r);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://user:secret@127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
};

test("代理：设了 ALL_PROXY，请求确实经过代理；不用设 NODE_USE_ENV_PROXY", async () => {
  const px = await startFakeProxy();
  try {
    const res = await proxiedFetch(`${mock.base}/v2/post/publish/status/fetch/`, { method: "POST" }, { ALL_PROXY: px.url });
    assert.ok(res.status > 0);
    assert.equal(px.seen.length, 1);
    assert.match(px.seen[0].url, /\/v2\/post\/publish\/status\/fetch\//);
  } finally {
    await px.close();
  }
});

test("代理：HTTPS 目标经 CONNECT 隧道发出，不直连目标 443", async () => {
  const { execFileSync } = await import("node:child_process");
  const { createServer: createTlsServer } = await import("node:https");
  const dir = mkdtempSync(join(tmpdir(), "vk-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const targetSeen = [];
  const target = createTlsServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
    targetSeen.push(req.url);
    res.end("ok");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const connects = [];
  const proxy = createHttpServer();
  proxy.on("connect", (req, client, head) => {
    connects.push(req.url);
    const [host, port] = req.url.split(":");
    const up = netConnect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const savedTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // 目标是自签证书
  try {
    const tport = target.address().port;
    const res = await proxiedFetch(`https://127.0.0.1:${tport}/raw?x=1`, { method: "GET" }, { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(connects, [`127.0.0.1:${tport}`]);
    assert.deepEqual(targetSeen, ["/raw?x=1"]);
  } finally {
    if (savedTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTls;
    proxy.close();
    target.close();
  }
});

test("代理：NO_PROXY 命中的主机直连，不经过代理", async () => {
  const px = await startFakeProxy();
  try {
    const env = { HTTP_PROXY: px.url, NO_PROXY: "localhost,127.0.0.1" };
    assert.equal(proxyFor(`${mock.base}/x`, env), null);
    await proxiedFetch(`${mock.base}/v2/post/publish/status/fetch/`, { method: "POST" }, env);
    assert.equal(px.seen.length, 0);
  } finally {
    await px.close();
  }
});

test("代理：小写变量也认", () => {
  assert.equal(proxyFor("https://open.tiktokapis.com/", { https_proxy: "127.0.0.1:7890" }), "http://127.0.0.1:7890");
});

test("代理不通：error_code 是 network_unreachable，人话点名要检查的代理变量，不是 fetch failed", async () => {
  const saved = process.env.HTTPS_PROXY;
  const savedHttp = process.env.HTTP_PROXY;
  const savedNo = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  delete process.env.NO_PROXY; // 开发机的 NO_PROXY 可能含 127.0.0.1，会让请求绕开假代理
  delete process.env.no_proxy;
  process.env.HTTP_PROXY = "http://127.0.0.1:1"; // 没人监听
  try {
    await assert.rejects(
      () => callApi("/v2/x/", { token: "t" }),
      (err) => {
        assert.equal(err.code, "network_unreachable");
        assert.match(err.message, /网络或代理/);
        assert.match(err.message, /HTTPS_PROXY/);
        assert.match(err.message, /ALL_PROXY/);
        assert.doesNotMatch(err.message, /^连不上 TikTok（fetch failed/);
        return true;
      },
    );
  } finally {
    if (savedHttp === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = savedHttp;
    if (saved !== undefined) process.env.HTTPS_PROXY = saved;
    for (const [k, v] of Object.entries(savedNo)) if (v !== undefined) process.env[k] = v;
  }
});
