// 后台自动更新：检查正式发版、校验下载、判断是否空闲。
//
// 安装、自检与退回由 packages/cli/src/service.mjs 负责。
//
// 约束：
//   · 下载请求不带 token、不带任何个人信息，User-Agent 是固定的通用名；
//   · 联网失败只记日志，不抛、不弹提醒，下一轮再试；
//   · 更新只在空闲时发生：没有正在发的、没有打开的登录窗口、接下来 15 分钟内没有要发的。

import { readEnv } from "./env.mjs";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { open, getMeta } from "./index.mjs";
import { readConfig, updateConfig } from "./config.mjs";

export const DEFAULT_API = "https://hifabu.com/download";
export const DEFAULT_INTERVAL_HOURS = 6;
/** 接下来这段时间里有要发的，就不更新。 */
export const SOON_MS = 15 * 60e3;
/** 登录窗口开了这么久还没动静，就当它已经被丢下了（不能让一个忘关的窗口永远挡住更新）。 */
export const LOGIN_STALE_MS = 30 * 60e3;
const STATE_KEY = "update.state";

export function apiBase(env = process.env) {
  const override = readEnv("HIFABU_UPDATE_API", env);
  if (!override) return DEFAULT_API;
  const base = new URL(override);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" ||
      base.username || base.password || base.search || base.hash) {
    throw new Error("测试更新源必须是本地 HTTP 地址，且不能包含凭证、查询参数或片段");
  }
  return base.href.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- 我是哪个提交

const APP_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FULL_SHA = /^[0-9a-f]{40}$/;

export const shortCommit = (sha) => (sha ? String(sha).slice(0, 7) : null);

/**
 * 装好的程序自己知道自己是哪个提交：install.sh 在换上新程序之前把 `.versekit-build.json` 写进程序目录
 * （提交号来自 tarball 里被 export-subst 替换过的 install.sh，或 HIFABU_APP_COMMIT）。
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

const headers = { "User-Agent": "versekit-updater" };
const SHA256 = /^[0-9a-f]{64}$/;
// 与发布脚本接受的 SemVer 一致。
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const INTEGER = /^[0-9]+$/;

function isNewer(latest, current) {
  if (!current) return true;
  for (let i = 1; i <= 3; i++) {
    if (latest[i] !== current[i]) return BigInt(latest[i]) > BigInt(current[i]);
  }
  if (!current[4]) return false;
  if (!latest[4]) return true;
  const next = latest[4].split(".");
  const installed = current[4].split(".");
  for (let i = 0; i < Math.min(next.length, installed.length); i++) {
    if (next[i] === installed[i]) continue;
    const nextNumeric = INTEGER.test(next[i]);
    const installedNumeric = INTEGER.test(installed[i]);
    if (nextNumeric && installedNumeric) return BigInt(next[i]) > BigInt(installed[i]);
    if (nextNumeric !== installedNumeric) return !nextNumeric;
    return next[i] > installed[i];
  }
  return next.length > installed.length;
}

export class ReleaseDownloadError extends Error {}
export class ReleaseIntegrityError extends Error {}

async function downloadWithRetries(url, { fetchImpl, timeoutMs, requestHeaders, sha256, size }) {
  let chunks = [];
  let offset = 0;
  let canResume = false;
  let etag;
  const reset = () => { chunks = []; offset = 0; canResume = false; etag = undefined; };

  for (let attempt = 0; ; attempt++) {
    if (!canResume) reset();
    const request = { ...requestHeaders, "Accept-Encoding": "identity" };
    if (offset) {
      request.Range = `bytes=${offset}-`;
      if (etag) request["If-Range"] = etag;
    }
    try {
      const res = await fetchImpl(url, {
        headers: request, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        if (res.status === 416) reset();
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      const encoding = res.headers.get("content-encoding");
      const identity = !encoding || encoding.toLowerCase() === "identity";
      let rangeEnd;
      let total;
      if (res.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
        const [start, end, length] = range?.slice(1).map(Number) ?? [];
        if (!offset || !identity || start !== offset || end < start || end >= length || !Number.isSafeInteger(length)) {
          reset();
          await res.body?.cancel();
          throw new Error("续传响应的 Content-Range 无效");
        }
        rangeEnd = end + 1;
        total = length;
      } else {
        reset();
        const tag = res.headers.get("etag");
        etag = tag?.startsWith('"') ? tag : undefined;
        // 没有锁定哈希的文件需要强 ETag，避免把两个版本的字节拼在一起。
        canResume = identity && Boolean(sha256 || etag);
      }
      if (res.body) {
        for await (const chunk of res.body) {
          offset += chunk.length;
          if (size !== undefined && offset > size) throw new ReleaseIntegrityError("下载文件大于清单所列大小");
          if (rangeEnd !== undefined && offset > rangeEnd) {
            reset();
            throw new Error("续传响应超过 Content-Range 的长度");
          }
          chunks.push(chunk);
        }
      }
      if (rangeEnd !== undefined && offset !== total) throw new Error("续传响应未传完");
      return Buffer.concat(chunks, offset);
    } catch (err) {
      if (err instanceof ReleaseIntegrityError || attempt === 5) throw err;
      await delay(2000);
    }
  }
}

/** 下载同一份发布文件；校验失败时丢弃全部字节，再从头下载一次。 */
export async function downloadReleaseFile(url, { fetchImpl = globalThis.fetch, timeoutMs, requestHeaders, sha256, size }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const bytes = await downloadWithRetries(url, { fetchImpl, timeoutMs, requestHeaders, sha256, size });
      if ((size !== undefined && bytes.length !== size) ||
          (sha256 && createHash("sha256").update(bytes).digest("hex") !== sha256)) {
        throw new ReleaseIntegrityError("SHA-256 校验不通过");
      }
      return bytes;
    } catch (err) {
      if (!(err instanceof ReleaseIntegrityError) || attempt === 1) throw err;
    }
  }
}

