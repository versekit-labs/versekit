// 视频号适配器（ACC-shipinhao-01/02/03/06 的适配器一侧）。
//
// 全部在离线模拟页上跑（fixtures/channels-mock.mjs：wujie shadow root 结构 + 真实文案），
// 不打开 channels.weixin.qq.com，不碰任何真实账号，不起 Chrome。
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HIFABU_HOME = mkdtempSync(join(tmpdir(), "vk-sph-"));

const core = await import("../../core/src/index.mjs");
const adapter = (await import("../src/index.mjs")).default;
const { checkShortTitle, checkDescription, shipinhaoParams, planDraft } = await import("../src/copy.mjs");
const { fillDraft, setPace, UPLOAD_TIMEOUT_MS, CREATE } = await import("../src/form.mjs");
const { startQrLogin, qrLoginStatus, QR_SESSION_MS } = await import("../src/login.mjs");
const { ChannelsMock, fakeTab, LIST_PATH } = await import("../fixtures/channels-mock.mjs");
const { validateAdapter } = await import("../../core/src/contract.mjs");

setPace(0.001); // 页面动画级别的等待压到几乎为零；超时与重试次数照旧
const db = () => core.open();
const tmp = process.env.HIFABU_HOME;
const file = (name) => { const p = join(tmp, name); writeFileSync(p, "x"); return p; };
const VIDEO = file("成片.mp4");
const COVER34 = file("cover34.png");
const COVER43 = file("cover43.png");

const plan = (extra = {}) => ({ file: VIDEO, shortTitle: "三分钟看懂汇率", description: "这是正文\n\n#汇率 #理财", location: "不显示位置", aiMark: "含AI生成内容", covers: null, ...extra });
const run = (page, p = plan(), opts = {}) => fillDraft(fakeTab(page), p, { listTimeoutMs: 200, ...opts });

before(() => core.migrate());

// ---------------------------------------------------------------- ACC-shipinhao-01 契约与移植

test("ACC-shipinhao-01 契约：按 adapter-contract 导出，draft 为 true，只存草稿", () => {
  const info = validateAdapter(adapter, "adapter-shipinhao");
  assert.equal(info.platform, "shipinhao");
  assert.equal(adapter.capabilities.draft, true);
  assert.equal(adapter.capabilities.publish, "web");
  assert.equal(adapter.capabilities.collect, "none", "采集不在本单：工厂就是 stats: null");
  assert.equal(adapter.draftOnly, true);
  assert.equal(adapter.loginTracked, true);
});

test("ACC-shipinhao-01 移植：文件头写来源；工厂里的硬编码一个不留；不引入运行时依赖", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dir);
  const code = files.filter((f) => /\.mjs$/.test(f) && !f.includes("/test/"));
  const all = code.map((f) => readFileSync(f, "utf8")).join("\n");
  assert.match(readFileSync(join(dir, "src/form.mjs"), "utf8"), /^.*ported from trustbridge@1f9c92f videos\/factory\/publishers\/channels\.mjs/m);
  assert.match(readFileSync(join(dir, "src/login.mjs"), "utf8"), /ported from trustbridge@1f9c92f videos\/factory\/keepalive\.mjs/);
  for (const banned of ["assurelane", "channels-error.png", "filesOf(", "youtube.json", "short_title", "ffmpeg", "lark.mjs", "execFileSync"]) {
    assert.ok(!all.includes(banned), `不该出现：${banned}`);
  }
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {}), []);
  // 通知不直接调飞书：适配器里没有任何对 lark / feishu 的引用。
  assert.ok(!/lark|feishu/i.test(all.replace(/飞书/g, "")), "只发事件，不直推飞书");
});

