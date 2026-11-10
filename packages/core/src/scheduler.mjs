// Proactive account health (ARCHITECTURE §4.1).
//
// G3 says the system must find an expired login before the person does. That only holds if there
// is a clock doing it: without this sweep, "expired" is discovered at the next publish, which is
// exactly the failure the product promises to prevent.
//
// The sweep is deliberately dumb — who is due, queue a check — so it can be tested without a
// browser and cannot get stuck mid-way.

import { open, enqueue } from "./index.mjs";

export const CHECK_INTERVAL_MS = 6 * 3600e3;

/** Accounts whose last probe is older than the interval. `manual` accounts are skipped on purpose. */
export function dueAccounts({ now = Date.now(), intervalMs = CHECK_INTERVAL_MS } = {}) {
  return open()
    .prepare(
      `SELECT id, platform, handle, last_checked_at FROM account
        WHERE is_manual = 0 AND removed_at IS NULL
          AND (last_checked_at IS NULL OR last_checked_at <= ?)
        ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC`,
    )
    .all(now - intervalMs);
}

/**
 * Queues one check per due account. Enqueue already dedupes by (kind, target) while a run is
 * queued or running, so calling this every ten minutes does not pile up work.
 */
export function sweepAccountChecks(options = {}) {
  const due = dueAccounts(options);
  for (const account of due) {
    enqueue({ kind: "check", targetType: "account", targetId: account.id, lane: account.id, priority: 300 });
  }
  return due.map((a) => a.id);
}

/** Starts the periodic sweep. Returns a stop function; the timer must not keep the process alive. */
export function startCheckSweeper({ everyMs = 10 * 60e3, intervalMs = CHECK_INTERVAL_MS, log = () => {} } = {}) {
  const run = () => {
    try {
      const queued = sweepAccountChecks({ intervalMs });
      if (queued.length) log(`[scheduler] 排了 ${queued.length} 个账号体检`);
    } catch (err) {
      log(`[scheduler] 体检排单失败：${err.message}`);
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
