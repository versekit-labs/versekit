// The runner: one loop that takes queued work off the `run` table and drives it to a terminal
// state. Everything that talks to a platform goes through an adapter handler, so the loop stays
// testable without a browser.
//
// Two invariants decide whether this is safe in production:
//   · a run holds a lease; if the process dies, the lease expires and the work is requeued
//     instead of being lost or done twice
//   · a lane (usually account_id) runs only one job at a time — two publishes on one account is
//     the fastest way to get rate-limited or flagged

import { enqueue, emit, open, newId } from "./index.mjs";
import { ERROR_CODES } from "./errors.mjs";

export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
export const MAX_ATTEMPTS = 3;

const now = () => Date.now();

export function createRunner({
  handlers = {},
  concurrency = 2,
  leaseMs = 5 * 60_000,
  uploadLeaseMs = 30 * 60_000,
  heartbeatMs = 30_000,
  maxAttempts = MAX_ATTEMPTS,
  onRunFailed = null,
  log = () => {},
} = {}) {
  const db = () => open();
  const active = new Map(); // runId -> {beat}
  let stopping = false;

  const leaseFor = (kind) => (kind === "publish" ? uploadLeaseMs : leaseMs);

  /** Requeue or fail runs whose owner stopped answering. */
  function sweep() {
    const stale = db()
      .prepare("SELECT id, kind, target_type, target_id, attempts FROM run WHERE state='running' AND lease_until < ?")
      .all(now());
    for (const r of stale) {
      const attempts = r.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      // 中断不是失败：进程崩了不该让一条发布白等一分钟，所以立即重排（但计入 attempts）。
      db()
        .prepare("UPDATE run SET state=?, attempts=?, lease_until=NULL, last_error=?, run_after=NULL WHERE id=?")
        .run(terminal ? "failed" : "queued", attempts, "租约过期（进程中断）", r.id);
      emit({
        type: "run.interrupted",
        severity: "warn",
        payload: { runId: r.id, kind: r.kind, target: r.target_id, attempts },
        dedupeKey: `run:${r.id}:interrupted:${attempts}`,
      });
      log(`[runner] 租约过期 ${r.kind} ${r.target_id} → ${terminal ? "failed" : "queued"}`);
    }
  }

  /**
   * Claim one job. The UPDATE is the lock: two runners cannot both win because the second's
   * `state='queued'` guard fails.
   */
  function claim() {
    return db()
      .prepare(
        `UPDATE run SET state='running', lease_until=?, heartbeat_at=?
         WHERE id = (
           SELECT r.id FROM run r
           WHERE r.state='queued'
             AND (r.run_after IS NULL OR r.run_after <= ?)
             AND (r.lane IS NULL OR r.lane NOT IN (SELECT lane FROM run WHERE state='running' AND lane IS NOT NULL))
           ORDER BY r.priority ASC, r.created_at ASC
           LIMIT 1)
           AND state='queued'
         RETURNING *`,
      )
      .get(now() + leaseMs, now(), now());
  }

  function beat(runId) {
    const beatTimer = setInterval(() => {
      try {
        const row = db().prepare("SELECT kind FROM run WHERE id=?").get(runId);
        if (!row) return;
        db()
          .prepare("UPDATE run SET heartbeat_at=?, lease_until=? WHERE id=? AND state='running'")
          .run(now(), now() + leaseFor(row.kind), runId);
      } catch (err) {
        log(`[runner] 心跳失败 ${runId}: ${err.message}`);
      }
    }, heartbeatMs);
    beatTimer.unref?.();
    return beatTimer;
  }

  function giveUp(run, error, message, attempts) {
    db().prepare("UPDATE run SET state='failed', attempts=?, lease_until=NULL, last_error=? WHERE id=?").run(attempts, message.slice(0, 500), run.id);
    emit({
      type: "run.failed",
      severity: "critical",
      payload: { runId: run.id, kind: run.kind, target: run.target_id, attempts, error: message },
      dedupeKey: `run:${run.id}:failed`,
    });
    log(`[runner] ✗ ${run.kind} ${run.target_id}: ${message}`);
    // The queue is transport; the publish row still has to end somewhere a person can see.
    try {
      onRunFailed?.(run, error);
    } catch (hookError) {
      log(`[runner] onRunFailed 出错 ${run.id}: ${hookError.message}`);
    }
  }

  function finish(run, error) {
    if (!error) {
      db().prepare("UPDATE run SET state='done', lease_until=NULL, last_error=NULL WHERE id=?").run(run.id);
      log(`[runner] ✓ ${run.kind} ${run.target_id}`);
      return;
    }
    const policy = ERROR_CODES[error?.code] ?? null;
    const message = error instanceof Error ? error.message : String(error);

    // Quota is not the publish's fault: wait it out without spending the retry budget, otherwise
    // three rate limits in one evening would silently turn a publish into a failure.
    if (policy && policy.countsAttempt === false) {
      const delay = policy.delayMs ?? BACKOFF_MS[0];
      db()
        .prepare("UPDATE run SET state='queued', lease_until=NULL, last_error=?, run_after=? WHERE id=?")
        .run(message.slice(0, 500), now() + delay, run.id);
      log(`[runner] ⏸ ${run.kind} ${run.target_id} 配额限制，${Math.round(delay / 1000)}s 后再试（不计次数）`);
      return;
    }

    const attempts = run.attempts + 1;
    // A coded non-retryable failure (auth, asset_invalid …) is terminal on the first try. Retrying
    // it would just make the person wait three backoff rounds for the same answer.
    if ((policy && !policy.retryable) || attempts >= maxAttempts) {
      giveUp(run, error, message, attempts);
      return;
    }
    const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    db()
      .prepare("UPDATE run SET state='queued', attempts=?, lease_until=NULL, last_error=?, run_after=? WHERE id=?")
      .run(attempts, message.slice(0, 500), now() + delay, run.id);
    log(`[runner] ↻ ${run.kind} ${run.target_id} 第 ${attempts} 次失败，${Math.round(delay / 1000)}s 后重试`);
  }

  async function execute(run) {
    const handler = handlers[run.kind];
    if (!handler) {
      // 缺处理器是配置错误，不是瞬时故障：重试三次也一样，直接失败并告警。
      const message = `没有注册 ${run.kind} 处理器`;
      db().prepare("UPDATE run SET state='failed', attempts=?, lease_until=NULL, last_error=? WHERE id=?").run(MAX_ATTEMPTS, message, run.id);
      emit({ type: "run.failed", severity: "critical", payload: { runId: run.id, kind: run.kind, target: run.target_id, error: message }, dedupeKey: `run:${run.id}:failed` });
      log(`[runner] ✗ ${run.kind}: ${message}`);
      return;
    }
    active.set(run.id, { beat: beat(run.id) });
    try {
      await handler(run);
      finish(run, null);
    } catch (err) {
      finish(run, err);
    } finally {
      clearInterval(active.get(run.id)?.beat);
      active.delete(run.id);
    }
  }

  /** One pass: recover interrupted work, then fill free slots. Returns how many started. */
  async function tick() {
    if (stopping) return 0;
    sweep();
    const started = [];
    while (active.size < concurrency) {
      const run = claim();
      if (!run) break;
      started.push(execute(run));
      if (!handlers[run.kind]) break; // unknown kind: fail fast instead of spinning
    }
    await Promise.all(started);
    return started.length;
  }

  async function loop({ every = 1000 } = {}) {
    for (;;) {
      if (stopping) break;
      try {
        await tick();
      } catch (err) {
        log(`[runner] tick 出错：${err.message}`);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }

  return {
    tick,
    loop,
    sweep,
    claim,
    get activeCount() {
      return active.size;
    },
    stop() {
      stopping = true;
    },
    state() {
      const d = db();
      return {
        queued: d.prepare("SELECT COUNT(*) n FROM run WHERE state='queued'").get().n,
        running: d.prepare("SELECT COUNT(*) n FROM run WHERE state='running'").get().n,
        failed: d.prepare("SELECT COUNT(*) n FROM run WHERE state='failed'").get().n,
        active: active.size,
      };
    },
  };
}

/** Convenience: queue a publish for one row, with the account as its lane. */
export function queuePublish(publish, { priority = 100, runAfter = null } = {}) {
  return enqueue({
    kind: "publish",
    targetType: "publish",
    targetId: publish.id ?? publish,
    lane: publish.account_id ?? publish.accountId ?? null,
    priority,
    runAfter,
  });
}

export function queueCollect(publishId, accountId, { priority = 200, runAfter = null } = {}) {
  return enqueue({ kind: "collect", targetType: "publish", targetId: publishId, lane: accountId, priority, runAfter });
}

export { newId };
