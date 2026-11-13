// Turning an adapter's answer into the database's truth.
//
// The single rule this file exists to enforce: adapters do not write publish state, snapshots or
// followups. They return a result or throw a coded error, and this module decides what that means
// for the state machine. Without it, five adapters each invent their own transition order and the
// "never silently fail" guarantee becomes five different guarantees.

import { open, transitionPublish, emit, enqueue, newId } from "./index.mjs";
import { ERROR_CODES, toAdapterError } from "./errors.mjs";
import { assertPublishResult } from "./contract.mjs";
import { nextCollectAt } from "./collect-plan.mjs";
import { DEFAULT_PUBLISH_TIMEOUT_MS } from "./config.mjs";

const SNAPSHOT_SOURCES = ["api", "intercept", "csv"];
const SNAPSHOT_STATUSES = ["ok", "partial", "failed"];

export function getPublishRow(publishId) {
  return open()
    .prepare(
      `SELECT p.*, a.platform, a.handle, a.state AS account_state, a.id AS account_id, w.title AS work_title
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
        WHERE p.id = ?`,
    )
    .get(publishId);
}

/** One row per capture; the caller supplies what it knows and `status` says how complete it is. */
export function recordSnapshot({ publishId, source, status, metrics, capturedAt = Date.now() }) {
  if (!SNAPSHOT_SOURCES.includes(source)) throw new Error(`未知的采集来源：${source}（只能是 ${SNAPSHOT_SOURCES.join(" / ")}）`);
  if (!SNAPSHOT_STATUSES.includes(status)) throw new Error(`未知的快照状态：${status}（只能是 ${SNAPSHOT_STATUSES.join(" / ")}）`);
  if (!metrics || typeof metrics !== "object") throw new Error("快照缺少 metrics");
  const id = newId("snap");
  try {
    open()
      .prepare("INSERT INTO snapshot (id, publish_id, captured_at, source, status, metrics_json) VALUES (?,?,?,?,?,?)")
      .run(id, publishId, capturedAt, source, status, JSON.stringify(metrics));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return { id: null, capturedAt, duplicate: true };
    throw err;
  }
  return { id, capturedAt, duplicate: false };
}

/**
 * Applies a successful adapter answer: state, external id, followups, and the first collection.
 * Called at the adapter boundary so a malformed result fails before any row is touched.
 */
export function applyPublishResult(publishId, result) {
  assertPublishResult(result, `publish ${publishId}`);
  const row = getPublishRow(publishId);
  if (!row) throw new Error(`没有这条发布：${publishId}`);

  const patch = { external_id: result.id, external_url: result.url };
  // 采集节奏从「第一次真的发出去」起算，不能从建行（可能提前几天定时）起算。
  if (!row.published_at && ["published", "published_limited"].includes(result.state)) patch.published_at = Date.now();
  if (row.state === result.state) {
    // Adapter filled in the row itself (legacy) — patch the ids, do not transition twice.
    open()
      .prepare("UPDATE publish SET external_id=?, external_url=?, updated_at=? WHERE id=?")
      .run(patch.external_id, patch.external_url, Date.now(), publishId);
  } else {
    transitionPublish(publishId, result.state, { patch });
  }

  const followups = [];
  for (const f of result.followups ?? []) {
    const exists = open().prepare("SELECT id FROM followup WHERE publish_id=? AND kind=?").get(publishId, f.kind);
    if (exists) continue;
    const id = newId("fu");
    open().prepare("INSERT INTO followup (id, publish_id, kind, state, verify_hint) VALUES (?,?,?,'open',?)").run(id, publishId, f.kind, f.hint ?? null);
    emit({
      type: "publish.needs_followup",
      severity: "warn",
      publishId,
      payload: { kind: f.kind, hint: f.hint ?? null, verify: f.verify ?? null },
      dedupeKey: `publish:${publishId}:followup:${f.kind}`,
    });
    followups.push(f.kind);
  }

  // First collection is part of publishing, not a separate decision someone can forget.
  if (["published", "published_limited"].includes(result.state)) {
    const publishedAt = getPublishRow(publishId)?.published_at ?? Date.now();
    const next = nextCollectAt(publishedAt);
    if (next) {
      enqueue({
        kind: "collect",
        targetType: "publish",
        targetId: publishId,
        lane: row.account_id,
        priority: 200,
        runAfter: next,
      });
    }
  }

  return { state: result.state, id: result.id, url: result.url, followups };
}

const ACCOUNT_EVENT = { auth: "account.expired" };

/**
 * Applies a coded failure. Returns `{ terminal, retryable }` so the caller knows whether the queue
 * should keep trying — the adapter describes the failure, the core decides the disposition.
 */
