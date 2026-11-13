// 小红书「图文笔记」路径：在同一个发布页切到「上传图文」后完成一次图文发布。
//
// 与视频路径（index.mjs 里的 publish()）共享同一套编辑器动作（标题、正文、话题面板），
// 由 index.mjs 以 ctx 注入——这样「话题必须从面板选」「tiptap 焦点」这些踩坑知识只有一份，
// 视频与图文不会各演化出一套。
//
// 这个文件里的 platform 事实（来自 2026-11 实测创作服务平台）：
//   · 页签是 .creator-tab，「上传图文」切过去后 URL 会多一个 &from=tab_switch；
//   · 图文上传控件 input.upload-input 的 accept 是 .jpg,.jpeg,.png,.webp，且 multiple；
//   · 图片按「选择顺序」进编辑器（实测 img-idx 1..N 与 setFileInputFiles 的数组顺序一致），
//     所以排序与数量在 core 的 asset-kind.mjs 里已经统一算好，这里不再自作主张重排；
//   · 上传后编辑器里会出现「N/18」，正文限制 1000 字（页面上直接标着）；
//   · 「谁可以看」是 .d-select，选项为 .name：公开可见 / 仅自己可见 / 仅互关好友可见；
//   · 发布按钮仍是 <xhs-publish-btn> 的 closed shadow root，走 CDP 穿透点击（同视频路径）；
//   · 图片编辑引导（.feature-guide__btn「我知道了」）会盖住底部按钮，发布前要关掉。

import { extname, basename, resolve } from "node:path";
import { AdapterError } from "../../core/src/errors.mjs";
import { sleep } from "../../driver-browser/src/index.mjs";

export const MAX_IMAGE_NOTE_IMAGES = 18;

// 小红书图文只收这四种；gif/heic 等在 core 里算「图片」，但平台不收，所以在适配器里再挡一次。
export const IMAGE_NOTE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// 发布页「谁可以看」的界面文案。值域只认核心的 publish.visibility；private_then_public 先发
// 「仅自己可见」，再由 followup 提醒人改公开——不假装已经公开。
export const IMAGE_NOTE_VISIBILITY_TEXT = {
  public: "公开可见",
  private: "仅自己可见",
  friends: "仅互关好友可见",
};

/**
 * 图文素材的纯逻辑校验：在打开浏览器之前就失败（ACC-publish-04 的同一原则）。
 *
 * `files` 来自 core 的 assetFilesOf（已按文件名自然排序），所以这里只做平台口径：
 * 1–18 张、格式 jpg/png/webp、可见性可表达。
 */
export function planImageNote({ asset = null, files = [], visibility = "public" } = {}) {
  if (!Array.isArray(files) || !files.length) {
    throw new AdapterError("asset_invalid", `图文笔记至少要 1 张图片：${asset ?? "素材"} 里没有可上传的图片`);
  }
  if (files.length > MAX_IMAGE_NOTE_IMAGES) {
    throw new AdapterError(
      "asset_invalid",
      `小红书图文最多 ${MAX_IMAGE_NOTE_IMAGES} 张图片（现在是 ${files.length} 张）：删掉多余的图片再发`,
    );
  }
  const bad = files.find((file) => !IMAGE_NOTE_EXTENSIONS.has(extname(String(file)).toLowerCase()));
  if (bad) {
    throw new AdapterError(
      "asset_invalid",
      `小红书图文只收 jpg / png / webp：${basename(String(bad))} 不是支持的图片格式，换一张图或用视频路径发`,
    );
  }

  const wantsPublicFollowup = visibility === "private_then_public";
  const uiVisibility = wantsPublicFollowup ? "private" : visibility;
  const visibilityText = IMAGE_NOTE_VISIBILITY_TEXT[uiVisibility];
  if (!visibilityText) {
    throw new AdapterError(
      "asset_invalid",
      `小红书不认识的可见性「${visibility}」：用 public / private / friends / private_then_public`,
    );
  }

  return {
    // 上传控件只收绝对路径；排序与格式校验都在原始列表上做过，这里只补全路径。
    files: files.map((file) => resolve(String(file))),
    count: files.length,
    visibility: uiVisibility,
    visibilityText,
    wantsPublicFollowup,
  };
}

const IMAGE_INPUT = `document.querySelector('input.upload-input[accept*=".png"], input[type=file][accept*=".png"]')`;
const IMAGE_INPUT_READY = `!!(${IMAGE_INPUT})`;
const VISIBILITY_SELECT = `(R) => [...R.querySelectorAll('.d-select')].find((e) => e.offsetParent && /^(公开可见|仅自己可见|仅互关好友可见)$/.test(e.innerText.trim()))`;
const GUIDE_CLOSE = `(R) => R.querySelector('.feature-guide__btn') || R.querySelector('.feature-guide__close')`;

