// 视频号助手发表页的填表流程：上传成片 → 等处理完 → 封面 → 描述 → 短标题 → 位置 → 标注 → 回读 → 保存草稿。
//
// ported from trustbridge@1f9c92f videos/factory/publishers/channels.mjs
// 表单在 wujie 微前端里，所以所有查找都在它的 shadow root 内做。第一版只存草稿：人在手机上点发表，
// 这里没有「发表」按钮的点击。
//
// 搬过来的踩坑知识（别当成多余的）：
//   · 点之前 scrollIntoView({behavior:'instant'})：页面平滑滚动，量到的坐标会指向别的元素；
//   · 上传完成 = 封面卡片出现「编辑」且页面没有 上传中/生成中/正在处理/百分比，最多等 20 分钟；
//   · 9:16 的成片一张封面卡片、16:9 的两张；只点看得见的「编辑」，关着的对话框里也有「编辑」，点了没反应；
//   · 封面编辑框第一次常常点不开，最多点三次；另一张卡片已有图时会先弹「直接编辑」；
//   · 封面上传中「确认」会变成转圈并吞掉点击，等它回来再点。

import { AdapterError } from "../../core/src/errors.mjs";

export const CREATE = "https://channels.weixin.qq.com/platform/post/create";
export const DRAFT_LIST = "https://channels.weixin.qq.com/platform/post/list";
export const UPLOAD_TIMEOUT_MS = 20 * 60e3;

const R = `document.querySelector('wujie-app')?.shadowRoot`;
// 页面动画级别的短等待。测试把它压到几乎为零（setPace），真实运行就是原值。
let pace = 1;
export const setPace = (n) => { pace = n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * pace));
export const EXPIRED = "视频号登录过期了，请重新扫码";
const ON_LOGIN = `location.pathname.includes('login')`;
const q = (s) => JSON.stringify(s);

/** 页面落点：登录页（二维码）/ 发表表单 / 还没渲染出来。 */
export const WHERE = `location.pathname.includes('login') ? 'login' : (${R}?.querySelector('input[type=file]') ? 'form' : '')`;

