// 抖音适配器：用发布机上用户自己已登录的 Chrome 驱动创作者中心发布页，把成片和文案存进抖音草稿箱。
//
// ported from dreammis/social-auto-upload@3847fff uploader/douyin_uploader/main.py
// （MIT，全文与移植范围见仓库根的 THIRD_PARTY_NOTICES.md；按 ADR-0002 §4.1 方式 B 带声明移植）。
// 只搬上传、填表、封面、话题这部分页面流程，用现有 driver-browser 重写；不走 Python sidecar。
// 不搬扫码、验证码输入、cookie 持久化：登录由用户在发布机的 Chrome 里登录一次解决，
// 账号 id 来自 account 行，登录态在该账号自己的 Chrome profile 里，适配器不写死任何账号。
//
// 第一版只存草稿，人在手机上点发布：
//   · 终点是 draft_pending（「已送到抖音草稿箱，在手机上点发布」），从来不是 published；
//   · 不用抖音页面自带的定时：预约发到点由 VerseKit 把稿子送进草稿箱（core 排期），现在发立即送；
//   · 草稿是否真的存进去，靠回到草稿箱数一遍标题确认，不信「点了按钮」。
//
// 这个平台最脆的三处（也是保留超时与逐步回读的原因）：
//   1. 发布页的表单要等视频开始上传才渲染，标题 input 与正文编辑器出现得晚；
//   2. 封面弹窗里有两个上传控件，传错那个封面就不会生效，「完成」还会一直灰着；
//   3. 风控页面（验证码 / 滑块 / 操作太频繁）一旦出现必须立即停手，不能重试。

import { writeFileSync } from "node:fs";
import { AdapterError, toAdapterError } from "../../core/src/errors.mjs";
import { open } from "../../core/src/index.mjs";
import { planRules } from "../../core/src/plan-rules.mjs";
import * as realDriver from "../../driver-browser/src/index.mjs";
import * as page from "./page.mjs";
import { COVER_EXTENSIONS, MAX_TOPICS, VIDEO_EXTENSIONS, compact, planDraft, requireMedia, squash, titleKey } from "./plan.mjs";
import * as ledger from "./state.mjs";

export { planDraft, MAX_TITLE_CHARS, MAX_TOPICS, normaliseTopics } from "./plan.mjs";

const PLATFORM = "douyin";
const NOTE = "已送到抖音草稿箱，在手机上点发布";
const LOGIN_DETAIL = "抖音登录过期：到系统页点「在发布机上打开登录窗口」，在窗口里登录一次后重试";

/** 超时按真实耗时给（adapter-contract 规则 9）：视频上传 20 分钟、进发布页 3 分钟、保存判定 3 分钟。 */
export const TIMEOUTS = Object.freeze({ upload: 20 * 60e3, publishPage: 3 * 60e3, save: 3 * 60e3, element: 30e3, coverModal: 5e3, coverDone: 15e3 });
/** 话题输入后等建议列表稳定再打空格（规则 8）；动画级过渡等待（driver-api §4 允许）。 */
export const SETTLE = Object.freeze({ topicMs: 700, afterTopicMs: 300, afterClickMs: 900, pollMs: 2000 });

/**
 * 工厂函数：driver 与 sleep / now 可注入，离线测试用 stub driver 替换真实 Chrome，
 * 默认导出的适配器用真实 driver-browser。流程只有这一份，测试跑的就是生产代码。
 */
