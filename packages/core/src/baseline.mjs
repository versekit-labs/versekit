// 「和平时比」：一条发布 24 小时的播放，相当于这个账号平时的几倍（ACC-v2-base-01）。
//
//   倍数 = 这条发布 24 小时的播放 ÷ 同一个账号最近 20 条发布 24 小时播放的中位数
//
// 口径（写死在这里，Web 和卡片只读结果，不再各算一遍）：
//  · 「平时」只看**同一个账号**——账号只属于一个平台，所以不同平台的播放数永远不会相加或互相比较。
//  · 「最近 20 条」= 这条发布**之前**发布的、已经有 24 小时播放的发布（不含它自己，否则它会拉动自己的基线）。
//  · 24 小时播放 = 发布后 24 小时（含 1 分钟误差）起、容忍窗口内的第一张快照里的 play（没有就用 views）。
//    只在 +7d 才采过一次的，那是七天的数，不冒充 24 小时，这条就不参与基线。
//  · 历史不足 5 条不给倍数，只说历史还差几条；平时的中位数是 0 也不给（除以 0 没有意义）。
//  · 2 倍及以上 =「比平时好」，一半及以下 =「比平时差」；阈值与窗口、最少条数都可以在 config.json 的 baseline 里改。

import { open } from "./index.mjs";
import { readConfig } from "./config.mjs";

export const DAY_MS = 24 * 3600e3;
/** 采集晚了几分钟不该让 +24h 的快照落选。 */
const EARLY_GRACE_MS = 60e3;
/** 24 小时那张快照最晚可以晚多久；再晚就是别的时间点的数，不当 24 小时用。 */
export const PLAY24H_TOLERANCE_MS = 6 * 3600e3;

export const BASELINE_DEFAULTS = { window: 20, minHistory: 5, good: 2, bad: 0.5 };

const positive = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/** config.json 的 `baseline: { window, min_history, good, bad }`；配错的值退回默认，不变成「永远不给」或「永远给」。 */
export function baselineConfig() {
  const raw = readConfig().baseline ?? {};
  const cfg = {
    window: Math.floor(positive(raw.window, BASELINE_DEFAULTS.window)),
    minHistory: Math.floor(positive(raw.min_history ?? raw.minHistory, BASELINE_DEFAULTS.minHistory)),
    good: positive(raw.good, BASELINE_DEFAULTS.good),
    bad: positive(raw.bad, BASELINE_DEFAULTS.bad),
  };
  return cfg;
}

export const VERDICT_LABEL = { better: "比平时好", worse: "比平时差", normal: "和平时差不多" };

const playOf = (metricsJson) => {
  try {
    const m = JSON.parse(metricsJson);
    const v = Number(m?.play ?? m?.views);
    return Number.isFinite(v) && (m?.play != null || m?.views != null) ? v : null;
  } catch {
    return null;
  }
};

/** 一条发布 24 小时的播放；没有合格的快照返回 null。 */
export function play24hOf(publishId, publishedAt) {
  if (!publishId || !Number.isFinite(Number(publishedAt))) return null;
  const from = Number(publishedAt) + DAY_MS - EARLY_GRACE_MS;
  const row = open()
    .prepare(
      `SELECT metrics_json FROM snapshot
        WHERE publish_id = ? AND captured_at >= ? AND captured_at <= ?
        ORDER BY captured_at ASC LIMIT 1`,
    )
    .get(publishId, from, Number(publishedAt) + DAY_MS + PLAY24H_TOLERANCE_MS);
  return row ? playOf(row.metrics_json) : null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** 这个账号已发布的发布（时间从新到旧）及各自的 24 小时播放，只留有数的。 */
function accountHistory(accountId) {
  const rows = open()
    .prepare(
      `SELECT id, published_at FROM publish
        WHERE account_id = ? AND published_at IS NOT NULL AND state IN ('published','published_limited')
        ORDER BY published_at DESC, id`,
    )
    .all(accountId);
  const out = [];
  for (const r of rows) {
    const play = play24hOf(r.id, r.published_at);
    if (play != null) out.push({ publishId: r.id, publishedAt: r.published_at, play });
  }
  return out;
}

/**
 * 一条发布和平时比。`history` 可由调用方按账号缓存传入（一次列表里同一账号不重复查库）。
 * 永远返回同一形状：没有倍数时 multiple 为 null，reason 说清为什么。
 */
export function baselineFor({ publishId, accountId, publishedAt }, { config = baselineConfig(), history = null } = {}) {
  const all = history ?? accountHistory(accountId);
  const own = all.find((h) => h.publishId === publishId)?.play ?? play24hOf(publishId, publishedAt);
  const prior = all
    .filter((h) => h.publishId !== publishId && (publishedAt == null || h.publishedAt <= publishedAt))
    .slice(0, config.window);
  const base = {
    play24h: own,
    baselineMedian: null,
    historyCount: prior.length,
    multiple: null,
    verdict: null,
    verdictLabel: null,
    reason: null,
  };

  if (own == null) return { ...base, reason: "还没有满 24 小时的播放数据" };
  if (prior.length < config.minHistory) {
    return { ...base, reason: `这个账号历史不足 ${config.minHistory} 条（现在 ${prior.length} 条），先不比` };
  }
  const med = median(prior.map((h) => h.play));
  if (!(med > 0)) return { ...base, baselineMedian: med, reason: "这个账号平时的播放中位数是 0，没法比" };

  const multiple = round2(own / med);
  const verdict = multiple >= config.good ? "better" : multiple <= config.bad ? "worse" : "normal";
  return { ...base, baselineMedian: med, multiple, verdict, verdictLabel: VERDICT_LABEL[verdict] };
}

/** 给一批带 accountId 的发布行补 baseline；按账号缓存历史。 */
export function withBaselines(rows) {
  const config = baselineConfig();
  const cache = new Map();
  const historyOf = (accountId) => {
    if (!cache.has(accountId)) cache.set(accountId, accountHistory(accountId));
    return cache.get(accountId);
  };
  return rows.map((row) => ({
    ...row,
    baseline: baselineFor(row, { config, history: historyOf(row.accountId) }),
  }));
}
