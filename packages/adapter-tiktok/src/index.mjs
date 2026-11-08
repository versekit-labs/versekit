// TikTok 适配器：TikTok Studio Web 上传 + 内容管理页接口拦截采集。
//
// ported from trustbridge/videos/factory/publishers/tiktok.mjs（生产验证过的 151 行）。
// 按 ADR-0001 只搬流程与踩坑知识，契约与数据来源重写：
//   · 账号（@assurelane6）、目录约定、filesOf、中文 notes 字符串全部剥掉；
//     账号、成片、封面、文案、可见性都来自 publish/account/work 行。
//   · 工厂把「还要去改公开」写成一句 notes；这里返回 followup，由 core 落库并负责核实。
//   · 适配器不写库：只 open() + SELECT 读行，返回结果或抛 AdapterError，状态迁移与事件归 core。
//
// 这个平台最脆的三处（也是移植时保留超时/回读的原因）：
//   1. Draft.js 描述框会预填文件名，macOS 上合成 Cmd+A 无效，必须用 commands:['selectAll']；
//   2. 话题建议列表会吃掉紧随其后的空格，所以每个 #tag 后要等 700ms 再打空格；
//   3. 封面的「保存」在窄窗口会掉出视口，所以先把设备指标固定成 1600x1000。

import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { open } from "../../core/src/index.mjs";
import { AdapterError, toAdapterError } from "../../core/src/errors.mjs";
import { openAccount, browserReady, evidencePath, sleep } from "../../driver-browser/src/index.mjs";

const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?lang=en";
const CONTENT_URL = "https://www.tiktok.com/tiktokstudio/content";
const LOGIN_DETAIL = "TikTok 登录过期：在浏览器里登录后重试";

/** TikTok 文案上限；话题另算，截断文案时给话题留位置，避免发出后才被平台截掉。 */
export const MAX_CAPTION_CHARS = 2200;
export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 50;

/** 平台文案中英双匹配：同一个账号可能被平台切语言（adapter-contract 规则 5）。 */
const T = {
  more: ["显示更多", "Show more"],
  cover: ["编辑封面", "Edit cover"],
  save: ["保存", "Save"],
  everyone: ["所有人", "Everyone"],
  onlyMe: ["仅自己", "Only me", "Only you"],
  friends: ["好友", "Friends"],
  ai: ["AI 生成的内容", "AI-generated content"],
  post: ["发布", "Post"],
  postNow: ["立即发布", "Post now", "仍然发布", "Continue to post"],
  turnOn: ["开启", "Turn on", "确认", "Confirm"],
};

/** publish.visibility → 页面上的「谁可以看」选项。private_then_public 先按 private 发。 */
const VISIBILITY_TEXT = {
  public: T.everyone,
  private: T.onlyMe,
  friends: T.friends,
};
const ALL_VISIBILITY = Object.values(VISIBILITY_TEXT).flat();

// ------------------------------------------------------------------ 纯逻辑（可单测）

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonField(value, name) {
  if (value == null || value === "") return {};
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") throw new AdapterError("unknown", `${name} 必须是对象或 JSON 字符串`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AdapterError("unknown", `${name} 不是合法 JSON`);
  }
  if (!isPlainObject(parsed)) throw new AdapterError("unknown", `${name} 必须是 JSON 对象`);
  return parsed;
}

const asText = (value) => (value == null ? "" : String(value).trim());

function firstText(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return "";
}

