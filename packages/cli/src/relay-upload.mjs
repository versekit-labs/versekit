// 制作机投递队列。完整版由 hifabu serve 处理，小程序在交付命令里处理。
import { pushDelivery, relayConnectionKey } from "../../relay/src/client.mjs";
import { RETENTION_MS } from "../../relay/src/status.mjs";

function forConnection(rows, cfg) {
  if (!cfg) return [];
  const key = relayConnectionKey(cfg);
  return rows.filter((row) => row.url === cfg.url && row.connectionKey === key);
}

export function createRelayUploadQueue({ log = () => {}, connection, state, onFailure = () => {}, foreground = false }) {
  const jobs = () => state.jobs();
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
    if (!rows.length) return;
    const cfg = connection();
    const matching = forConnection(rows, cfg);
    const now = Date.now();
    const job = matching.find((row) => row.retryAt <= now);
    if (!job) {
      // 另一个中转连接的任务等原连接恢复；同一连接的任务等退避到期。
      const delay = matching.length === rows.length ? Math.min(...matching.map((row) => row.retryAt - now)) : 1000;
      wake(delay);
      return;
    }

    await upload(job, cfg, () => running);
    wake();
  }

  async function upload(job, cfg, shouldRecord = () => true) {
    const controller = new AbortController();
    const progress = { ...job, errorCode: null };
    active = { controller, progress };
    try {
      let failure;
      let delivery;
      try {
        delivery = await pushDelivery({
          ...cfg, id: job.id, group: job.group, manifest: job.manifest, files: job.files,
          retries: 0, signal: controller.signal,
          onProgress: ({ deliverySent }) => { progress.sent = deliverySent; progress.updatedAt = Date.now(); },
        });
      } catch (err) {
        failure = err;
      }
      if (!shouldRecord()) return; // 正常停机和强杀一样，把登记留给下次启动。

      const updatedAt = Date.now();
      if (failure?.retryable) {
        const attempts = job.attempts + 1;
        const retryAt = updatedAt + Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5));
        const retry = { ...job, attempts, retryAt, updatedAt, sent: progress.sent, errorCode: failure.code, reason: failure.message };
        state.putJob(retry);
        log(`[relay] 投递 ${job.id} 已排队重试（${failure.code}）：${failure.message}`);
        return { failure };
      }
      if (failure) {
        const { id, url, connectionKey, title, group, totalBytes, createdAt, uploadBytesPerSecond } = job;
        const errorCode = failure.code ?? "upload_failed";
        const reason = failure.message;
        const nextStep = errorCode === "disk_low" || errorCode === "quota_exceeded" ? "清出中转空间后，再从制作机重新交付。"
          : errorCode === "relay_disabled" ? "到我的 Hifabu 申请开通传片，再从制作机重新交付。"
          : errorCode === "source_unavailable" || errorCode === "hash_mismatch" ? "检查制作机上的素材，选好文件后重新交付。"
          : "检查中转连接后，从制作机重新交付。";
        const failed = { id, url, connectionKey, title, group, totalBytes, createdAt, updatedAt, uploadBytesPerSecond, sent: progress.sent, errorCode, reason, nextStep };
        onFailure(failed);
        state.finishJob(job.id, failed, updatedAt - RETENTION_MS);
        log(`[relay] 投递 ${id} 没交成（${errorCode}）：${reason}`);
        return { failure, nextStep };
      }
      state.finishJob(job.id);
      log(`[relay] 投递 ${job.id} 已上传到中转`);
      return { delivery };
    } finally {
      active = null;
    }
  }

  async function flush(cfg, id) {
    let result;
    for (const job of forConnection(jobs(), cfg)) {
      if (job.id !== id && job.retryAt > Date.now()) continue;
      const attempt = await upload(job, cfg);
      if (job.id === id) result = attempt;
    }
    return result;
  }

  return {
    register(job) {
      if (foreground) {
        const matching = jobs().find((row) => row.url === job.url && row.connectionKey === job.connectionKey &&
          row.group === job.group && JSON.stringify(row.manifest) === JSON.stringify(job.manifest) &&
          JSON.stringify(row.files) === JSON.stringify(job.files));
        if (matching) return matching;
      }
      const stored = { ...job, attempts: 0, retryAt: 0 };
      state.putJob(stored);
      wake();
      return stored;
    },
    ...(foreground ? { flush } : {}),
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