const at = (tab, find) =>
  tab.eval(`(() => { const R = ${R}; const e = (${find})(R); if (!e) return null; e.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);

const leaf = (label, nth = 0) =>
  `(R) => [...R.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.innerText?.trim() === ${q(label)})[${nth}]`;
const visibleBtn = (label, last = false) =>
  `(R) => [...R.querySelectorAll('button')].filter((e) => e.offsetParent && e.innerText.trim() === ${q(label)})${last ? ".pop()" : ".shift()"}`;

async function clickOn(tab, find, what) {
  const p = await at(tab, find);
  if (!p) throw new AdapterError("flaky_ui", `视频号助手页面上找不到「${what}」，页面可能改版了`);
  await tab.click(p);
  await sleep(800);
}

/** 填完逐项读回：写进去了不等于留住了，编辑器会吞字、下拉会选错。 */
export async function readForm(tab) {
  return tab.eval(`(() => {
    const R = ${R};
    const body = R.querySelector('body').innerText;
    return {
      place: R.querySelector('.position-display-wrap')?.innerText.trim() ?? null,
      shortTitle: R.querySelector('input[placeholder*=短标题]')?.value ?? null,
      description: R.querySelector('.input-editor')?.innerText ?? null,
      body,
    };
  })()`);
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

async function uploadCovers(tab, shots) {
  const dialogInput = `[...${R}.querySelectorAll('.weui-desktop-dialog__bd')].find((d) => d.offsetParent)?.querySelector('input[type=file][accept*=image]')`;
  const popover = `[...${R}.querySelectorAll('button')].find((e) => e.offsetParent && e.innerText.trim() === '直接编辑')`;
  const visibleEdit = (nth) => `(R) => [...R.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.innerText?.trim() === '编辑' && e.offsetParent)[${nth}]`;
  const confirmBtn = visibleBtn("确认", true);
  for (const [nth, img] of shots.entries()) {
    let opened = "";
    for (let i = 0; i < 3 && !opened; i++) {
      await clickOn(tab, visibleEdit(nth), "封面编辑");
      opened = await tab.waitFor(`${dialogInput} ? 'dialog' : ${popover} ? 'popover' : ''`, [], { timeout: 12e3, what: "封面编辑框" }).catch(() => "");
    }
    if (!opened) throw new AdapterError("flaky_ui", "点了三次「编辑」，封面编辑框都没有打开");
    if (opened === "popover") {
      await clickOn(tab, visibleBtn("直接编辑", true), "直接编辑");
      await tab.waitFor(`!!${dialogInput}`, [], { timeout: 15e3, what: "封面上传控件" });
    }
    await tab.upload(dialogInput, [img]);
    await tab.waitFor(`(() => { const R = ${R}; return [...R.querySelectorAll('button')].some((e) => e.offsetParent && e.innerText.trim() === '确认'); })()`, [], { timeout: 30e3, what: "封面上传完成" });
    await clickOn(tab, confirmBtn, "确认");
    const closed = await tab.waitFor(`!(${dialogInput})`, [], { timeout: 20e3, what: "封面编辑框关闭" }).catch(() => null);
    if (!closed) {
      await clickOn(tab, confirmBtn, "确认");
      await tab.waitFor(`!(${dialogInput})`, [], { timeout: 20e3, what: "封面编辑框关闭" });
    }
  }
}

/**
 * 填表并（非 dry-run 时）点「保存草稿」。
 * plan: { file, shortTitle, description, location, aiMark, covers: { profile?, share? } | null }
 * hooks: { step, dryRun, uploadTimeoutMs, listTimeoutMs }
 * 返回 { dryRun: true, form } 或 { saved: true, form }。
 */
export async function fillDraft(tab, plan, options = {}) {
  try {
    return await fillDraftSteps(tab, plan, options);
  } catch (err) {
    // 发布途中被送到二维码页：不管当时卡在哪一步，都是「登录过期」，不能报成找不到元素。
    if (!(err instanceof AdapterError && err.code === "auth") && (await tab.eval(ON_LOGIN).catch(() => false))) throw new AdapterError("auth", EXPIRED, { cause: err });
    throw err;
  }
}

async function fillDraftSteps(tab, plan, { step = () => {}, dryRun = false, uploadTimeoutMs = UPLOAD_TIMEOUT_MS, listTimeoutMs = 60e3 } = {}) {
  step("打开视频号助手发表页");
  const where = await tab.waitFor(WHERE, [], { timeout: 90e3, every: 1000, what: "视频号助手发表页" });
  if (where === "login") throw new AdapterError("auth", EXPIRED);

  step("上传成片");
  await tab.upload(`${R}.querySelector('input[type=file][accept*=video]')`, [plan.file]);
  step("等视频上传和处理完成");
  // 等的这二十分钟里登录掉了，页面会被送去二维码页：不能干等到超时。
  const uploaded = await tab.waitFor(
    `(() => { if (${ON_LOGIN}) return 'login'; const R = ${R}; const t = R.querySelector('body').innerText; return R.querySelectorAll('.edit-btn').length >= 1 && !/上传中|生成中|正在处理|\\d+%/.test(t); })()`,
    [],
    { timeout: uploadTimeoutMs, every: 2000, what: "视频上传完成" },
  );
  if (uploaded === "login") throw new AdapterError("auth", EXPIRED);
  await sleep(1500);

  const covers = plan.covers;
  if (covers) {
    step("设置封面");
    // 一张卡片传一张图：9:16 的成片一张（3:4 个人主页），16:9 的两张（再加 4:3 分享）。
    const cards = await tab.eval(`(() => { const R = ${R}; return [...R.querySelectorAll('.edit-btn')].filter((e) => e.offsetParent).length; })()`);
    const want = Math.max(1, Math.min(cards, 2));
    const shots = [covers.profile, covers.share].slice(0, want);
    if (shots.every(Boolean)) await uploadCovers(tab, shots);
  }

  step("填描述");
  await clickOn(tab, `(R) => R.querySelector('.input-editor')`, "视频描述");
  await tab.type(`${plan.description} `);
  step("填短标题");
  await clickOn(tab, `(R) => R.querySelector('input[placeholder*=短标题]')`, "短标题");
  await tab.type(plan.shortTitle);

  step("设置位置");
  await clickOn(tab, `(R) => R.querySelector('.position-display-wrap')`, "位置");
  // 下拉里的行是 .option-item，里面的文字不是点击目标。
  await clickOn(tab, `(R) => [...R.querySelectorAll('.option-item')].find((e) => e.offsetParent && e.innerText.trim().startsWith(${q(plan.location)}))`, plan.location);
  if (plan.aiMark) {
    step("设置视频标注");
    await clickOn(tab, leaf("选择视频标注"), "视频标注");
    await clickOn(tab, `(R) => [...R.querySelectorAll('.mark-tag-option')].find((e) => e.offsetParent && e.innerText.trim() === ${q(plan.aiMark)})`, plan.aiMark);
  }

  step("回读表单");
  const form = await readForm(tab);
  const wrong = [];
  if (squash(form.description) !== squash(plan.description)) wrong.push("描述没有填成要发的内容");
  if (squash(form.shortTitle) !== squash(plan.shortTitle)) wrong.push(`短标题没有填进去（现在是「${form.shortTitle ?? ""}」）`);
  if (!String(form.place ?? "").startsWith(plan.location)) wrong.push(`位置没有设成「${plan.location}」（现在是「${form.place ?? ""}」）`);
  if (plan.aiMark && !form.body.includes(plan.aiMark)) wrong.push(`视频标注没有设成「${plan.aiMark}」`);
  const over = form.body.match(/[^\n]*超过\d+字限制[^\n]*/);
  if (over) wrong.push(`表单有超长提示：${over[0]}`);
  if (wrong.length) throw new AdapterError("flaky_ui", `视频号表单回读对不上：${wrong.join("；")}`);

  // 测试表单：填完、读回、截图，停在「保存草稿」前一步，不动平台上的任何东西。
  if (dryRun) return { dryRun: true, form };

  step("保存草稿");
  await clickOn(tab, visibleBtn("保存草稿", true), "保存草稿");
  await tab.waitFor(`/post\\/(list|draft)/.test(location.pathname)`, [], { timeout: 120e3, what: "保存草稿后跳转到草稿列表" });
  // 到草稿列表把这一条读回来才算数，不信「点了按钮」。
  step("到草稿列表核对");
  const key = [...plan.shortTitle].slice(0, 12).join("");
  const found = await tab
    .waitFor(`(() => { const R = ${R}; return !!R && R.querySelector('body').innerText.includes(${q(key)}); })()`, [], { timeout: listTimeoutMs, what: "草稿列表里的这一条" })
    .catch(() => null);
  if (!found) throw new AdapterError("flaky_ui", `点了「保存草稿」，但草稿列表里没有读回「${plan.shortTitle}」：没有记成已送草稿箱`);
  return { saved: true, form };
}
