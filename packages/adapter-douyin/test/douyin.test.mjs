// 抖音适配器测试（ACC-douyin-01 … 06）：离线模拟站 + stub driver，不开 Chrome、不联网、不碰真实账号。
//
// 跑的是生产代码：createAdapter({ driver: stub }) 与默认导出的适配器是同一份流程。
// 真实页面上选择器对不对是 ACC-douyin-07（所有者真机），不在这里测；这里钉的是流程、回读、错误码、上限和暂停。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const HOME = mkdtempSync(join(tmpdir(), "vk-douyin-"));
process.env.VK_HOME = HOME;
delete process.env.VK_DOUYIN_BASE;

const core = await import("../../core/src/index.mjs");
const { createAdapter, planDraft, MAX_TITLE_CHARS, MAX_TOPICS } = await import("../src/index.mjs");
const { default: realAdapter } = await import("../src/index.mjs");
const page = await import("../src/page.mjs");
const state = await import("../src/state.mjs");
const { validateAdapter } = await import("../../core/src/contract.mjs");
const { AdapterError } = await import("../../core/src/errors.mjs");
const { publishInputFor } = await import("../../core/src/publish-flow.mjs");
const { buildHandlers, checkAccount } = await import("../../core/src/adapters.mjs");
const { planRules, describeRules } = await import("../../core/src/plan-rules.mjs");
const { updateConfig } = await import("../../core/src/config.mjs");
const { createSim } = await import("./sim-page.mjs");

core.migrate();
const db = core.open();
const EVIDENCE = mkdtempSync(join(tmpdir(), "vk-douyin-evidence-"));
const ASSET = join(HOME, "成片.mp4");
const COVER = join(HOME, "封面.png");
writeFileSync(ASSET, "stub video");
writeFileSync(COVER, "stub cover");

let seq = 0;

/** 造一条抖音平台稿（队列里等着发），返回各种 id 和一个接了模拟站的适配器。 */
function setup({ faults = {}, mode = "auto", title = "离线模拟页：AI 剪辑工作流", body = "第一行正文\n第二行正文", tags = ["AI工具", "效率"], cover = null, accountId = null, clockStart } = {}) {
  const n = ++seq;
  const acc = accountId ?? `acc_dy_${n}`;
  const t = Date.now();
  const sim = createSim({ evidenceDir: EVIDENCE, faults, clockStart: clockStart ?? t });
  const adapter = createAdapter({ driver: sim.driver, sleep: sim.sleep, now: sim.now });
  if (!db.prepare("SELECT 1 FROM account WHERE id = ?").get(acc)) {
    db.prepare("INSERT INTO account (id, platform, handle, state, created_at) VALUES (?, 'douyin', ?, 'ok', ?)").run(acc, `@我的抖音号${n}`, t);
  }
  const work = `work_dy_${n}`;
  const cut = `cut_dy_${n}`;
  const ver = `ver_dy_${n}`;
  const pub = `pub_dy_${n}`;
  const meta = { title, description: body, tags, ...(cover ? { cover } : {}) };
  db.prepare("INSERT INTO work (id, title, asset_path, meta_json, created_at) VALUES (?,?,?,?,?)").run(work, title, ASSET, JSON.stringify(meta), t);
  db.prepare("INSERT INTO cut (id, work_id, title, position, created_at) VALUES (?,?,?,0,?)").run(cut, work, title, t);
  db.prepare("INSERT INTO cut_version (id, cut_id, language, asset_path, created_at) VALUES (?,?, 'default', ?, ?)").run(ver, cut, ASSET, t);
  db.prepare(
    "INSERT INTO publish (id, work_id, cut_id, version_id, account_id, mode, visibility, state, created_at, updated_at) VALUES (?,?,?,?,?,?, 'private', 'queued', ?, ?)",
  ).run(pub, work, cut, ver, acc, mode, t, t);
  return { n, acc, pub, sim, adapter, input: (extra = {}) => publishInputFor(pub, extra) };
}

const rowOf = (pub) => db.prepare("SELECT * FROM publish WHERE id = ?").get(pub);
const events = (pub) => db.prepare("SELECT * FROM event WHERE publish_id = ? ORDER BY created_at").all(pub).map((e) => ({ ...e, payload: e.payload_json ? JSON.parse(e.payload_json) : null }));