test("ACC-shipinhao-01 dry-run：true 只做本地校验（不开浏览器）；\"form\" 停在「保存草稿」前一步并截图", async () => {
  // 本地校验口径：标题合规、素材存在。
  const copy = { title: "三分钟看懂汇率", body: "正文", tags: ["汇率"], metaJson: null, overridesJson: null };
  const local = await adapter.publish({ publishId: "p_x", asset: VIDEO, copy, dryRun: true });
  assert.equal(local.dryRun, true);
  assert.equal(local.target.shortTitle, "三分钟看懂汇率");

  const page = new ChannelsMock();
  const tab = fakeTab(page);
  await tab.goto(CREATE);
  db().prepare("INSERT OR IGNORE INTO account (id,platform,handle,state,created_at) VALUES ('a_dry','shipinhao','@dry','ok',?)").run(Date.now());
  db().prepare("INSERT OR IGNORE INTO work (id,title,asset_path,created_at) VALUES ('w_dry','干跑',?,?)").run(VIDEO, Date.now());
  db().prepare("INSERT OR IGNORE INTO publish (id,work_id,account_id,mode,visibility,state,created_at,updated_at) VALUES ('p_dry','w_dry','a_dry','draft','public','draft_running',?,?)").run(Date.now(), Date.now());
  const r = await adapter.publish({ publishId: "p_dry", asset: VIDEO, copy, dryRun: "form", tab, fillOptions: { listTimeoutMs: 100 } });
  assert.equal(r.dryRun, true);
  assert.ok(r.screenshot, "留了一张截图");
  assert.ok(!page.log.includes("click:保存草稿"), "没点保存草稿");
  assert.ok(!page.log.includes("click:发表"), "没点发表");
  assert.equal(page.drafts.length, 0, "平台上什么都没有留下");
});

// ---------------------------------------------------------------- ACC-shipinhao-02 存草稿

test("ACC-shipinhao-02 存草稿：9:16 一张封面卡片 —— 上传 → 等处理 → 封面 → 描述 → 短标题 → 位置 → 标注 → 回读 → 保存 → 草稿列表读回", async () => {
  const page = new ChannelsMock({ ratio: "9:16", processingPolls: 3 });
  const steps = [];
  const out = await run(page, plan({ covers: { profile: COVER34, share: COVER43 } }), { onStepSpy: 1, step: (s) => steps.push(s) });
  assert.equal(out.saved, true);
  assert.deepEqual(page.log.filter((l) => l.startsWith("cover:")), ["cover:0:cover34.png"], "9:16 只有一张卡片，只传 3:4 一张");
  assert.equal(page.drafts.length, 1);
  assert.equal(page.drafts[0].shortTitle, "三分钟看懂汇率");
  assert.equal(page.path, LIST_PATH, "跳到草稿列表后读回");
  assert.ok(!page.log.includes("click:发表"), "第一版只存草稿，从不点发表");
  assert.ok(page.log.includes("place:不显示位置") && page.log.includes("mark:含AI生成内容"));
  assert.deepEqual(steps.slice(0, 3), ["打开视频号助手发表页", "上传成片", "等视频上传和处理完成"]);
  assert.equal(steps.at(-1), "到草稿列表核对");
});

test("ACC-shipinhao-02 封面：16:9 两张卡片，各传一张；第二张先弹「直接编辑」也走通", async () => {
  const page = new ChannelsMock({ ratio: "16:9" });
  await run(page, plan({ covers: { profile: COVER34, share: COVER43 } }));
  assert.deepEqual(page.log.filter((l) => l.startsWith("cover:")), ["cover:0:cover34.png", "cover:1:cover43.png"]);
  assert.ok(page.log.includes("click:直接编辑"), "另一张已有图时先弹直接编辑");
});

test("ACC-shipinhao-02 封面：入库清单没给就用平台默认，一张都不传", async () => {
  const page = new ChannelsMock({ ratio: "16:9" });
  await run(page, plan({ covers: null }));
  assert.deepEqual(page.log.filter((l) => l.startsWith("cover:")), []);
  assert.equal(page.drafts.length, 1);
});

test("ACC-shipinhao-02 封面编辑框第一次常常点不开：最多点三次；三次都不开就明确失败", async () => {
  const slow = new ChannelsMock({ ratio: "9:16", ignoreEditClicks: 2 });
  await run(slow, plan({ covers: { profile: COVER34, share: COVER43 } }));
  assert.equal(slow.log.filter((l) => l.startsWith("click:编辑")).length, 3, "点了三次才开");
  const dead = new ChannelsMock({ ratio: "9:16", ignoreEditClicks: 9 });
  await assert.rejects(run(dead, plan({ covers: { profile: COVER34, share: COVER43 } }), { }), (e) => e.code === "flaky_ui" && /点了三次/.test(e.message));
  assert.equal(dead.log.filter((l) => l.startsWith("click:编辑")).length, 3, "只点三次，不无限重试");
  assert.equal(dead.drafts.length, 0);
});

