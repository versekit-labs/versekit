// 抖音创作者中心的页面知识：地址、文案、选择器，以及在页面里执行的小函数。
//
// ported from dreammis/social-auto-upload@3847fff uploader/douyin_uploader/main.py
// （MIT，全文见仓库根的 THIRD_PARTY_NOTICES.md）。只搬上传、填表、封面、话题、存草稿的页面知识：
//   · 上传页 / 发布页地址、上传控件、「重新上传」判上传完成、「上传失败」判失败
//   · 标题 input[placeholder*=填写作品标题]、正文 div.zone-container[contenteditable]
//   · 封面弹窗 div.dy-creator-content-modal、「完成」按钮禁用态、「请设置封面后再发布」兜底
//   · 清掉 shepherd 新手引导浮层、话题下拉浮层
// 不搬：扫码登录、验证码输入、登录态文件持久化、账号名、固定话题、固定等待秒数、
//   自主声明 / 合集 / 商品链接 / 定时发布（这一版只存草稿）。
//
// 这个文件是整个适配器里「唯一知道抖音页面长什么样」的地方：页面改版只改这里，流程在 index.mjs。
// 所有在页面里执行的函数都必须是顶层具名函数、自包含（会被序列化后送进页面，不能引用外面的变量）：
// 离线测试里的模拟页按函数名接管它们（test/sim-page.mjs），所以名字就是接口。

/** 创作者中心根地址。开发机测试时用 VK_DOUYIN_BASE 指向本地模拟页，永远不要在开发机上指向真实站点。 */
export const DEFAULT_BASE = "https://creator.douyin.com";

