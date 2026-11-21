// 后台自动更新的「读」这一半（#217）：我是哪个提交、有没有新版本、现在空闲吗、什么时候再查。
//
// 「写」这一半（下载新包、跑新包里的 install.sh、自检、退回）在 packages/cli/src/service.mjs，
// 因为它要动服务和程序目录；这里只依赖库和配置，守护进程、CLI、系统页共用同一份结果。
//
// 约束：
//   · GitHub 请求不带 token、不带任何个人信息，User-Agent 是固定的通用名；
//   · 联网失败只记日志，不抛、不弹提醒，下一轮再试；
//   · 更新只在空闲时发生：没有正在发的、没有打开的登录窗口、接下来 15 分钟内没有要发的。

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open, getMeta } from "./index.mjs";
import { readConfig, updateConfig } from "./config.mjs";

export const DEFAULT_API = "https://api.github.com/repos/versekit-labs/versekit";
export const DEFAULT_INTERVAL_HOURS = 6;
/** 接下来这段时间里有要发的，就不更新。 */
export const SOON_MS = 15 * 60e3;
/** 登录窗口开了这么久还没动静，就当它已经被丢下了（不能让一个忘关的窗口永远挡住更新）。 */
export const LOGIN_STALE_MS = 30 * 60e3;
const STATE_KEY = "update.state";

export const apiBase = (env = process.env) => (env.VERSEKIT_UPDATE_API || DEFAULT_API).replace(/\/+$/, "");

// ---------------------------------------------------------------- 我是哪个提交

const APP_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FULL_SHA = /^[0-9a-f]{40}$/;

export const shortCommit = (sha) => (sha ? String(sha).slice(0, 7) : null);

/**
 * 装好的程序自己知道自己是哪个提交：install.sh 在换上新程序之前把 `.versekit-build.json` 写进程序目录
 * （提交号来自 tarball 里被 export-subst 替换过的 install.sh，或 VERSEKIT_APP_COMMIT）。
 * 在源码仓库里跑（开发）没有这个文件，退回 `git rev-parse HEAD`，再不行就是「未知」。
 */
export function buildInfo({ root = APP_ROOT } = {}) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
  } catch {
    /* 没有就没有 */
  }
  let stamp = null;
  try {
    stamp = JSON.parse(readFileSync(`${root}.versekit-build.json`, "utf8"));
  } catch {
    /* 没有就没有 */
  }
  let commit = FULL_SHA.test(stamp?.commit ?? "") ? stamp.commit : null;
  if (!commit && !stamp && existsSync(`${root}.git`)) {
    const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (r.status === 0 && FULL_SHA.test(r.stdout.trim())) commit = r.stdout.trim();
  }
  return {
    version: pkg.version ?? "0.0.0",
    commit,
    short: shortCommit(commit),
    installedAt: stamp?.installed_at ?? null,
    fromInstall: Boolean(stamp),
  };
}

/**
 * 用户看得到的版本号只在这里拼（ACC-update-06）：`<package.json 版本>+<短提交号>`，如 `0.1.0+860ddc6`。
 * package.json 的版本很少变，光看它分不出装没装上新版；没有提交号写「+未知提交」，不假装是同一版。
 * install.sh 里有一份等价的 shell 拼法（version_label），改这里要一起改。
 */
export const displayVersion = (b = buildInfo()) => `${b.version}+${b.short ?? "未知提交"}`;

export const versionLine = (b = buildInfo()) => `${displayVersion(b)}${b.installedAt ? ` · 安装于 ${b.installedAt}` : ""}`;

// ---------------------------------------------------------------- 配置与状态

/** `config.json` 的 `update.auto`（默认开）与 `update.interval_hours`（默认 6，非法值退回默认）。 */
export function autoConfig(config = readConfig()) {
  const u = config.update ?? {};
  const h = Number(u.interval_hours);
  return {
    auto: u.auto !== false,
    intervalHours: Number.isFinite(h) && h > 0 ? h : DEFAULT_INTERVAL_HOURS,
  };
}

export function setAuto(on) {
  updateConfig({ update: { auto: Boolean(on) } });
  return autoConfig();
}

