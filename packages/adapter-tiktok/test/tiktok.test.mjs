// TikTok 适配器测试：只测不依赖浏览器的部分 —— 发布计划、指标归一化、契约形状、参数校验。
// 不启动 Chrome、不联网；真的页面行为由人工环境里的契约测试兜底（docs/BLUEPRINT §5.2）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 必须在 import 之前指好状态目录：适配器会 import core，但测试不碰库。
process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-tiktok-"));

const {
  default: adapter,
  planPost,
  normaliseMetrics,
  findMetricsItem,
  newestVideoId,
  MAX_CAPTION_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
} = await import("../src/index.mjs");
const { validateAdapter } = await import("../../core/src/contract.mjs");
const { AdapterError, ERROR_CODES } = await import("../../core/src/errors.mjs");

const HERE = fileURLToPath(new URL("../src/index.mjs", import.meta.url));

const json = (value) => JSON.stringify(value);

// ------------------------------------------------------------------ 契约

test("default 通过 validateAdapter：platform / capabilities / 四个方法都在", () => {
  const view = validateAdapter(adapter, "adapter-tiktok");
  assert.equal(view.platform, "tiktok");
  assert.equal(view.publish, "web");
  assert.equal(view.collect, "web");
  assert.equal(view.draft, false);
  assert.equal(view.requiresQualification, false);
  assert.deepEqual(view.visibility, ["public", "private", "friends"]);
  for (const method of ["ready", "check", "publish", "collect"]) {
    assert.equal(typeof adapter[method], "function", `${method} 必须是函数`);
  }
});

test("ready() 只返回 null 或一句人话", () => {
  const reason = adapter.ready();
  assert.ok(reason === null || typeof reason === "string", `ready() 返回了 ${typeof reason}`);
  if (typeof reason === "string") assert.match(reason, /^TikTok /);
});

// ------------------------------------------------------------------ planPost

test("planPost 从 work/meta 取默认值，标题在前、正文在后", () => {
  const plan = planPost({
    work_title: "默认标题",
    visibility: "public",
    meta_json: json({
      description: "默认正文",
      tags: ["#出海", "效率"],
      tiktok: { cover: "/tmp/tiktok-cover.png" },
    }),
  });
  assert.deepEqual(plan, {
    caption: "默认标题\n\n默认正文",
    tags: ["出海", "效率"],
    visibility: "public",
    cover: "/tmp/tiktok-cover.png",
  });
});

test("overrides 压过 work/meta：标题、正文、话题、可见性、封面都按本条发布走", () => {
  const plan = planPost({
    work_title: "基础标题",
    visibility: "public",
    meta_json: json({ description: "基础正文", tags: ["旧"] }),
    overrides_json: json({
      title: "覆盖标题",
      description: "覆盖正文",
      tags: ["#新话题", "新话题"],
      visibility: "friends",
      cover: "/tmp/override.png",
    }),
  });
  assert.equal(plan.caption, "覆盖标题\n\n覆盖正文");
  assert.deepEqual(plan.tags, ["新话题"]);
  assert.equal(plan.visibility, "friends");
  assert.equal(plan.cover, "/tmp/override.png");
});

test("private_then_public 先按 private 发（followup 由 publish 负责）", () => {
  const plan = planPost({ work_title: "标题", visibility: "private_then_public" });
  assert.equal(plan.visibility, "private");
});

test("话题去重、去 #、去空白，并卡上限", () => {
  const many = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `#话题 ${i}`);
  const plan = planPost({ work_title: "标题", tags: many, visibility: "public" });
  assert.equal(plan.tags.length, MAX_TAGS);
  assert.ok(plan.tags.every((tag) => !tag.includes("#") && !tag.includes(" ")));
  assert.equal(planPost({ work_title: "T", tags: ["#同款", "同款"], visibility: "public" }).tags.length, 1);
});

test("单个话题和整条文案都有长度上限", () => {
  const longTag = "长".repeat(80);
  const plan = planPost({
    work_title: "标".repeat(3000),
    tags: [longTag],
    visibility: "public",
  });
  assert.equal([...plan.tags[0]].length, MAX_TAG_CHARS);
  assert.ok([...plan.caption].length <= MAX_CAPTION_CHARS);
  assert.ok(plan.caption.startsWith("标标标"), "截断不能把标题开头吃掉");
});

