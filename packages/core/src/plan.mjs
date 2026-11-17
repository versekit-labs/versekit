// 发布方案（ACC-v2-sys-08）：每个账号组一份，「成片类型 · 语言 → 发到哪些平台 → 节奏」。
//
// 行 = { kind: "video" | "image" | "*", language: "<语言>" | "*", platforms: [平台...], delayDays: 0.. }
// 没存过方案时用默认方案：所有成片、所有语言，发到组里所有已接入的平台，尽快（与改动前的 plan.apply 一致）。
// 命中规则：越具体越优先——(类型, 语言) > (类型, *) > (*, 语言) > (*, *)。

import { copyPlatformOf } from "./store.mjs";

export const PLAN_KINDS = ["video", "image", "*"];
export const KIND_LABEL = { video: "视频", image: "图片", "*": "成片" };
const LANGUAGE_LABEL = { zh: "中文", en: "English", ja: "日本語", ko: "한국어", default: "默认语言", "*": "所有语言" };
export const MAX_DELAY_DAYS = 60;

export const languageLabel = (l) => LANGUAGE_LABEL[l] ?? l;
export const rowLabel = (row) => `${KIND_LABEL[row.kind] ?? row.kind} · ${languageLabel(row.language)}`;
export const rhythmLabel = (delayDays) => (delayDays > 0 ? `入库后第 ${delayDays} 天起排` : "尽快：入库后马上排最近的可用时间");

/** 默认方案：platforms 为 null 表示「组里所有已接入的平台」。 */
export const DEFAULT_ROW = Object.freeze({ kind: "*", language: "*", platforms: null, delayDays: 0 });

export function normalizeRows(rows) {
  return (rows ?? []).map((r) => ({
    kind: PLAN_KINDS.includes(r.kind) ? r.kind : "*",
    language: String(r.language || "*"),
    platforms: Array.isArray(r.platforms) ? r.platforms : null,
    delayDays: Number.isInteger(r.delayDays) && r.delayDays > 0 ? r.delayDays : 0,
  }));
}

/** 这支成片（素材类型 kind、语言 language）该用方案里的哪一行；没有命中返回 null。 */
export function matchRow(rows, { kind, language }) {
  const score = (r) => {
    if ((r.kind !== "*" && r.kind !== kind) || (r.language !== "*" && r.language !== language)) return -1;
    return (r.kind === "*" ? 0 : 2) + (r.language === "*" ? 0 : 1);
  };
  let best = null;
  let bestScore = -1;
  for (const r of rows) {
    const s = score(r);
    if (s > bestScore) [best, bestScore] = [r, s];
  }
  return best;
}

/** 方案行里的平台是否覆盖这个账号（tiktok 与 tiktok-api 算同一个对人展示的平台）。 */
export const rowCovers = (row, account) =>
  row.platforms == null || row.platforms.some((p) => copyPlatformOf(p) === copyPlatformOf(account.platform));