test("ACC-shipinhao-02 上传完成按工厂的判定等：处理中（上传中/生成中/百分比）不算完；超时给 20 分钟", async () => {
  assert.equal(UPLOAD_TIMEOUT_MS, 20 * 60e3);
  const stuck = new ChannelsMock({ stuckProcessing: true });
  await assert.rejects(run(stuck, plan(), { uploadTimeoutMs: 80 }), (e) => /视频上传完成/.test(e.message));
  assert.ok(!stuck.log.includes("click:保存草稿"), "没处理完不往下走");
  const slow = new ChannelsMock({ processingPolls: 5 });
  await run(slow);
  assert.equal(slow.drafts.length, 1, "处理完才填表、保存");
});

test("ACC-shipinhao-02 位置、标注是平台稿参数：改位置、关掉标注都生效", async () => {
  const page = new ChannelsMock();
  await run(page, plan({ location: "深圳市", aiMark: null }));
  assert.ok(page.log.includes("place:深圳市 · 某某大厦"));
  assert.ok(!page.log.some((l) => l.startsWith("mark:")), "aiMark 关掉就不点标注");
  const p = shipinhaoParams({ metaJson: JSON.stringify({ shipinhao: { aiMark: true } }), overridesJson: JSON.stringify({ shipinhao: { location: "深圳市" } }) });
  assert.equal(p.location, "深圳市");
  assert.equal(p.aiMark, "含AI生成内容");
  assert.equal(shipinhaoParams({}).location, "不显示位置", "默认不显示位置");
  assert.equal(shipinhaoParams({}).aiMark, "含AI生成内容", "默认标注");
});

test("ACC-shipinhao-02 短标题：16 字（含空格）、标点白名单；不合规在确认前就拦下并说明", () => {
  assert.equal(checkShortTitle("三分钟看懂汇率《指南》：50%？"), "三分钟看懂汇率《指南》：50%？");
  assert.equal(checkShortTitle("一二三四五六七八九十一二三四五六"), "一二三四五六七八九十一二三四五六", "恰好 16 字可以");
  assert.throws(() => checkShortTitle("一二三四五六七八九十一二三四五六七"), (e) => e.code === "asset_invalid" && /超过 16 字.*现在是 17 字/.test(e.message));
  assert.throws(() => checkShortTitle("一二三四五六七八九十一二三 四五六"), (e) => e.code === "asset_invalid" && /空格也算/.test(e.message), "空格也算一个字：17 个");
  for (const bad of ["你好，世界", "真的吗！", "a/b", "好#话题", "（括号）"]) {
    assert.throws(() => checkShortTitle(bad), (e) => e.code === "asset_invalid" && /不允许的符号/.test(e.message), bad);
  }
  assert.throws(() => checkShortTitle("  "), (e) => e.code === "asset_invalid");
});

test("ACC-shipinhao-02 描述：正文加话题最多 950 字，超了在确认前拦下；没有从 YouTube 文案推导，也没有「更多：」", () => {
  const d = checkDescription({ body: "正文", tags: ["汇率", "#理财"] });
  assert.equal(d, "正文\n\n#汇率 #理财");
  assert.equal([...checkDescription({ body: "字".repeat(950) })].length, 950);
  assert.throws(() => checkDescription({ body: "字".repeat(951) }), (e) => e.code === "asset_invalid" && /超过 950 字/.test(e.message));
  assert.throws(() => checkDescription({ body: "字".repeat(940), tags: ["一二三四五六七八九十"] }), (e) => /超过 950 字/.test(e.message), "话题也算");
  assert.equal(checkDescription({ body: "", title: "只有标题" }), "只有标题");
  assert.ok(!/更多：/.test(d));
  // 短标题没写：标题本身合规才能当短标题，否则要人写。
  assert.equal(planDraft({ title: "短标题", body: "b" }).shortTitle, "短标题");
  assert.throws(() => planDraft({ title: "这是一个远远超过十六个字的很长很长的作品标题啊", body: "b" }), (e) => e.code === "asset_invalid");
  assert.equal(planDraft({ title: "很长很长很长很长很长很长很长很长很长很长很长很长标题", body: "b", overridesJson: JSON.stringify({ shipinhao: { shortTitle: "短一点" } }) }).shortTitle, "短一点");
});