// 点击「发布」后的三种结局，必须在同一次轮询里区分：成功 / 平台拒绝 / 什么都没发生。
// 平台拒绝的文案（2026-11 实测）是「因违反社区规范禁止发笔记」——不识别它就只能等超时，
// 人看到的是「卡住了」，而不是平台自己给的原因（ACC-publish-06 的失败留现场）。
const PUBLISH_REJECT = /因违反社区规范|禁止发笔记|内容违规|违反社区规范|审核不通过|发布失败/;
const PUBLISH_SUCCESS = /发布成功|提交成功|已提交审核|笔记已提交|审核中/;
const REJECT_SENTENCE = /[^\n]{0,40}(?:因违反社区规范|禁止发笔记|内容违规|违反社区规范|审核不通过|发布失败)[^\n]{0,60}/;

/** 从页面文本里摘出平台自己的那句话；摘不到也不编。 */
export function rejectionSentenceOf(text) {
  const m = String(text ?? "").match(REJECT_SENTENCE);
  return m ? m[0].trim() : "";
}

/**
 * 等发布结局。成功不只看「/publish/success」：图文常常停在当页弹一句「已提交审核」。
 * 拒绝优先判断——它可能是一个几秒就消失的 toast，等超时再报就把原因弄丢了。
 */
export async function waitPublishOutcome(tab, { timeout = 120e3, every = 500 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const url = await tab.url().catch(() => "");
    const text = await tab.eval("document.body.innerText").catch(() => "");
    if (PUBLISH_REJECT.test(text)) {
      const said = rejectionSentenceOf(text);
      throw new AdapterError("platform_reject", `小红书拒绝了这条图文：${said || "平台没有给出具体原因（页面显示禁止发笔记）"}`);
    }
    if (/\/publish\/success/.test(url) || PUBLISH_SUCCESS.test(text)) return { state: "published" };
    if (Date.now() > end) {
      throw new AdapterError("flaky_ui", "等不到发布结果：页面既没有成功提示，也没有显示平台拒绝的原因");
    }
    await sleep(every);
  }
}

const currentVisibility = `(() => {
  const e = (${VISIBILITY_SELECT})(document);
  return e ? e.innerText.trim() : '';
})()`;

/** 等图片真正进编辑器：数量到了、没有上传中的字样、标题框已出现。 */
const imagesLoaded = (count) => `(() => {
  const t = document.body.innerText;
  if (!t.includes(${JSON.stringify(`${count}/18`)})) return false;
  if (/上传中|处理中|正在上传|\\d+%/.test(t)) return false;
  return !!document.querySelector('input[placeholder*="标题"]');
})()`;

/** 图片编辑引导是一次性的「我知道了」浮层；它挡住底部按钮时点发布会点空。 */
async function dismissGuide(tab, clickOn) {
  const present = await tab.eval(`document.querySelector('.feature-guide__btn, .feature-guide__close') ? true : false`);
  if (!present) return;
  try {
    await clickOn(tab, GUIDE_CLOSE, "图片编辑引导");
    await tab.waitFor(`!document.querySelector('.feature-guide__btn') && !document.querySelector('.feature-guide__close')`, [], {
      timeout: 5e3,
      every: 200,
      what: "图片编辑引导关闭",
    });
  } catch {
    // 引导关不掉不是失败：发布按钮的可用性会在下一步再校验一次。
  }
}

/**
 * 点「发布」并等结局。实测图文发布页的按钮偶尔第一次点击不生效（页面不报错、按钮也还是
 * enabled），所以先给 12 秒看结局；没反应且按钮仍可点才补一次，避免重复提交。
 */
async function submitAndWait(tab, step) {
  const FIRST_WINDOW = 12e3;
  await sleep(1500); // 刚切换完可见性，给页面一点提交时间
  step("点击发布");
  await tab.clickInShadow("xhs-publish-btn", "发布");
  const early = await waitPublishOutcome(tab, { timeout: FIRST_WINDOW }).catch((err) => {
    if (err instanceof AdapterError && err.code === "flaky_ui") return null; // 没反应不等于失败：可能只是这页慢
    throw err;
  });
  if (early) return early;

  const state = await tab
    .eval(`(() => { const b = document.querySelector('xhs-publish-btn'); return b ? b.getAttribute('submit-loading') + '|' + b.getAttribute('submit-disabled') : 'gone'; })()`)
    .catch(() => "gone");
  if (state === "false|false") {
    step("重新点击发布（上一次没有反应）");
    await tab.clickInShadow("xhs-publish-btn", "发布");
  }
  // 页面已经跳走（gone）或按钮进入处理中：这里只需要等结局，不再点。
  return waitPublishOutcome(tab, { timeout: 108e3 });
}

