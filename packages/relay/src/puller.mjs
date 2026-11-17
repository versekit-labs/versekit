// 发布机一侧的一轮拉取：列出待投递 → 下载（可续传）→ 核对 sha256 → 交给 ingest 入库 → 回报中转。
//
// 本文件不碰数据库：入库和「这个投递是否已入库」都由调用方注入（core 的 handlers 接 work.add + plan.apply，
// 状态记在 core 的 meta 表里），所以重复拉取、服务重启都不会重复入库。

import { join } from "node:path";
import { downloadBlob, listDeliveries, reportState, RelayError } from "./client.mjs";

const safeName = (n) => String(n).replace(/[\\/]/g, "_").replace(/^\.+/, "_") || "file";

/**
 * deps:
 *   inboxDir                下载目录（每个投递一个子目录）
 *   getRecord(id)           本机记着的这个投递的结果：{ state: "ingested"|"failed", ... } 或 null
 *   ingest(delivery, paths) 入库；paths = { <sha256>: 本地绝对路径 }；不合格就抛带人话的错
 *   record(id, rec)         记下结果
 *   onProgress(p)           { id, name, received, total } 或 null（没有在下载的）
 */
export async function pullOnce({ url, token, inboxDir, getRecord, record, ingest, onProgress = () => {}, log = () => {}, retries = 3, backoffMs = 1000 }) {
  const out = { seen: 0, ingested: [], failed: [], skipped: [], pending: [] };
  const deliveries = await listDeliveries({ url, token });
  out.seen = deliveries.length;

  for (const d of deliveries) {
    // 中转是外部输入：id 和 sha 要长得对，才拿来拼本地路径。
    if (!/^dl_[0-9a-f]{12,32}$/.test(d?.id ?? "") || !Array.isArray(d.blobs) || d.blobs.some((b) => !/^[0-9a-f]{64}$/.test(b?.sha256 ?? "") || !Number.isInteger(b?.size))) {
      log("[relay] 跳过一条格式不对的投递");
      continue;
    }
    const known = getRecord(d.id);
    if (known?.state === "ingested" || known?.state === "failed") {
      // 本机已经处理过；中转还显示待拉取，说明上次的回报没送到：补报，不再入库。
      out.skipped.push(d.id);
      await reportState({ url, token, id: d.id, state: known.state, reason: known.reason }).catch((err) => log(`[relay] 补报 ${d.id} 失败：${err.message}`));
      continue;
    }

    const paths = {};
    let failure = null;
    let current = null;
    try {
      for (const b of d.blobs) {
        current = b;
        const dest = join(inboxDir, d.id, b.sha256.slice(0, 12), safeName(b.name));
        await downloadBlob({
          url,
          token,
          sha256: b.sha256,
          size: b.size,
          dest,
          retries,
          backoffMs,
          onProgress: (received, total) => onProgress({ id: d.id, name: b.name, received, total }),
        });
        paths[b.sha256] = dest;
      }
    } catch (err) {
      onProgress(null);
      if (err instanceof RelayError && err.code === "hash_mismatch") failure = `文件「${current?.name ?? "成片"}」下载后校验不过（sha256 不符），没有入库：重新从制作机 push 一次`;
      else {
        // 网络问题不是投递的错：留着，下一轮接着下。
        log(`[relay] 投递 ${d.id} 这一轮没下完：${err.message}`);
        out.pending.push({ id: d.id, error: err.message });
        continue;
      }
    }
    onProgress(null);

    if (!failure) {
      await reportState({ url, token, id: d.id, state: "downloaded" }).catch(() => {});
      try {
        const res = await ingest(d, paths);
        record(d.id, { state: "ingested", at: Date.now(), title: d.manifest?.title ?? null, ...(res ?? {}) });
        out.ingested.push(d.id);
        await reportState({ url, token, id: d.id, state: "ingested" }).catch((err) => log(`[relay] 回报「已入库」失败（下一轮补报）：${err.message}`));
        continue;
      } catch (err) {
        failure = err.message;
      }
    }
    record(d.id, { state: "failed", at: Date.now(), reason: failure, title: d.manifest?.title ?? null });
    out.failed.push({ id: d.id, reason: failure });
    await reportState({ url, token, id: d.id, state: "failed", reason: failure }).catch((err) => log(`[relay] 回报「失败」没送到（下一轮补报）：${err.message}`));
  }
  return out;
}
