// 图文路径的结果判定（#134 · ACC-publish-08 / 09）：全部用录制的接口响应 / fixture，
// 不打开浏览器、不碰任何真实账号。
import { test } from "node:test";
import assert from "node:assert/strict";
import { submitAndWait, NET_HOOK } from "../src/image-note.mjs";
import { AdapterError, ERROR_CODES, isRetryable } from "../../core/src/errors.mjs";

// 录制的发布接口响应（字段形状与视频路径 noteIdFromPublishResponse 一致）
const RECORDED_OK = JSON.stringify({ success: true, code: 0, msg: "成功", data: { id: "6740aa11000000001b02c3d4", score: 0 } });

function fakePage({ onClick } = {}) {
  const page = { url: "https://creator.xiaohongshu.com/publish/publish", text: "发布笔记 2/18", btn: "false|false", seen: 3, uploads: 0, submits: [], clicks: 0 };
  const tab = {
    async eval(expr) {
      if (expr === NET_HOOK) return true;
      const { clicks, ...shot } = page;
      return JSON.stringify(shot);
    },
    async clickInShadow() {
      page.clicks += 1;
      onClick?.(page);
    },
  };
  return { page, tab };
}
const fast = { budgetMs: 800, settleMs: 100, gaps: [60, 80], every: 10 };
const rec = (body, status = 200) => ({ at: Date.now(), status, body, done: Date.now() });

test("图文：接口回执有 note_id → published，id 是真实笔记 id，不核对、不重复点", async () => {
  const { page, tab } = fakePage({ onClick: (p) => p.submits.push(rec(RECORDED_OK)) });
  let verified = 0;
  const r = await submitAndWait(tab, () => {}, { ...fast, verify: async () => (verified++, null) });
  assert.equal(r.state, "published");
  assert.equal(r.noteId, "6740aa11000000001b02c3d4");
  assert.equal(page.clicks, 1);
  assert.equal(verified, 0);
});

test("图文：页面显示成功但回执没有 id → 去笔记管理核对，核对到就用真实 id", async () => {
  const { tab } = fakePage({
    onClick: (p) => {
      p.submits.push(rec(JSON.stringify({ success: true })));
      p.text = "发布成功";
    },
  });
  const sinces = [];
  const r = await submitAndWait(tab, () => {}, { ...fast, verify: async (since) => (sinces.push(since), "n-from-manager") });
  assert.equal(r.noteId, "n-from-manager");
  assert.equal(sinces.length, 1);
  assert.ok(sinces[0] > 0 && sinces[0] <= Date.now());
});

test("图文：页面成功文字但笔记管理核对不到 → result_unconfirmed，绝不拿标题当 id", async () => {
  const { tab } = fakePage({ onClick: (p) => (p.text = "发布成功") });
  await assert.rejects(
    submitAndWait(tab, () => {}, { ...fast, verify: async () => null }),
    (err) => err instanceof AdapterError && err.code === "result_unconfirmed" && /请到笔记管理核对/.test(err.message),
  );
});

test("图文：点击后无回执、核对不到 → result_unconfirmed → notify_pending，不重试、不转草稿", async () => {
  const { tab } = fakePage({ onClick: (p) => (p.btn = "true|false") }); // 提交中，之后什么都没发生
  let verified = 0;
  await assert.rejects(
    submitAndWait(tab, () => {}, { ...fast, budgetMs: 300, verify: async () => (verified++, null) }),
    (err) => err.code === "result_unconfirmed",
  );
  assert.equal(verified, 1, "自动去笔记管理核对一次");
  assert.equal(isRetryable("result_unconfirmed"), false);
  assert.equal(ERROR_CODES.result_unconfirmed.escalateTo, undefined);
  assert.equal(ERROR_CODES.result_unconfirmed.publishState, "notify_pending");
});

test("图文：点击后无回执但核对到了 → 改判成功", async () => {
  const { tab } = fakePage({ onClick: (p) => (p.btn = "true|false") });
  const r = await submitAndWait(tab, () => {}, { ...fast, budgetMs: 300, verify: async () => "n-late" });
  assert.equal(r.state, "published");
  assert.equal(r.noteId, "n-late");
});

test("图文：核对本身出错也只是「核对不到」，仍是 result_unconfirmed", async () => {
  const { tab } = fakePage({ onClick: (p) => (p.btn = "true|false") });
  await assert.rejects(
    submitAndWait(tab, () => {}, {
      ...fast,
      budgetMs: 300,
      verify: async () => {
        throw new Error("boom");
      },
    }),
    (err) => err.code === "result_unconfirmed",
  );
});

test("图文：点击之前失败（第一下点击就抛错）原样上抛，不转 result_unconfirmed，onClicked 不触发", async () => {
  const tab = {
    async eval() {
      return JSON.stringify({ url: "", text: "", btn: "false|false", hooked: true, seen: 1, uploads: 0, submits: [] });
    },
    async clickInShadow() {
      throw new AdapterError("flaky_ui", "找不到发布按钮");
    },
  };
  let clicked = false;
  await assert.rejects(
    submitAndWait(tab, () => {}, { ...fast, onClicked: () => (clicked = true) }),
    (err) => err.code === "flaky_ui",
  );
  assert.equal(clicked, false);
  assert.equal(isRetryable("flaky_ui"), true);
});

test("图文：平台明确拒绝仍是 platform_reject（有明确结局，不是「判不出」）", async () => {
  const { tab } = fakePage({ onClick: (p) => p.submits.push(rec(JSON.stringify({ success: false, msg: "内容违规" }))) });
  await assert.rejects(submitAndWait(tab, () => {}, fast), (err) => err.code === "platform_reject" && /内容违规/.test(err.message));
});
