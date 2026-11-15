// 小红书适配器：能力声明、「图片不当视频硬传」的本地兜底（#74 / ACC-publish-04），
// 以及图文笔记的素材口径（#93 / ACC-publish-06）。
//
// 这里不启动浏览器：本地校验（格式 / 数量 / 混装 / 可见性）全部在 openAccount 之前完成，
// dry-run 也在对外动作之前返回。真机路径由 ACC-publish-07 的「测试探针」账号验收。
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-xhs-"));

const core = await import("../../core/src/index.mjs");
const { AdapterError } = await import("../../core/src/errors.mjs");
const adapter = (await import("../src/index.mjs")).default;
const { planImageNote, rejectionSentenceOf, submitAndWait, submitVerdict, NET_HOOK } = await import("../src/image-note.mjs");

const db = () => core.open();
let seq = 0;

function fixture(asset) {
  const k = ++seq;
  const now = Date.now();
  db().prepare("INSERT INTO work (id,title,asset_path,meta_json,created_at) VALUES (?,?,?,?,?)").run(
    `w${k}`,
    "小红书测试",
    asset,
    JSON.stringify({ title: "测试标题", body: "测试正文" }),
    now,
  );
  db().prepare("INSERT INTO account (id,platform,handle,state,created_at) VALUES (?,?,?, 'ok', ?)").run(`a${k}`, "xiaohongshu", `@x${k}`, now);
  db()
    .prepare("INSERT INTO publish (id,work_id,account_id,mode,visibility,state,created_at,updated_at) VALUES (?,?,?, 'auto','public','auto_running',?,?)")
    .run(`p${k}`, `w${k}`, `a${k}`, now, now);
  return `p${k}`;
}

/** 在临时目录里造一个图集；files 的顺序就是我们要的自然排序输入（故意乱序）。 */
function imageDir(name, files) {
  const dir = join(process.env.VK_HOME, name);
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), "fake image");
  return dir;
}

before(() => core.migrate());
beforeEach(() => {
  db().exec("DELETE FROM publish; DELETE FROM work; DELETE FROM account;");
});

test("能力声明：小红书支持视频与图文", () => {
  assert.deepEqual(adapter.capabilities.assetTypes, ["video", "image"], "声明出来，发布台才能在创建前拦住发不了的素材");
});

test("图片素材不再被适配器拒绝：图文目录 dry-run 返回按文件名自然排序的图片", async () => {
  const dir = imageDir("note-natural-order", ["10-green.png", "2-blue.png", "01-red.png"]);
  const publishId = fixture(dir);

  const result = await adapter.publish({ publishId, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.target.kind, "image");
  assert.equal(result.target.imageCount, 3);
  assert.deepEqual(
    result.target.images.map((f) => f.split("/").pop()),
    ["01-red.png", "2-blue.png", "10-green.png"],
    "按文件名自然排序：1 < 2 < 10，而不是字典序 10 < 2",
  );
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "auto_running");
});

test("单张图片文件（发布台单文件路径）也算图文，不再被当成视频硬传", async () => {
  const png = join(process.env.VK_HOME, "01_pier_landing.png");
  writeFileSync(png, "fake image");
  const publishId = fixture(png);

  const result = await adapter.publish({ publishId, dryRun: true });
  assert.equal(result.target.kind, "image");
  assert.equal(result.target.imageCount, 1);
  assert.deepEqual(result.target.images, [png]);
});

test("图文格式口径：gif 等平台不收的图片在打开浏览器之前被拒绝", async () => {
  const dir = imageDir("note-gif", ["01.png", "02.gif"]);
  const publishId = fixture(dir);

  await assert.rejects(
    () => adapter.publish({ publishId, dryRun: true }),
    (err) => err instanceof AdapterError && err.code === "asset_invalid" && /只收 jpg \/ png \/ webp/.test(err.message) && /02\.gif/.test(err.message),
  );
});

