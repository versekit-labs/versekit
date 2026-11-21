// 视频号适配器：视频号没有发布接口，所以在账号自己的 Chrome 里驱动视频号助手（channels.weixin.qq.com），
// 第一版**只存草稿**：成片、封面、描述、短标题、位置、标注都填好、读回核对，点「保存草稿」，
// 到草稿列表读回这一条才算数。发表由人在手机上点。
//
// ported from trustbridge@1f9c92f videos/factory/publishers/channels.mjs（发布器）
// ported from trustbridge@1f9c92f videos/factory/keepalive.mjs（登录探测；保活本身不搬——所有者说不管用）
// 按 ADR-0001 只搬流程与踩坑知识，契约与数据来源重写：文案、短标题、位置、标注来自平台稿，
// 通知不直接推飞书（失败抛 AdapterError，由 core 发事件），截图走驱动的证据目录。
// 登录要撑多久、什么时候查，都由 core 记录和调度（适配器不碰库）。
//
// 这个平台最脆的三处：
//   1. 表单在 wujie 微前端的 shadow root 里，选择器全部从 shadowRoot 起查；
//   2. 上传后要等封面卡片出现「编辑」且页面没有进度字样（最多 20 分钟）；
//   3. 登录只能撑一阵，掉到二维码页就是「请重新扫码」，不能报成找不到元素。

import { existsSync, writeFileSync } from "node:fs";
import { open } from "../../core/src/index.mjs";
import { AdapterError } from "../../core/src/errors.mjs";
import { resolvePublishAsset, resolvePublishCopy } from "../../core/src/publish-flow.mjs";
import { openAccount, closeAccount, closeLoginWindow, hasLiveBrowser, browserReady, evidencePath } from "../../driver-browser/src/index.mjs";
import { planDraft } from "./copy.mjs";
import { fillDraft, CREATE } from "./form.mjs";
import { probeLogin, startQrLogin, qrLoginStatus, EXPIRED_DETAIL } from "./login.mjs";

export { planDraft, checkShortTitle, checkDescription, shipinhaoParams } from "./copy.mjs";

const text = (v) => (v == null ? "" : String(v).trim());

/** 封面：入库清单给了就用（9:16 要一张、16:9 要两张，缺了就整体用平台默认）。 */
function coversOf(plan) {
  const ok = (p) => (p && existsSync(p) ? p : null);
  const profile = ok(plan.cover34);
  const share = ok(plan.cover43);
  if (!profile && !share) return null;
  return { profile, share };
}

/** 在人确认之前就能判定的事：短标题、描述、封面文件。不开浏览器，不碰平台。 */
export function preflight({ publishId, copy = null } = {}) {
  if (!publishId) throw new AdapterError("unknown", "preflight 需要 publishId");
  return planDraft(copy ?? resolvePublishCopy(publishId));
}

async function capture(tab, accountId, tag) {
  if (!tab) return null;
  try {
    const file = evidencePath(accountId, `shipinhao-${tag}`);
    writeFileSync(file, await tab.screenshot());
    return file;
  } catch {
    return null;
  }
}

async function withEvidence(tab, accountId, tag, err) {
  const shot = await capture(tab, accountId, tag);
  const e = err instanceof AdapterError ? err : new AdapterError("flaky_ui", err.message);
  if (shot && !e.evidence) e.evidence = shot;
  if (shot) e.message += `\n页面截图：${shot}`;
  return e;
}