test("可见性不认识就抛 AdapterError，而不是悄悄发错范围", () => {
  assert.throws(
    () => planPost({ work_title: "标题", visibility: "unlisted" }),
    (err) => err instanceof AdapterError && err.code === "unknown" && /不支持的可见性/.test(err.detail),
  );
});

test("meta_json 坏了也是 AdapterError，不是裸 SyntaxError", () => {
  assert.throws(
    () => planPost({ work_title: "标题", meta_json: "{" }),
    (err) => err instanceof AdapterError && Object.hasOwn(ERROR_CODES, err.code),
  );
});

// ------------------------------------------------------------------ normaliseMetrics

test("normaliseMetrics 只输出白名单键，字段名归一", () => {
  const metrics = normaliseMetrics({
    playCount: "1,234",
    diggCount: 5,
    commentCount: "6",
    shareCount: 0,
    collectCount: "7",
    mystery: 999,
  });
  assert.deepEqual(metrics, { play: 1234, like: 5, comment: 6, share: 0, fav: 7 });
});

test("收藏不存在就不写 fav，也不补 0", () => {
  const metrics = normaliseMetrics({ playCount: 10, diggCount: 2 });
  assert.deepEqual(metrics, { play: 10, like: 2 });
  assert.equal("fav" in metrics, false);
});

test("显式 0 保留，缺失 / 非法值省略", () => {
  assert.deepEqual(normaliseMetrics({ playCount: 0 }), { play: 0 });
  assert.deepEqual(normaliseMetrics({ playCount: "?" }), {});
  assert.deepEqual(normaliseMetrics(null), {});
});

test("能读嵌套 stats，也能处理 1.2K 这类缩写", () => {
  assert.deepEqual(normaliseMetrics({ item: { stats: { playCount: "1.2K", diggCount: "12" } } }), {
    play: 1200,
    like: 12,
  });
});

// ------------------------------------------------------------------ 采集响应解析

test("findMetricsItem 递归按 external_id 找，不拿同响应里的别的作品", () => {
  const body = {
    data: {
      item_list: [
        { id: "111", stats: { playCount: 1 } },
        { id: "222", stats: { playCount: 2, diggCount: 3 } },
      ],
    },
  };
  const item = findMetricsItem(body, "222");
  assert.equal(item.id, "222");
  assert.deepEqual(normaliseMetrics(item), { play: 2, like: 3 });
  assert.equal(findMetricsItem(body, "333"), null);
});

test("只有 id 没有 stats 也先认领，采集记 partial 而不是误报找不到", () => {
  const body = { item_list: [{ id: "222", video: { id: "222" } }] };
  assert.equal(findMetricsItem(body, "222").id, "222");
});

test("newestVideoId 按雪花 id 取最新，不依赖 DOM 里置顶的顺序", () => {
  const hrefs = [
    "https://www.tiktok.com/@me/video/7000000000000000001",
    "https://www.tiktok.com/@me/video/7000000000000000009",
    "https://www.tiktok.com/@me/video/7000000000000000005",
  ];
  assert.equal(newestVideoId(hrefs), "7000000000000000009");
  assert.equal(newestVideoId([]), null);
  assert.equal(newestVideoId(["https://www.tiktok.com/@me"]), null);
});

// ------------------------------------------------------------------ 参数校验 / 零后门

test("publish / collect / check 缺参数都抛登记过的 AdapterError", async () => {
  const calls = [
    ["publish", () => adapter.publish({})],
    ["collect", () => adapter.collect({})],
    ["check", () => adapter.check({})],
  ];
  for (const [name, call] of calls) {
    await assert.rejects(call, (err) => {
      assert.ok(err instanceof AdapterError, `${name} 抛的不是 AdapterError：${err?.name}`);
      assert.ok(Object.hasOwn(ERROR_CODES, err.code), `${name} 的 code 未登记：${err.code}`);
      return true;
    });
  }
});

test("适配器源码不写库：没有状态迁移 / 事件 / 入队 / INSERT", () => {
  const source = readFileSync(HERE, "utf8");
  assert.equal(/\btransitionPublish\s*\(/.test(source), false);
  assert.equal(/\bemit\s*\(/.test(source), false);
  assert.equal(/\benqueue\s*\(/.test(source), false);
  assert.equal(/\bINSERT\s+INTO\b/i.test(source), false);
  assert.equal(/\.prepare\(\s*["'`]INSERT/i.test(source), false);
});
