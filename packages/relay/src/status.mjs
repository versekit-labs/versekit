import { deliveryTitle } from "./delivery-v1.mjs";

// ADR-0003 §3 的实测基线（字节/秒）；有较新的上传或发布机下载样本时优先用实测样本。
export const BASELINE_TRANSFER = { uploadBytesPerSecond: 1.1e6, downloadBytesPerSecond: 0.11e6 };
const OFFLINE_AFTER_MS = 6 * 3600e3;
const PROGRESS_STALE_MS = 120e3;

export function transferSeconds(bytes, bytesPerSecond) {
  return Math.ceil(Math.max(0, bytes) / bytesPerSecond);
}

export const formatBytes = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)}MB`;
export const formatDuration = (seconds) => seconds >= 3600
  ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`
  : seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;

export function deliveryProgress(bytes, totalBytes, bytesPerSecond) {
  return {
    bytes, totalBytes, bytesPerSecond,
    percent: totalBytes ? Math.floor(100 * bytes / totalBytes) : 0,
    etaSeconds: transferSeconds(totalBytes - bytes, bytesPerSecond),
  };
}

export function deliveryStatusView(row, { lastPullAt = null, downloadBytesPerSecond, now = Date.now() } = {}) {
  const title = deliveryTitle(row.manifest);
  const totalBytes = row.blobs.reduce((n, blob) => n + blob.size, 0);
  const meta = { id: row.id, title, group: row.group, totalBytes, createdAt: row.created_at, updatedAt: row.updated_at, lastPullAt };
  if (row.state === "ingested") {
    const drafts = row.summary?.drafts?.length;
    return { ...meta, state: "awaiting_confirmation", label: "等你确认",
      summary: row.summary ?? null, reason: row.reason ?? null,
      message: drafts == null ? "到了。请在发布机的「今天」页或飞书确认。" : `到了。${drafts} 条等你确认。` };
  }
  if (row.state === "failed") {
    const reason = row.reason ?? "发布机没说原因";
    return { ...meta, state: "failed", label: "没交成", reason,
      errorCode: row.error_code ?? "ingest_failed", nextStep: row.next_step ?? "在发布机处理上述原因，再从制作机重新交付。",
      message: `没交成：${reason}` };
  }
  const current = row.progress && now - row.progress.at < PROGRESS_STALE_MS ? row.progress : null;
  if (current || row.state === "downloaded") {
    const progress = deliveryProgress(current?.received ?? totalBytes, totalBytes,
      current?.bytesPerSecond || downloadBytesPerSecond || BASELINE_TRANSFER.downloadBytesPerSecond);
    const message = row.state === "downloaded" ? "发布机已下载，正在入库。"
      : `发布机在下载：${progress.percent}%，还要约 ${formatDuration(progress.etaSeconds)}。`;
    return { ...meta, state: "downloading", label: "发布机在下载", progress, message };
  }
  const age = now - (lastPullAt ?? row.created_at);
  const offline = age >= OFFLINE_AFTER_MS;
  const message = offline ? "已到中转，但发布机 6 小时没来取。打开那台电脑上的 versekit 就会自动下载。"
    : lastPullAt == null ? "已到中转。发布机还没来取。"
      : `已到中转。发布机上次来取是 ${formatDuration(Math.max(0, Math.floor(age / 1000)))}前。`;
  return { ...meta, state: "waiting", label: "等发布机来取", offline, message };
}