/** 上次检查、上次更新、上次失败：放在 meta 表里，不改 schema。 */
export function readState() {
  try {
    return JSON.parse(getMeta(STATE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function patchState(patch) {
  const next = { ...readState(), ...patch };
  open().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(STATE_KEY, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------- 检查

const headers = { Accept: "application/vnd.github+json", "User-Agent": "versekit-updater" };

async function getJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  return res.json();
}

/**
 * 已装提交 vs main 最新提交。返回人话 `message`；联网失败抛错（调用方决定是记日志还是报给人）。
 * `commits` 是新提交的标题（最多 5 条，新的在前），给系统页「更新了什么」用。
 */
export async function checkLatest({ current = buildInfo(), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const base = apiBase(env);
  const head = await getJson(`${base}/commits/main`, { fetchImpl });
  const latest = head?.sha;
  if (!FULL_SHA.test(latest ?? "")) throw new Error("GitHub 返回的最新提交号不对");
  const out = { current: current.commit, latest, behind: null, commits: [], upToDate: false, message: "" };
  if (current.commit === latest) {
    return { ...out, behind: 0, upToDate: true, message: "已是最新" };
  }
  if (current.commit) {
    try {
      const cmp = await getJson(`${base}/compare/${current.commit}...${latest}`, { fetchImpl });
      if (cmp.status === "identical" || cmp.ahead_by === 0) return { ...out, behind: 0, upToDate: true, message: "已是最新" };
      if (Number.isInteger(cmp.ahead_by)) out.behind = cmp.ahead_by;
      out.commits = (cmp.commits ?? [])
        .map((c) => String(c.commit?.message ?? "").split("\n")[0].trim())
        .filter(Boolean)
        .reverse()
        .slice(0, 5);
    } catch {
      /* 比不出差几个就只说「有新版本」 */
    }
  }
  out.message = out.behind != null ? `有新版本：${out.behind} 个提交` : current.commit ? "有新版本" : "有新版本（本机的提交号未知，没法数差几个）";
  return out;
}

/** 检查并记下时间与结果；联网失败也记下「上次检查失败」，但不抛。 */
export async function recordCheck(opts = {}) {
  try {
    const r = await checkLatest(opts);
    patchState({ last_check_at: Date.now(), last_check: { latest: r.latest, behind: r.behind, up_to_date: r.upToDate, message: r.message, commits: r.commits }, last_check_error: null });
    return r;
  } catch (err) {
    patchState({ last_check_error: { at: Date.now(), message: err.message } });
    throw err;
  }
}

// ---------------------------------------------------------------- 空闲判断

/**
 * 空闲 = 没有正在发布的、没有打开的登录窗口、接下来 15 分钟内没有要发的。
 * `loginsOpen` 由守护进程传入（登录会话在它的内存里）；不空闲就说清楚为什么。
 */
export function idleState({ now = Date.now(), loginsOpen = 0 } = {}) {
  const conn = open({ readonly: true });
  const running = conn.prepare("SELECT COUNT(*) AS n FROM publish WHERE state IN ('auto_running','draft_running')").get().n;
  const runningRuns = conn.prepare("SELECT COUNT(*) AS n FROM run WHERE kind = 'publish' AND state = 'running'").get().n;
  const soon = conn
    .prepare("SELECT COUNT(*) AS n FROM publish WHERE state = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= ?)")
    .get(now + SOON_MS).n;
  const reasons = [];
  if (running || runningRuns) reasons.push(`有 ${Math.max(running, runningRuns)} 条正在发布`);
  if (loginsOpen > 0) reasons.push(`有 ${loginsOpen} 个登录窗口开着`);
  if (soon) reasons.push(`接下来 15 分钟内有 ${soon} 条要发`);
  return { idle: reasons.length === 0, reasons, reason: reasons.join("；") };
}

// ---------------------------------------------------------------- 状态视图（update.status）

export function statusView({ now = Date.now() } = {}) {
  const b = buildInfo();
  const cfg = autoConfig();
  const s = readState();
  return {
    version: b.version,
    display: displayVersion(b),
    commit: b.commit,
    short: b.short,
    installedAt: b.installedAt,
    installed: b.fromInstall,
    auto: cfg.auto,
    intervalHours: cfg.intervalHours,
    lastCheckAt: s.last_check_at ?? null,
    lastCheckAgeMs: s.last_check_at ? Math.max(0, now - s.last_check_at) : null,
    lastCheck: s.last_check ?? null,
    lastCheckError: s.last_check_error ?? null,
    lastUpdate: s.last_update ?? null,
    lastFailure: s.last_failure ?? null,
    inProgress: Boolean(s.in_progress && now - (s.in_progress.since ?? 0) < 30 * 60e3),
  };
}

// ---------------------------------------------------------------- 守护进程里的定时检查

/**
 * 启动后不久查一次，之后每 `interval_hours` 小时一次；每一轮都重读配置，系统页关掉自动更新立刻生效。
 *
 * `apply()` 由调用方给（真正的更新要动服务和程序目录，在 CLI 那一层）；它必须自己脱离守护进程——
 * 更新会停掉这个守护进程。`busy()` 返回当前打开的登录窗口数。
 * 同一个目标提交失败过一次就不再自动重试它（否则每次启动都会装一遍再退一遍）。
 */
export function startAutoUpdate({ apply, busy = () => 0, log = () => {}, startDelayMs = 30e3, env = process.env, fetchImpl, now = () => Date.now() } = {}) {
  let timer = null;
  let stopped = false;

  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };

  async function tick() {
    const next = () => schedule(autoConfig().intervalHours * 3600e3);
    try {
      if (!autoConfig().auto) {
        log("[update] 自动更新已关闭，跳过检查");
        return next();
      }
      const r = await recordCheck({ fetchImpl, env });
      if (stopped) return;
      if (r.upToDate) return next();
      // 网络检查期间，用户可能已经从 CLI 或系统页关掉自动更新。
      if (!autoConfig().auto) {
        log("[update] 检查期间关闭了自动更新，跳过安装");
        return next();
      }
      const state = readState();
      if (state.last_failure?.to === r.latest) {
        log(`[update] ${shortCommit(r.latest)} 上次自动更新失败过，不再自动重试（在系统页点「现在更新」可以再试）`);
        return next();
      }
      const idle = idleState({ now: now(), loginsOpen: busy() });
      if (!idle.idle) {
        log(`[update] 有新版本（${r.message}），现在不空闲：${idle.reason}；推迟到下一次检查`);
        return next();
      }
      log(`[update] ${r.message}，空闲，开始更新到 ${shortCommit(r.latest)}`);
      await apply({ latest: r.latest });
    } catch (err) {
      // 联网失败、GitHub 限流：只记日志，不弹提醒。
      log(`[update] 检查更新没成功（${err.message}），下一轮再试`);
    }
    return next();
  }

  schedule(startDelayMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