test("图文数量口径：超过 18 张在打开浏览器之前被拒绝", async () => {
  const files = Array.from({ length: 19 }, (_, i) => `img-${String(i + 1).padStart(2, "0")}.png`);
  const dir = imageDir("note-too-many", files);
  const publishId = fixture(dir);

  await assert.rejects(
    () => adapter.publish({ publishId, dryRun: true }),
    (err) => err instanceof AdapterError && err.code === "asset_invalid" && /最多 18 张/.test(err.message) && /19/.test(err.message),
  );
});

test("同一作品图片与视频混装：适配器在本地拒绝并说人话（创建前还有 core 那道）", async () => {
  const dir = imageDir("note-mixed", ["01.png", "clip.mp4"]);
  const publishId = fixture(dir);

  await assert.rejects(
    () => adapter.publish({ publishId, dryRun: true }),
    (err) =>
      err instanceof AdapterError &&
      err.code === "asset_invalid" &&
      /不能把图片和视频混在一起/.test(err.message) &&
      /note-mixed/.test(err.message),
  );
});

test("视频 dry-run 照常返回，不改状态、不打开浏览器", async () => {
  const mp4 = join(process.env.VK_HOME, "clip.mp4");
  writeFileSync(mp4, "fake video");
  const publishId = fixture(mp4);

  const result = await adapter.publish({ publishId, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.target.asset, mp4);
  assert.equal(result.target.kind, "video");
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "auto_running");
});

test("图文可见性：private 映射到「仅自己可见」，private_then_public 先发私密并留 followup", () => {
  const files = ["/tmp/01.png", "/tmp/02.png"];
  const priv = planImageNote({ asset: "/tmp/imgs", files, visibility: "private" });
  assert.equal(priv.visibilityText, "仅自己可见");
  assert.equal(priv.wantsPublicFollowup, false);

  const later = planImageNote({ asset: "/tmp/imgs", files, visibility: "private_then_public" });
  assert.equal(later.visibilityText, "仅自己可见");
  assert.equal(later.wantsPublicFollowup, true, "先发私密、再由 followup 提醒改公开，不假装已经公开");

  assert.throws(() => planImageNote({ asset: "/tmp/imgs", files, visibility: "unlisted" }), /不认识的可见性/);
});

test("平台拒绝文案：摘出平台自己的那句话，摘不到不编", () => {
  assert.equal(rejectionSentenceOf("发布\n因违反社区规范禁止发笔记"), "因违反社区规范禁止发笔记");
  assert.equal(rejectionSentenceOf("发布成功"), "");
  assert.equal(rejectionSentenceOf(null), "");
});

// ── 点「发布」要看效果（ACC-publish-07 第 5 轮：按钮可点、事件也到了，平台却没发出提交）──
//
// 假页面：eval(NET_HOOK) 装钩子；eval(其他) 是快照；clickInShadow 由 onClick 决定这一下有没有效果。
function fakePage({ onClick, uploads = 0 } = {}) {
  const page = { url: "https://creator.xiaohongshu.com/publish/publish", text: "发布笔记 2/18", btn: "false|false", seen: 3, uploads, submits: [], clicks: 0, hooked: false };
  const tab = {
    async eval(expr) {
      if (expr === NET_HOOK) {
        page.hooked = true;
        return true;
      }
      const { clicks, ...shot } = page;
      return JSON.stringify(shot);
    },
    async clickInShadow(host, text) {
      assert.equal(host, "xhs-publish-btn");
      assert.equal(text, "发布");
      page.clicks += 1;
      onClick?.(page);
    },
  };
  return { page, tab };
}
const fast = { budgetMs: 2000, settleMs: 300, gaps: [80, 120, 160], every: 10 };