async function publish({ publishId, asset: given = null, copy: givenCopy = null, dryRun = false, signal, onStep, tab: injectedTab = null, fillOptions = {} } = {}) {
  if (typeof publishId !== "string" || !publishId.trim()) throw new AdapterError("unknown", "publishId 必须是非空字符串");
  const step = (label) => {
    try {
      onStep?.(label);
    } catch {
      // 进度回调坏了不能影响发布本身。
    }
  };
  // 先算计划：短标题 / 描述不合规在打开浏览器之前就抛 asset_invalid。
  const copy = givenCopy ?? resolvePublishCopy(publishId);
  const plan = planDraft(copy);
  const file = text(given ?? resolvePublishAsset(publishId).asset);
  if (!file || !existsSync(file)) throw new AdapterError("asset_invalid", `找不到成片：${file || "（路径为空）"}`);

  // dryRun: true = 契约里的「发布前彩排」：只做本地校验，不开浏览器、不联网（check:contract 钉着这条）。
  // dryRun: "form" = 真的打开视频号助手把表单填完、读回、截图，停在「保存草稿」前一步，不保存任何东西。
  const target = { shortTitle: plan.shortTitle, description: plan.description, location: plan.location, aiMark: plan.aiMark, file };
  if (dryRun === true) return { dryRun: true, target };

  const accountId = fillOptions.accountId ?? accountOf(publishId);
  let tab = injectedTab;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    if (accountId && !injectedTab) closeAccount(accountId).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (!tab) {
      tab = await openAccount({ accountId });
      await tab.goto(CREATE);
    }
    const result = await fillDraft(tab, { ...plan, file, covers: coversOf(plan) }, { step, dryRun: dryRun === "form", ...fillOptions });
    if (result.dryRun) {
      const shot = await capture(tab, accountId, "dry-run");
      return { dryRun: true, target, form: result.form, screenshot: shot };
    }
    const shot = await capture(tab, accountId, "draft-saved");
    return {
      // 视频号没有网页链接：草稿在草稿箱里按短标题找；平台 id 记短标题。
      id: plan.shortTitle,
      url: "https://channels.weixin.qq.com/platform/post/list",
      visibility: "private",
      state: "draft_pending",
      note: "已送到视频号草稿箱，在手机上点发表",
      followups: [],
      ...(shot ? { evidence: { screenshot: shot } } : {}),
    };
  } catch (err) {
    if (aborted) throw err; // 总时限中止由内核按 timeout 处理，不改写
    throw await withEvidence(tab, accountId, "publish", err);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (aborted) await closeAccount(accountId).catch(() => {});
    else if (!injectedTab) await tab?.close().catch(() => {});
  }
}

function accountOf(publishId) {
  const row = open().prepare("SELECT account_id FROM publish WHERE id = ?").get(publishId);
  if (!row) throw new AdapterError("unknown", `找不到发布：${publishId}`);
  return row.account_id;
}

/** 登录检查：打开一个只读页面看会不会被送去二维码页。过期人话固定为「视频号登录过期了，请重新扫码」。 */
async function check(ctx = {}) {
  const accountId = ctx?.accountId;
  if (typeof accountId !== "string" || !accountId.trim()) throw new AdapterError("unknown", "check 需要 accountId");
  let tab = ctx.tab ?? null;
  // 人正开着登录窗口时，既不能关它，也不能把它的页面跳走。
  const reusedVisible = !tab && hasLiveBrowser(accountId);
  try {
    tab ??= await openAccount({ accountId, headless: true });
    const state = await probeLogin(tab);
    if (state === "ok") {
      if (reusedVisible) closeLoginWindow(accountId, { cookieUrl: "https://channels.weixin.qq.com" }).catch(() => {});
      return { state: "ok" };
    }
    return { state: "expired", detail: EXPIRED_DETAIL };
  } catch (err) {
    throw await withEvidence(tab, accountId, "check", err);
  } finally {
    if (!ctx.tab) {
      if (!reusedVisible) await closeAccount(accountId).catch(() => {});
    }
  }
}

export default {
  platform: "shipinhao",
  capabilities: {
    publish: "web",
    collect: "none",
    // 第一版只存草稿：人在手机上点发表。没有自动直接发表。
    draft: true,
    visibility: [],
    requiresQualification: false,
    assetTypes: ["video"],
  },
  /** 平台稿一律走草稿（core 据此把 auto 模式的行当草稿跑）。 */
  draftOnly: true,
  /** 登录只能撑一阵：core 为它记登录时长，并且不挂 6 小时一次的通用体检（所有者：保活不管用）。 */
  loginTracked: true,
  ready() {
    const reason = browserReady();
    return reason ? `视频号未配置：${reason}` : null;
  },
  check,
  preflight,
  publish,
  /** 网页扫码（ACC-v3-login-01 的做法）：vk 的 account.login.qr / login.status 委托到这两个。 */
  loginQr: startQrLogin,
  loginStatus: qrLoginStatus,
};