async function download(base, file, fetchImpl, timeoutMs = 15000, sha256) {
  try {
    return await downloadReleaseFile(`${base}/${file}`, { fetchImpl, timeoutMs, requestHeaders: headers, sha256 });
  } catch (err) {
    if (err instanceof ReleaseIntegrityError) throw new Error(`${file} 的 SHA-256 校验不通过`);
    throw new ReleaseDownloadError(`下载新版本失败：${file}（${err.message}）`);
  }
}

function parseJson(bytes, file) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${file} 的 JSON 格式无效`);
  }
}

function checksum(sums, name) {
  const matches = sums.toString("utf8").split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 2 && fields[1] === name);
  if (matches.length !== 1 || !SHA256.test(matches[0][0])) {
    throw new Error(`SHA256SUMS 中缺少 ${name} 的唯一有效 SHA-256`);
  }
  return matches[0][0];
}

/** 先把版本指针与同一版的清单对上，再提供该版经过校验的安装脚本。 */
export async function inspectRelease({ current = buildInfo(), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const base = apiBase(env);
  const latest = parseJson(await download(base, "latest.json", fetchImpl), "latest.json");
  const version = latest?.version;
  const parsed = typeof version === "string" && SEMVER.exec(version);
  if (!parsed || latest.manifest !== `${version}/manifest.json` ||
      typeof latest.sha256 !== "string" || !SHA256.test(latest.sha256)) {
    throw new Error("latest.json 的版本指针无效");
  }

  const sums = await download(base, `${version}/SHA256SUMS`, fetchImpl);
  if (checksum(sums, "manifest.json") !== latest.sha256) {
    throw new Error("SHA256SUMS 中 manifest.json 的 SHA-256 与 latest.json 不符");
  }
  const manifestBytes = await download(base, latest.manifest, fetchImpl, undefined, latest.sha256);
  const manifest = parseJson(manifestBytes, "manifest.json");
  if (manifest?.schema !== "hifabu.release/1" || manifest.version !== version ||
      typeof manifest.commit !== "string" || !FULL_SHA.test(manifest.commit) || typeof manifest.notes !== "string") {
    throw new Error("manifest.json 的版本信息无效");
  }
  const upToDate = !isNewer(parsed, SEMVER.exec(current.version));
  const check = {
    current: current.commit, latest: manifest.commit, behind: upToDate ? 0 : null, commits: [],
    upToDate, message: upToDate ? "已是最新" : `有新版本：${version}`,
    latestVersion: version, notes: manifest.notes,
  };
  return {
    check,
    async downloadInstaller() {
      const expected = checksum(sums, "install.sh");
      return download(base, `${version}/install.sh`, fetchImpl, 120e3, expected);
    },
  };
}

export async function checkLatest(opts) {
  return (await inspectRelease(opts)).check;
}

/** 检查并记下时间与结果；检查失败由调用方处理。 */
export async function recordCheck(opts = {}) {
  try {
    const r = await checkLatest(opts);
    patchState({ last_check_at: Date.now(), last_check: { latest: r.latest, behind: r.behind, up_to_date: r.upToDate, message: r.message, commits: r.commits, latestVersion: r.latestVersion, notes: r.notes }, last_check_error: null });
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

function installedReleaseNotes(build) {
  if (!build.fromInstall) return null;
  try {
    const release = JSON.parse(readFileSync(`${APP_ROOT}release-manifest.json`, "utf8"));
    return release.schema === "hifabu.release/1" && release.version === build.version &&
      release.commit === build.commit && typeof release.notes === "string" ? release.notes : null;
  } catch {
    return null; // 旧安装没有版本清单。
  }
}

export function statusView({ now = Date.now() } = {}) {
  const b = buildInfo();
  const cfg = autoConfig();
  const s = readState();
  return {
    version: b.version,
    notes: installedReleaseNotes(b),
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
        log(`[update] ${r.latestVersion} 上次自动更新失败过，不再自动重试（在系统页点「现在更新」可以再试）`);
        return next();
      }
      const idle = idleState({ now: now(), loginsOpen: busy() });
      if (!idle.idle) {
        log(`[update] ${r.message}，现在不空闲：${idle.reason}；推迟到下一次检查`);
        return next();
      }
      log(`[update] ${r.message}，空闲，开始更新`);
      await apply({ latest: r.latest });
    } catch (err) {
      // 检查失败只记日志，下一轮再试。
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