export function baseUrl(env = process.env) {
  return String(env.VK_DOUYIN_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

/** 地址是不是本机的模拟页（回环地址或 file://）。只有这种地址上才会真的走一遍彩排，真实站点上 dry-run 只出计划。 */
export function isLocalBase(base) {
  try {
    const u = new URL(base);
    return u.protocol === "file:" || ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export const urls = (base = baseUrl()) => ({
  upload: `${base}/creator-micro/content/upload`,
  manage: `${base}/creator-micro/content/manage`,
  home: `${base}/creator-micro/home`,
});

/**
 * 平台文案中英双匹配（adapter-contract 规则 5）。同一个账号可能被平台切语言；
 * 每一项都是「任一命中即可」。
 */
export const T = {
  reupload: ["重新上传", "Re-upload", "Reupload"],
  uploadFailed: ["上传失败", "Upload failed"],
  titleHint: ["填写作品标题", "作品标题", "Add a title", "Title"],
  coverEdit: ["编辑封面", "选择封面", "设置封面", "Edit cover", "Select cover", "Set cover"],
  coverPortrait: ["设置竖封面", "Portrait cover"],
  coverDone: ["完成", "Done"],
  coverNeeded: ["请设置封面后再发布", "Please set a cover"],
  coverConfirm: ["是否确认应用此封面？", "Apply this cover?"],
  confirm: ["确定", "确认", "OK", "Confirm"],
  // 存草稿按钮。SAU 只有「发布」，这一项是抖音发布页底部「发布」旁边的「暂存离开」，
  // 没法在开发机上对真实页面核对（红线），由 ACC-douyin-07 真机验证；文案集中在这里，改版只改这一行。
  saveDraft: ["暂存离开", "存草稿", "保存草稿", "Save draft", "Save as draft"],
  draftsTab: ["草稿箱", "草稿", "Drafts"],
  login: ["手机号登录", "扫码登录", "Log in", "Scan to log in"],
};

/**
 * 风控页面：验证码 / 滑块 / 操作太频繁。命中就立即停下、不重试（ACC-douyin-06）。
 * 登录页自己也有「验证码」字样，所以调用方必须先判登录页再判风控。
 */
export const RISK_PATTERNS = [
  "验证码",
  "滑块",
  "拖动.{0,6}验证",
  "安全验证",
  "请完成验证",
  "身份验证",
  "操作(太|过于)频繁",
  "请求(太|过于)频繁",
  "稍后再试",
  "captcha",
  "verify you are human",
  "too many (requests|attempts)",
];

/** 账号被限制（只读页面上出现的提示）。命中给「被限」，不当成登录过期。 */
export const LIMITED_PATTERNS = ["账号(已被|被)?(封禁|限制|冻结)", "账号存在(违规|异常)", "your account (has been|is) (restricted|suspended)"];

/** 浏览器视口：和 TikTok 一样固定尺寸，窄窗口会让封面弹窗的「完成」掉出视口。 */
export const VIEWPORT = Object.freeze({ width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

// ------------------------------------------------------------------ 页面里执行的函数（自包含、具名）
// 约定：参数里的文案数组由外面传进来；返回值必须可 JSON 序列化；
// 函数之间不许互相调用（序列化后只有函数自己进页面，调用别的函数会 ReferenceError 被 waitFor 吞掉，
// 表现成「一直等不到」）——test/page-contract.test.mjs 用静态检查钉住这一条。

/** 上传页的文件控件表达式（给 tab.upload 用，必须求值成元素）。 */
export const UPLOAD_INPUT_EXPR = `document.querySelector("input.upload-btn-input, div[class^='container'] input[accept]") || document.querySelector("div[class^='container'] input[type='file']")`;

/** 封面弹窗里「上传封面」的文件控件：要取帧选择区那个，不是左边「AI 参考图」那个（SAU 踩过的坑）。 */
export const COVER_INPUT_EXPR = `(() => {
  const modal = document.querySelector("div.dy-creator-content-modal");
  if (!modal) return null;
  const hit = [...modal.querySelectorAll(".semi-upload")].find((u) => u.querySelector(".semi-upload-drag-area-main-text"));
  return (hit && hit.querySelector("input.semi-upload-hidden-input")) || [...modal.querySelectorAll("input.semi-upload-hidden-input")].pop() || null;
})()`;

/** 当前是登录页 / 登录弹层吗。 */
export function loginShown(texts) {
  if (/\/login/.test(location.pathname)) return true;
  return [...document.querySelectorAll("*")].some((e) => e.offsetParent && e.children.length === 0 && texts.includes((e.innerText || "").trim()));
}

/** 页面上有没有风控字样；有就返回命中的那段原文（给人话和截图旁证），没有返回空串。 */
export function riskText(patterns) {
  const text = document.body ? document.body.innerText : "";
  for (const p of patterns) {
    const m = text.match(new RegExp(p, "i"));
    if (m) return m[0];
  }
  return "";
}

export function pageText() {
  return document.body ? document.body.innerText : "";
}

export function uploadInputReady() {
  return Boolean(document.querySelector("input.upload-btn-input, div[class^='container'] input[accept], div[class^='container'] input[type='file']"));
}

export function onPublishPage() {
  return /\/content\/(publish|post\/video)/.test(location.pathname);
}

/** 上传进度：done = 出现「重新上传」；failed = 进度区出现「上传失败」。 */
export function uploadState(doneTexts, failTexts) {
  const card = [...document.querySelectorAll('[class^="long-card"] div')].some((e) => doneTexts.some((t) => (e.innerText || "").includes(t)));
  if (card) return "done";
  const fail = [...document.querySelectorAll("div.progress-div > div")].some((e) => failTexts.some((t) => (e.innerText || "").includes(t)));
  return fail ? "failed" : "";
}

export function findTitleInput(hints) {
  return [...document.querySelectorAll("input")].find((e) => e.offsetParent && hints.some((h) => (e.placeholder || "").includes(h)));
}

export function titleInputReady(hints) {
  return [...document.querySelectorAll("input")].some((e) => e.offsetParent && hints.some((h) => (e.placeholder || "").includes(h)));
}

export function titleValue(hints) {
  const input = [...document.querySelectorAll("input")].find((e) => e.offsetParent && hints.some((h) => (e.placeholder || "").includes(h)));
  return input ? input.value : null;
}

export function findDescEditor() {
  return [...document.querySelectorAll('div.zone-container[contenteditable="true"]')].find((e) => e.offsetParent);
}

export function descText() {
  const el = [...document.querySelectorAll('div.zone-container[contenteditable="true"]')][0];
  return el ? el.innerText : "";
}

/** 清掉会拦截点击的新手引导和话题下拉浮层（SAU 的做法）。 */
export function removeOverlays() {
  const sel = '.shepherd-element, .shepherd-modal-overlay-container, [class*="mention-wrapper"]';
  const list = document.querySelectorAll(sel);
  list.forEach((e) => e.remove());
  return list.length;
}

/** 文案精确匹配的可点元素（按钮 / role=button），取最后一个可见的。 */
export function findButton(texts) {
  return [...document.querySelectorAll('button, [role="button"], div[class*="button"], span[class*="button"]')]
    .filter((e) => e.offsetParent && texts.includes((e.innerText || "").trim()))
    .pop();
}

export function findLeaf(texts) {
  return [...document.querySelectorAll("*")].filter((e) => e.offsetParent && e.children.length === 0 && texts.includes((e.innerText || "").trim())).pop();
}

/** 封面区域：带 img 的 cover- 容器，没有就退到任意 cover 容器。 */
export function findCoverArea() {
  const withImg = [...document.querySelectorAll('[class*="cover-"]')].find((e) => e.querySelector("img") && e.offsetParent);
  return withImg || [...document.querySelectorAll('[class*="cover"]')].find((e) => e.offsetParent);
}

export function coverImageSrc() {
  const area = [...document.querySelectorAll('[class*="cover-"]')].find((e) => e.querySelector("img"));
  return area ? area.querySelector("img").getAttribute("src") || "" : "";
}

export function coverModalOpen() {
  return Boolean(document.querySelector("div.dy-creator-content-modal"));
}

export function coverModalGone() {
  return !document.querySelector("div.dy-creator-content-modal");
}

/** 封面弹窗里的「完成」：处理中是 semi-button-disabled，点了无效，要等它解禁。 */
export function coverDoneState(texts) {
  const modal = document.querySelector("div.dy-creator-content-modal");
  if (!modal) return "gone";
  const btn = [...modal.querySelectorAll("button")].find((b) => texts.includes((b.innerText || "").trim()));
  if (!btn) return "missing";
  return (btn.className || "").includes("semi-button-disabled") ? "disabled" : "ready";
}

export function findCoverDone(texts) {
  const modal = document.querySelector("div.dy-creator-content-modal");
  if (!modal) return undefined;
  return [...modal.querySelectorAll("button")].find((b) => texts.includes((b.innerText || "").trim()));
}

export function findModalButton(texts) {
  return [...document.querySelectorAll('.semi-modal-content button, [role="dialog"] button')].filter((b) => b.offsetParent && texts.includes((b.innerText || "").trim())).pop();
}

export function textVisible(texts) {
  return [...document.querySelectorAll("*")].some((e) => e.offsetParent && e.children.length === 0 && texts.some((t) => (e.innerText || "").includes(t)));
}

export function findRecommendCover() {
  return document.querySelector('[class^="recommendCover-"]');
}

/** 草稿箱页面里某个标题出现了几次（回读用：保存前后各数一次，必须多出一条）。 */
export function countOnPage(needle) {
  const text = (document.body ? document.body.innerText : "").replace(/\s+/g, " ");
  const want = String(needle).replace(/\s+/g, " ").trim();
  if (!want) return 0;
  let n = 0;
  for (let at = text.indexOf(want); at !== -1; at = text.indexOf(want, at + want.length)) n += 1;
  return n;
}

/** 草稿箱里第一条草稿的链接（拿得到就给人点；拿不到返回空串）。 */
export function firstDraftHref(needle) {
  const want = String(needle).replace(/\s+/g, " ").trim();
  const item = [...document.querySelectorAll("a[href]")].find((a) => (a.innerText || "").replace(/\s+/g, " ").includes(want));
  return item ? item.href : "";
}

export function titleEmpty(hints) {
  const input = [...document.querySelectorAll("input")].find((e) => e.offsetParent && hints.some((h) => (e.placeholder || "").includes(h)));
  return Boolean(input) && input.value === "";
}

export function descEmpty() {
  const el = [...document.querySelectorAll('div.zone-container[contenteditable="true"]')][0];
  return Boolean(el) && (el.innerText || "").trim() === "";
}

export function coverDoneReady(texts) {
  const modal = document.querySelector("div.dy-creator-content-modal");
  if (!modal) return false;
  const btn = [...modal.querySelectorAll("button")].find((b) => texts.includes((b.innerText || "").trim()));
  return Boolean(btn) && !(btn.className || "").includes("semi-button-disabled");
}

/** 草稿箱里 needle 出现的次数是否已经超过 min。 */
export function countExceeds(needle, min) {
  const text = (document.body ? document.body.innerText : "").replace(/\s+/g, " ");
  const want = String(needle).replace(/\s+/g, " ").trim();
  if (!want) return false;
  let n = 0;
  for (let at = text.indexOf(want); at !== -1; at = text.indexOf(want, at + want.length)) n += 1;
  return n > min;
}

/**
 * 点「存草稿」之后页面在哪：manage = 已跳到作品管理页；cover = 提示要先设封面；
 * 空串 = 还没有结果（有的版本只弹提示、不跳转，由调用方去草稿箱回读）。
 */
export function saveOutcome(coverNeeded) {
  if (/\/content\/manage/.test(location.pathname)) return "manage";
  const needCover = [...document.querySelectorAll("*")].some((e) => e.offsetParent && e.children.length === 0 && coverNeeded.some((t) => (e.innerText || "").includes(t)));
  return needCover ? "cover" : "";
}

/** 体检页的状态：login / limited / risk / ready；页面还没渲染出来返回空串（继续等）。 */
export function homeState(loginTexts, limitedPatterns, riskPatterns) {
  const text = document.body ? document.body.innerText : "";
  const loginVisible =
    /\/login/.test(location.pathname) ||
    [...document.querySelectorAll("*")].some((e) => e.offsetParent && e.children.length === 0 && loginTexts.includes((e.innerText || "").trim()));
  if (loginVisible) return "login";
  for (const p of limitedPatterns) if (new RegExp(p, "i").test(text)) return "limited";
  for (const p of riskPatterns) if (new RegExp(p, "i").test(text)) return "risk";
  return /\/creator-micro\//.test(location.pathname) && text.trim().length > 20 ? "ready" : "";
}

export function descEditorReady() {
  return [...document.querySelectorAll('div.zone-container[contenteditable="true"]')].some((e) => e.offsetParent);
}
