// Adapter and channel discovery, plus the boundary where an adapter's answer becomes database truth.
//
// Adapters are separate packages (`packages/adapter-<platform>`) so they can be versioned and
// tested on their own. The core never imports one directly — it reads the registry — which is
// what keeps "core cannot depend on an adapter" true instead of aspirational.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { open, transitionPublish, emit, enqueue } from "./index.mjs";
import { validateAdapter } from "./contract.mjs";
import { AdapterError, toAdapterError } from "./errors.mjs";
import { recordSnapshot, applyPublishResult, applyPublishError, getPublishRow, publishInputFor } from "./publish-flow.mjs";
import { nextCollectAt } from "./collect-plan.mjs";
import { publishTimeoutMs as configuredPublishTimeoutMs } from "./config.mjs";
import { LOGIN_TRACKED, takeCheckTrigger } from "./scheduler.mjs";
import { recordLogin } from "./egress.mjs";
import { computeLoginClock, loginRecords } from "./overview.mjs";
import { componentBinary } from "./components.mjs";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Loads every installed adapter. `only` restricts to some platforms (useful in tests and in
 * `vk doctor`). A broken adapter is reported, not fatal — one bad package must not stop the rest.
 */
export async function loadAdapters({ only = null, root = PACKAGES } = {}) {
  const dirs = existsSync(root)
    ? readdirSync(root).filter((d) => d.startsWith("adapter-") && existsSync(join(root, d, "package.json")))
    : [];
  const loaded = [];
  const errors = [];
  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dirPath, "package.json"), "utf8"));
    } catch (err) {
      errors.push({ dir, message: `读不到 package.json: ${err.message}` });
      continue;
    }
    const entry = pkg.exports?.["."]?.import ?? pkg.module ?? pkg.main ?? "src/index.mjs";
    try {
      const mod = await import(pathToFileURL(join(dirPath, entry)).href);
      const adapter = mod.default ?? mod.adapter;
      const info = validateAdapter(adapter, dir);
      if (only && !only.includes(info.platform)) continue;
      loaded.push(info);
    } catch (err) {
      errors.push({ dir, message: err.message });
    }
  }
  return { adapters: loaded, errors };
}

/**
 * Turns loaded adapters into runner handlers. Missing capabilities are simply not registered.
 *
 * The handlers own the state machine: an adapter never writes `publish.state`. If it did, two
 * adapters would eventually disagree about the order of "外部 id 落库" and "转 published", and the
 * difference would only show up as a publish stuck mid-flight for one platform.
 */
/**
 * 登录时长的原始记录（视频号，#275）：每次检查的结果记一条 account.check_result；登录成功（上次不是正常、
 * 或者还没有一次开着的登录）再记一条 account.login_ok。由 core 记，适配器不碰库。时间用传入的时钟，能用假时钟测。
 */
export function recordLoginCheck(account, result, { at = Date.now(), trigger = "manual", publishId = null, wasOk = true } = {}) {
  if (!account || !LOGIN_TRACKED.has(account.platform)) return;
  const base = { accountId: account.id, platform: account.platform, handle: account.handle, at };
  if (result === "ok") {
    const open_ = computeLoginClock(loginRecords(account.id), at).since != null;
    if (!wasOk || !open_) emit({ type: "account.login_ok", severity: "info", payload: { ...base, source: wasOk ? "observed" : "relogin" } });
  }
  emit({ type: "account.check_result", severity: "info", payload: { ...base, result, trigger, ...(publishId ? { publishId } : {}) } });
}

/**
 * 「账号登录成功」：出口位置要在这一刻记基线（#310、#325）。直接调 egress.recordLogin，不依赖 `vk serve`
 * 有没有在跑——命令行单独登录、网页登录、体检恢复为正常，三条路径走的都是这一处。
 * 探测失败 / 没有 IP 库时 recordLogin 不记基线（原基线保留）并留 egress.probe_failed 事件；出错也不让登录/检查失败。
 * 离线服务（vk serve --offline）不访问任何外部，调 setLoginRecording(false) 关掉；测试可用 setLoginHook 换实现。
 */