test("ACC-shipinhao-02 填完逐项回读：描述被编辑器吞字、位置没选对，抛 flaky_ui 并留截图，不点保存", async () => {
  const page = new ChannelsMock({ eatDescription: true });
  await assert.rejects(run(page), (e) => e.code === "flaky_ui" && /回读对不上.*描述/.test(e.message));
  assert.ok(!page.log.includes("click:保存草稿"));

  // 经由适配器：失败带截图路径（证据在驱动的证据目录，不是写死的家目录文件）。
  const k = Date.now();
  db().prepare("INSERT INTO account (id,platform,handle,state,created_at) VALUES (?,?,?,'ok',?)").run(`a${k}`, "shipinhao", `@e${k}`, k);
  db().prepare("INSERT INTO work (id,title,asset_path,created_at) VALUES (?,?,?,?)").run(`w${k}`, "回读", VIDEO, k);
  db().prepare("INSERT INTO publish (id,work_id,account_id,mode,visibility,state,created_at,updated_at) VALUES (?,?,?,'draft','public','draft_running',?,?)").run(`p${k}`, `w${k}`, `a${k}`, k, k);
  const bad = new ChannelsMock({ eatDescription: true });
  await assert.rejects(
    adapter.publish({ publishId: `p${k}`, asset: VIDEO, copy: { title: "回读", body: "正文", tags: [] }, tab: fakeTab(bad), fillOptions: { listTimeoutMs: 50 } }),
    (e) => e.code === "flaky_ui" && /页面截图：/.test(e.message) && e.evidence && !e.message.includes("channels-error.png"),
  );
});

test("ACC-shipinhao-02 点了保存草稿但草稿列表里读不回这一条：不记 draft_pending", async () => {
  const page = new ChannelsMock({ dropDraft: true });
  await assert.rejects(run(page), (e) => e.code === "flaky_ui" && /草稿列表里没有读回/.test(e.message));
});

test("ACC-shipinhao-02 经适配器：读回成功才返回 draft_pending，说明在手机上点发表；失败即抛，不是结果", async () => {
  const k = Date.now() + 1;
  db().prepare("INSERT INTO account (id,platform,handle,state,created_at) VALUES (?,?,?,'ok',?)").run(`a${k}`, "shipinhao", `@s${k}`, k);
  db().prepare("INSERT INTO work (id,title,asset_path,created_at) VALUES (?,?,?,?)").run(`w${k}`, "存草稿", VIDEO, k);
  db().prepare("INSERT INTO publish (id,work_id,account_id,mode,visibility,state,created_at,updated_at) VALUES (?,?,?,'draft','public','draft_running',?,?)").run(`p${k}`, `w${k}`, `a${k}`, k, k);
  const page = new ChannelsMock();
  const r = await adapter.publish({ publishId: `p${k}`, asset: VIDEO, copy: { title: "存草稿", body: "正文", tags: ["话题"] }, tab: fakeTab(page), fillOptions: { listTimeoutMs: 100 } });
  assert.equal(r.state, "draft_pending");
  assert.equal(r.visibility, "private");
  assert.equal(r.id, "存草稿");
  assert.match(r.note, /已送到视频号草稿箱，在手机上点发表/);
  assert.equal(page.drafts.length, 1);
  // 状态由 core 迁移：适配器没有碰 publish 行。
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(`p${k}`).state, "draft_running");
});

test("ACC-shipinhao-02 preflight：短标题不合规在确认之前就抛 asset_invalid，不开浏览器", () => {
  assert.throws(() => adapter.preflight({ publishId: "p_x", copy: { title: "短", body: "b", overridesJson: JSON.stringify({ shipinhao: { shortTitle: "这个短标题其实有一点点长超过了十六个字" } }) } }), (e) => e.code === "asset_invalid");
  assert.equal(adapter.preflight({ publishId: "p_x", copy: { title: "短", body: "b" } }).shortTitle, "短");
});

// ---------------------------------------------------------------- ACC-shipinhao-03 登录检查

test("ACC-shipinhao-03 check：打开只读页面；二维码页 = 过期，人话「视频号登录过期了，请重新扫码」，不是找不到元素", async () => {
  const ok = await adapter.check({ accountId: "acc_ok", tab: fakeTab(new ChannelsMock({ loggedIn: true })) });
  assert.deepEqual(ok, { state: "ok" });
  const page = new ChannelsMock({ loggedIn: false });
  const expired = await adapter.check({ accountId: "acc_expired", tab: fakeTab(page) });
  assert.equal(expired.state, "expired");
  assert.equal(expired.detail, "视频号登录过期了，请重新扫码");
  assert.deepEqual(page.log, ["goto:/platform"], "只打开了首页这一个只读页面");
});

test("ACC-shipinhao-03 发布一开始就落到二维码页：抛 auth，人话同上", async () => {
  await assert.rejects(run(new ChannelsMock({ loggedIn: false })), (e) => e.code === "auth" && e.message === "视频号登录过期了，请重新扫码");
});