test("提交：点一次就发出提交且接口确认 → published，只点一次", async () => {
  const { page, tab } = fakePage({
    onClick: (p) => {
      p.submits.push({ at: Date.now(), status: 200, body: JSON.stringify({ success: true, code: 0 }), done: Date.now() });
      p.url = "https://creator.xiaohongshu.com/publish/success";
    },
  });
  const r = await submitAndWait(tab, () => {}, fast);
  assert.equal(r.state, "published");
  assert.equal(page.clicks, 1);
  assert.equal(page.hooked, true);
});

test("提交：前几次点击没发出提交请求 → 按退避再点，直到平台真的收下", async () => {
  const steps = [];
  const { page, tab } = fakePage({
    onClick: (p) => {
      if (p.clicks < 3) return; // 前两下：事件到了按钮，但平台没有发出提交（验收现场）
      p.submits.push({ at: Date.now(), status: 200, body: "{}", done: Date.now() });
      p.text = "发布成功";
    },
  });
  const r = await submitAndWait(tab, (s) => steps.push(s), fast);
  assert.equal(r.state, "published");
  assert.equal(page.clicks, 3);
  assert.ok(steps.some((s) => /第 2 次点击发布/.test(s)), steps.join(" / "));
});

test("提交：已发出提交就绝不再点（避免重复发帖），回执失败把平台原话带给人", async () => {
  const { page, tab } = fakePage({
    onClick: (p) => {
      const rec = { at: Date.now(), status: 0, body: "", done: 0 };
      p.submits.push(rec);
      setTimeout(() => Object.assign(rec, { status: 200, body: JSON.stringify({ success: false, code: -9135, msg: "笔记包含敏感信息" }), done: Date.now() }), 300);
    },
  });
  await assert.rejects(
    submitAndWait(tab, () => {}, fast),
    (err) => err instanceof AdapterError && err.code === "platform_reject" && /笔记包含敏感信息/.test(err.message),
  );
  assert.equal(page.clicks, 1);
});

test("提交：一直没发出提交 → 预算内停手，flaky_ui 说清点了几次、没发出去、可以重试", async () => {
  const { page, tab } = fakePage({ onClick: () => {} });
  await assert.rejects(
    submitAndWait(tab, () => {}, { ...fast, budgetMs: 600 }),
    (err) => err instanceof AdapterError && err.code === "flaky_ui" && /点了 \d+ 次「发布」/.test(err.message) && /没有发出去/.test(err.message),
  );
  assert.ok(page.clicks >= 2, `应当重试过，实际 ${page.clicks} 次`);
});

test("提交：图片上传请求还在途时先等，不在图片没就绪时点发布", async () => {
  const { page, tab } = fakePage({
    uploads: 2,
    onClick: (p) => {
      assert.equal(p.uploads, 0, "上传请求清零前不该点发布");
      p.text = "发布成功";
    },
  });
  setTimeout(() => (page.uploads = 0), 100);
  const r = await submitAndWait(tab, () => {}, fast);
  assert.equal(r.state, "published");
});

test("提交：看不到页面请求（钩子失效）时最多点两次，不盲目连点", async () => {
  const { page, tab } = fakePage({ onClick: () => {} });
  page.seen = 0;
  await assert.rejects(submitAndWait(tab, () => {}, fast), (err) => err.code === "flaky_ui" && /观察不到/.test(err.message));
  assert.equal(page.clicks, 2);
});

test("提交回执口径：success:false / code≠0 / 非 2xx 是拒绝，空 2xx 回执算收下", () => {
  assert.equal(submitVerdict(null).state, "pending");
  assert.equal(submitVerdict({ done: 0 }).state, "pending");
  assert.equal(submitVerdict({ done: 1, status: 200, body: '{"success":true,"code":0}' }).state, "ok");
  assert.equal(submitVerdict({ done: 1, status: 200, body: "" }).state, "ok");
  assert.deepEqual(submitVerdict({ done: 1, status: 200, body: '{"success":false,"msg":"今日发布次数已达上限"}' }), { state: "rejected", message: "今日发布次数已达上限" });
  assert.equal(submitVerdict({ done: 1, status: 500, body: "oops" }).state, "rejected");
});