let loginHook = null;
let loginRecording = true;
export const setLoginHook = (fn) => {
  loginHook = fn ?? null;
};
export const setLoginRecording = (on) => {
  loginRecording = on !== false;
};
export async function notifyLogin(accountId, at = Date.now()) {
  if (!loginHook && !loginRecording) return;
  try {
    await (loginHook ?? recordLogin)(accountId, { at });
  } catch (err) {
    emit({ type: "egress.probe_failed", severity: "warn", payload: { code: "egress_login_probe_failed", message: `登录时记录出口位置失败：${err.message}` }, dedupeKey: `egress.login_hook:${accountId}:${Math.floor(at / 36e5)}` });
  }
}

export async function checkAccount(adapters, accountId, { now = Date.now } = {}) {
  {
    const byPlatform = new Map(adapters.map((a) => [a.platform, a]));
    let account = open().prepare("SELECT * FROM account WHERE id=?").get(accountId);
    if (!account) throw new Error(`没有这个账号：${accountId}`);
    const adapter = byPlatform.get(account.platform);
    // 定时暂停（YouTube 配额）到点了：先放开，检查结果才是账号现在真实的状态。
    if (adapter && resumeLapsedPauses(adapter).includes(accountId)) account = open().prepare("SELECT * FROM account WHERE id=?").get(accountId);
    const at = now();
    const tracked = LOGIN_TRACKED.has(account.platform);
    const why = tracked ? takeCheckTrigger(accountId) : null;
    const wasOk = account.state === "ok";
    const mark = (patch) => {
      const sets = Object.keys(patch).map((k) => `${k}=?`).join(", ");
      open().prepare(`UPDATE account SET ${sets} WHERE id=?`).run(...Object.values(patch), accountId);
    };

    if (!adapter?.adapter?.check) {
      mark({ last_checked_at: at });
      return { skipped: true, reason: `${account.platform} 适配器没有 check()`, passive_only: true };
    }

    try {
      const health = await adapter.adapter.check({ accountId });
      const states = ["ok", "expiring", "expired", "banned", "manual"];
      if (!states.includes(health?.state)) {
        throw new Error(`${account.platform} 的 check() 返回了未知状态：${JSON.stringify(health?.state)}`);
      }
      const patch = { state: health.state, last_checked_at: at };
      if (health.state === "ok") patch.last_ok_at = at;
      if (Number.isInteger(health.expiresAt)) patch.expires_at = health.expiresAt;
      mark(patch);
      // 从「没登录过 / 掉线」变成正常 = 一次新的登录成功；平时每次检查正常不算。
      if (health.state === "ok" && (!wasOk || account.last_ok_at == null)) await notifyLogin(accountId, at);
      if (tracked && ["ok", "expired"].includes(health.state)) recordLoginCheck(account, health.state, { at, trigger: why.trigger, publishId: why.publishId, wasOk });

      if (health.state !== account.state && ["expiring", "expired", "banned"].includes(health.state)) {
        emit({
          type: `account.${health.state}`,
          severity: health.state === "expiring" ? "warn" : "critical",
          payload: { accountId, platform: account.platform, handle: account.handle, detail: health.detail ?? null },
          // One card per account per state per day; a probe every six hours must not become spam.
          dedupeKey: `account:${accountId}:${health.state}:${new Date(at).toISOString().slice(0, 10)}`,
        });
      }
      return { accountId, state: health.state, detail: health.detail ?? null };
    } catch (err) {
      const error = toAdapterError(err);
      if (error.code === "auth") {
        mark({ state: "expired", last_checked_at: at });
        if (tracked) recordLoginCheck(account, "expired", { at, trigger: why.trigger, publishId: why.publishId, wasOk });
        emit({
          type: "account.expired",
          severity: "critical",
          payload: { accountId, platform: account.platform, handle: account.handle, detail: String(error.message).slice(0, 300) },
          dedupeKey: `account:${accountId}:expired:${new Date(at).toISOString().slice(0, 10)}`,
        });
      } else {
        mark({ last_checked_at: at });
      }
      throw error;
    }
  }
}