export function applyPublishError(publishId, err) {
  const error = toAdapterError(err);
  const spec = ERROR_CODES[error.code];
  const row = getPublishRow(publishId);
  if (!row) return { terminal: true, retryable: false, code: error.code };

  open()
    .prepare("UPDATE publish SET error_code=?, error_message=?, updated_at=? WHERE id=?")
    .run(error.code, String(error.message).slice(0, 500), Date.now(), publishId);

  if (error.code === "auth") {
    open().prepare("UPDATE account SET state='expired' WHERE id=?").run(row.account_id);
    if (["queued", "auto_running", "draft_running", "draft_pending"].includes(row.state)) {
      transitionPublish(publishId, "blocked", { reason: "auth", patch: { error_code: "auth" } });
    }
    emit({
      type: ACCOUNT_EVENT.auth,
      severity: "critical",
      publishId,
      payload: { accountId: row.account_id, platform: row.platform, handle: row.handle },
      dedupeKey: `account:${row.account_id}:expired`,
    });
    return { terminal: true, retryable: false, code: "auth" };
  }

  if (error.code === "platform_reject") {
    if (["queued", "auto_running", "draft_running", "draft_pending"].includes(row.state)) {
      transitionPublish(publishId, "notify_pending", { reason: "platform_reject" });
    }
    return { terminal: false, retryable: false, code: error.code };
  }

  if (error.code === "asset_invalid") {
    if (["queued", "auto_running", "draft_running"].includes(row.state)) {
      transitionPublish(publishId, "failed", { reason: "asset_invalid" });
    }
    return { terminal: true, retryable: false, code: error.code };
  }

  // 超时必须有终点（ACC-publish-05）：停在 auto_running 的发布既不是成功也不是失败，
  // 人看不到原因，也没法重试。转 failed 并保留 error_code=timeout + 人话（停在哪一步）。
  if (error.code === "timeout") {
    if (["queued", "auto_running", "draft_running", "draft_pending"].includes(row.state)) {
      transitionPublish(publishId, "failed", { reason: "timeout" });
    }
    return { terminal: true, retryable: false, code: error.code };
  }

  return { terminal: false, retryable: spec.retryable, code: error.code };
}

/** What the fallback reason should read like when automation gave up. */
const FALLBACK_OF = {
  auth: "no_upload_path",
  quota: "risk_control",
  flaky_ui: "flaky_automation",
  unknown: "flaky_automation",
  asset_invalid: "asset_invalid",
  platform_reject: "app_only_feature",
  timeout: "flaky_automation",
};

/**
 * Called when the queue gives up (MAX_ATTEMPTS). This is the guard against a publish sitting in
 * `auto_running` forever: the person is told, with the reason, and the row lands in notify_pending.
 */
export function applyTerminalFailure(publishId, err) {
  const error = toAdapterError(err);
  const row = getPublishRow(publishId);
  if (!row) return null;
  if (!["queued", "auto_running", "draft_running", "draft_pending", "failed"].includes(row.state)) return null;
  // 已经 failed 的行已经有原因和重试入口了；队列放弃只是把 run 标成失败，别再把它翻成
  // notify_pending——那会把 error_code=timeout / asset_invalid 的口径冲掉（ACC-publish-05）。
  if (row.state === "failed") return null;

  const fallback = FALLBACK_OF[error.code] ?? "flaky_automation";
  transitionPublish(publishId, "notify_pending", {
    reason: fallback,
    patch: { fallback_reason: fallback, error_code: error.code, error_message: String(error.message).slice(0, 500) },
  });
  return { state: "notify_pending", fallback };
}

/**
 * 总时限的第二道保险（ACC-publish-05）：handler 里的定时器只管「适配器还在手上」的那一次；
 * 进程崩过、run 丢了、租约卡住的行没人管，就会永久停在 auto_running。
 *
 * 只处理**没有活 run** 的行：有活 run 时超时由 handler 的定时器负责，fallback 扫到同一行
 * 会跟正在返回的适配器抢状态（一个转 failed、一个转 published，白挨一次非法迁移）。
 */
export function sweepStuckPublishes({ timeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS, now = Date.now() } = {}) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return { failed: [] };
  const cutoff = now - ms;
  const rows = open()
    .prepare(
      `SELECT p.id, p.state FROM publish p
        WHERE p.state IN ('auto_running', 'draft_running')
          AND p.updated_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM run r
             WHERE r.kind = 'publish' AND r.target_type = 'publish' AND r.target_id = p.id
               AND r.state = 'running' AND (r.lease_until IS NULL OR r.lease_until > ?))`,
    )
    .all(cutoff, now);

  const minutes = Math.max(1, Math.round(ms / 60e3));
  const failed = [];
  for (const row of rows) {
    const stage = row.state === "draft_running" ? "草稿" : "自动发布";
    transitionPublish(row.id, "failed", {
      reason: "timeout",
      patch: {
        error_code: "timeout",
        error_message: `${stage}超过 ${minutes} 分钟没有推进：适配器没有返回结果，已判超时；重试前先确认账号浏览器状态`,
      },
    });
    failed.push(row.id);
  }
  return { failed };
}
