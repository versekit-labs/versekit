// 平台排期规则：每个账号每日上限、两条之间的最小间隔（ACC-v2-confirm-06）。
//
// 默认值由所有者定（2026-11-15）：每个平台、每个账号每日 10 条，最小间隔 10 分钟，所有平台同一组。
// 数字只在 DEFAULT_PLAN_RULES 里出现一次；要改写进 config.json，可按平台覆盖：
//   { "plan": { "rules": { "default": { "daily_cap": 10, "min_gap_minutes": 10 },
//                          "platforms": { "xiaohongshu": { "daily_cap": 3, "min_gap_minutes": 60 } } } } }
// 配错的值（非正整数）退回默认，不会变成「不限制」。
//
// 「一天」按本机时区的自然日算。同一个账号下，除自己之外已排的平台稿（待确认、已确认等时间、
// 在发、已发）都占名额；先不发、已取消、失败、阻塞、过期的不占。

import { open } from "./index.mjs";
import { readConfig } from "./config.mjs";

export const DEFAULT_PLAN_RULES = Object.freeze({ daily_cap: 10, min_gap_minutes: 10 });

/** 不占名额的状态：人没打算发，或已经没发出去。 */
export const SLOT_FREE_STATES = ["skipped", "canceled", "failed", "blocked", "expired"];

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** 某平台生效的规则：平台覆盖 > 配置里的 default > 内置默认。返回 { dailyCap, minGapMs, minGapMinutes }。 */
export function planRules(platform, config = readConfig()) {
  const rules = config?.plan?.rules ?? {};
  const pick = (key) =>
    posInt(rules.platforms?.[platform]?.[key]) ?? posInt(rules.default?.[key]) ?? DEFAULT_PLAN_RULES[key];
  const dailyCap = pick("daily_cap");
  const minGapMinutes = pick("min_gap_minutes");
  return { dailyCap, minGapMinutes, minGapMs: minGapMinutes * 60e3 };
}

const dayStart = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const nextDayStart = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

/**
 * 纯函数：时间 `at` 在已占用时间 `taken`（毫秒数组）旁边合不合规则。
 * 返回 null 表示合规，否则 { reason: "daily_cap" | "min_gap", ... }。
 */
export function violationAt(at, taken, { dailyCap, minGapMs }) {
  const near = taken.filter((t) => Math.abs(t - at) < minGapMs);
  if (near.length) return { reason: "min_gap", conflictAt: near.sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0] };
  const from = dayStart(at);
  const to = nextDayStart(at);
  const sameDay = taken.filter((t) => t >= from && t < to).length;
  if (sameDay >= dailyCap) return { reason: "daily_cap", count: sameDay };
  return null;
}

/**
 * 纯函数：离 `at` 最近、晚于 `now` 且满足两条规则的时间（离得一样远取晚的）。
 * 可行区间的边界只会是「别的时间 ± 最小间隔」或自然日的边界，所以只试这些点。
 */
export function nearestAvailable(at, taken, rules, now = Date.now()) {
  const days = Math.ceil((taken.length + 1) / rules.dailyCap) + 2;
  const candidates = new Set([at]);
  for (const t of taken) {
    candidates.add(t + rules.minGapMs);
    candidates.add(t - rules.minGapMs);
  }
  let d = dayStart(at);
  for (let i = 0; i < days; i++) {
    candidates.add(d);
    candidates.add(d - 1);
    d = nextDayStart(d);
  }
  d = dayStart(at);
  for (let i = 0; i < days; i++) {
    d = dayStart(d - 1);
    candidates.add(d);
    candidates.add(d - 1);
  }
  let best = null;
  for (const c of candidates) {
    if (c <= now || violationAt(c, taken, rules)) continue;
    if (best == null || Math.abs(c - at) < Math.abs(best - at) || (Math.abs(c - at) === Math.abs(best - at) && c > best)) best = c;
  }
  return best;
}

/** 这个账号上除 `excludePublishId` 外已占名额的时间点。 */
export function takenTimes(accountId, excludePublishId) {
  const placeholders = SLOT_FREE_STATES.map(() => "?").join(",");
  return open()
    .prepare(
      `SELECT COALESCE(published_at, scheduled_at) AS t FROM publish
        WHERE account_id = ? AND id != ? AND state NOT IN (${placeholders})
          AND COALESCE(published_at, scheduled_at) IS NOT NULL`,
    )
    .all(accountId, excludePublishId, ...SLOT_FREE_STATES)
    .map((r) => r.t);
}

const fmt = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * publish.edit 改时间前调用：违规就抛错，信息里带最近的可用时间；错误对象上有 code、suggestedAt。
 * `row` 是 store.getPublish 的结果（要有 id、account_id、platform）。
 */
export function assertPlanSlot(row, at, { now = Date.now(), config } = {}) {
  const rules = planRules(row.platform, config);
  const taken = takenTimes(row.account_id, row.id);
  const v = violationAt(at, taken, rules);
  if (!v) return { ok: true, rules };
  const suggestedAt = nearestAvailable(at, taken, rules, now);
  const why =
    v.reason === "daily_cap"
      ? `${row.platform} 这个账号那天已经排了 ${v.count} 条，每日上限 ${rules.dailyCap} 条`
      : `和 ${fmt(v.conflictAt)} 那条隔得太近，最小间隔 ${rules.minGapMinutes} 分钟`;
  const hint = suggestedAt != null ? `最近的可用时间：${fmt(suggestedAt)}（--at ${new Date(suggestedAt).toISOString()}）` : "近期没有可用时间";
  const err = new Error(`改的时间违反平台规则：${why}。${hint}`);
  err.code = v.reason === "daily_cap" ? "plan_daily_cap" : "plan_min_gap";
  err.suggestedAt = suggestedAt;
  throw err;
}