/**
 * 适配器报了「必须暂停账号」的错（TikTok 的 spam_risk_* / reached_active_user_cap）：立即暂停、推事件。
 * 不重试由错误码 platform_reject（终态）保证；这里只负责暂停与留痕。TikTok 自己的错误码写进事件。
 */
function pauseAccountFor(publishId, row, err) {
  const { code, banned } = err.pause;
  open().prepare(`UPDATE account SET is_manual = 1${banned ? ", state = 'banned'" : ""} WHERE id = ?`).run(row.account_id);
  const day = new Date().toISOString().slice(0, 10);
  const payload = {
    error_code: err.code,
    platform_error: code,
    accountId: row.account_id,
    platform: row.platform,
    handle: row.handle,
    accountPaused: true,
    message: String(err.message).slice(0, 300),
  };
  emit({ type: "publish.needs_human", severity: "critical", publishId, payload, dedupeKey: `publish:${publishId}:${code}` });
  if (banned) {
    emit({
      type: "account.banned",
      severity: "critical",
      publishId,
      payload: { accountId: row.account_id, platform: row.platform, handle: row.handle, detail: payload.message },
      dedupeKey: `account:${row.account_id}:banned:${day}`,
    });
  }
}

/**
 * 适配器报了「暂停到某个时刻」的错（YouTube 每日配额用完，到太平洋时间零点重置）：账号暂停（和 TikTok 的
 * 暂停是同一个开关 is_manual）并推事件。适配器自己记着暂停到几点；到点后 resumeLapsedPauses 放开。
 */
function pauseAccountUntil(publishId, row, err) {
  const { code, until } = err.pause;
  open().prepare("UPDATE account SET is_manual = 1 WHERE id = ?").run(row.account_id);
  emit({
    type: "publish.needs_human",
    severity: "warn",
    publishId,
    payload: {
      error_code: err.code,
      platform_error: code,
      accountId: row.account_id,
      platform: row.platform,
      handle: row.handle,
      accountPaused: true,
      pausedUntil: until,
      message: String(err.message).slice(0, 300),
    },
    dedupeKey: `publish:${publishId}:${code}`,
  });
}

/** 适配器声明的定时暂停到期了：把它们的账号放开。返回被放开的账号 id。 */
function resumeLapsedPauses(adapter) {
  if (typeof adapter.adapter.lapsedPauses !== "function") return [];
  let ids = [];
  try {
    ids = adapter.adapter.lapsedPauses() ?? [];
  } catch {
    return []; // 记账文件读不了不该挡住发布；暂停没放开只是多等一次检查
  }
  for (const id of ids) open().prepare("UPDATE account SET is_manual = 0 WHERE id = ?").run(id);
  return ids;
}

/** 适配器说「这次发出去了，但有一件事要人知道」（YouTube 把视频锁成私享）：写进平台稿，页面和卡片都读得到。 */
function recordNotice(publishId, notice) {
  open()
    .prepare("UPDATE publish SET fallback_reason = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?")
    .run(notice.code, notice.code, String(notice.message).slice(0, 500), Date.now(), publishId);
}

/** 视频已经发出去之后，缩略图、字幕、播放列表这类尽力而为的步骤没做成：不是失败，也不能静默——留事件。 */
function recordNotes(publishId, platform, notes) {
  emit({
    type: "publish.needs_followup",
    severity: "warn",
    publishId,
    payload: { kind: "notes", platform, hint: notes.join("；").slice(0, 500) },
    dedupeKey: `publish:${publishId}:notes`,
  });
}

/** 队列可以拿去调适配器的平台稿状态（白名单）。running 是租约过期后重领的情形。 */
export const RUNNABLE_PUBLISH_STATES = ["queued", "auto_running", "draft_running"];