export function createAdapter({ driver = realDriver, sleep = driver.sleep, now = Date.now, env = process.env } = {}) {
  // ---------------------------------------------------------------- 取证与错误

  async function capture(tab, accountId, tag) {
    if (!tab || !accountId) return null;
    try {
      const path = driver.evidencePath(accountId, tag);
      writeFileSync(path, await tab.screenshot());
      return { screenshot: path };
    } catch {
      // 截图尽力而为：连页面都没了，也必须把原始错误抛出去，不能用截图失败盖掉它。
      return null;
    }
  }

  async function withEvidence(tab, accountId, tag, err) {
    const wrapped = toAdapterError(err);
    const shot = await capture(tab, accountId, tag);
    if (shot) wrapped.evidence = { ...(wrapped.evidence ?? {}), ...shot };
    return wrapped;
  }

  /** 驱动抛的普通 Error 翻成 flaky_ui：「页面没按预期走」不能被记成未知错误。 */
  async function uiStep(what, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError("flaky_ui", `${what}失败：${err?.message ?? err}`, { cause: err });
    }
  }

  function riskError(accountId, hit, where) {
    const until = ledger.pauseUntil(accountId, ledger.nextLocalMidnight(now()));
    const err = new AdapterError(
      "platform_reject",
      `抖音要你在发布机的窗口里手动过一下验证（${where}，页面提示：「${String(hit).slice(0, 40)}」）：已立即停下、没有重试，这个账号暂停到明天零点；验证通过后到系统页恢复`,
    );
    err.platformCode = "douyin_risk_control";
    err.pause = { code: "douyin_risk_control", until };
    return err;
  }

  const ctxOf = (tab, accountId) => ({ tab, accountId });

  /** 每次页面发生变化之后都要问一句：被踢回登录页了吗、撞上风控了吗。先判登录（登录页自己也有「验证码」字样）。 */
  async function guard({ tab, accountId }, where) {
    if (await tab.eval(page.loginShown, page.T.login).catch(() => false)) throw new AdapterError("auth", LOGIN_DETAIL);
    const hit = await tab.eval(page.riskText, page.RISK_PATTERNS).catch(() => "");
    if (hit) throw riskError(accountId, hit, where);
  }

  const pointOrNull = async (tab, find, ...args) => {
    try {
      return await tab.point(find, ...args);
    } catch {
      return null;
    }
  };

  async function clickOn(tab, find, arg, what) {
    const point = await pointOrNull(tab, find, arg);
    if (!point) throw new AdapterError("flaky_ui", `抖音创作者中心上找不到「${what}」，页面可能改版了`);
    await tab.click(point);
    await sleep(SETTLE.afterClickMs);
  }

  function checkAbort(signal) {
    if (signal?.aborted) throw new AdapterError("timeout", "发布被总时限中止：已关闭浏览器，可以重试");
  }

  // ---------------------------------------------------------------- 读库（只读）

  function accountOf(publishId, previewAccountId) {
    const db = open();
    if (publishId) {
      const row = db.prepare("SELECT a.id AS account_id, a.platform, a.handle FROM publish p JOIN account a ON a.id = p.account_id WHERE p.id = ?").get(publishId);
      if (!row) throw new AdapterError("unknown", `找不到发布：${publishId}`);
      if (row.platform !== PLATFORM) throw new AdapterError("unknown", `账号 ${row.account_id} 不是抖音`);
      return row;
    }
    if (!previewAccountId) return null;
    const row = db.prepare("SELECT id AS account_id, platform, handle FROM account WHERE id = ?").get(previewAccountId);
    if (row && row.platform !== PLATFORM) throw new AdapterError("unknown", `账号 ${row.account_id} 不是抖音`);
    return row ?? null;
  }

  // ---------------------------------------------------------------- 页面步骤

  /** 打开作品管理页的草稿箱，返回这个标题在里面出现了几次（保存前后各数一次）。 */
  async function draftCount(ctx, key, where) {
    const { tab } = ctx;
    const links = page.urls(page.baseUrl(env));
    await uiStep(`打开作品管理页（${where}）`, () => tab.goto(links.manage));
    await guard(ctx, `作品管理页（${where}）`);
    await clickOn(tab, page.findLeaf, page.T.draftsTab, "草稿箱");
    await uiStep("等草稿箱列表", () => tab.waitFor(page.pageText, [], { timeout: TIMEOUTS.element, what: "草稿箱列表" }));
    await guard(ctx, `草稿箱（${where}）`);
    return tab.eval(page.countOnPage, key);
  }

  async function uploadVideo(ctx, asset, signal) {
    const { tab } = ctx;
    const links = page.urls(page.baseUrl(env));
    await uiStep("打开抖音上传页", () => tab.goto(links.upload));
    await guard(ctx, "上传页");
    try {
      await tab.waitFor(page.uploadInputReady, [], { timeout: 60e3, what: "抖音上传页的文件控件" });
    } catch (err) {
      // 等不到上传控件：多半是被踢回登录页或撞上风控，先问一遍，问不出来才算页面改版。
      await guard(ctx, "上传页");
      throw new AdapterError("flaky_ui", "抖音上传页没有出现文件控件，页面可能改版了", { cause: err });
    }
    await uiStep("上传视频", () => tab.upload(page.UPLOAD_INPUT_EXPR, [asset]));

    // 上传后进发布页：地址变化 + 风控 / 登录守卫，一起轮询。
    const end = now() + TIMEOUTS.publishPage;
    for (;;) {
      checkAbort(signal);
      if (await tab.eval(page.onPublishPage).catch(() => false)) break;
      await guard(ctx, "上传后");
      if (now() > end) throw new AdapterError("flaky_ui", "视频选好了，三分钟内没有进到抖音发布页");
      await sleep(SETTLE.afterClickMs);
    }
  }

  async function fillTitle(ctx, title) {
    const { tab } = ctx;
    const hints = page.T.titleHint;
    await uiStep("等标题输入框", () => tab.waitFor(page.titleInputReady, [hints], { timeout: TIMEOUTS.upload, every: 1000, what: "标题输入框（视频开始上传后才出现）" }));
    await clickOn(tab, page.findTitleInput, hints, "作品标题");
    await uiStep("清空标题", async () => {
      await tab.selectAll();
      await tab.key("Backspace", "Backspace", 8);
      await tab.waitFor(page.titleEmpty, [hints], { timeout: 2000, every: 100, what: "标题清空" });
    });
    await tab.type(title);
    const shown = await tab.eval(page.titleValue, hints);
    if (compact(shown) !== compact(title)) throw new AdapterError("flaky_ui", `作品标题没有填对，现在是：${String(shown ?? "").slice(0, 80)}`);
  }

  async function fillDescription(ctx, { body, topics }) {
    const { tab } = ctx;
    await uiStep("等正文编辑器", () => tab.waitFor(page.descEditorReady, [], { timeout: TIMEOUTS.element, what: "作品描述编辑器" }));
    await clickOn(tab, page.findDescEditor, undefined, "作品描述");
    await uiStep("清空作品描述", () => tab.clear(page.descEmpty));

    const lines = body ? body.split("\n") : [];
    for (const [i, line] of lines.entries()) {
      if (i) await tab.key("Enter", "Enter", 13);
      if (line) await tab.type(line);
    }
    if (body && topics.length) await tab.key("Enter", "Enter", 13);

    // 话题逐个输入并回读：建议列表会吃掉紧跟着的空格，等它稳定再补空格（规则 8）。
    for (const topic of topics) {
      await tab.type(`#${topic}`);
      await sleep(SETTLE.topicMs);
      await tab.type(" ");
      await sleep(SETTLE.afterTopicMs);
      const typed = await tab.eval(page.descText);
      if (!squash(typed).includes(`#${topic}`)) {
        throw new AdapterError("flaky_ui", `话题「#${topic}」没有填进作品描述，现在是：${String(typed).slice(0, 200)}`);
      }
    }
    await tab.key("Escape", "Escape", 27); // 收起话题下拉，避免浮层挡住后面的点击
    await tab.eval(page.removeOverlays).catch(() => 0);

    const typed = squash(await tab.eval(page.descText));
    const head = [...squash(body)].slice(0, 40).join("");
    if ((head && !typed.includes(head)) || topics.some((t) => !typed.includes(`#${t}`))) {
      throw new AdapterError("flaky_ui", `作品描述没有填对，现在是：${typed.slice(0, 300)}`);
    }
  }

  async function waitUploadDone(ctx, signal) {
    const { tab } = ctx;
    const end = now() + TIMEOUTS.upload;
    for (;;) {
      checkAbort(signal);
      const state = await tab.eval(page.uploadState, page.T.reupload, page.T.uploadFailed).catch(() => "");
      if (state === "done") return;
      if (state === "failed") {
        const body = await tab.eval(page.pageText).catch(() => "");
        if (/不支持|格式|时长|大小|unsupported/i.test(body)) throw new AdapterError("asset_invalid", "抖音拒收这个视频（格式、时长或大小不符）");
        throw new AdapterError("flaky_ui", "抖音页面提示视频上传失败");
      }
      await guard(ctx, "视频上传中");
      if (now() > end) throw new AdapterError("flaky_ui", "20 分钟内没有等到抖音视频上传完成");
      await sleep(SETTLE.pollMs); // 轮询间隔，不是同步手段：同步靠上面的 uploadState
    }
  }

  async function setCover(ctx, cover) {
    const { tab } = ctx;
    const before = await tab.eval(page.coverImageSrc);
    await tab.eval(page.removeOverlays).catch(() => 0); // 新手引导浮层会拦截封面点击
    let opened = false;
    for (let attempt = 0; attempt < 5 && !opened; attempt++) {
      const point = (await pointOrNull(tab, page.findLeaf, page.T.coverEdit)) ?? (await pointOrNull(tab, page.findCoverArea));
      if (!point) {
        await sleep(SETTLE.afterClickMs);
        continue;
      }
      await tab.click(point);
      opened = await tab.waitFor(page.coverModalOpen, [], { timeout: TIMEOUTS.coverModal, what: "封面弹窗" }).then(() => true, () => false);
    }
    if (!opened) throw new AdapterError("flaky_ui", "抖音封面弹窗打不开：入库封面没有设上，页面可能改版了");

    const portrait = await pointOrNull(tab, page.findLeaf, page.T.coverPortrait);
    if (portrait) {
      await tab.click(portrait);
      await sleep(SETTLE.afterClickMs);
    }
    await uiStep("上传封面", () => tab.upload(page.COVER_INPUT_EXPR, [cover]));
    await uiStep("等封面处理完（「完成」解禁）", () => tab.waitFor(page.coverDoneReady, [page.T.coverDone], { timeout: TIMEOUTS.coverDone, every: 500, what: "封面「完成」按钮解禁" }));
    await clickOn(tab, page.findCoverDone, page.T.coverDone, "封面「完成」");

    let closed = await tab.waitFor(page.coverModalGone, [], { timeout: TIMEOUTS.coverDone, what: "封面弹窗关闭" }).then(() => true, () => false);
    if (!closed) {
      // 点「完成」后偶尔还有二次确认：点确认，再不行才 Esc；仍然关不掉就报错，不带着浮层往下点。
      const confirm = await pointOrNull(tab, page.findModalButton, page.T.confirm);
      if (confirm) await tab.click(confirm);
      else await tab.key("Escape", "Escape", 27);
      closed = await tab.waitFor(page.coverModalGone, [], { timeout: TIMEOUTS.coverModal, what: "封面弹窗关闭" }).then(() => true, () => false);
    }
    if (!closed) throw new AdapterError("flaky_ui", "抖音封面弹窗点了「完成」仍没有关闭：封面可能没设上");

    const after = await tab.eval(page.coverImageSrc);
    if (!after || after === before) throw new AdapterError("flaky_ui", "封面弹窗关了，但页面上的封面没有变：入库封面没有设上");
  }

  /** 平台要求先设封面（没有入库封面时的兜底）：选第一个平台推荐封面。 */
  async function applyDefaultCover(ctx) {
    const { tab } = ctx;
    const point = await pointOrNull(tab, page.findRecommendCover);
    if (!point) throw new AdapterError("flaky_ui", "抖音提示要先设封面，但找不到推荐封面：页面可能改版了");
    await tab.click(point);
    await sleep(SETTLE.afterClickMs);
    if (await tab.eval(page.textVisible, page.T.coverConfirm)) {
      await clickOn(tab, page.findModalButton, page.T.confirm, "确认应用封面");
    }
  }

  async function saveDraft(ctx, signal) {
    const { tab } = ctx;
    for (let round = 0; round < 2; round++) {
      checkAbort(signal);
      await tab.eval(page.removeOverlays).catch(() => 0);
      await clickOn(tab, page.findButton, page.T.saveDraft, "存草稿（暂存离开）");
      // 有的版本点完会跳到作品管理页，有的只弹提示不跳转：等一小段，没有结果就交给草稿箱回读判断，不在这里死等。
      const end = now() + TIMEOUTS.element;
      let outcome = "";
      while (!outcome && now() <= end) {
        checkAbort(signal);
        outcome = await tab.eval(page.saveOutcome, page.T.coverNeeded).catch(() => "");
        if (outcome) break;
        await guard(ctx, "点存草稿之后");
        await sleep(SETTLE.afterClickMs);
      }
      if (outcome === "cover" && round === 0) {
        await applyDefaultCover(ctx);
        continue;
      }
      if (outcome === "cover") throw new AdapterError("flaky_ui", "抖音一直提示要先设封面，草稿存不进去");
      return;
    }
  }

  // ---------------------------------------------------------------- 流程（dry-run 与真发共用同一段）

  /**
   * 填到「存草稿」前一步为止。stopBeforeSave 为真时在这里截图返回（dry-run 彩排），
   * 否则继续点存草稿并回读。同一段代码跑两种模式，dry-run 才能证明真发的路径走得通。
   */
  async function run({ tab, accountId, plan, asset, cover, signal, onStep, stopBeforeSave }) {
    const ctx = ctxOf(tab, accountId);
    const steps = [];
    const step = (name) => {
      steps.push(name);
      onStep?.(name);
    };
    if (signal) signal.addEventListener("abort", () => void tab.close().catch(() => {}), { once: true });

    await uiStep("设置视口", () => tab.send("Emulation.setDeviceMetricsOverride", page.VIEWPORT));
    const key = titleKey(plan.title);

    // 保存前先数一遍草稿箱里同标题有几条：保存后必须多出一条，才能确认「这一条」进去了。
    step("数草稿箱里已有的同名草稿");
    const before = await draftCount(ctx, key, "保存前");

    step("打开上传页并选择视频");
    await uploadVideo(ctx, asset, signal);
    step("填写标题");
    await fillTitle(ctx, plan.title);
    step("填写正文与话题");
    await fillDescription(ctx, plan);
    step("等视频上传完成");
    await waitUploadDone(ctx, signal);
    if (cover) {
      step("设置封面");
      await setCover(ctx, cover);
    }
    await guard(ctx, "存草稿前");

    if (stopBeforeSave) {
      const shot = await capture(tab, accountId, "douyin-dry-run");
      return { steps, before, evidence: shot ?? undefined };
    }

    step("点「存草稿」");
    await saveDraft(ctx, signal);

    step("回草稿箱核实");
    await draftCount(ctx, key, "保存后");
    const found = await tab
      .waitFor(page.countExceeds, [key, before], { timeout: TIMEOUTS.element, every: 1000, what: "草稿箱里多出这一条" })
      .then(() => true, () => false);
    if (!found) {
      await guard(ctx, "草稿箱核实");
      throw new AdapterError("flaky_ui", `点了存草稿，但草稿箱里没有多出标题以「${key}」开头的草稿：草稿可能没有存进去`);
    }
    const href = await tab.eval(page.firstDraftHref, key).catch(() => "");
    return { steps, before, draftUrl: href || null };
  }

  // ---------------------------------------------------------------- 发布

  async function publish({ publishId = null, asset: given = null, copy = null, dryRun = false, preview = null, signal = null, onStep = null } = {}) {
    let tab = null;
    let accountId = null;
    try {
      const row = accountOf(publishId, preview?.accountId);
      accountId = row?.account_id ?? null;
      const plan = planDraft(copy ?? {});
      const media = requireMedia(given, "成片", VIDEO_EXTENSIONS);
      const cover = plan.cover ? requireMedia(plan.cover, "封面", COVER_EXTENSIONS) : null;
      const base = page.baseUrl(env);
      const cap = planRules(PLATFORM).dailyCap;
      const used = accountId ? ledger.draftsToday(accountId, now()) : 0;

      const request = {
        mode: "draft",
        title: plan.title,
        body: plan.body,
        topics: plan.topics,
        cover: cover ?? "平台默认封面",
        asset: media,
        quota: { cap, used },
        steps: ["打开抖音上传页并选择视频", "填写标题", "填写正文与话题", "等视频上传完成", ...(cover ? ["设置封面"] : []), "点「存草稿」", "回草稿箱核实"],
        ...(plan.droppedTopics.length ? { droppedTopics: plan.droppedTopics } : {}),
      };

      if (dryRun) {
        const plain = { dryRun: true, request, target: { title: plan.title, topics: plan.topics }, asset: media, cover, steps: request.steps };
        // 真实站点上 dry-run 只出计划：打开发布页上传视频就已经是对平台的动作了。
        // 本机模拟页（回环地址 / file://）上才真的走一遍，停在「存草稿」前并截图。
        if (!page.isLocalBase(base) || !accountId) return plain;
        tab = await driver.openAccount({ accountId });
        const out = await run({ tab, accountId, plan, asset: media, cover, signal, onStep, stopBeforeSave: true });
        return { ...plain, rehearsed: true, steps: out.steps, ...(out.evidence ? { evidence: out.evidence } : {}) };
      }

      if (!publishId || !accountId) throw new AdapterError("unknown", "publish 需要 publishId");

      // 每天送草稿箱的条数有上限（ACC-douyin-06）：到上限就不再送，原因写清楚，不开浏览器。
      const pausedTo = ledger.pausedUntil(accountId, now());
      if (pausedTo) {
        throw new AdapterError("platform_reject", `这个抖音账号因验证 / 风控暂停到 ${new Date(pausedTo).toLocaleString("zh-CN")}：这条没有送草稿箱，到点或验证通过后再试`);
      }
      if (used >= cap) {
        throw new AdapterError(
          "platform_reject",
          `${row.handle ?? "这个抖音账号"}今天已经送了 ${used} 条到抖音草稿箱，达到每日上限 ${cap} 条：这条没有送，明天再送，或在发布方案里调高上限`,
        );
      }

      tab = await driver.openAccount({ accountId });
      const out = await run({ tab, accountId, plan, asset: media, cover, signal, onStep, stopBeforeSave: false });
      ledger.recordDraft(accountId, now());

      return {
        // 草稿没有公开作品 id：用平台稿 id 派生一个稳定的，人在手机上发出去之后的真实 id 属于后续采集单。
        id: `draft-${publishId}`,
        url: out.draftUrl ?? page.urls(base).manage,
        visibility: "private",
        state: "draft_pending",
        note: NOTE,
        ...(plan.droppedTopics.length ? { notes: [`话题超过 ${MAX_TOPICS} 个或过长，没有填：${plan.droppedTopics.map((t) => `#${t}`).join(" ")}`] } : {}),
      };
    } catch (err) {
      throw await withEvidence(tab, accountId, "douyin-publish", err);
    } finally {
      await tab?.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 登录态探测

  /** 打开创作者中心首页（只读）判断：正常 / 登录过期 / 被限制 / 需要人工验证。 */
  async function check(ctx = {}) {
    const accountId = ctx?.accountId;
    if (typeof accountId !== "string" || !accountId.trim()) throw new AdapterError("unknown", "check 需要 accountId");
    let tab = null;
    try {
      tab = await driver.openAccount({ accountId });
      await uiStep("打开抖音创作者中心", () => tab.goto(page.urls(page.baseUrl(env)).home));
      let state = "";
      try {
        state = await tab.waitFor(page.homeState, [page.T.login, page.LIMITED_PATTERNS, page.RISK_PATTERNS], { timeout: 20e3, every: 500, what: "创作者中心首页" });
      } catch (err) {
        throw new AdapterError("flaky_ui", "抖音创作者中心首页 20 秒内没有渲染出来，页面可能改版了", { cause: err });
      }
      if (state === "login") return { state: "expired", detail: LOGIN_DETAIL };
      if (state === "limited") {
        return { state: "banned", detail: "抖音提示这个账号被限制了：到手机抖音里看一下限制原因，处理好之前别往这个账号送草稿" };
      }
      if (state === "risk") return { state: "manual", detail: "抖音要你在发布机的窗口里手动过一下验证，过完再检查一次" };
      return { state: "ok" };
    } catch (err) {
      throw await withEvidence(tab, accountId, "douyin-check", err);
    } finally {
      await tab?.close().catch(() => {});
    }
  }

  return {
    platform: PLATFORM,
    capabilities: {
      publish: "web",
      collect: "none", // 数据采集另开单（工单：自动直发、数据采集、扫码登录都不在这一版）
      draft: true,
      visibility: [], // 草稿在手机上发布时才选可见范围，发布时不能选
      requiresQualification: false,
      assetTypes: ["video"],
    },
    /** 这一版所有抖音稿都只存草稿：core 把「自动发」当「存草稿」跑，不会走 auto_running → draft_pending 这条非法迁移。 */
    draftOnly: true,
    /** 撞上验证 / 风控后账号暂停到次日零点，core 的 publish handler 读这两项。 */
    respectsPause: true,
    pausedWhy: "抖音要你在发布机的窗口里手动过一下验证",
    lapsedPauses: () => ledger.lapsedPauses(now()),
    /** 声明：vk publish --dry-run 真的调这里的彩排（本机模拟页上走一遍并截图，真实站点只出计划）。 */
    dryRunPreview: true,
    ready() {
      const reason = driver.browserReady();
      return reason ? `抖音未配置：${reason}` : null;
    },
    check,
    publish,
  };
}

export default createAdapter();
