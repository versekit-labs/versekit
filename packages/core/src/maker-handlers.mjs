import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { hashFile, uniqueBlobs, newDeliveryId, ping, pushDelivery, listDeliveryStatus, getDeliveryStatus, relayConnectionKey, assertPublisherAccepts, getGroupSnapshot } from "../../relay/src/client.mjs";
import { BASELINE_TRANSFER, deliveryProgress, deliveryStatusView, formatBytes, formatDuration, transferSeconds, MIN_FREE_BYTES, RETENTION_MS } from "../../relay/src/status.mjs";
import { deliveryCopy, deliveryFiles, isVersionedDelivery, validateDeliveryV1 } from "../../relay/src/delivery-v1.mjs";
import { checkWorkPlan, COPY_LIMITS, copyFor, copyViolations } from "./plan-rules.mjs";

/** 报错的文字是给页面看的人话；命令提示放 hint，只给命令行（页面收到的错误体不带 hint）。 */
const fail = (message, hint) => {
  throw Object.assign(new Error(message), hint ? { hint } : {});
};

/** v1 uses file identities on the wire. The work pipeline still takes cuts with local asset paths. */
export function deliveryWorkPlan(manifest, pathOf, defaultLanguage = "default") {
  const { title, language = defaultLanguage } = manifest.work;
  const cuts = manifest.cuts.map(({ title: cutTitle, video, cover, copy }, i) => ({
    title: cutTitle ?? (manifest.cuts.length === 1 ? title : "成片 " + (i + 1)),
    ...(cover ? { cover: pathOf(cover) } : {}),
    copy: deliveryCopy(copy),
    versions: [{ language, asset: pathOf(video) }],
  }));
  return { title, cuts };
}