export function buildHandlers(adapters, { log = () => {}, publishTimeoutMs = configuredPublishTimeoutMs() } = {}) {
  const byPlatform = new Map(adapters.map((a) => [a.platform, a]));
  const handlers = {};
  const timeoutMs = Number.isFinite(Number(publishTimeoutMs)) && Number(publishTimeoutMs) > 0 ? Number(publishTimeoutMs) : configuredPublishTimeoutMs();

  // The platform lives on the publish row, not on the run: the runner stays platform-agnostic.
  const platformOf = (publishId) =>
    open()
      .prepare("SELECT a.platform FROM publish p JOIN account a ON a.id = p.account_id WHERE p.id = ?")
      .get(publishId)?.platform ?? null;

  const adapterFor = (publishId) => {
    const platform = platformOf(publishId);
    if (!platform) throw new Error(`找不到发布 ${publishId}，或它的账号没有平台`);
    const adapter = byPlatform.get(platform);
    if (!adapter) throw Object.assign(
      new Error(`没有 ${platform} 适配器：这个平台的组件没装好`),
      { hint: `packages/adapter-${platform}` }, // 给命令行看的提示，页面收不到
    );
    return adapter;
  };

  if (adapters.some((a) => a.publish !== "none")) {
    handlers.publish = async (run) => {
      const publishId = run.target_id;
      const adapter = adapterFor(publishId);
      const row = getPublishRow(publishId);
      if (!row) throw new Error(`找不到发布：${publishId}`);

      // 红线第二道防线（#146）：白名单，不是黑名单。只有已经被人确认、在队列里（或租约过期重领时
      // 还停在 running）的平台稿才往下走；待确认、先不发、已取消以及以后新增的任何状态都不调适配器。
      // 第一道防线是「待确认的平台稿根本不排 run」；这里兜住遗留的或误排的 run。不静默：留事件。
      if (!RUNNABLE_PUBLISH_STATES.includes(row.state)) {
        const message = `平台稿 ${publishId} 现在是 ${row.state}，不在可发状态（${RUNNABLE_PUBLISH_STATES.join(" / ")}）：没有调用适配器${row.state === "pending_confirm" ? "，等人确认后才会发" : ""}`;
        emit({
          type: "publish.not_runnable",
          severity: "warn",
          publishId,
          payload: { error_code: "not_runnable", state: row.state, runId: run.id, message },
          dedupeKey: `run:${run.id}:not_runnable`,
        });
        log(`[publish] ${message}`);
        return { skipped: true, state: row.state, error_code: "not_runnable" };
      }

      // 暂停中的账号不再发（#143）：TikTok 判了 spam_risk_* / 活跃用户上限后，账号已被暂停；
      // 队列里同账号的其他平台稿不能绕过暂停继续往外发。不静默：转「待人处理」并留事件。
      if (adapter.adapter.respectsPause) {
        resumeLapsedPauses(adapter);
        const acc = open().prepare("SELECT is_manual FROM account WHERE id = ?").get(row.account_id);
        if (acc?.is_manual) {
          const message = `账号 ${row.handle} 已被暂停自动发布（${adapter.adapter.pausedWhy ?? "TikTok 风控或用户上限"}）：这条没有发；确认没问题后到系统页恢复自动发布，再重新确认`;
          transitionPublish(publishId, "notify_pending", { reason: "account_paused", patch: { fallback_reason: "risk_control", error_message: message.slice(0, 500) } });
          emit({
            type: "publish.needs_human",
            severity: "warn",
            publishId,
            payload: { error_code: "account_paused", accountId: row.account_id, message },
            dedupeKey: `publish:${publishId}:account_paused`,
          });
          return { state: "notify_pending", error: "account_paused" };
        }
      }

      // notify / manual are choices, not failures: the person asked to be told, so tell them.
      if (row.mode === "notify") {
        if (row.state === "queued") transitionPublish(publishId, "notify_pending", { reason: "notify_mode" });
        return { state: "notify_pending" };
      }

      // 只能存草稿的平台（视频号、抖音第一版）：auto 模式的平台稿也按草稿跑——到草稿箱为止，发表由人在手机上点。
      // 把 mode 写回库（而不是只改局部变量）：重试、界面和事件看到的都是 draft，不会出现库里 auto、实际按草稿跑的两种说法。
      // auto_running 之后拿到 draft_pending 会撞非法迁移，所以必须在迁移前改。
      if (adapter.adapter.draftOnly && row.mode === "auto") {
        open().prepare("UPDATE publish SET mode = 'draft' WHERE id = ?").run(publishId);
        row.mode = "draft";
      }

      // Draft requested but the platform has no draft box: say so, do not pretend to try.
      if (row.mode === "draft" && adapter.draft !== true) {
        if (row.state === "queued") transitionPublish(publishId, "draft_running");
        transitionPublish(publishId, "notify_pending", {
          reason: "no_upload_path",
          patch: { fallback_reason: "no_upload_path" },
        });
        return { state: "notify_pending", fallback: "no_upload_path" };
      }

      if (adapter.platform === "bilibili" && !componentBinary("biliup")) {
        const error = new AdapterError("component_missing");
        applyPublishError(publishId, error);
        throw error;
      }

      const running = row.mode === "draft" ? "draft_running" : "auto_running";
      if (row.state === "queued") transitionPublish(publishId, running);

      // 发布总时限（ACC-publish-05）：适配器可能永远不返回（页面停在「上传视频」，文件根本
      // 没上传）。这里给整次发布一个硬截止时间：到点先中止适配器（它据此关掉浏览器），再把
      // error_code=timeout 落到 failed——任何发布都不允许无限停在 auto_running。
      const progress = { step: null };
      const controller = new AbortController();
      let timer = null;
      let input;
      const runAdapter = Promise.resolve().then(() => {
        // 素材路径由 core 按平台稿的语言版本解析后传入（ACC-v2-confirm-07）。
        input = publishInputFor(publishId, {
          signal: controller.signal,
          // 适配器边跑边报「现在停在哪一步」，超时文案才能说人话，而不是一句「出错了」。
          onStep: (step) => {
            if (step) progress.step = String(step).slice(0, 80);
          },
        });
        return adapter.adapter.publish(input);
      });
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const seconds = Math.max(1, Math.round(timeoutMs / 1000));
          const span = seconds >= 90 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
          const where = progress.step ? `停在「${progress.step}」` : "还没进入具体步骤";
          try {
            controller.abort();
          } catch {
            /* 适配器没监听 signal：至少发布行会落到 failed，不会无声卡住 */
          }
          reject(new AdapterError("timeout", `发布超过 ${span}没有结果（${where}）：已中止并关闭浏览器，可以重试`));
        }, timeoutMs);
        // 不 unref：这个定时器就是「发布总时限」本身，唯一的 goroutine 如果只剩它，进程也该
        // 等到它触发后再退，而不是让发布悄悄消失。finally 里一定会 clearTimeout。
      });

      try {
        const result = await Promise.race([runAdapter, deadline]);
        if (result?.dryRun) return result;
        const applied = applyPublishResult(publishId, result, input);
        if (result?.notice?.code) recordNotice(publishId, result.notice);
        if (Array.isArray(result?.notes) && result.notes.length) recordNotes(publishId, adapter.platform, result.notes);
        // 选了「送草稿箱」不是失败也不是降级：说清楚下一步在 TikTok 收件箱里发。
        if (result?.state === "draft_pending" && result.note) {
          emit({
            type: "publish.needs_human",
            severity: "info",
            publishId,
            payload: { kind: "draft_sent", platform: adapter.platform, message: String(result.note).slice(0, 300) },
            dedupeKey: `publish:${publishId}:draft_sent`,
          });
        }
        return applied;
      } catch (err) {
        if (err?.pause?.until) pauseAccountUntil(publishId, row, err);
        else if (err?.pause) pauseAccountFor(publishId, row, err);
        // 视频号发布途中落到二维码页（auth）：同样记一次「过期」，登录时长才算得准。
        if (LOGIN_TRACKED.has(row.platform) && toAdapterError(err).code === "auth") {
          const acct = open().prepare("SELECT * FROM account WHERE id = ?").get(row.account_id);
          recordLoginCheck(acct, "expired", { trigger: "publish", publishId, wasOk: acct?.state === "ok" });
        }
        const disposition = applyPublishError(publishId, err);
        // 适配器给了平台自己的错误码（uploadLimitExceeded、视频被拒、预估配额不够……）：留一条带原码的事件，
        // 光有 error_code=platform_reject 分不清是哪一种。暂停类已在上面单独发过事件。
        if (err?.platformCode && !err.pause?.until && ["platform_reject", "result_unconfirmed"].includes(err.code)) {
          emit({
            type: "publish.needs_human",
            severity: "warn",
            publishId,
            payload: { error_code: err.code, platform_error: err.platformCode, platform: row.platform, handle: row.handle, message: String(err.message).slice(0, 300) },
            dedupeKey: `publish:${publishId}:${err.platformCode}`,
          });
        }
        if (disposition.retryable) throw toAdapterError(err);
        // 超时还要把 run 标成失败：任务页靠 run.state=failed 显示这条错误并给出「重试」入口。
        // 其他终态失败（auth / asset_invalid …）已有对应状态与人话，run 正常结束即可。
        if (["timeout", "component_missing"].includes(disposition.code)) throw toAdapterError(err);
        // Terminal or already handed to a human: the run is done, the row carries the reason.
        log(`[publish] ${adapter.platform} ${publishId} 失败（${disposition.code}），不再重试`);
        return { state: getPublishRow(publishId)?.state, error: disposition.code };
      } finally {
        clearTimeout(timer);
        // 超时后适配器可能还在收尾；它的 rejection 不能在别处冒成 unhandled。
        runAdapter.catch(() => {});
      }
    };
  }

  if (adapters.some((a) => a.collect !== "none")) {
    handlers.collect = async (run) => {
      const publishId = run.target_id;
      const adapter = adapterFor(publishId);
      if (adapter.collect === "none") throw new Error(`${adapter.platform} 还没有指标采集`);
      try {
        const result = await adapter.adapter.collect({ publishId });
        const snap = recordSnapshot({
          publishId,
          source: result.source,
          status: result.status,
          metrics: result.metrics,
          capturedAt: result.capturedAt ?? Date.now(),
        });

        // 排下一个采集点：前密后疏，30 天封顶。失败不排——这一次的 run 会先重试。
        const row = getPublishRow(publishId);
        const next = row?.published_at ? nextCollectAt(row.published_at) : null;
        if (next && next > Date.now()) {
          enqueue({ kind: "collect", targetType: "publish", targetId: publishId, lane: row.account_id, priority: 200, runAfter: next });
        }
        return snap;
      } catch (err) {
        const error = toAdapterError(err);
        const row = getPublishRow(publishId);
        if (error.code === "auth" && row) {
          open().prepare("UPDATE account SET state='expired' WHERE id=?").run(row.account_id);
        }
        emit({
          type: "collect.degraded",
          severity: error.code === "auth" ? "critical" : "warn",
          publishId,
          payload: { platform: adapter.platform, code: error.code, message: String(error.message).slice(0, 300) },
          // One card per publish per hour per reason — a flaky selector must not become a stream.
          dedupeKey: `collect:${publishId}:${error.code}:${new Date().toISOString().slice(0, 13)}`,
        });
        throw error;
      }
    };
  }
  // Health checks target an account, not a publish, so this handler exists even when no adapter
  // implements check(): the run then records "probed, but this platform cannot be probed".
  handlers.check = (run) => checkAccount(adapters, run.target_id);

  return handlers;
}