function normaliseTags(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,，\s]+/)
      : [];
  const tags = [];
  for (const item of list) {
    // 用户可能写「#AI 工具」或「#AI#工具」：平台把 # 当分隔符，这里统一剥掉空白与 #。
    const tag = [...String(item ?? "").replace(/^#+/, "").replace(/[\s#]+/g, "")].slice(0, MAX_TAG_CHARS).join("");
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

const ALLOWED_VISIBILITY = ["public", "private", "friends", "private_then_public"];

/**
 * 把 DB 行摊成发布计划。overrides 是这一条发布的临时修改，优先级高于 work 的 meta；
 * meta.tiktok 留给平台专属字段（封面、note），不污染通用字段。
 *
 * 只返回 {caption, tags, visibility, cover}：可见性返回「实际要设的值」，
 * private_then_public 已映射成 private，调用方另外用 requestedVisibility 决定 followup。
 */
export function planPost(row) {
  const inputs = planInputs(row);
  return {
    caption: buildCaption(inputs.title, inputs.description, inputs.tags),
    tags: inputs.tags,
    visibility: inputs.visibility === "private_then_public" ? "private" : inputs.visibility,
    cover: inputs.cover,
  };
}

function planInputs(row) {
  const meta = parseJsonField(row?.meta_json ?? row?.meta, "meta_json");
  const overrides = parseJsonField(row?.overrides_json ?? row?.overrides, "overrides_json");
  const tiktok = isPlainObject(meta.tiktok) ? meta.tiktok : {};

  const title = firstText(overrides.title, tiktok.title, meta.title, row?.work_title, row?.title);

  // 移植源把 caption 与 note 分两段；这里把 overrides.desc 视为「这一段正文」，
  // 仍由 buildCaption 把标题放最前，保证发布后能用「标题前 40 字」回读核实。
  let description = firstText(
    overrides.desc,
    overrides.description,
    overrides.caption,
    tiktok.desc,
    tiktok.description,
    tiktok.caption,
    meta.desc,
    meta.description,
    meta.caption,
    row?.desc,
    row?.description,
  );
  const note = firstText(tiktok.note, meta.note);
  if (note && !firstText(overrides.desc, overrides.description, overrides.caption)) {
    description = [description, note].filter(Boolean).join("\n\n");
  }

  const requested = firstText(overrides.visibility, row?.visibility, tiktok.visibility, "public");
  if (!ALLOWED_VISIBILITY.includes(requested)) {
    throw new AdapterError("unknown", `不支持的可见性：${requested}`);
  }

  const rawCover = overrides.cover ?? tiktok.cover ?? null;
  const cover = asText(rawCover) || null;

  const rawTags =
    overrides.tags ?? overrides.hashtags ?? tiktok.tags ?? tiktok.hashtags ?? meta.tags ?? meta.hashtags ?? row?.tags ?? row?.hashtags ?? [];

  return { title, description, tags: normaliseTags(rawTags), visibility: requested, cover };
}

function buildCaption(title, description, tags) {
  const body = [title, description].filter(Boolean).join("\n\n");
  const tagText = tags.map((tag) => `#${tag}`).join(" ");
  const budget = Math.max(0, MAX_CAPTION_CHARS - (tagText ? tagText.length + 1 : 0));
  return [...body].slice(0, budget).join("").replace(/\s+$/, "");
}

/** raw 里的可见性策略；planPost 只给实际值，followup 需要知道原始策略。 */
function requestedVisibility(row) {
  return planInputs(row).visibility;
}

const METRIC_KEYS = [
  ["play", ["playCount", "play_count", "play"]],
  ["like", ["diggCount", "digg_count", "likeCount", "like_count", "like"]],
  ["comment", ["commentCount", "comment_count", "comment"]],
  ["share", ["shareCount", "share_count", "share"]],
  // 收藏不是每条 TikTok 都返回；缺字段就省略，绝不补 0（0 会被当成真实指标画进图里）。
  ["fav", ["collectCount", "collect_count", "favoriteCount", "favorite_count", "favCount", "fav"]],
];

function toCount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,/g, "");
  if (!text) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const scaled = text.match(/^(-?\d+(?:\.\d+)?)\s*([kKmMbB万])$/);
  if (!scaled) return null;
  const unit = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4 }[scaled[2].toLowerCase()];
  return unit ? Math.round(Number(scaled[1]) * unit) : null;
}