/** Shared delivery commands. The caller supplies its connection and upload state backend. */
export function createDeliveryHandlers({ makerConnection, state, uploadQueue, defaultGroupOf = () => null, onFailure = () => {}, log = () => {} }) {
  const uploading = new Map();
  const sameMaker = (row, cfg) => row.url === cfg.url && (row.connectionKey ? row.connectionKey === relayConnectionKey(cfg) : !cfg.accountId);
  const makerFailures = (cfg) => state.failures().filter((row) => sameMaker(row, cfg) && Date.now() - row.updatedAt < RETENTION_MS);
  const localStatus = (row, lastPullAt = null) => {
    const elapsed = (Date.now() - row.createdAt) / 1000;
    const speed = elapsed >= 1 && row.sent ? row.sent / elapsed : row.uploadBytesPerSecond;
    const progress = deliveryProgress(row.sent, row.totalBytes, speed);
    const state = row.queued ? "queued" : row.errorCode ? "failed" : "uploading";
    const { id, title, group, totalBytes, createdAt, updatedAt } = row;
    const view = { id, title, group, totalBytes, createdAt, updatedAt, lastPullAt, state, progress };
    if (state === "queued") {
      const { errorCode, reason, retryAt } = row;
      let message = "已登记，等后台上传。";
      if (uploadQueue?.flush) message = "已排队，下次交付时会接着传。";
      else if (errorCode === "unreachable") message = "中转连不上，已经排队。网通了会自动接着传，不用再说一遍。";
      else if (errorCode) message = "上传中断，已经排队。后台会自动接着传。";
      return { ...view, label: "排队中", message, ...(errorCode ? { errorCode, reason, retryAt } : {}) };
    }
    if (state === "failed") {
      const { errorCode, reason, nextStep } = row;
      return { ...view, label: "没交成", errorCode, reason, nextStep, message: `没交成：${reason}` };
    }
    return { ...view, label: "正在传",
      message: `正在传 ${title}：${formatBytes(progress.bytes)} / ${formatBytes(totalBytes)}，还要约 ${formatDuration(progress.etaSeconds)}。` };
  };

  return {
    "work.push": async ({ manifest, group, dryRun = false }) => {
      const cfg = makerConnection();
      if (!manifest || !existsSync(manifest)) fail(`找不到清单：${manifest ?? "（没给）"}`);
      let raw;
      try {
        raw = JSON.parse(readFileSync(manifest, "utf8"));
      } catch (err) {
        fail(`清单不是合法的 JSON：${manifest}（${err.message}）`);
      }
      const deliveryV1 = isVersionedDelivery(raw);
      if (deliveryV1) validateDeliveryV1(raw);
      const groupName = String(deliveryV1 ? raw.target.group : group ?? cfg.defaultGroup ?? defaultGroupOf(manifest) ?? "").trim();
      if (!groupName) fail("要先选账号组：投递到发布机上的哪个账号组", "--group <组名>，或用 vk relay connect 记住默认组");
      if (deliveryV1 && group != null && group.trim() !== groupName) fail("指定的账号组和清单里的目标组不一致。", "让 --group 和清单的 target.group 一致。");
      const baseDir = dirname(resolvePath(manifest));
      const rel = (p) => (typeof p === "string" && p ? resolvePath(baseDir, p) : p);
      const legacyCuts = () => (Array.isArray(raw?.cuts) ? raw.cuts : []).map((c) => ({
        ...c,
        ...(c?.cover ? { cover: rel(c.cover) } : {}),
        versions: (Array.isArray(c?.versions) ? c.versions : []).map((v) => ({ ...v, ...(v?.cover ? { cover: rel(v.cover) } : {}), asset: rel(v?.asset) })),
      }));
      const plan = deliveryV1 ? deliveryWorkPlan(raw, (file) => rel(file.name)) : { title: raw?.title, source: raw?.source, cuts: legacyCuts() };
      const { cuts } = plan;
      // 规则和 work.add 同一套：不合格当场报错，一个字节都不上传。
      const rejected = [];
      const onCopyViolation = dryRun ? (violation) => {
        if (!rejected.some((r) => r.platform === violation.platform && r.cut === violation.cut && r.reason === violation.reason)) rejected.push(violation);
      } : undefined;
      const checked = checkWorkPlan(plan, { onCopyViolation, deliveryV1 });
      const covers = [...new Set(cuts.flatMap((c) => [c.cover, ...c.versions.map((v) => v.cover)]).filter(Boolean))];
      const missingCovers = covers.filter((a) => !existsSync(a) || !statSync(a).isFile());
      if (missingCovers.length) fail(`找不到封面图片：${missingCovers.join("、")}（路径相对清单所在目录）`);
      const assets = [...new Set(cuts.flatMap((c) => c.versions.map((v) => v.asset)))];
      const missing = assets.filter((a) => !existsSync(a));
      if (missing.length) fail(`找不到成片：${missing.join("、")}（路径相对清单所在目录）`);
      const nonFiles = assets.filter((a) => !statSync(a).isFile());
      if (nonFiles.length) fail(`中转目前只支持视频文件，不支持图片目录：${nonFiles.join("、")}`);

      const files = [];
      const bySha = new Map();
      for (const path of new Set([...assets, ...covers])) {
        const size = statSync(path).size;
        if (!size) fail(`文件是空的：${path}，补好后再交付`);
        const sha256 = await hashFile(path);
        files.push({ path, sha256, size, name: basename(path) });
        bySha.set(path, { sha256, size });
      }
      if (deliveryV1) {
        for (const file of deliveryFiles(raw)) {
          const actual = bySha.get(rel(file.name));
          if (actual.sha256 !== file.sha256.toLowerCase() || actual.size !== file.size) {
            throw Object.assign(new Error("素材「" + file.name + "」和清单里的 SHA-256 或大小不一致，请重新生成清单。"), { code: "hash_mismatch" });
          }
        }
      }
      const unique = uniqueBlobs(files);
      const bytes = unique.reduce((n, f) => n + f.size, 0);
      let targetPlatforms;
      if (deliveryV1) {
        const snapshot = await getGroupSnapshot(cfg).catch((err) => { if (!err.retryable) throw err; return null; });
        if (snapshot) {
          const target = snapshot.groups.find(({ name }) => name === groupName);
          if (!target) fail("发布机上没有「" + groupName + "」组，现在有：" + (snapshot.groups.map(({ name }) => name).join("、") || "没有账号组") + "。");
          targetPlatforms = [...new Set(target.accounts.map(({ platform }) => platform))];
        }
      }
      if (dryRun) {
        // 有快照时只报告目标组的平台；旧清单继续按全部平台预检。
        const platforms = targetPlatforms ?? Object.keys(COPY_LIMITS);
        for (const cut of checked.plan) {
          const version = cut.versions.find((v) => v.language === "zh") ?? cut.versions[0];
          for (const platform of platforms) {
            const copy = copyFor(version.meta?.copy, platform);
            const bad = copyViolations(platform, { ...copy, title: copy.title ?? cut.title });
            if (bad.length) onCopyViolation({ platform, cut: cut.title, language: version.language, reason: bad.join("；") });
          }
        }
        const warnings = [];
        const details = await ping({ ...cfg, details: true }).catch((err) => {
          if (!err.retryable) throw err;
          warnings.push({ code: err.code, message: err.message });
          return {};
        });
        if (deliveryV1 && !warnings.length) assertPublisherAccepts(details, raw.schema);
        const { freeBytes = null, minFreeBytes = MIN_FREE_BYTES } = details;
        const speeds = { ...BASELINE_TRANSFER };
        for (const key of Object.keys(speeds)) {
          if (Number.isFinite(details[key]) && details[key] > 0) speeds[key] = details[key];
        }
        if (freeBytes == null && !warnings.length) warnings.push({ code: "disk_unknown", message: "中转未回报剩余空间，请更新中转后再检查。" });
        if (freeBytes != null && freeBytes - bytes < minFreeBytes) {
          const gb = (n) => `${(n / 1024 ** 3).toFixed(1)}GB`;
          warnings.push({ code: "disk_low", message: `中转空间不够：剩余 ${gb(freeBytes)}，交付后需保留 ${gb(minFreeBytes)}。先清理中转，或等已入库的旧期满 7 天自动清理。` });
        }
        const uploadSeconds = transferSeconds(bytes, speeds.uploadBytesPerSecond);
        const downloadSeconds = transferSeconds(bytes, speeds.downloadBytesPerSecond);
        return {
          dryRun: true, group: groupName, title: checked.t, files: unique.map(({ name, size }) => ({ name, size })), bytes,
          etaSeconds: uploadSeconds + downloadSeconds, transfer: { ...speeds, uploadSeconds, downloadSeconds },
          freeBytes, minFreeBytes, rejected: targetPlatforms ? rejected.filter(({ platform }) => targetPlatforms.includes(platform)) : rejected, warnings,
        };
      }
      const blobOf = (o) => (o?.cover ? { cover: "blob:" + bySha.get(o.cover).sha256 } : {});
      const wire = deliveryV1 ? raw : {
        title: raw.title,
        ...(raw.source == null ? {} : { source: rel(raw.source.trim()) }),
        cuts: cuts.map((c) => ({ ...c, ...blobOf(c), versions: c.versions.map((v) => ({ ...v, ...blobOf(v), asset: "blob:" + bySha.get(v.asset).sha256 })) })),
      };
      const id = newDeliveryId();
      const createdAt = Date.now();
      const upload = { id, url: cfg.url, connectionKey: relayConnectionKey(cfg), title: checked.t, group: groupName, totalBytes: bytes, createdAt, updatedAt: createdAt, sent: 0,
        uploadBytesPerSecond: BASELINE_TRANSFER.uploadBytesPerSecond };
      if (uploadQueue) {
        if (deliveryV1) {
          const info = await ping(cfg).catch((err) => { if (!err.retryable) throw err; return null; });
          if (info) assertPublisherAccepts(info, raw.schema);
        }
        const job = uploadQueue.register({ ...upload, manifest: wire, files: unique });
        const sent = await uploadQueue.flush?.(cfg, job.id);
        if (sent?.delivery) {
          return { id: job.id, state: sent.delivery.state, group: groupName, files: unique.length, bytes, message: `已上传到中转，投递 ${job.id}，等发布机拉取（发布机上之后一律待确认，不会自动发）` };
        }
        if (sent?.failure && !sent.failure.retryable) throw Object.assign(sent.failure, { hint: `${sent.nextStep} 投递号 ${job.id}` });
        const message = uploadQueue.flush
          ? `已排队，投递 ${job.id}。下次交付会继续上传。`
          : `已登记，投递 ${job.id}，后台会上传。`;
        const warning = sent?.failure && { code: sent.failure.code, message: sent.failure.message };
        return { id: job.id, state: "pending", group: groupName, files: unique.length, bytes, message, ...(warning ? { warning } : {}) };
      }
      log(`[relay] 上传 ${files.length} 个文件到中转…`);
      uploading.set(id, upload);
      try {
        const delivery = await pushDelivery({
          ...cfg, id, group: groupName, manifest: wire, files: unique,
          onProgress: ({ deliverySent }) => { upload.sent = deliverySent; upload.updatedAt = Date.now(); },
        });
        return { id: delivery.id, state: delivery.state, group: groupName, files: unique.length, bytes, message: `已上传到中转，投递 ${delivery.id}，等发布机拉取（发布机上之后一律待确认，不会自动发）` };
      } catch (err) {
        const errorCode = err.code ?? "upload_failed";
        const nextStep = err.hint ?? (errorCode === "disk_low" || errorCode === "quota_exceeded" ? "清出中转空间后，再从制作机重新交付。"
          : errorCode === "relay_disabled" ? "到我的 Hifabu 申请开通传片，再从制作机重新交付。"
          : "检查中转连接后，从制作机重新交付。");
        const failed = { ...upload, updatedAt: Date.now(), errorCode, reason: err.message, nextStep };
        state.finishJob(id, failed, Date.now() - RETENTION_MS);
        onFailure(id, failed);
        throw Object.assign(err, { hint: `${nextStep} 投递号 ${id}` });
      } finally {
        uploading.delete(id);
      }
    },

    "delivery.list": async () => {
      const cfg = makerConnection();
      const active = uploadQueue ? uploadQueue.list(cfg) : [...uploading.values()].filter((row) => sameMaker(row, cfg));
      const local = active.concat(makerFailures(cfg));
      const result = await listDeliveryStatus(cfg).catch((err) => {
        if (!local.length || (!err.retryable && err.code !== "relay_disabled")) throw err;
        return { deliveries: [], warning: err.message };
      });
      const { lastPullAt = null, downloadBytesPerSecond, warning } = result;
      const deliveries = result.deliveries.map((row) => deliveryStatusView(row, { lastPullAt, downloadBytesPerSecond }));
      const remoteIds = new Set(deliveries.map((row) => row.id));
      for (const row of local) if (!remoteIds.has(row.id)) deliveries.push(localStatus(row, lastPullAt));
      deliveries.sort((a, b) => b.createdAt - a.createdAt);
      return { deliveries, lastPullAt, ...(warning ? { warning } : {}) };
    },

    "delivery.show": async ({ id }) => {
      if (!/^dl_[0-9a-f]{12,32}$/.test(id)) fail("投递号不合法：请核对投递列表里的编号", "vk delivery list");
      const cfg = makerConnection();
      const active = uploadQueue ? uploadQueue.list(cfg).find((row) => row.id === id) : uploading.get(id);
      if (active && sameMaker(active, cfg)) return localStatus(active);
      try {
        const cloud = await getDeliveryStatus({ ...cfg, id });
        return deliveryStatusView(cloud, cloud);
      } catch (err) {
        const failed = makerFailures(cfg).find((row) => row.id === id);
        if (failed && (err.status === 404 || err.retryable || err.code === "relay_disabled")) return localStatus(failed);
        throw err;
      }
    },
  };
}