/** 点开「谁可以看」并选中目标项；已经选好时不动它。 */
async function setVisibility(tab, text, clickOn) {
  const current = await tab.eval(currentVisibility);
  if (!current) throw new AdapterError("flaky_ui", "小红书发表页上找不到「谁可以看」选项，页面可能改版了");
  if (current === text) return;
  await clickOn(tab, VISIBILITY_SELECT, "谁可以看");
  const option = await tab.waitFor(
    `(() => {
      const e = [...document.querySelectorAll('.name')].find((x) => x.offsetParent && x.innerText.trim() === ${JSON.stringify(text)});
      if (!e) return '';
      e.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return '';
      return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
    })()`,
    [],
    { timeout: 5e3, every: 200, what: `可见性「${text}」` },
  );
  await tab.click(JSON.parse(option));
  await tab.waitFor(`(() => (${VISIBILITY_SELECT})(document)?.innerText.trim() === ${JSON.stringify(text)})()`, [], {
    timeout: 3e3,
    every: 200,
    what: `可见性已切到「${text}」`,
  });
}

/**
 * 图文发布主流程。调用方已保证 tab 停在发表页且本地校验通过；这里只做页面动作。
 *
 * 返回 `{ state, visibility, missed }`，由 index.mjs 补 id / url / followups——
 * 适配器不认识数据库，也不迁移状态。
 */
export async function publishImageNote(tab, { note, plan, step = () => {}, clickOn, addTag, fillTitle, fillBody }) {
  step("切换到上传图文");
  if (!(await tab.eval(IMAGE_INPUT_READY))) {
    // 页面默认停在「上传视频」；点页签切过去。找不到页签时给出候选文案便于排障。
    await clickOn(tab, `(R) => [...R.querySelectorAll('.creator-tab')].filter((e) => e.offsetParent && e.innerText.trim() === '上传图文').pop()`, "上传图文");
    await tab.waitFor(IMAGE_INPUT_READY, [], { timeout: 30e3, every: 500, what: "图文上传控件" });
  }

  step(`上传 ${plan.count} 张图片`);
  // 一次 setFileInputFiles 传完，顺序即数组顺序（core 已按文件名自然排序）。
  await tab.upload(IMAGE_INPUT, plan.files);
  step("等待图片上传完成");
  await tab.waitFor(imagesLoaded(plan.count), [], { timeout: 10 * 60e3, every: 2000, what: "图片上传完成" });

  // 上传后编辑器里「N/18」出现才算真的进队列；再看一次缩略图序号，避免「数量对了但顺序错了」。
  const order = await tab.eval(`JSON.stringify([...document.querySelectorAll('.img-idx')].map((e) => e.innerText.trim()))`);
  try {
    const shown = JSON.parse(order || "[]");
    if (shown.length !== plan.count) {
      throw new AdapterError("flaky_ui", `小红书只认了 ${shown.length} 张图（要发 ${plan.count} 张）：图片可能有一张没上传成功`);
    }
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    throw new AdapterError("flaky_ui", `读不到图片顺序：${order}`);
  }
  await dismissGuide(tab, clickOn);

  step("填写标题");
  await fillTitle(tab, note.title);

  step("填写正文");
  await fillBody(tab, note.body);

  const missed = [];
  if (note.tags.length) {
    step("添加话题");
    await tab.key("Enter", "Enter", 13);
    for (const tag of note.tags) await addTag(tab, tag, missed);
  }

  step("设置谁可以看");
  await setVisibility(tab, plan.visibilityText, clickOn);
  // 有些账号会在填完正文后才弹引导；发布前再关一次，避免点到浮层。
  await dismissGuide(tab, clickOn);

  step("等待发布按钮可用");
  await tab.waitFor(
    `(() => { const b = document.querySelector('xhs-publish-btn'); return b && b.getAttribute('submit-loading') === 'false' && b.getAttribute('submit-disabled') === 'false' ? 'ready' : ''; })()`,
    [],
    { timeout: 20e3, what: "发布按钮可用" },
  );
  step("等待发布结果");
  const outcome = await submitAndWait(tab, step);

  return { state: outcome.state, visibility: plan.visibility, missed };
}