function statsSources(raw) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const key of ["statsV2", "stats", "itemStats", "statistics"]) {
      const stats = node[key];
      if (isPlainObject(stats) && !seen.has(stats)) {
        seen.add(stats);
        out.push(stats);
      }
    }
    for (const key of ["item", "itemInfo", "video", "aweme"]) walk(node[key], depth + 1);
  };
  walk(raw, 0);
  if (isPlainObject(raw) && !seen.has(raw)) out.push(raw);
  return out;
}

/**
 * TikTok 接口字段 → versekit 的统一指标。只认白名单，未知键直接丢；缺失 ≠ 0。
 * 同时接受页面原始 stats、包着 stats 的 item，以及已经归一化过的对象，方便复用。
 */
export function normaliseMetrics(raw) {
  if (!raw || typeof raw !== "object") return {};
  const sources = statsSources(raw);
  const metrics = {};
  for (const [output, aliases] of METRIC_KEYS) {
    let found = null;
    for (const source of sources) {
      for (const alias of aliases) {
        if (source[alias] == null || source[alias] === "") continue;
        const n = toCount(source[alias]);
        if (n != null) {
          found = n;
          break;
        }
      }
      if (found != null) break;
    }
    if (found != null) metrics[output] = found;
  }
  return metrics;
}

const hasStats = (value) =>
  isPlainObject(value) &&
  ["statsV2", "stats", "itemStats", "statistics"].some((key) => isPlainObject(value[key]));

function matchesExternalId(value, externalId) {
  const candidates = [
    value.id,
    value.itemId,
    value.awemeId,
    value.aweme_id,
    value.videoId,
    value.video_id,
    value.video?.id,
    value.item?.id,
  ];
  return candidates.some((id) => id != null && String(id) === externalId);
}

/**
 * 接口响应里递归找这条作品。同一个响应可能套 item_list → item → video 好几层；
 * 优先返回自带 stats 的对象，实在只有 id 也返回（让采集记 partial 而不是误报“找不到”）。
 */
export function findMetricsItem(node, externalId) {
  const want = String(externalId);
  let fallback = null;
  const walk = (value) => {
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }
    if (matchesExternalId(value, want)) {
      if (hasStats(value)) return value;
      fallback ??= value;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const hit = walk(child);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(node) ?? fallback;
}

/** 主页链接可能包含置顶旧作；按雪花 id 取最大才是真正的最新一条。 */
export function newestVideoId(hrefs) {
  const ids = (Array.isArray(hrefs) ? hrefs : [])
    .map((href) => String(href ?? "").match(/\/video\/(\d+)/)?.[1])
    .filter(Boolean);
  if (!ids.length) return null;
  return ids.reduce((best, id) => (BigInt(id) > BigInt(best) ? id : best));
}

// ------------------------------------------------------------------ 页面交互小工具

const findLeaf = (texts) =>
  [...document.querySelectorAll("*")].filter((e) => e.offsetParent && e.children.length === 0 && texts.includes(e.innerText?.trim())).pop();

const findButton = (texts) => [...document.querySelectorAll("button")].filter((e) => e.offsetParent && texts.includes(e.innerText.trim())).pop();

const findCombobox = (texts) => [...document.querySelectorAll("button[role=combobox]")].find((e) => e.offsetParent && texts.includes(e.innerText.trim()));

const findOption = (texts) =>
  [...document.querySelectorAll("[role=option], li, span, div")].filter((e) => e.offsetParent && texts.includes(e.innerText?.trim())).pop();

const findDialogButton = (texts) => [...document.querySelectorAll("[role=dialog] button")].filter((e) => e.offsetParent && texts.includes(e.innerText.trim())).pop();

const findAiChecked = (texts) => {
  const input = [...document.querySelectorAll("input[role=switch]")].find((el) => {
    let node = el;
    for (let k = 0; k < 6 && node; k++, node = node.parentElement) {
      if (texts.some((text) => node.innerText?.trim().startsWith(text))) return true;
    }
    return false;
  });
  return input ? Boolean(input.checked) : null;
};

const findAiSwitchParent = (texts) => {
  const input = [...document.querySelectorAll("input[role=switch]")].find((el) => {
    let node = el;
    for (let k = 0; k < 6 && node; k++, node = node.parentElement) {
      if (texts.some((text) => node.innerText?.trim().startsWith(text))) return true;
    }
    return false;
  });
  return input?.parentElement ?? null;
};

const currentVisibility = (texts) =>
  [...document.querySelectorAll("button[role=combobox]")].map((e) => e.innerText.trim()).find((text) => texts.includes(text));

const uploadFormState = () =>
  /\/login/.test(location.pathname) ? "login" : document.querySelector("input[type=file][accept*=video]") ? "form" : "";

const uploadFinished = () => /已上传|Uploaded/.test(document.body.innerText) && Boolean(document.querySelector(".public-DraftEditor-content"));

const editorText = () => document.querySelector(".public-DraftEditor-content")?.innerText ?? "";

const coverSaveGone = (texts) => ![...document.querySelectorAll("button")].some((e) => e.offsetParent && texts.includes(e.innerText.trim()));

const onContentPage = () => /tiktokstudio\/content/.test(location.pathname);

const profileVideos = () => {
  const links = [...document.querySelectorAll('a[href*="/video/"]')].map((a) => a.href);
  return links.length ? links : "";
};

const pageText = () => document.body.innerText;

async function pointOrNull(tab, find, arg) {
  try {
    return await tab.point(find, arg);
  } catch {
    // 可选元素（展开更多/二次确认/仍要发布）探测失败不该盖住真正的错误；真正点不到的地方由 clickOn 抛。
    return null;
  }
}

async function clickOn(tab, find, arg, what) {
  const point = await pointOrNull(tab, find, arg);
  if (!point) throw new AdapterError("flaky_ui", `TikTok Studio 上找不到「${what}」，页面可能改版了`);
  await tab.click(point);
  await sleep(900);
}

/** 把驱动抛的普通 Error 翻成 flaky_ui，避免「页面没按预期走」被误记成未知错误。 */
async function uiStep(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    throw new AdapterError("flaky_ui", `${what}失败：${err?.message ?? err}`, { cause: err });
  }
}

