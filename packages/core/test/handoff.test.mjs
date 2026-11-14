// 交给手机（#120）：小红书默认由人在手机上发布，程序不访问小红书。
// ACC-handoff-01..08：模式与迁移、零访问证明、交接页与安全边界、回执、通知与二维码、不体检不采集。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-handoff-"));

// ---- 网络与驱动记录：整个文件内所有 fetch / WebSocket 都经过这里 --------------------------
const requested = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  requested.push(String(input?.url ?? input));
  return realFetch(input, init);
};
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
  constructor(url, ...rest) {
    requested.push(String(url));
    super(url, ...rest);
  }
};
const touchedXhs = () => requested.filter((u) => /xiaohongshu|xhslink|xhscdn/i.test(u));

const core = await import("../src/index.mjs");
mkdirSync(dirname(core.paths().configFile), { recursive: true });
const store = await import("../src/store.mjs");
const approval = await import("../src/approval.mjs");
const { loadAdapters, buildHandlers } = await import("../src/adapters.mjs");
const { createRunner } = await import("../src/runner.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { startDaemon, createDispatcher } = await import("../src/daemon.mjs");
const { buildEventCard } = await import("../src/cards.mjs");
const { deliverPending } = await import("../src/notify.mjs");
const { doctorReport } = await import("../src/doctor.mjs");
const { qrMatrix, qrSvg } = await import("../src/qr.mjs");

const db = () => core.open();
const PORT = 18700 + (process.pid % 300);
const URL0 = `http://127.0.0.1:${PORT}`;
let daemon;
let n = 0;

// stub driver：一个会数自己被调用几次的「小红书适配器」。handoff 下它必须一次都不被调用。
const driverCalls = { publish: 0, collect: 0, check: 0 };
globalThis.__xhsDriver = driverCalls;
async function stubAdapters() {
  const root = mkdtempSync(join(tmpdir(), "vk-pkg-"));
  const dir = join(root, "adapter-xiaohongshu");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "adapter-xiaohongshu", type: "module", exports: { ".": { import: "./src/index.mjs" } } }));
  writeFileSync(
    join(dir, "src", "index.mjs"),
    `const c = globalThis.__xhsDriver;
     export default {
       platform: "xiaohongshu",
       capabilities: { publish: "web", collect: "web" },
       ready: () => null,
       async publish() { c.publish++; return { id: "x", url: "https://www.xiaohongshu.com/x", visibility: "public", state: "published" }; },
       async collect() { c.collect++; return { source: "api", status: "ok", metrics: {} }; },
       async check() { c.check++; return { state: "ok" }; },
     };`,
  );
  return (await loadAdapters({ root })).adapters;
}

