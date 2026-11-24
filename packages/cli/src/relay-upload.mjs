// 制作机的投递队列。登记和重试时间写进本机状态，实际传输由 vk serve 串行处理。
import { createHash } from "node:crypto";
import { readConfig } from "../../core/src/config.mjs";
import { emit } from "../../core/src/index.mjs";
import { getRelayState, patchRelayState } from "../../core/src/store.mjs";
import { pushDelivery, RETENTION_MS } from "../../relay/src/index.mjs";

const keyOf = (token) => createHash("sha256").update(token).digest("hex");
const jobs = () => getRelayState().push_jobs ?? [];

function connection() {
  const relay = readConfig().relay;
  if (typeof relay?.url === "string" && relay.url && typeof relay.push_token === "string" && relay.push_token) {
    return { url: relay.url.replace(/\/+$/, ""), token: relay.push_token };
  }
  return null;
}

function forConnection(rows, cfg) {
  if (!cfg) return [];
  const key = keyOf(cfg.token);
  return rows.filter((row) => row.url === cfg.url && row.connectionKey === key);
}

export function createRelayUploadQueue({ log = () => {} } = {}) {
  let running = false;
  let timer = null;
  let active = null;

  function wake(delay = 0) {
    if (!running || active) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      tick().catch((err) => {
        log(`[relay] 处理上传队列失败：${err.message}`);
        wake(1000);
      });
    }, delay);
    timer.unref();
  }

  async function tick() {
    const rows = jobs();
    const cfg = connection();
    const matching = forConnection(rows, cfg);
    const now = Date.now();
    const job = matching.find((row) => row.retryAt <= now);
    if (!job) {
      if (!rows.length) return;
      // 另一个中转连接的任务等原连接恢复；同一连接的任务等退避到期。
      const delay = matching.length === rows.length ? Math.min(...matching.map((row) => row.retryAt - now)) : 1000;
      wake(delay);
      return;
    }

    const controller = new AbortController();
    const progress = { ...job, errorCode: null };
    active = { controller, progress };
    try {
      let failure = null;
      try {
        await pushDelivery({
          ...cfg, id: job.id, group: job.group, manifest: job.manifest, files: job.files,
          retries: 0, signal: controller.signal,
          onProgress: ({ deliverySent }) => { progress.sent = deliverySent; progress.updatedAt = Date.now(); },
        });
      } catch (err) {
        failure = err;
      }
      if (!running) return; // 正常停机和强杀一样，把登记留给下次启动。

      const pending = jobs();
      const updatedAt = Date.now();
      if (failure?.retryable) {
        const attempts = job.attempts + 1;
        const retryAt = updatedAt + Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5));
        const retry = { ...job, attempts, retryAt, updatedAt, sent: progress.sent, errorCode: failure.code, reason: failure.message };
        patchRelayState({ push_jobs: pending.map((row) => row.id === job.id ? retry : row) });
        log(`[relay] 投递 ${job.id} 已排队重试（${failure.code}）：${failure.message}`);
      } else {
        const patch = { push_jobs: pending.filter((row) => row.id !== job.id) };
        if (failure) {
          const { id, url, title, group, totalBytes, createdAt, uploadBytesPerSecond } = job;
          const errorCode = failure.code ?? "upload_failed";
          const reason = failure.message;
          const nextStep = errorCode === "disk_low" ? "清出中转空间后，再从制作机重新交付。"
            : errorCode === "source_unavailable" || errorCode === "hash_mismatch" ? "检查制作机上的素材，选好文件后重新交付。"
            : "检查中转连接后，从制作机重新交付。";
          const history = (getRelayState().push_failures ?? []).filter((row) => row.updatedAt >= updatedAt - RETENTION_MS);
          const failed = { id, url, title, group, totalBytes, createdAt, updatedAt, uploadBytesPerSecond, sent: progress.sent, errorCode, reason, nextStep };
          patch.push_failures = [failed, ...history].slice(0, 20);
          emit({ type: "delivery.failed", severity: "warn", payload: { id, errorCode, message: reason, nextStep }, dedupeKey: `delivery:${id}:failed` });
          log(`[relay] 投递 ${id} 没交成（${errorCode}）：${reason}`);
        } else {
          log(`[relay] 投递 ${job.id} 已上传到中转`);
        }
        patchRelayState(patch);
      }
    } finally {
      active = null;
    }
    wake();
  }

  return {
    register(job, token) {
      patchRelayState({ push_jobs: [...jobs(), { ...job, connectionKey: keyOf(token), attempts: 0, retryAt: 0 }] });
      wake();
    },
    list(cfg) {
      return forConnection(jobs(), cfg).map((row) => active?.progress.id === row.id ? active.progress : { ...row, queued: true });
    },
    start() {
      running = true;
      wake();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      active?.controller.abort();
    },
  };
}