async function rejects(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AdapterError, `应该抛 AdapterError，实际 ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}：${err.message}`);
    return err;
  }
  assert.fail(`应该抛 ${code}，但没有抛`);
}

const hasShot = (err) => Boolean(err.evidence?.screenshot) && existsSync(err.evidence.screenshot);

// ------------------------------------------------------------------ ACC-douyin-01 许可与移植

test("[01] THIRD_PARTY_NOTICES.md 收录 MIT 全文、版本 3847fff 和移植的文件", () => {
  const text = readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(text, /dreammis\/social-auto-upload/);
  assert.match(text, /3847fff/);
  assert.match(text, /uploader\/douyin_uploader\/main\.py/);
  assert.match(text, /MIT License/);
  assert.match(text, /Copyright \(c\) 2023 dreammis/);
  assert.match(text, /Permission is hereby granted, free of charge/);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test("[01] 适配器源文件头带移植声明", () => {
  const header = "// ported from dreammis/social-auto-upload@3847fff uploader/douyin_uploader/main.py";
  for (const file of ["index.mjs", "page.mjs"]) {
    assert.ok(readFileSync(join(HERE, "..", "src", file), "utf8").split("\n").slice(0, 5).join("\n").includes(header), `${file} 文件头缺移植声明`);
  }
});

test("[01] 硬编码全部剥离：源码里 grep 不到账号名 / cookie 目录 / 固定话题 / 写死的等待秒数 / Python 与 patchright", () => {
  const files = readdirSync(join(HERE, "..", "src")).map((f) => join(HERE, "..", "src", f));
  const forbidden = [
    [/assurelane/i, "账号名"],
    [/storage_state|account_file|cookies?\.json|cookies\//i, "SAU 的登录态文件 / cookie 目录"],
    [/playwright|patchright/i, "patchright / playwright"],
    [/\bpython\b|\.py\b|sidecar/i, "Python / sidecar"],
    [/sleep\(\s*\d+\s*\)/, "写死的等待秒数（等待要走具名常量）"],
    [/#(AI|ai)\b|"#\w+"/, "固定话题"],
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//")) // 注释里讲「没搬什么」不算
      .join("\n");
    for (const [re, what] of forbidden) assert.doesNotMatch(text, re, `${file} 里出现了${what}`);
  }
});

test("[01] 不引入运行时依赖", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(existsSync(join(HERE, "..", "requirements.txt")), false);
});

// ------------------------------------------------------------------ ACC-douyin-02 契约

test("[02] 默认导出通过 validateAdapter：capabilities.draft 为 true，素材只收视频，没有 collect", () => {
  const view = validateAdapter(realAdapter, "adapter-douyin");
  assert.equal(view.platform, "douyin");
  assert.equal(view.publish, "web");
  assert.equal(view.collect, "none");
  assert.equal(view.draft, true);
  assert.equal(view.requiresQualification, false);
  assert.deepEqual(view.assetTypes, ["video"]);
  assert.equal(realAdapter.draftOnly, true);
  assert.equal(realAdapter.respectsPause, true);
  assert.equal(realAdapter.dryRunPreview, true);
  for (const m of ["ready", "check", "publish"]) assert.equal(typeof realAdapter[m], "function");
  const reason = realAdapter.ready();
  assert.ok(reason === null || /^抖音未配置：/.test(reason));
});

test("[02] 真实站点上的 dry-run 只出计划：不开浏览器、不联网、不写任何东西", async () => {
  const { adapter, sim, input, pub } = setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("dry-run 不该联网");
  try {
    const out = await adapter.publish(input({ dryRun: true }));
    assert.equal(out.dryRun, true);
    assert.equal(out.rehearsed, undefined);
    assert.equal(out.request.mode, "draft");
    assert.equal(out.request.title, "离线模拟页：AI 剪辑工作流");
    assert.deepEqual(out.request.topics, ["AI工具", "效率"]);
    assert.equal(out.request.cover, "平台默认封面");
    assert.equal(out.request.quota.cap, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sim.site.opened, 0, "真实站点上 dry-run 不许开浏览器");
  assert.equal(rowOf(pub).state, "queued");
});

test("[02] 本机模拟页上的 dry-run 真走一遍，停在「存草稿」前一步并截图，没有任何副作用", async () => {
  const { adapter, sim, acc } = setup({ cover: COVER });
  const env = { VK_DOUYIN_BASE: "http://127.0.0.1:8099" };
  const rehearsal = createAdapter({ driver: sim.driver, sleep: sim.sleep, now: sim.now, env });
  const out = await rehearsal.publish({
    publishId: null,
    asset: ASSET,
    dryRun: true,
    preview: { accountId: acc },
    copy: { title: "彩排标题", body: "彩排正文", tags: ["彩排"], metaJson: JSON.stringify({ cover: COVER }) },
  });
  assert.equal(out.dryRun, true);
  assert.equal(out.rehearsed, true);
  assert.ok(out.evidence?.screenshot && existsSync(out.evidence.screenshot), "要有截图");
  assert.ok(!sim.site.log.includes("click save-draft"), "dry-run 不许点存草稿");
  assert.equal(sim.site.published, false);
  assert.equal(sim.site.drafts.length, 0, "草稿箱里不许多东西");
  assert.equal(sim.site.form.title, "彩排标题");
  assert.match(sim.site.form.coverSrc, /封面\.png/, "封面已经设上了，才算彩排到「存草稿」前一步");
  assert.equal(sim.site.closed, sim.site.opened, "tab 要关");
  assert.equal(state.draftsToday(acc, sim.now()), 0, "dry-run 不占今天的额度");
  void adapter;
});

// ------------------------------------------------------------------ ACC-douyin-03 存草稿

test("[03] 存草稿全流程：上传 → 标题 → 正文 → 话题 → 封面 → 存草稿 → 回草稿箱读出这一条，记 draft_pending，不是已发布", async () => {
  const { adapter, sim, input, acc } = setup({ cover: COVER });
  const steps = [];
  const result = await adapter.publish(input({ onStep: (s) => steps.push(s) }));

  assert.equal(result.state, "draft_pending");
  assert.equal(result.note, "已送到抖音草稿箱，在手机上点发布");
  assert.equal(result.visibility, "private");
  assert.match(result.id, /^draft-pub_dy_/);
  assert.ok(result.url);

  const { site } = sim;
  assert.equal(site.published, false, "从来不点「发布」");
  assert.equal(site.form.title, "离线模拟页：AI 剪辑工作流");
  assert.equal(site.form.desc, "第一行正文\n第二行正文\n#AI工具 #效率 ");
  assert.match(site.form.coverSrc, /封面\.png/);
  assert.equal(site.drafts.length, 1);
  assert.equal(site.uploadedFile, ASSET);
  assert.equal(site.closed, site.opened);

  // 顺序：先数草稿箱 → 上传 → 填标题与正文 → 封面 → 存草稿 → 再回草稿箱
  const order = ["open drafts", "upload video", "type title", "type desc", "open cover modal", "upload cover", "cover done", "click save-draft", "open drafts"].map((k) => site.log.findIndex((l, i, a) => l === k && (k !== "open drafts" || i === a.indexOf(k) || i > a.indexOf("click save-draft") || true)));
  assert.ok(order.every((i) => i >= 0), `步骤都要出现：${order}`);
  assert.ok(site.log.indexOf("click save-draft") > site.log.indexOf("cover done"));
  assert.ok(site.log.lastIndexOf("open drafts") > site.log.indexOf("click save-draft"), "存完要回草稿箱核实");
  assert.deepEqual(steps.slice(0, 3), ["数草稿箱里已有的同名草稿", "打开上传页并选择视频", "填写标题"]);
  assert.equal(state.draftsToday(acc, sim.now()), 1, "回读成功才记一条额度");
});

test("[03] 标题刚好 55 字可以，56 字在开浏览器之前就报错（asset_invalid，没有截图因为没开页面）", async () => {
  assert.equal(MAX_TITLE_CHARS, 55);
  const ok = setup({ title: "字".repeat(55) });
  assert.equal((await ok.adapter.publish(ok.input())).state, "draft_pending");

  const bad = setup({ title: "字".repeat(56) });
  const err = await rejects(bad.adapter.publish(bad.input()), "asset_invalid");
  assert.match(err.message, /标题最多 55 字，现在是 56 字/);
  assert.equal(bad.sim.site.opened, 0, "超长标题不许开浏览器");
});

test("[03] 标题 + 正文 + 话题合计超 1000 字、没有标题、文件不对，都在发布前报错", async () => {
  const long = setup({ body: "字".repeat(1000) });
  assert.match((await rejects(long.adapter.publish(long.input()), "asset_invalid")).message, /合计.*1000/);
  assert.equal(long.sim.site.opened, 0);

  assert.throws(() => planDraft({ title: "  ", body: "x" }), (e) => e.code === "asset_invalid" && /标题/.test(e.message));

  const s = setup();
  await rejects(s.adapter.publish({ ...s.input(), asset: join(HOME, "不存在.mp4") }), "asset_invalid");
  writeFileSync(join(HOME, "a.txt"), "x");
  await rejects(s.adapter.publish({ ...s.input(), asset: join(HOME, "a.txt") }), "asset_invalid");
  assert.equal(s.sim.site.opened, 0);

  const badCover = setup({ cover: join(HOME, "没有这个封面.png") });
  await rejects(badCover.adapter.publish(badCover.input()), "asset_invalid");
  assert.equal(badCover.sim.site.opened, 0);
});

test("[03] 话题来自平台稿、逐个输入并回读；超过 5 个的不填，写进 notes 而不是悄悄丢", async () => {
  assert.equal(MAX_TOPICS, 5);
  const { adapter, sim, input } = setup({ tags: ["一", "二", "三", "四", "五", "六", "七"] });
  const result = await adapter.publish(input());
  assert.match(sim.site.form.desc, /#一 #二 #三 #四 #五 $/);
  assert.doesNotMatch(sim.site.form.desc, /#六/);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /#六 #七/);
});

test("[03] 话题没输进去 → flaky_ui + 截图，不存草稿", async () => {
  const { adapter, sim, input } = setup({ faults: { dropTopics: true } });
  const err = await rejects(adapter.publish(input()), "flaky_ui");
  assert.match(err.message, /话题「#AI工具」没有填进作品描述/);
  assert.ok(hasShot(err));
  assert.equal(sim.site.drafts.length, 0);
  assert.ok(!sim.site.log.includes("click save-draft"));
});

test("[03] 标题回读对不上（页面截断了）→ flaky_ui + 截图", async () => {
  const { adapter, input } = setup({ faults: { titleMax: 8 } });
  const err = await rejects(adapter.publish(input()), "flaky_ui");
  assert.match(err.message, /作品标题没有填对/);
  assert.ok(hasShot(err));
});

test("[03] 点了存草稿，草稿箱里没多出这一条 → flaky_ui + 截图，不占额度", async () => {
  const { adapter, input, acc, sim } = setup({ faults: { dropDraft: true } });
  const err = await rejects(adapter.publish(input()), "flaky_ui");
  assert.match(err.message, /草稿箱里没有多出/);
  assert.ok(hasShot(err));
  assert.equal(state.draftsToday(acc, sim.now()), 0);
});

test("[03] 草稿箱里已经有同名草稿时，按「多出一条」核实，不会把旧的当成这一条", async () => {
  const { adapter, sim, input } = setup({});
  sim.site.drafts.push({ title: "离线模拟页：AI 剪辑工作流", body: "旧的" });
  assert.equal((await adapter.publish(input())).state, "draft_pending");
  assert.equal(sim.site.drafts.length, 2);

  const lost = setup({ faults: { dropDraft: true } });
  lost.sim.site.drafts.push({ title: "离线模拟页：AI 剪辑工作流", body: "旧的" });
  await rejects(lost.adapter.publish(lost.input()), "flaky_ui");
});

test("[03] 封面：入库封面有就用；没有就不碰封面，页面要求时选平台推荐封面", async () => {
  const none = setup({});
  await none.adapter.publish(none.input());
  assert.ok(!none.sim.site.log.includes("open cover modal"), "没有入库封面就不打开封面弹窗");

  const need = setup({ faults: { coverRequired: true } });
  const result = await need.adapter.publish(need.input());
  assert.equal(result.state, "draft_pending");
  assert.ok(need.sim.site.log.includes("recommend cover"), "页面要求先设封面：选平台推荐封面");
  assert.equal(need.sim.site.log.filter((l) => l === "click save-draft").length, 2);

  const stuck = setup({ faults: { coverAlwaysRequired: true } });
  const err = await rejects(stuck.adapter.publish(stuck.input()), "flaky_ui");
  assert.match(err.message, /一直提示要先设封面/);
  assert.ok(hasShot(err));
});

test("[03] 封面弹窗打不开 / 点完成关不掉 / 入口找不到 → flaky_ui + 截图（不带着浮层往下点）", async () => {
  const noEntry = setup({ cover: COVER, faults: { noCoverEntry: true } });
  const e1 = await rejects(noEntry.adapter.publish(noEntry.input()), "flaky_ui");
  assert.match(e1.message, /封面弹窗打不开/);
  assert.ok(hasShot(e1));

  const never = setup({ cover: COVER, faults: { coverNeverCloses: true } });
  const e2 = await rejects(never.adapter.publish(never.input()), "flaky_ui");
  assert.ok(hasShot(e2));
  assert.equal(never.sim.site.drafts.length, 0);
});

test("[03] 找不到「存草稿」按钮 / 找不到草稿箱入口 / 上传页没有文件控件 / 标题框一直不出现 → flaky_ui + 截图", async () => {
  for (const [fault, re] of [
    [{ noSaveButton: true }, /找不到「存草稿/],
    [{ noDraftsTab: true }, /找不到「草稿箱」/],
    [{ noUploadInput: true }, /没有出现文件控件/],
  ]) {
    const s = setup({ faults: fault });
    const err = await rejects(s.adapter.publish(s.input()), "flaky_ui");
    assert.match(err.message, re);
    assert.ok(hasShot(err), JSON.stringify(fault));
    assert.equal(s.sim.closed ?? s.sim.site.closed, s.sim.site.opened, "出错也要关 tab");
  }
});

test("[03] 视频上传失败 → flaky_ui + 截图", async () => {
  const s = setup({ faults: { uploadFail: true } });
  const err = await rejects(s.adapter.publish(s.input()), "flaky_ui");
  assert.match(err.message, /上传失败/);
  assert.ok(hasShot(err));
});

test("[03] 驱动抛的普通 Error（Chrome 起不来）不丢：归 unknown 并保留原文", async () => {
  const s = setup({ faults: { openFails: true } });
  const err = await rejects(s.adapter.publish(s.input()), "unknown");
  assert.match(err.message, /Chrome 起不来/);
});

test("[03] 总时限 abort：中止、报 timeout、关 tab，不继续点", async () => {
  const s = setup({ faults: { uploadMs: 60 * 60e3 } });
  const controller = new AbortController();
  const p = s.adapter.publish(s.input({ signal: controller.signal, onStep: (step) => step === "等视频上传完成" && controller.abort() }));
  const err = await rejects(p, "timeout");
  assert.match(err.message, /总时限/);
  assert.ok(!s.sim.site.log.includes("click save-draft"));
  assert.equal(s.sim.site.closed >= 1, true);
});

// ------------------------------------------------------------------ ACC-douyin-04 时间 / 只存草稿的模式

test("[04] 只存草稿：core 把「自动发」当「存草稿」跑（draft_running → draft_pending），现在发立即送、预约发到点才送，都不会变已发布", async () => {
  for (const scheduled of [false, true]) {
    const s = setup({ mode: "auto" });
    if (scheduled) db.prepare("UPDATE publish SET scheduled_at = ? WHERE id = ?").run(Date.now() + 3600e3, s.pub);
    const info = validateAdapter(s.adapter, "adapter-douyin");
    const handlers = buildHandlers([info]);
    const out = await handlers.publish({ id: `run_${s.pub}`, target_id: s.pub });
    assert.equal(out.state, "draft_pending");
    const row = rowOf(s.pub);
    assert.equal(row.state, "draft_pending");
    assert.equal(row.published_at, null, "草稿不算已发布");
    assert.ok(row.external_id.startsWith("draft-"));
    const trail = events(s.pub);
    assert.ok(trail.some((e) => e.type === "publish.degraded" && e.payload?.to === "draft_pending"), "状态迁移留事件");
    const sent = trail.find((e) => e.payload?.kind === "draft_sent");
    assert.ok(sent, "要发「已送到草稿箱」事件，今天页 / 飞书卡片据此提醒去手机上发");
    assert.match(sent.payload.message, /在手机上点发布/);
  }
});

test("[04] 选了「通知我」的仍然是通知，不会偷偷送草稿箱", async () => {
  const s = setup({ mode: "notify" });
  const handlers = buildHandlers([validateAdapter(s.adapter, "adapter-douyin")]);
  const out = await handlers.publish({ id: `run_${s.pub}`, target_id: s.pub });
  assert.equal(out.state, "notify_pending");
  assert.equal(s.sim.site.opened, 0);
});

// ------------------------------------------------------------------ ACC-douyin-05 登录与体检

test("[05] check：正常 / 登录过期 / 被限制 / 需要人工验证，给人话；页面没渲染出来报 flaky_ui + 截图", async () => {
  const ok = setup({});
  assert.deepEqual(await ok.adapter.check({ accountId: ok.acc }), { state: "ok" });
  assert.equal(ok.sim.site.closed, ok.sim.site.opened);
  assert.ok(ok.sim.site.log.includes("goto /creator-micro/home"), "体检只读首页");
  assert.ok(!ok.sim.site.log.includes("click save-draft"));

  const expired = setup({ faults: { mode: "login" } });
  const e = await expired.adapter.check({ accountId: expired.acc });
  assert.equal(e.state, "expired");
  assert.match(e.detail, /在发布机上打开登录窗口/);

  const limited = setup({ faults: { mode: "limited" } });
  const l = await limited.adapter.check({ accountId: limited.acc });
  assert.equal(l.state, "banned");
  assert.match(l.detail, /限制/);

  const risk = setup({ faults: { mode: "risk" } });
  const r = await risk.adapter.check({ accountId: risk.acc });
  assert.equal(r.state, "manual");
  assert.match(r.detail, /手动过一下验证/);

  const blank = setup({ faults: { homeBlank: true } });
  const err = await rejects(blank.adapter.check({ accountId: blank.acc }), "flaky_ui");
  assert.ok(hasShot(err));

  await assert.rejects(() => ok.adapter.check({}), (x) => x.code === "unknown");
});

test("[05] 登录过期时账号变「需要重新登录」并发事件（走 core 的 checkAccount）", async () => {
  const s = setup({ faults: { mode: "login" } });
  const info = validateAdapter(s.adapter, "adapter-douyin");
  const out = await checkAccount([info], s.acc);
  assert.equal(out.state, "expired");
  assert.equal(db.prepare("SELECT state FROM account WHERE id = ?").get(s.acc).state, "expired");
  const ev = db.prepare("SELECT * FROM event WHERE type = 'account.expired' AND payload_json LIKE ?").get(`%${s.acc}%`);
  assert.ok(ev, "要发 account.expired 事件");
});

test("[05] 发布时被踢回登录页 → auth + 截图；core 把账号转需要重新登录并把这条转 blocked", async () => {
  const s = setup({ faults: { mode: "login" } });
  const err = await rejects(s.adapter.publish(s.input()), "auth");
  assert.match(err.message, /登录窗口/);
  assert.ok(hasShot(err));

  const t = setup({ faults: { mode: "login" } });
  const handlers = buildHandlers([validateAdapter(t.adapter, "adapter-douyin")]);
  const out = await handlers.publish({ id: `run_${t.pub}`, target_id: t.pub });
  assert.equal(out.error, "auth");
  assert.equal(rowOf(t.pub).state, "blocked");
  assert.equal(db.prepare("SELECT state FROM account WHERE id = ?").get(t.acc).state, "expired");
});

// ------------------------------------------------------------------ ACC-douyin-06 安全预算与错误

test("[06] 每个账号每天送草稿箱默认 3 条，沿用按平台额度；别的平台不受影响；可改", () => {
  assert.equal(planRules("douyin").dailyCap, 3);
  assert.equal(planRules("xiaohongshu").dailyCap, 10);
  assert.equal(planRules("tiktok").dailyCap, 10);
  assert.equal(describeRules("douyin").isDefault, true);
  assert.equal(describeRules("douyin").dailyCap, 3);
  updateConfig({ plan: { rules: { platforms: { douyin: { daily_cap: 5 } } } } });
  try {
    assert.equal(planRules("douyin").dailyCap, 5);
    assert.equal(describeRules("douyin").isDefault, false);
    assert.equal(planRules("tiktok").dailyCap, 10);
  } finally {
    updateConfig({ plan: { rules: { platforms: { douyin: null } } } });
  }
  assert.equal(planRules("douyin").dailyCap, 3, "改回去后恢复默认");
});

test("[06] 到每日上限就不再送：说明原因、不开浏览器；第二天重新计数", async () => {
  const acc = `acc_dy_cap_${++seq}`;
  const start = new Date(2026, 10, 21, 9, 0, 0).getTime();
  for (let i = 0; i < 3; i++) {
    const s = setup({ accountId: acc, clockStart: start + i * 60e3 });
    assert.equal((await s.adapter.publish(s.input())).state, "draft_pending");
  }
  const fourth = setup({ accountId: acc, clockStart: start + 600e3 });
  const err = await rejects(fourth.adapter.publish(fourth.input()), "platform_reject");
  assert.match(err.message, /今天已经送了 3 条到抖音草稿箱，达到每日上限 3 条/);
  assert.match(err.message, /调高上限/);
  assert.equal(fourth.sim.site.opened, 0, "到上限不开浏览器");
  assert.equal(fourth.sim.site.drafts.length, 0);

  // core 对 platform_reject：转「待人处理」，人话进事件
  const handlers = buildHandlers([validateAdapter(fourth.adapter, "adapter-douyin")]);
  await handlers.publish({ id: `run_${fourth.pub}`, target_id: fourth.pub });
  assert.equal(rowOf(fourth.pub).state, "notify_pending");

  const nextDay = setup({ accountId: acc, clockStart: new Date(2026, 10, 22, 9, 0, 0).getTime() });
  assert.equal((await nextDay.adapter.publish(nextDay.input())).state, "draft_pending", "次日重新计数");
});

test("[06] 风控页面（验证码 / 滑块 / 操作太频繁）：立即停下、不重试、账号暂停到次日零点、有截图和人话", async () => {
  const start = new Date(2026, 10, 21, 22, 30, 0).getTime();
  for (const riskOn of ["upload", "manage", "save", "publish-page"]) {
    const s = setup({ faults: { riskOn }, clockStart: start });
    const err = await rejects(s.adapter.publish(s.input()), "platform_reject");
    assert.match(err.message, /抖音要你在发布机的窗口里手动过一下验证/, riskOn);
    assert.match(err.message, /没有重试/);
    assert.equal(err.platformCode, "douyin_risk_control");
    assert.equal(err.pause.until, new Date(2026, 10, 22, 0, 0, 0).getTime(), "暂停到次日本机零点");
    assert.ok(hasShot(err), riskOn);
    assert.equal(s.sim.site.opened, 1, "不重试：只开过一次浏览器");
    assert.equal(s.sim.site.closed, 1);
    assert.equal(s.sim.site.published, false);
    assert.equal(state.pausedUntil(s.acc, start), err.pause.until);
    // 暂停期间再发：不开浏览器直接拒
    const again = setup({ accountId: s.acc, clockStart: start });
    await rejects(again.adapter.publish(again.input()), "platform_reject");
    assert.equal(again.sim.site.opened, 0);
    // 到点放开，且只放开一次
    assert.deepEqual(state.lapsedPauses(err.pause.until + 1), [s.acc]);
    assert.deepEqual(state.lapsedPauses(err.pause.until + 2), []);
    assert.equal(state.pausedUntil(s.acc, err.pause.until + 1), null);
  }
});

test("[06] 风控走 core：账号暂停 + 事件（publish.needs_human）；暂停中的账号其余稿子不发，不开浏览器", async () => {
  const s = setup({ faults: { riskOn: "upload" } });
  const handlers = buildHandlers([validateAdapter(s.adapter, "adapter-douyin")]);
  const out = await handlers.publish({ id: `run_${s.pub}`, target_id: s.pub });
  assert.equal(out.state, "notify_pending");
  assert.equal(db.prepare("SELECT is_manual FROM account WHERE id = ?").get(s.acc).is_manual, 1);
  const paused = events(s.pub).find((e) => e.payload?.accountPaused);
  assert.ok(paused, "要发账号暂停事件");
  assert.equal(paused.payload.platform_error, "douyin_risk_control");
  assert.ok(paused.payload.pausedUntil > Date.now());
  assert.match(paused.payload.message, /手动过一下验证/);

  // 同账号的另一条：core 的 respectsPause 拦住，没开浏览器
  const other = setup({ accountId: s.acc });
  const info = validateAdapter(other.adapter, "adapter-douyin");
  const out2 = await buildHandlers([info]).publish({ id: `run_${other.pub}`, target_id: other.pub });
  assert.equal(out2.error, "account_paused");
  assert.equal(other.sim.site.opened, 0);
});

test("[06] 每种失败都有 AdapterError code：asset_invalid / auth / flaky_ui / platform_reject（上面逐条钉过），错误码都是 core 登记过的", async () => {
  const { ERROR_CODE_LIST } = await import("../../core/src/errors.mjs");
  const seen = new Set();
  const cases = [
    [setup({ title: "字".repeat(56) }), "asset_invalid"],
    [setup({ faults: { mode: "login" } }), "auth"],
    [setup({ faults: { dropDraft: true } }), "flaky_ui"],
    [setup({ faults: { riskOn: "upload" } }), "platform_reject"],
  ];
  for (const [s, code] of cases) {
    const err = await rejects(s.adapter.publish(s.input()), code);
    seen.add(err.code);
    assert.ok(ERROR_CODE_LIST.includes(err.code));
    assert.ok(err.message.length > 5, "要有人话");
  }
  assert.equal(seen.size, 4);
});

// ------------------------------------------------------------------ 页面函数与模拟页 / 离线页面的一致性

test("页面函数自包含：互相不引用（序列化进页面后只剩函数自己）", () => {
  // baseUrl / isLocalBase / urls 是适配器自己用的纯函数，不进页面；其余都会被序列化送进 Chrome
  const fns = Object.entries(page).filter(([k, v]) => typeof v === "function" && !["baseUrl", "isLocalBase", "urls"].includes(k));
  assert.ok(fns.length > 20);
  for (const [name, fn] of fns) {
    for (const [other] of fns) {
      if (other === name) continue;
      assert.doesNotMatch(String(fn), new RegExp(`\\b${other}\\s*\\(`), `${name} 里调用了 ${other}：序列化进页面后会 ReferenceError`);
    }
  }
});

test("适配器用到的每个页面函数，模拟页都有对应实现（否则测试在骗人）", () => {
  const src = readFileSync(join(HERE, "..", "src", "index.mjs"), "utf8");
  const used = new Set([...src.matchAll(/page\.([A-Za-z]+)/g)].map((m) => m[1]));
  const sim = readFileSync(join(HERE, "sim-page.mjs"), "utf8");
  for (const name of used) {
    if (typeof page[name] !== "function" || ["baseUrl", "isLocalBase", "urls"].includes(name)) continue; // 常量与不进页面的纯函数
    assert.match(sim, new RegExp(`\\b${name}\\b`), `模拟页没有实现 ${name}`);
  }
});

test("离线模拟页（fixtures/）复现了适配器依赖的结构和文案", () => {
  const html = readdirSync(join(HERE, "..", "fixtures"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => readFileSync(join(HERE, "..", "fixtures", f), "utf8"))
    .join("\n");
  for (const needle of [
    "upload-btn-input",
    "填写作品标题",
    'class="zone-container"',
    'contenteditable="true"',
    "long-card",
    ...page.T.reupload.slice(0, 1),
    "dy-creator-content-modal",
    "semi-upload-drag-area-main-text",
    "semi-upload-hidden-input",
    "semi-button-disabled",
    "recommendCover-",
    ...page.T.coverNeeded.slice(0, 1),
    ...page.T.saveDraft.slice(0, 1),
    ...page.T.draftsTab.slice(0, 1),
    ...page.T.coverEdit.slice(0, 1),
    ...page.T.coverPortrait.slice(0, 1),
    ...page.T.coverDone.slice(0, 1),
    ...page.T.login.slice(0, 2),
  ]) {
    assert.ok(html.includes(needle), `fixtures 里没有「${needle}」：适配器依赖它，模拟页必须复现`);
  }
});

test("isLocalBase / baseUrl：只有回环地址和 file:// 算本机模拟页", () => {
  assert.equal(page.baseUrl({}), "https://creator.douyin.com");
  assert.equal(page.baseUrl({ VK_DOUYIN_BASE: "http://127.0.0.1:8099/" }), "http://127.0.0.1:8099");
  assert.equal(page.isLocalBase("http://127.0.0.1:8099"), true);
  assert.equal(page.isLocalBase("http://localhost:1"), true);
  assert.equal(page.isLocalBase("https://creator.douyin.com"), false);
  assert.equal(page.isLocalBase("https://127.0.0.1.evil.example"), false);
  assert.equal(page.isLocalBase("not a url"), false);
});