function pathnameOf(href) {
  try {
    return new URL(href).pathname;
  } catch {
    return String(href ?? "");
  }
}

function requireFile(value, what) {
  const text = asText(value);
  if (!text) throw new AdapterError("asset_invalid", `没有配置${what}路径`);
  const path = isAbsolute(text) ? text : resolve(text);
  if (!existsSync(path)) throw new AdapterError("asset_invalid", `${what}不存在：${path}`);
  return path;
}

function normaliseHandle(value) {
  const handle = asText(value)
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/^@+/, "")
    .replace(/[/?#].*$/, "");
  if (!handle) throw new AdapterError("unknown", "账号没有 TikTok handle，无法在主页核实作品");
  return handle;
}

// ------------------------------------------------------------------ 读库（只读）

function load(publishId) {
  const db = open();
  const row = db
    .prepare(
      `SELECT p.*, a.platform, a.handle, a.id AS account_id,
              w.title AS work_title, w.asset_path, w.meta_json
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
        WHERE p.id = ?`,
    )
    .get(publishId);
  if (!row) throw new AdapterError("unknown", `找不到发布：${publishId}`);
  if (row.platform !== "tiktok") throw new AdapterError("unknown", `账号 ${row.account_id} 不是 TikTok`);
  return row;
}

const requirePublishId = (publishId) => {
  if (typeof publishId !== "string" || !publishId.trim()) throw new AdapterError("unknown", "publishId 必须是非空字符串");
  return publishId;
};

// ------------------------------------------------------------------ 取证

async function capture(tab, accountId, tag) {
  if (!tab || !accountId) return null;
  try {
    const path = evidencePath(accountId, tag);
    writeFileSync(path, await tab.screenshot());
    return { screenshot: path };
  } catch {
    // 截图是尽力而为：连页面都没了也必须把原始错误抛出去，而不是用截图失败覆盖它。
    return null;
  }
}

async function withEvidence(tab, accountId, tag, err) {
  const wrapped = toAdapterError(err);
  const shot = await capture(tab, accountId, tag);
  if (shot) wrapped.evidence = { ...(wrapped.evidence ?? {}), ...shot };
  return wrapped;
}

// ------------------------------------------------------------------ 发布

async function publish({ publishId, dryRun = false } = {}) {
  requirePublishId(publishId);
  let tab = null;
  let accountId = null;

  try {
    const row = load(publishId);
    accountId = row.account_id;
    const plan = planPost(row);
    const policy = requestedVisibility(row);
    const asset = requireFile(row.asset_path, "成片");
    const cover = plan.cover ? requireFile(plan.cover, "封面") : null;
    const handle = normaliseHandle(row.handle);
    const steps = [];

    // dry-run 是契约测试与「先看一眼」的入口：它必须零对外动作，所以放在开浏览器之前。
    // 一旦这里开始 goto/upload，dry-run 就变成了「假装试跑其实真跑」。
    if (dryRun) {
      return {
        dryRun: true,
        target: {
          visibility: plan.visibility,
          captionPreview: [...plan.caption].slice(0, 160).join(""),
          tags: plan.tags,
        },
        asset,
        cover,
        steps: ["打开 TikTok Studio 上传页", "设置 1600x1000 视口", "上传视频", "填写描述与话题", "设置封面", "设置可见性", "打开 AI 生成内容声明"],
      };
    }

    tab = await openAccount({ accountId });
    await uiStep("打开 TikTok Studio 上传页", () => tab.goto(UPLOAD_URL));
    steps.push("打开 TikTok Studio 上传页");

    // 封面的「保存」在窄窗口会掉出视口，必须在所有点击之前固定视口尺寸。
    await uiStep(
      "设置 1600x1000 视口",
      () => tab.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }),
    );
    steps.push("设置 1600x1000 视口");

    let where;
    try {
      where = await tab.waitFor(uploadFormState, [], { timeout: 60e3, what: "TikTok Studio 上传页" });
    } catch (err) {
      // 等不到上传控件通常就是登录态没了；这里按 auth 处理，让人去浏览器里重新登录。
      throw new AdapterError("auth", LOGIN_DETAIL, { cause: err });
    }
    if (where === "login") throw new AdapterError("auth", LOGIN_DETAIL);

    await uiStep("上传视频", () => tab.upload("document.querySelector('input[type=file][accept*=video]')", [asset]));
    try {
      await tab.waitFor(uploadFinished, [], { timeout: 20 * 60e3, every: 2000, what: "视频上传完成" });
    } catch (err) {
      const body = await tab.eval(pageText).catch(() => "");
      if (/不支持|无法上传|unsupported|failed to upload/i.test(body)) {
        throw new AdapterError("asset_invalid", `TikTok 拒收这个视频：${asset}`, { cause: err });
      }
      throw new AdapterError("flaky_ui", "20 分钟内没有等到 TikTok 视频上传完成", { cause: err });
    }
    await sleep(2000);
    steps.push("上传视频");

    await clickOn(tab, () => document.querySelector(".public-DraftEditor-content"), undefined, "视频描述");
    await uiStep("清空描述框", () =>
      tab.clear(() => document.querySelector(".public-DraftEditor-content")?.innerText.trim()),
    );

    const lines = plan.caption.split("\n");
    for (const [i, line] of lines.entries()) {
      if (i) await tab.key("Enter", "Enter", 13);
      if (line) await tab.type(line);
    }
    if (plan.tags.length) {
      await tab.key("Enter", "Enter", 13);
      await tab.key("Enter", "Enter", 13);
    }
    for (const tag of plan.tags) {
      await tab.type(`#${tag}`);
      // 建议列表会吃掉紧跟着的空格，等它稳定再补空格，否则话题会被粘成一条。
      await sleep(700);
      await tab.type(" ");
      await sleep(300);
    }
    await tab.key("Escape", "Escape", 27);

    const typed = await tab.eval(editorText);
    const compact = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
    // caption 由 title 开头拼成，所以「前 40 字」一定是标题前缀（标题更短时连带正文，断言更严）。
    const head = [...plan.caption].slice(0, 40).join("");
    if (!compact(typed).includes(compact(head)) || plan.tags.some((tag) => !typed.includes(`#${tag}`))) {
      throw new AdapterError("flaky_ui", `视频描述没有填对，现在是：${String(typed).slice(0, 300)}`);
    }
    steps.push("填写标题/描述/话题");

    if (cover) {
      await clickOn(tab, findLeaf, T.cover, "编辑封面");
      await uiStep("等待封面上传控件", () =>
        tab.waitFor(() => Boolean(document.querySelector("input[type=file][accept*=image]")), [], { timeout: 20e3, what: "封面上传控件" }),
      );
      await uiStep("上传封面", () => tab.upload("document.querySelector('input[type=file][accept*=image]')", [cover]));
      // 封面处理是平台异步转码，4 秒是过渡等待（driver-api §4 允许的动画级 sleep）。
      await sleep(4000);
      await clickOn(tab, findButton, T.save, "封面保存");
      await uiStep("等待封面编辑框关闭", () =>
        tab.waitFor(coverSaveGone, [T.save], { timeout: 30e3, what: "封面编辑框关闭" }),
      );
      steps.push("设置封面");
    }

    const want = VISIBILITY_TEXT[plan.visibility];
    let shown = await tab.eval(currentVisibility, [ALL_VISIBILITY]);
    if (!want.includes(shown)) {
      await clickOn(tab, findCombobox, ALL_VISIBILITY, "谁可以看");
      await clickOn(tab, findOption, want, want[0]);
      shown = await tab.eval(currentVisibility, [ALL_VISIBILITY]);
      if (!want.includes(shown)) {
        throw new AdapterError("flaky_ui", `「谁可以看」没有设成${want[0]}（现在是 ${shown ?? "未知"}）`);
      }
    }
    steps.push("设置可见性");

    // 「显示更多」展开后 AI 开关仍在 DOM 里（只是隐藏），所以先尝试展开，再按 role=switch 找。
    const more = await pointOrNull(tab, findLeaf, T.more);
    if (more) {
      await tab.click(more);
      await sleep(900);
    }
    const checked = await tab.eval(findAiChecked, [T.ai]);
    if (checked == null) throw new AdapterError("flaky_ui", "找不到「AI 生成的内容」开关，页面可能改版了");
    if (!checked) {
      await clickOn(tab, findAiSwitchParent, T.ai, "AI 生成的内容开关");
      const confirm = await pointOrNull(tab, findDialogButton, T.turnOn);
      if (confirm) {
        await tab.click(confirm);
        await sleep(800);
      }
      if (!(await tab.eval(findAiChecked, [T.ai]))) {
        throw new AdapterError("flaky_ui", "「AI 生成的内容」没有打开");
      }
    }
    steps.push("打开 AI 生成内容声明");

    await clickOn(tab, findButton, T.post, "发布");

    // 发布后平台先做内容检查；有时会弹「仍然发布 / Post now」。以跳进作品管理页为准，而不是点了按钮。
    const end = Date.now() + 180e3;
    for (;;) {
      if (await tab.eval(onContentPage).catch(() => false)) break;
      const again = await pointOrNull(tab, findButton, T.postNow);
      if (again) {
        await tab.click(again);
        await sleep(900);
      }
      if (Date.now() > end) {
        const body = await tab.eval(pageText).catch(() => "");
        if (/达到上限|发布太频繁|too many|try again later|rate limit/i.test(body)) {
          throw new AdapterError("quota", "TikTok 提示发布频率受限，稍后再试");
        }
        if (/不符合|违反|violat|not eligible|can't post|cannot post/i.test(body)) {
          throw new AdapterError("platform_reject", "TikTok 没有通过这条内容");
        }
        throw new AdapterError("flaky_ui", "点了发布，三分钟内没有跳到作品管理页");
      }
      await sleep(2000);
    }

    // 不信返回页：回主页拿最新视频链接，id 必须来自平台，拿不到就报错，绝不用标题冒充。
    await uiStep("打开 TikTok 主页核实作品", () => tab.goto(`https://www.tiktok.com/@${handle}`));
    let hrefs = [];
    try {
      hrefs = await tab.waitFor(profileVideos, [], { timeout: 90e3, every: 1000, what: "主页上的新视频" });
    } catch {
      hrefs = [];
    }
    const id = newestVideoId(hrefs);
    if (!id) {
      throw new AdapterError("unknown", `发布后没有在 @${handle} 主页找到 /video/ 链接，无法确认作品 id`);
    }

    const followups =
      policy === "private_then_public"
        ? [{ kind: "set_visibility_public", hint: "确认无误后放行公开", verify: "visibility" }]
        : [];

    return {
      id,
      url: `https://www.tiktok.com/@${handle}/video/${id}`,
      visibility: plan.visibility,
      state: policy === "private_then_public" ? "published_limited" : "published",
      ...(followups.length ? { followups } : {}),
    };
  } catch (err) {
    throw await withEvidence(tab, accountId, "tiktok-publish", err);
  } finally {
    await tab?.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ 采集

async function collect({ publishId } = {}) {
  requirePublishId(publishId);
  let tab = null;
  let accountId = null;

  try {
    const row = load(publishId);
    accountId = row.account_id;
    const externalId = asText(row.external_id);
    if (!externalId) throw new AdapterError("unknown", "这条发布还没有 TikTok 作品 id，无法采集");

    tab = await openAccount({ accountId });
    let kicked = false;
    const found = await tab.collectJson(
      /item_list|posts|video\/list/,
      async () => {
        await uiStep("打开 TikTok 作品管理页", () => tab.goto(CONTENT_URL));
        kicked = /\/login/.test(pathnameOf(await tab.url()));
      },
      {
        timeout: 60e3,
        until: (list) => kicked || list.some(({ body }) => findMetricsItem(body, externalId)),
      },
    );

    if (kicked || /\/login/.test(pathnameOf(await tab.url().catch(() => "")))) {
      throw new AdapterError("auth", LOGIN_DETAIL);
    }
    if (!found.length) {
      // 一个响应都没拦到：接口改名/改版比“作品被删”常见，先说改版，别让人白找。
      throw new AdapterError("flaky_ui", "内容管理页没有等到作品列表接口，接口可能改版了");
    }

    const item = found.map(({ body }) => findMetricsItem(body, externalId)).find(Boolean);
    if (!item) {
      throw new AdapterError("unknown", `TikTok 作品管理页里找不到作品 ${externalId}`);
    }

    const metrics = normaliseMetrics(item);
    return {
      source: "intercept",
      status: metrics.play == null ? "partial" : "ok",
      metrics,
      capturedAt: Date.now(),
    };
  } catch (err) {
    throw await withEvidence(tab, accountId, "tiktok-collect", err);
  } finally {
    await tab?.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ 登录态探测

async function check(ctx = {}) {
  const accountId = ctx?.accountId;
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new AdapterError("unknown", "check 需要 accountId");
  }
  let tab = null;
  try {
    tab = await openAccount({ accountId });
    await uiStep("打开 TikTok Studio", () => tab.goto(CONTENT_URL));
    if (/\/login/.test(pathnameOf(await tab.url()))) {
      return { state: "expired", detail: LOGIN_DETAIL };
    }
    return { state: "ok" };
  } catch (err) {
    throw await withEvidence(tab, accountId, "tiktok-check", err);
  } finally {
    await tab?.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ 契约

export default {
  platform: "tiktok",
  capabilities: {
    publish: "web",
    collect: "web",
    draft: false, // TikTok Studio 有草稿，但适配器目前不把草稿箱当发布终点
    visibility: ["public", "private", "friends"],
    requiresQualification: false, // 走网页自动化，不需要开发者资质
  },
  ready() {
    const reason = browserReady();
    return reason ? `TikTok 未配置：${reason}` : null;
  },
  check,
  publish,
  collect,
};