function seed({ platform = "xiaohongshu", mode = "handoff", state = "notify_pending", fallback = "phone_handoff", meta = null, assets = null } = {}) {
  const k = ++n;
  let asset = `/tmp/none-${k}.png`;
  if (assets) {
    asset = mkdtempSync(join(tmpdir(), "vk-assets-"));
    for (const name of assets) writeFileSync(join(asset, name), Buffer.from(`img-${name}`));
  }
  db().prepare("INSERT INTO account (id, platform, handle, display_name, is_manual, created_at) VALUES (?,?,?,?,?,?)")
    .run(`acc${k}`, platform, `@h${k}`, `号${k}`, { auto: 0, manual: 1, handoff: 2 }[mode], Date.now());
  db().prepare("INSERT INTO work (id, title, asset_path, meta_json, created_at) VALUES (?,?,?,?,?)")
    .run(`wk${k}`, `第 ${k} 篇笔记`, asset, meta ? JSON.stringify(meta) : null, Date.now());
  db().prepare("INSERT INTO publish (id, work_id, account_id, state, fallback_reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(`pub${k}`, `wk${k}`, `acc${k}`, state, fallback, Date.now(), Date.now());
  return { publishId: `pub${k}`, accountId: `acc${k}`, workId: `wk${k}`, asset };
}

before(async () => {
  core.migrate();
  daemon = await startDaemon({ handlers: {}, log: () => {}, port: PORT, host: "127.0.0.1", runQueue: false, channels: [] });
});
after(async () => {
  await daemon?.close?.();
});

// ============================================================ ACC-handoff-01 模式与默认值
test("ACC-handoff-01 新建小红书账号默认 handoff，其他平台仍是 auto；account.mode 可设 handoff", () => {
  const g = store.addGroup({ name: "测试组" });
  const xhs = store.addAccount({ platform: "xiaohongshu", handle: "@新号", groupId: g.id });
  const g2 = store.addGroup({ name: "测试组2" });
  const bili = store.addAccount({ platform: "bilibili", handle: "@b", groupId: g2.id });
  assert.equal(store.accountModeOf(store.getAccount(xhs.id)), "handoff");
  assert.equal(store.accountModeOf(store.getAccount(bili.id)), "auto");

  store.setAccountMode(xhs.id, "auto");
  assert.equal(store.listAccounts().find((a) => a.id === xhs.id).mode, "auto");
  assert.deepEqual(store.setAccountMode(xhs.id, "handoff"), { id: xhs.id, mode: "handoff" });
  assert.throws(() => store.setAccountMode(xhs.id, "bogus"), /auto \/ manual \/ handoff/);

  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  assert.equal(handlers["account.mode"]({ accountId: bili.id, mode: "handoff" }).mode, "handoff");
});

test("ACC-handoff-01 已有小红书账号由迁移改为 handoff（只迁一次，之后用户改回 auto 不被改回去）", () => {
  const k = ++n;
  db().prepare("INSERT INTO account (id, platform, handle, state, is_manual, created_at) VALUES (?,?,?,?,0,?)").run(`old${k}`, "xiaohongshu", `@old${k}`, "expired", Date.now());
  db().prepare("INSERT INTO account (id, platform, handle, is_manual, created_at) VALUES (?,?,?,0,?)").run(`tt${k}`, "tiktok", `@tt${k}`, Date.now());
  db().prepare("DELETE FROM meta WHERE key = 'migration:xiaohongshu_handoff'").run();

  core.migrate();
  const old = db().prepare("SELECT is_manual, state FROM account WHERE id=?").get(`old${k}`);
  assert.equal(old.is_manual, 2);
  assert.equal(old.state, "ok", "交给手机不要求电脑登录：旧的「已失效」要复位");
  assert.equal(db().prepare("SELECT is_manual FROM account WHERE id=?").get(`tt${k}`).is_manual, 0, "别的平台不受影响");

  store.setAccountMode(`old${k}`, "auto");
  core.migrate();
  assert.equal(db().prepare("SELECT is_manual FROM account WHERE id=?").get(`old${k}`).is_manual, 0, "迁移只跑一次");
});

test("ACC-handoff-01/08 stub driver：handoff 发布到点只转 notify_pending，driver 调用 0 次、零访问小红书域名", async () => {
  const adapters = await stubAdapters();
  const handlers = buildHandlers(adapters, { log: () => {} });
  const { publishId, accountId } = seed({ mode: "handoff", state: "queued", fallback: null });
  core.enqueue({ kind: "publish", targetType: "publish", targetId: publishId, lane: accountId });
  core.enqueue({ kind: "check", targetType: "account", targetId: accountId, lane: accountId });

  const before = requested.length;
  const runner = createRunner({ handlers, log: () => {} });
  await runner.tick();
  await runner.tick();

  const row = db().prepare("SELECT state, fallback_reason FROM publish WHERE id=?").get(publishId);
  assert.equal(row.state, "notify_pending");
  assert.equal(row.fallback_reason, "phone_handoff");
  assert.deepEqual(driverCalls, { publish: 0, collect: 0, check: 0 }, "stub driver 一次都不能被调用");
  assert.equal(touchedXhs().length, 0, `不得访问小红书域名：${touchedXhs().join(", ")}`);
  assert.equal(requested.length, before, "整个过程没有任何网络请求");
  assert.equal(db().prepare("SELECT state FROM run WHERE target_id=?").get(publishId).state, "done");
  // 事件：电脑端与飞书都靠它长出「待在手机上发布」
  assert.ok(db().prepare("SELECT 1 FROM event WHERE publish_id=? AND type='publish.needs_human'").get(publishId));
});

test("ACC-handoff-01 对照组：auto 账号仍然走 driver（证明 stub 在记数、不是没接上）", async () => {
  const adapters = await stubAdapters();
  const handlers = buildHandlers(adapters, { log: () => {} });
  const { publishId, accountId } = seed({ mode: "auto", state: "queued", fallback: null });
  core.enqueue({ kind: "publish", targetType: "publish", targetId: publishId, lane: accountId });
  await createRunner({ handlers, log: () => {} }).tick();
  assert.equal(driverCalls.publish, 1);
  driverCalls.publish = 0;
});

// ============================================================ ACC-handoff-07 不体检、不采集、不告警
test("ACC-handoff-07 handoff 账号不进体检清单、不采集、doctor 不算异常", async () => {
  const { dueAccounts } = await import("../src/scheduler.mjs");
  const { accountId, publishId } = seed({ mode: "handoff", state: "published", fallback: null });
  db().prepare("UPDATE account SET state='expired' WHERE id=?").run(accountId); // 即便脏数据留着旧状态
  assert.ok(!dueAccounts().some((a) => a.id === accountId), "scheduler 不体检 handoff 账号");

  const adapters = await stubAdapters();
  const handlers = buildHandlers(adapters, { log: () => {} });
  const out = await handlers.collect({ target_id: publishId });
  assert.equal(out.skipped, true);
  const chk = await handlers.check({ target_id: accountId });
  assert.equal(chk.handoff, true);
  assert.deepEqual(driverCalls, { publish: 0, collect: 0, check: 0 });

  const report = doctorReport({ adapters: [] });
  const health = report.checks.find((c) => c.id === "account_health");
  const expiredNonHandoff = db().prepare("SELECT COUNT(*) n FROM account WHERE state IN ('expiring','expired') AND is_manual != 2 AND removed_at IS NULL").get().n;
  assert.equal(health.detail.startsWith(`${expiredNonHandoff} 个账号`) || health.detail === "全部正常", true);

  const h = createCoreHandlers({ adapters: [], log: () => {} });
  assert.throws(() => h["collect.now"]({ publishId }), /交给手机/);
  assert.match(h["account.reauth"]({ accountId }).next, /不需要在电脑登录/);
});

test("ACC-handoff-07 账号读模型带 mode，新鲜度不把 handoff 算陈旧", async () => {
  const { listAccountViews } = await import("../src/overview.mjs");
  const { accountId } = seed({ mode: "handoff", state: "published", fallback: null });
  const view = listAccountViews().find((a) => a.id === accountId);
  assert.equal(view.mode, "handoff");
  assert.equal(view.freshness.level, "unknown");
});

// ============================================================ ACC-handoff-02 交接页
test("ACC-handoff-02 /h/<token>：账号、标题、正文（含话题）、图片按作品顺序", async () => {
  const { publishId } = seed({ meta: { body: "正文第一行\n第二行", tags: ["徒步", "#周末"] }, assets: ["1.png", "2.png", "10.png"] });
  const path = approval.handoffPath(publishId);

  const shell = await realFetch(`${URL0}${path}`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-type"), /text\/html/);
  const html = await shell.text();
  assert.match(html, /保存全部图片/);
  assert.match(html, /name="viewport"/);

  const data = await (await realFetch(`${URL0}${path}/data`)).json();
  assert.equal(data.ok, true);
  assert.match(data.account.name, /^号\d+$/);
  assert.match(data.title, /篇笔记/);
  assert.equal(data.bodyText, "正文第一行\n第二行\n\n#徒步 #周末");
  assert.deepEqual(data.assets.map((a) => a.name), ["1.png", "2.png", "10.png"], "自然排序：10 在 2 后面");
  assert.ok(data.assets.every((a) => a.kind === "image"));
  assert.equal(data.canAct, true);
  assert.ok(!JSON.stringify(data).includes(tmpdir()), "不向手机暴露本机路径");

  for (const [i, name] of ["1.png", "2.png", "10.png"].entries()) {
    const res = await realFetch(`${URL0}${path}/asset/${i}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(await res.text(), `img-${name}`);
  }
  assert.equal((await realFetch(`${URL0}${path}/asset/9`)).status, 404);

  const range = await realFetch(`${URL0}${path}/asset/0`, { headers: { range: "bytes=0-2" } });
  assert.equal(range.status, 206, "视频在 iOS 上需要 Range");
  assert.equal(await range.text(), "img");
  assert.equal(touchedXhs().length, 0);
});

test("ACC-handoff-02 链接过期 / 坏签名 / 审批链接都打不开交接页，交接链接也进不了审批页", async () => {
  const { publishId } = seed();
  const expired = approval.handoffPath(publishId, Date.now() - 1000);
  const res = await realFetch(`${URL0}${expired}/data`);
  assert.equal(res.status, 410);
  assert.match((await res.json()).error.message, /过期/);

  const tampered = approval.handoffPath(publishId).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal((await realFetch(`${URL0}${tampered}/data`)).status, 410);

  const retry = approval.signApproval({ publishId });
  assert.equal((await realFetch(`${URL0}/h/${retry}/data`)).status, 410, "审批链接不能当交接链接用");
  assert.equal((await realFetch(`${URL0}/h/${retry}/asset/0`)).status, 410);

  const page = await realFetch(`${URL0}${approval.handoffPath(publishId).replace("/h/", "/a/")}`);
  assert.equal(page.status, 400, "交接链接不能当审批链接用");
  assert.throws(() => approval.applyApproval(approval.handoffPath(publishId).slice(3), "cancel"), /交接链接/);
});

test("ACC-handoff-02 安全边界：局域网只能到 /a/ 与 /h/，其余接口仍只允许本机", async () => {
  const dispatch = createDispatcher({ handlers: {}, log: () => {} });
  const call = (url, remote) =>
    new Promise((resolve) => {
      const res = { writeHead: (s) => (res.status = s), end: () => resolve(res.status), write() {}, on() {}, once() {}, emit() {} };
      dispatch({ url, method: "GET", headers: {}, socket: { remoteAddress: remote }, on() {} }, res);
    });
  const lan = "192.168.1.23";
  assert.equal(await call("/api/bootstrap", lan), 403);
  assert.equal(await call("/api/handoffs/link?publishId=x", lan), 403);
  assert.equal(await call("/handoff.html", lan), 403, "静态页（含 handoff.html 本体）不开放给局域网");
  assert.equal(await call("/accounts", lan), 403);
  assert.notEqual(await call("/h/bad/data", lan), 403, "/h/ 对局域网开放");
  assert.notEqual(await call("/a/bad", lan), 403, "/a/ 照旧开放");
});

// ============================================================ ACC-handoff-03/04 复制与深链（页面脚本契约）
test("ACC-handoff-03/04 页面：复制有 execCommand 回退 + 选中提示；深链与分享条件", async () => {
  const html = await (await realFetch(`${URL0}/h/x`)).text();
  assert.match(html, /document\.execCommand\("copy"\)/, "非 secure context 的回退");
  assert.match(html, /window\.isSecureContext && navigator\.clipboard/);
  assert.match(html, /请手动复制/);
  assert.match(html, /selectNodeContents/, "失败时选中文字");
  assert.match(html, /href="xhsdiscover:\/\/"/, "只拉起 App 首页（无可靠出处的路径不用）");
  assert.match(html, /window\.isSecureContext && images\.length && typeof navigator\.canShare/);
  assert.match(html, /id="share" type="button" hidden/, "条件不满足时分享按钮默认隐藏");
  assert.match(html, /navigator\.canShare\(\{ files \}\)/);
});

// ============================================================ ACC-handoff-05 回执
test("ACC-handoff-05 我已发布：记 external_url，只认小红书域名，重复点击去重，不进采集", async () => {
  const { publishId } = seed();
  const path = approval.handoffPath(publishId);
  const post = (sub, body) => realFetch(`${URL0}${path}/${sub}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const bad = await post("done", { url: "https://evil.example.com/explore/1" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /xiaohongshu\.com 或 xhslink\.com/);
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "notify_pending", "链接不合法时不改状态");
  assert.equal((await post("done", { url: "https://xiaohongshu.com.evil.test/x" })).status, 400, "后缀欺骗");

  const ok = await post("done", { url: "复制这段 http://xhslink.com/a/AbC123 打开小红书" });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(body.state, "published");
  const row = db().prepare("SELECT state, external_url, published_at FROM publish WHERE id=?").get(publishId);
  assert.equal(row.state, "published");
  assert.equal(row.external_url, "http://xhslink.com/a/AbC123");
  assert.ok(row.published_at);

  const again = await (await post("done", { url: "http://xhslink.com/a/AbC123" })).json();
  assert.equal(again.duplicate, true);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM command_audit WHERE idempotency_key=?").get(`handoff:${publishId}:done`).n, 1);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM run WHERE kind='collect' AND target_id=?").get(publishId).n, 0, "handoff 不排采集");

  // 已终结：页面说人话、canAct=false，不再给按钮
  const view = await (await realFetch(`${URL0}${path}/data`)).json();
  assert.equal(view.canAct, false);
  assert.equal(view.state, "published");
  assert.equal((await post("skip", {})).status, 400, "已发布后不能再标成不发");
});

test("ACC-handoff-05 我已发布可以不带链接；这次不发了 → canceled 并记原因；CLI 等价命令走 core", async () => {
  const a = seed();
  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  const done = handlers["handoff.done"]({ publishId: a.publishId });
  assert.equal(done.state, "published");
  assert.equal(db().prepare("SELECT external_url FROM publish WHERE id=?").get(a.publishId).external_url, null);

  const b = seed();
  const skipped = handlers["handoff.skip"]({ publishId: b.publishId, reason: "标题还要改" });
  assert.equal(skipped.state, "canceled");
  assert.equal(handlers["handoff.skip"]({ publishId: b.publishId }).duplicate, true);
  const ev = db().prepare("SELECT payload_json FROM event WHERE publish_id=? AND type LIKE 'publish.%' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(b.publishId);
  assert.match(ev.payload_json, /handoff_skipped: 标题还要改/);
  assert.match(db().prepare("SELECT reason FROM command_audit WHERE idempotency_key=?").get(`handoff:${b.publishId}:skip`).reason, /标题还要改/);
  assert.throws(() => handlers["handoff.done"]({ publishId: b.publishId }), /不发了/);

  const q = seed({ state: "queued", fallback: null });
  assert.throws(() => handlers["handoff.done"]({ publishId: q.publishId }), /还没到手机上发布/);
});

test("ACC-handoff-05 parseNoteUrl 只接受 xiaohongshu.com / xhslink.com（含子域名）", () => {
  assert.equal(approval.parseNoteUrl(""), null);
  assert.equal(approval.parseNoteUrl("https://www.xiaohongshu.com/explore/65a"), "https://www.xiaohongshu.com/explore/65a");
  assert.equal(approval.parseNoteUrl("http://xhslink.com/abc"), "http://xhslink.com/abc");
  for (const bad of ["https://example.com/xiaohongshu.com", "没有链接", "ftp://xiaohongshu.com/x", "https://notxiaohongshu.com/x"]) {
    assert.throws(() => approval.parseNoteUrl(bad), /xiaohongshu\.com 或 xhslink\.com|没找到链接/, bad);
  }
});

// ============================================================ ACC-handoff-06 通知与二维码
test("ACC-handoff-06 飞书卡片带交接链接和标题（不是审批链接）", async () => {
  const { publishId } = seed({ state: "queued", fallback: null });
  core.transitionPublish(publishId, "notify_pending", { reason: "phone_handoff", patch: { fallback_reason: "phone_handoff" } });
  const sent = [];
  const channel = { channel: "feishu", send: async (m) => { sent.push(m); return { messageId: "m1" }; } };
  await deliverPending({ channel, binding: { external_user_id: "ou_1" } });

  const urlOf = (c) => c.elements.find((e) => e.tag === "action")?.actions.map((a) => a.url).find(Boolean) ?? "";
  const card = sent.map((m) => m.card).find((c) => JSON.stringify(c).includes("待在手机上发布") && urlOf(c).includes("/h/") && approval.verifyHandoff(urlOf(c).split("/h/")[1]).p === publishId);
  assert.ok(card, "应有一张属于这条发布的「待在手机上发布」卡片");
  const text = JSON.stringify(card);
  assert.match(text, /第 \d+ 篇笔记/, "卡片带标题");
  const urls = card.elements.find((e) => e.tag === "action").actions.map((a) => a.url).filter(Boolean);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/h\//);
  assert.doesNotMatch(urls[0], /\/a\//);
  assert.equal(approval.verifyHandoff(urls[0].split("/h/")[1]).p, publishId);

  // 非 handoff 的 notify_pending 仍是原来的「需要你处理」+ 审批链接
  const plain = buildEventCard({ id: "e", type: "publish.needs_human", severity: "warn", payload: {} }, { publish: { id: "p", platform: "tiktok", handle: "@t", title: "x" }, approvalUrl: "https://e.test/a/t" });
  assert.match(JSON.stringify(plain), /需要你处理/);
});

test("ACC-handoff-06 handoff.link 返回链接与二维码 SVG；非 handoff 账号拒绝", () => {
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  const { publishId } = seed();
  const out = h["handoff.link"]({ publishId });
  assert.match(out.url, /\/h\//);
  assert.match(out.qr, /^<svg [^>]*viewBox/);
  assert.match(out.qr, /<path d="M/);
  assert.equal(approval.verifyHandoff(out.path.slice(3)).p, publishId);
  const auto = seed({ mode: "auto", state: "failed", fallback: null });
  assert.throws(() => h["handoff.link"]({ publishId: auto.publishId }), /不是「交给手机」/);
});

test("ACC-handoff-06 二维码：结构合法（版本/尺寸/定位图案）、同输入同输出、长链接可编码", () => {
  const { size, version, rows } = qrMatrix("hi");
  assert.equal(version, 1);
  assert.equal(size, 21);
  // 三个定位图案：7x7 外框黑、内 3x3 黑
  for (const [ox, oy] of [[0, 0], [14, 0], [0, 14]]) {
    assert.equal(rows[oy][ox], true);
    assert.equal(rows[oy + 3][ox + 3], true);
    assert.equal(rows[oy + 1][ox + 1], false);
    assert.equal(rows[oy + 6][ox + 6], true);
  }
  assert.equal(rows[size - 8][8], true, "暗模块位置固定为黑");
  const url = `http://192.168.1.23:8787${approval.handoffPath("pub_x")}`;
  const long = qrMatrix(url);
  assert.ok(long.version >= 5 && long.size === 17 + 4 * long.version);
  assert.equal(qrSvg(url), qrSvg(url));
  assert.throws(() => qrMatrix("x".repeat(3000)), /too long/i);
});

// ============================================================ ACC-handoff-08 全程零访问
test("ACC-handoff-08 本文件全部流程结束后：driver 调用 0 次，没有任何请求指向小红书域名", () => {
  assert.equal(driverCalls.publish + driverCalls.collect + driverCalls.check, 0);
  assert.deepEqual(touchedXhs(), []);
});
