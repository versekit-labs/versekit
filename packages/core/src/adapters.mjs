// Adapter and channel discovery, plus the boundary where an adapter's answer becomes database truth.
//
// Adapters are separate packages (`packages/adapter-<platform>`) so they can be versioned and
// tested on their own. The core never imports one directly — it reads the registry — which is
// what keeps "core cannot depend on an adapter" true instead of aspirational.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { open, transitionPublish, emit, enqueue } from "./index.mjs";
import { validateAdapter } from "./contract.mjs";
import { toAdapterError } from "./errors.mjs";
import { recordSnapshot, applyPublishResult, applyPublishError, getPublishRow } from "./publish-flow.mjs";
import { nextCollectAt } from "./collect-plan.mjs";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Loads every installed adapter. `only` restricts to some platforms (useful in tests and in
 * `vk doctor`). A broken adapter is reported, not fatal — one bad package must not stop the rest.
 */
export async function loadAdapters({ only = null, root = PACKAGES } = {}) {
  const dirs = existsSync(root)
    ? readdirSync(root).filter((d) => d.startsWith("adapter-") && existsSync(join(root, d, "package.json")))
    : [];
  const loaded = [];
  const errors = [];
  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dirPath, "package.json"), "utf8"));
    } catch (err) {
      errors.push({ dir, message: `读不到 package.json: ${err.message}` });
      continue;
    }
    const entry = pkg.exports?.["."]?.import ?? pkg.module ?? pkg.main ?? "src/index.mjs";
    try {
      const mod = await import(pathToFileURL(join(dirPath, entry)).href);
      const adapter = mod.default ?? mod.adapter;
      const info = validateAdapter(adapter, dir);
      if (only && !only.includes(info.platform)) continue;
      loaded.push(info);
    } catch (err) {
      errors.push({ dir, message: err.message });
    }
  }
  return { adapters: loaded, errors };
}

/**
 * Turns loaded adapters into runner handlers. Missing capabilities are simply not registered.
 *
 * The handlers own the state machine: an adapter never writes `publish.state`. If it did, two
 * adapters would eventually disagree about the order of "外部 id 落库" and "转 published", and the
 * difference would only show up as a publish stuck mid-flight for one platform.
 */
