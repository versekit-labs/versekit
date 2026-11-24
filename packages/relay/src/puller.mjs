// 发布机一侧的一轮拉取：列出待投递 → 下载（可续传）→ 核对 sha256 → 交给 ingest 入库 → 回报中转。
//
// 本文件不碰数据库：入库和「这个投递是否已入库」都由调用方注入（core 的 handlers 接 work.add + plan.apply，
// 状态记在 core 的 meta 表里），所以重复拉取、服务重启都不会重复入库。

import { join } from "node:path";
import { downloadBlob, listDeliveries, reportState, RelayError } from "./client.mjs";

const safeName = (n) => String(n).replace(/[\\/]/g, "_").replace(/^\.+/, "_") || "file";
const PROGRESS_REPORT_MS = 5000;

/**
 * deps:
 *   inboxDir                下载目录（每个投递一个子目录）
 *   getRecord(id)           本机记着的这个投递的结果：{ state: "ingested"|"failed", ... } 或 null
 *   ingest(delivery, paths) 入库；paths = { <sha256>: 本地绝对路径 }；不合格就抛带人话的错
 *   record(id, rec)         记下结果
 *   onProgress(p)           { id, name, title, received, total } 或 null（没有在下载的）
 *   onEvent(e)              这一轮的进展（ACC-relay-06）：round{total} / begin{index,total,id,title,size} / ingested / failed / pending
 */
export async function pullOnce({ url, token, inboxDir, getRecord, record, ingest, onProgress = () => {}, onEvent = () => {}, log = () => {}, retries = 3, backoffMs = 1000 }) {
  const out = { seen: 0, ingested: [], failed: [], skipped: [], pending: [] };
  const deliveries = await listDeliveries({ url, token });
  out.seen = deliveries.length;

  const wellFormed = (d) => /^dl_[0-9a-f]{12,32}$/.test(d?.id ?? "") && Array.isArray(d.blobs) && !d.blobs.some((b) => !/^[0-9a-f]{64}$/.test(b?.sha256 ?? "") || !Number.isInteger(b?.size));
  const todo = deliveries.filter((d) => wellFormed(d) && !["ingested", "failed"].includes(getRecord(d.id)?.state));
  onEvent({ type: "round", total: todo.length });
  const titleOf = (d) => d.manifest?.title ?? null;

  for (const d of deliveries) {
    // 中转是外部输入：id 和 sha 要长得对，才拿来拼本地路径。
    if (!/^dl_[0-9a-f]{12,32}$/.test(d?.id ?? "") || !Array.isArray(d.blobs) || d.blobs.some((b) => !/^[0-9a-f]{64}$/.test(b?.sha256 ?? "") || !Number.isInteger(b?.size))) {
      log("[relay] 跳过一条格式不对的投递");
      continue;
    }
    const known = getRecord(d.id);
    const report = (fields) => reportState({ url, token, id: d.id, ...fields });
    if (known?.state === "ingested" || known?.state === "failed") {
      // 本机已经处理过；中转还显示待拉取，说明上次的回报没送到：补报，不再入库。
      out.skipped.push(d.id);
      const { state, reason, summary, errorCode, nextStep } = known;
      await report({ state, reason, summary, errorCode, nextStep }).catch((err) => log(`[relay] 补报 ${d.id} 失败：${err.message}`));
      continue;
    }

    const index = todo.indexOf(d) + 1;
    const title = titleOf(d);
    const size = d.blobs.reduce((n, b) => n + b.size, 0);
    onEvent({ type: "begin", index, total: todo.length, id: d.id, title, size });
    const paths = {};
    let failure = null;
    let current = null;
    let completedBytes = 0;
    let measuredBytes = 0;
    const started = performance.now();
    const speed = () => Math.round(measuredBytes * 1000 / Math.max(1, performance.now() - started));
    let lastProgressAt = started;
    let reporting = null;
    const progressReport = (received) => {
      if (reporting) return;
      lastProgressAt = performance.now();
      reporting = report({ state: "downloading", progress: { received, bytesPerSecond: speed() } })
        .catch((err) => {
          // 旧中转只接受终态回报，仍然可以下载和入库。
          if (err.status !== 400) log(`[relay] 回报 ${d.id} 下载进度失败：${err.message}`);
        })
        .finally(() => { reporting = null; });
    };
    progressReport(0);
    try {
      for (const b of d.blobs) {
        current = b;
        let previous = null;
        const dest = join(inboxDir, d.id, b.sha256.slice(0, 12), safeName(b.name));
        await downloadBlob({
          url,
          token,
          sha256: b.sha256,
          size: b.size,
          dest,
          retries,
          backoffMs,
          onProgress: (received, total) => {
            if (previous != null) measuredBytes += Math.max(0, received - previous);
            previous = received;
            onProgress({ id: d.id, name: b.name, title, received, total });
            if (performance.now() - lastProgressAt >= PROGRESS_REPORT_MS) progressReport(completedBytes + received);
          },
        });
        paths[b.sha256] = dest;
        completedBytes += b.size;
      }
    } catch (err) {
      onProgress(null);
      if (err instanceof RelayError && err.code === "hash_mismatch") {
        failure = { errorCode: err.code, reason: `文件「${current?.name ?? "成片"}」下载后校验不过（sha256 不符），没有入库：重新从制作机 push 一次` };
      }
      else {
        // 网络问题不是投递的错：留着，下一轮接着下。
        await reporting;
        await report({ state: "downloading", progress: null }).catch((reportError) => {
          if (reportError.status !== 400) log(`[relay] 回报 ${d.id} 下载中断失败：${reportError.message}`);
        });
        log(`[relay] 投递 ${d.id} 这一轮没下完：${err.message}`);
        out.pending.push({ id: d.id, error: err.message });
        onEvent({ type: "pending", index, total: todo.length, id: d.id, title, reason: err.message });
        continue;
      }
    }
    onProgress(null);
    await reporting;

    if (!failure) {
      const downloadBytesPerSecond = performance.now() - started >= 100 ? speed() : undefined;
      await report({ state: "downloaded", downloadBytesPerSecond }).catch((err) => log(`[relay] 回报 ${d.id} 已下载失败：${err.message}`));
      try {
        const res = await ingest(d, paths);
        record(d.id, { state: "ingested", at: Date.now(), title: d.manifest?.title ?? null, ...(res ?? {}) });
        out.ingested.push(d.id);
        onEvent({ type: "ingested", index, total: todo.length, id: d.id, title, drafts: res?.drafts ?? 0 });
        await report({ state: "ingested", reason: res?.reason, summary: res?.summary }).catch((err) => log(`[relay] 回报「已入库」失败（下一轮补报）：${err.message}`));
        continue;
      } catch (err) {
        failure = { errorCode: err.code ?? "ingest_failed", reason: err.message, nextStep: err.hint };
      }
    }
    failure.nextStep ??= "在发布机处理上述原因，再从制作机重新交付。";
    record(d.id, { state: "failed", at: Date.now(), ...failure, title });
    out.failed.push({ id: d.id, reason: failure.reason });
    onEvent({ type: "failed", index, total: todo.length, id: d.id, title, reason: failure.reason });
    await report({ state: "failed", ...failure }).catch((err) => log(`[relay] 回报「失败」没送到（下一轮补报）：${err.message}`));
  }
  return out;
}
