// YouTube Data API 配额的本地记账与暂停。
//
// 配额按 **Google Cloud 项目**（也就是用户填的 client id）计，不按频道计；每天太平洋时间（PT）午夜重置。
// 官方数字（2026-11-21 查阅，见 PR 说明）：
//   · videos.insert 有独立配额桶：默认每天 100 次，每次计 1；
//   · 其余接口共用每天 10,000 单位：videos.list / channels.list / playlists.list = 1，
//     thumbnails.set / playlistItems.insert / playlists.insert = 50，captions.insert = 400。
//   https://developers.google.com/youtube/v3/determine_quota_cost
//   https://developers.google.com/youtube/v3/getting-started
// 项目过审后额度可以申请调高：数字写进 config.json（youtube.daily_inserts / youtube.daily_units）
// 或环境变量（HIFABU_YOUTUBE_DAILY_INSERTS / HIFABU_YOUTUBE_DAILY_UNITS），不要改这里的默认值。
//
// 记账文件放在本机凭证目录里（youtube/_quota.json，权限 600），适配器不碰数据库。

import { readEnv } from "../../core/src/env.mjs";
import { createHash } from "node:crypto";
import { readConfig } from "../../core/src/config.mjs";
import { readJsonFile, writeJsonFile } from "./settings.mjs";

export const COSTS = Object.freeze({
  insert: 1, // 独立桶：计「次数」
  list: 1, // videos.list / channels.list / playlists.list
  thumbnail: 50,
  captions: 400,
  playlistItem: 50,
  playlist: 50,
});
export const DEFAULT_DAILY_INSERTS = 100;
export const DEFAULT_DAILY_UNITS = 10000;
const FILE = "youtube/_quota.json";
const TZ = "America/Los_Angeles";

const posInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
export const limits = () => {
  const c = readConfig().youtube ?? {};
  return {
    inserts: posInt(readEnv("HIFABU_YOUTUBE_DAILY_INSERTS")) ?? posInt(c.daily_inserts) ?? DEFAULT_DAILY_INSERTS,
    units: posInt(readEnv("HIFABU_YOUTUBE_DAILY_UNITS")) ?? posInt(c.daily_units) ?? DEFAULT_DAILY_UNITS,
  };
};

// ------------------------------------------------------------------ 太平洋时间

function ptParts(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, h: Number(parts.hour), m: Number(parts.minute), s: Number(parts.second) };
}

/** 现在是太平洋时间的哪一天（配额按这一天算）。 */
export const ptDay = (ms = Date.now()) => ptParts(ms).day;

/** 下一个太平洋时间 00:00 的毫秒时间戳（配额重置的时刻）。夏令时切换日有 23 / 25 小时，所以落点后再校一遍。 */
export function nextPtMidnight(ms = Date.now()) {
  const p = ptParts(ms);
  let at = ms + ((24 * 3600 - (p.h * 3600 + p.m * 60 + p.s)) * 1000);
  for (let i = 0; i < 3; i++) {
    const q = ptParts(at);
    if (q.h === 0 && q.m === 0) return at - q.s * 1000;
    at += q.h >= 12 ? (24 - q.h) * 3600e3 - (q.m * 60 + q.s) * 1000 : -(q.h * 3600e3 + q.m * 60e3 + q.s * 1000);
  }
  return at;
}

export const ptLabel = (ms) =>
  new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)) + "（太平洋时间）";

// ------------------------------------------------------------------ 记账

export const projectKey = (clientId) => createHash("sha256").update(String(clientId ?? "")).digest("hex").slice(0, 12);

const readAll = () => readJsonFile(FILE) ?? { version: 1, projects: {} };

/** 某项目今天的用量（跨日自动归零）与暂停状态。 */
export function usage(clientId, now = Date.now()) {
  const p = readAll().projects?.[projectKey(clientId)] ?? {};
  const day = ptDay(now);
  const today = p.day === day ? p : { day, inserts: 0, units: 0 };
  return { day, inserts: today.inserts ?? 0, units: today.units ?? 0, pausedUntil: p.paused_until ?? null, pausedAccounts: p.paused_accounts ?? [] };
}

function update(clientId, fn, now = Date.now()) {
  const all = readAll();
  all.projects ??= {};
  const key = projectKey(clientId);
  const cur = usage(clientId, now);
  const next = { day: cur.day, inserts: cur.inserts, units: cur.units, paused_until: cur.pausedUntil, paused_accounts: cur.pausedAccounts };
  fn(next);
  all.projects[key] = next;
  writeJsonFile(FILE, all);
  return next;
}

/** 记一次调用：insert 记次数，其余记单位。 */
export function spend(clientId, kind, now = Date.now()) {
  update(clientId, (p) => {
    if (kind === "insert") p.inserts += COSTS.insert;
    else p.units += COSTS[kind] ?? 0;
  }, now);
}

/** 一次发布大概要花多少：只数这次会发出去的步骤。 */
export function estimate({ thumbnail = false, captions = false, playlist = false } = {}) {
  const units = COSTS.list + (thumbnail ? COSTS.thumbnail : 0) + (captions ? COSTS.captions : 0) + (playlist ? COSTS.list + COSTS.playlistItem : 0);
  return { inserts: COSTS.insert, units };
}

/** 发布前预估：今天剩的配额够不够这一次。不够返回人话原因（调用方不开始上传）；够返回 null。 */
export function shortfall(clientId, need, now = Date.now()) {
  const lim = limits();
  const u = usage(clientId, now);
  const reset = nextPtMidnight(now);
  if (u.inserts + need.inserts > lim.inserts) {
    return `今天 YouTube 的上传配额不够：本机记账已上传 ${u.inserts}/${lim.inserts} 次，再传一条会超；没有开始上传。${ptLabel(reset)}重置后再发（项目过审后可以申请调高每日额度）`;
  }
  if (u.units + need.units > lim.units) {
    return `今天 YouTube 的接口配额不够：本机记账已用 ${u.units}/${lim.units} 单位，这条发布预计还要 ${need.units}；没有开始上传。${ptLabel(reset)}重置后再发`;
  }
  return null;
}

/** 接口回了 quotaExceeded：这个项目暂停到太平洋时间次日零点；记下是哪个账号撞上的，到点由 core 放开。 */
export function pauseProject(clientId, accountId, now = Date.now()) {
  const until = nextPtMidnight(now);
  update(clientId, (p) => {
    p.paused_until = until;
    p.paused_accounts = [...new Set([...(p.paused_accounts ?? []), accountId].filter(Boolean))];
  }, now);
  return until;
}

export const pausedUntil = (clientId, now = Date.now()) => {
  const until = usage(clientId, now).pausedUntil;
  return until && until > now ? until : null;
};

/** 暂停已到期：返回要放开的账号 id，并清掉记录。 */
export function lapsedPauses(clientId, now = Date.now()) {
  const u = usage(clientId, now);
  if (!u.pausedUntil || u.pausedUntil > now) return [];
  const ids = u.pausedAccounts;
  update(clientId, (p) => {
    p.paused_until = null;
    p.paused_accounts = [];
  }, now);
  return ids;
}
