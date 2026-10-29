// When to take the next snapshot (ARCHITECTURE §9.1).
//
// The cadence is front-loaded because that is when the curve is worth looking at: +1h, +6h,
// +24h, +3d, +7d, then daily until 30 days. It is a pure function of (published_at, now) so the
// schedule survives restarts and does not need a per-publish cursor in the database — a manual
// collection at 2h must not shift the 6h point.

export const COLLECT_OFFSETS = [3600e3, 6 * 3600e3, 24 * 3600e3, 3 * 24 * 3600e3, 7 * 24 * 3600e3];
export const DAILY_MS = 24 * 3600e3;
export const COLLECT_WINDOW_MS = 30 * DAILY_MS;

// A collection that runs a few milliseconds late must not make the next offset look "already
// passed" and skip from 1h straight to 6h.
const GRACE_MS = 60e3;

/**
 * Next capture time for a publish, or null when the 30-day window is over.
 * `now` is injectable so the rule can be tested without waiting three days.
 */
export function nextCollectAt(publishedAt, now = Date.now()) {
  if (!Number.isFinite(publishedAt) || publishedAt <= 0) return null;
  const age = now - publishedAt;
  if (age > COLLECT_WINDOW_MS) return null;

  for (const offset of COLLECT_OFFSETS) {
    if (offset > age + GRACE_MS) return publishedAt + offset;
  }

  // 七天之后进入每日档：第 n 天 = 7d + n*1d，直到 30 天。
  const last = COLLECT_OFFSETS.at(-1);
  const n = Math.floor((age - last) / DAILY_MS) + 1;
  const next = publishedAt + last + n * DAILY_MS;
  return next - publishedAt > COLLECT_WINDOW_MS ? null : next;
}

/** Human label for the schedule, used by docs and `vk now` later. */
export const COLLECT_SHAPE = "发布后 +1h · +6h · +24h · +3d · +7d，之后每天一次，最多 30 天";