export function buildHandlers(adapters, { log = () => {} } = {}) {
  const byPlatform = new Map(adapters.map((a) => [a.platform, a]));
  const handlers = {};

  // The platform lives on the publish row, not on the run: the runner stays platform-agnostic.
  const platformOf = (publishId) =>
    open()
      .prepare("SELECT a.platform FROM publish p JOIN account a ON a.id = p.account_id WHERE p.id = ?")
      .get(publishId)?.platform ?? null;

  const adapterFor = (publishId) => {
    const platform = platformOf(publishId);
    if (!platform) throw new Error(`找不到发布 ${publishId}，或它的账号没有平台`);
    const adapter = byPlatform.get(platform);
    if (!adapter) throw new Error(`没有 ${platform} 适配器（装 packages/adapter-${platform}）`);
    return adapter;
  };

  if (adapters.some((a) => a.publish !== "none")) {
    handlers.publish = async (run) => {
      const publishId = run.target_id;
      const adapter = adapterFor(publishId);
      const row = getPublishRow(publishId);
      if (!row) throw new Error(`找不到发布：${publishId}`);

      // notify / manual are choices, not failures: the person asked to be told, so tell them.
      if (row.mode === "notify") {
        if (row.state === "queued") transitionPublish(publishId, "notify_pending", { reason: "notify_mode" });
        return { state: "notify_pending" };
      }

      // Draft requested but the platform has no draft box: say so, do not pretend to try.
      if (row.mode === "draft" && adapter.draft !== true) {
        if (row.state === "queued") transitionPublish(publishId, "draft_running");
        transitionPublish(publishId, "notify_pending", {
          reason: "no_upload_path",
          patch: { fallback_reason: "no_upload_path" },
        });
        return { state: "notify_pending", fallback: "no_upload_path" };
      }

      const running = row.mode === "draft" ? "draft_running" : "auto_running";
      if (row.state === "queued") transitionPublish(publishId, running);

      try {
        const result = await adapter.adapter.publish({ publishId });
        if (result?.dryRun) return result;
        return applyPublishResult(publishId, result);
      } catch (err) {
        const disposition = applyPublishError(publishId, err);
        if (disposition.retryable) throw toAdapterError(err);
        // Terminal or already handed to a human: the run is done, the row carries the reason.
        log(`[publish] ${adapter.platform} ${publishId} 失败（${disposition.code}），不再重试`);
        return { state: getPublishRow(publishId)?.state, error: disposition.code };
      }
    };
  }

  if (adapters.some((a) => a.collect !== "none")) {
    handlers.collect = async (run) => {
      const publishId = run.target_id;
      const adapter = adapterFor(publishId);
      if (adapter.collect === "none") throw new Error(`${adapter.platform} 还没有指标采集`);
      try {
        const result = await adapter.adapter.collect({ publishId });
        const snap = recordSnapshot({
          publishId,
          source: result.source,
          status: result.status,
          metrics: result.metrics,
          capturedAt: result.capturedAt ?? Date.now(),
        });

        // 排下一个采集点：前密后疏，30 天封顶。失败不排——这一次的 run 会先重试。
        const row = getPublishRow(publishId);
        const next = row?.published_at ? nextCollectAt(row.published_at) : null;
        if (next && next > Date.now()) {
          enqueue({ kind: "collect", targetType: "publish", targetId: publishId, lane: row.account_id, priority: 200, runAfter: next });
        }
        return snap;
      } catch (err) {
        const error = toAdapterError(err);
        const row = getPublishRow(publishId);
        if (error.code === "auth" && row) {
          open().prepare("UPDATE account SET state='expired' WHERE id=?").run(row.account_id);
        }
        emit({
          type: "collect.degraded",
          severity: error.code === "auth" ? "critical" : "warn",
          publishId,
          payload: { platform: adapter.platform, code: error.code, message: String(error.message).slice(0, 300) },
          // One card per publish per hour per reason — a flaky selector must not become a stream.
          dedupeKey: `collect:${publishId}:${error.code}:${new Date().toISOString().slice(0, 13)}`,
        });
        throw error;
      }
    };
  }
  // Health checks target an account, not a publish, so this handler exists even when no adapter
  // implements check(): the run then records "probed, but this platform cannot be probed".
  handlers.check = async (run) => {
    const accountId = run.target_id;
    const account = open().prepare("SELECT * FROM account WHERE id=?").get(accountId);
    if (!account) throw new Error(`没有这个账号：${accountId}`);
    const adapter = byPlatform.get(account.platform);
    const at = Date.now();
    const mark = (patch) => {
      const sets = Object.keys(patch).map((k) => `${k}=?`).join(", ");
      open().prepare(`UPDATE account SET ${sets} WHERE id=?`).run(...Object.values(patch), accountId);
    };

    if (!adapter?.adapter?.check) {
      mark({ last_checked_at: at });
      return { skipped: true, reason: `${account.platform} 适配器没有 check()`, passive_only: true };
    }

    try {
      const health = await adapter.adapter.check({ accountId });
      const states = ["ok", "expiring", "expired", "banned", "manual"];
      if (!states.includes(health?.state)) {
        throw new Error(`${account.platform} 的 check() 返回了未知状态：${JSON.stringify(health?.state)}`);
      }
      const patch = { state: health.state, last_checked_at: at };
      if (health.state === "ok") patch.last_ok_at = at;
      if (Number.isInteger(health.expiresAt)) patch.expires_at = health.expiresAt;
      mark(patch);

      if (health.state !== account.state && ["expiring", "expired", "banned"].includes(health.state)) {
        emit({
          type: `account.${health.state}`,
          severity: health.state === "expiring" ? "warn" : "critical",
          payload: { platform: account.platform, handle: account.handle, detail: health.detail ?? null },
          // One card per account per state per day; a probe every six hours must not become spam.
          dedupeKey: `account:${accountId}:${health.state}:${new Date(at).toISOString().slice(0, 10)}`,
        });
      }
      return { accountId, state: health.state, detail: health.detail ?? null };
    } catch (err) {
      const error = toAdapterError(err);
      if (error.code === "auth") {
        mark({ state: "expired", last_checked_at: at });
        emit({
          type: "account.expired",
          severity: "critical",
          payload: { platform: account.platform, handle: account.handle, detail: String(error.message).slice(0, 300) },
          dedupeKey: `account:${accountId}:expired:${new Date(at).toISOString().slice(0, 10)}`,
        });
      } else {
        mark({ last_checked_at: at });
      }
      throw error;
    }
  };

  return handlers;
}