test("ACC-shipinhao-03 发布途中登录掉了（上传后被送去二维码页）：同样抛 auth，不报成找不到元素", async () => {
  const page = new ChannelsMock({ expireAfterUpload: true, processingPolls: 9 });
  await assert.rejects(run(page), (e) => e.code === "auth" && /请重新扫码/.test(e.message));
  assert.ok(!page.log.includes("click:保存草稿"));
  // 填表中途掉线（元素已经找不到）也算 auth。
  const mid = new ChannelsMock({ processingPolls: 0 });
  const tab = fakeTab(mid);
  const realClick = tab.click;
  let n = 0;
  tab.click = async (p) => { if (++n === 2) { mid.path = "/login.html"; mid.rebuild(); } return realClick(p); };
  await assert.rejects(fillDraft(tab, plan(), { listTimeoutMs: 50 }), (e) => e.code === "auth");
});

// ---------------------------------------------------------------- ACC-shipinhao-06 网页扫码

test("ACC-account-12 / ACC-shipinhao-06 扫码：先清旧登录 → 出码 → 已扫 → 确认成功", async () => {
  const page = new ChannelsMock({ loggedIn: true });
  page.loginPhase = "ok";
  const tab = fakeTab(page);
  const tabFor = async () => ({ tab, ownsBrowser: false });
  const start = await startQrLogin({ accountId: "acc_qr1", tabFor });
  assert.deepEqual(page.log.slice(0, 2), ["clearSiteCookies:weixin.qq.com", "goto:/login.html"]);
  assert.equal(start.state, "waiting");
  assert.match(start.qr, /^data:image\/png;base64,QR1/);
  assert.equal((await qrLoginStatus({ accountId: "acc_qr1" })).state, "waiting");
  page.scan();
  assert.equal((await qrLoginStatus({ accountId: "acc_qr1" })).state, "scanned");
  page.confirm();
  const done = await qrLoginStatus({ accountId: "acc_qr1" });
  assert.equal(done.state, "ok");
  assert.equal(done.persisted, true);
  assert.equal(tab.closed, true, "收尾关掉自己开的标签");
  assert.equal((await qrLoginStatus({ accountId: "acc_qr1" })).state, "idle", "会话结束后不再读旧页面");
});

test("ACC-shipinhao-06 二维码过期 → 换一个：新码和旧码不一样", async () => {
  const page = new ChannelsMock({ loggedIn: false });
  const tabFor = async () => ({ tab: fakeTab(page), ownsBrowser: false });
  const first = await startQrLogin({ accountId: "acc_qr2", tabFor });
  page.expireQr();
  const st = await qrLoginStatus({ accountId: "acc_qr2" });
  assert.equal(st.state, "expired");
  page.refreshQr();
  const next = await startQrLogin({ accountId: "acc_qr2", tabFor });
  assert.equal(next.state, "waiting");
  assert.notEqual(next.qr, first.qr);
});

test("ACC-shipinhao-06 取不到 <img> 时退回整页截图当二维码，仍然能扫", async () => {
  const page = new ChannelsMock({ loggedIn: false });
  const tab = fakeTab(page);
  const realEval = tab.eval;
  tab.eval = async (fn, ...a) => (String(fn).includes("naturalWidth") ? null : realEval(fn, ...a));
  const r = await startQrLogin({ accountId: "acc_qr3", tabFor: async () => ({ tab, ownsBrowser: false }) });
  assert.equal(r.state, "waiting");
  assert.equal(r.qr, `data:image/png;base64,${Buffer.from("png").toString("base64")}`);
  await startQrLogin({ accountId: "acc_qr3", tabFor: async () => ({ tab: fakeTab(new ChannelsMock({ loggedIn: false })), ownsBrowser: false }) }); // 收掉旧会话
});

test("ACC-shipinhao-06 10 分钟没人扫：会话作废，按过期处理", async () => {
  const page = new ChannelsMock({ loggedIn: false });
  await startQrLogin({ accountId: "acc_qr4", tabFor: async () => ({ tab: fakeTab(page), ownsBrowser: false }) });
  const real = Date.now;
  Date.now = () => real() + QR_SESSION_MS + 1000;
  try {
    assert.equal((await qrLoginStatus({ accountId: "acc_qr4" })).state, "expired");
  } finally {
    Date.now = real;
  }
});
