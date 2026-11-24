// 云端中转（ADR-0003 的最小一步）：只存成片文件和投递清单。
//
//   · 不是数据库：成片按 sha256 存成文件，投递是一个 JSON 文件；没有 SQLite，不存平台登录态，不连任何平台。
//   · 只监听 127.0.0.1，HTTPS 由反向代理（Caddy）提供。
//   · 用 Hifabu 公钥离线验机器令牌。每个账号的文件、投递和来取记录独立保存。
//     迁移期可启用旧的推送、拉取令牌。无有效令牌一律 401，令牌不进日志。
//   · 发布机回报「已入库」满 7 天后清理文件；磁盘剩余不足 2GB 拒收，并说人话。
//
// 协议（都在 /v1 下）：
//   GET  /v1/ping?details=1               任一 token → { ok, role }，可附磁盘与实测速度
//   GET  /v1/blobs/:sha/status            推送 → { complete, received }
//   PUT  /v1/blobs/:sha?offset=N&total=T  推送：从 offset 续传；传满自动核对 sha256
//   GET  /v1/blobs/:sha                   拉取：支持 Range: bytes=N-（断点续传）
//   POST /v1/deliveries                   推送：{ id, group, manifest, blobs:[{sha256,size,name}] }，幂等
//   GET  /v1/deliveries?state=a,b         拉取：默认 pending,downloaded
//   GET  /v1/deliveries?view=maker        推送：查看投递（不领取）
//   GET  /v1/deliveries/:id               任一 token
//   POST /v1/deliveries/:id/state         拉取：下载进度、已下载、入库摘要或失败原因
//   GET, DELETE /v1/control/accounts/:id  账号服务控制凭据 → 读取用量或删除账号目录

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createMachineTokenVerifier, machineTokenTtlMs } from "../../cloud/src/machine-token.mjs";
import { createRelayControlVerifier, relayAccountId as ACCOUNT_ID } from "../../cloud/src/relay-control.mjs";

export const MIN_FREE_BYTES = 2 * 1024 ** 3;
export const RETENTION_MS = 7 * 864e5;
const STALE_PARTIAL_MS = 7 * 864e5;
const SHA = /^[0-9a-f]{64}$/;
const DELIVERY_ID = /^dl_[0-9a-f]{12,32}$/;
const STATES = ["pending", "downloaded", "ingested", "failed"];
const MAX_JSON = 5 * 1024 * 1024;

const digest = (s) => createHash("sha256").update(String(s)).digest();
const sameToken = (given, expected) => Boolean(expected) && timingSafeEqual(digest(given), digest(expected));

const gb = (n) => `${Math.round((n / 1024 ** 3) * 10) / 10}GB`;

const sizeOf = (p) => statSync(p, { throwIfNoEntry: false })?.size ?? null;

function storageAt(root) {
  const blobsDir = join(root, "blobs");
  const partialDir = join(root, "partial");
  const deliveriesDir = join(root, "deliveries");
  const ensure = () => {
    for (const dir of [blobsDir, partialDir, deliveriesDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  };
  const activityPath = join(root, "activity.json");
  const readActivity = () => existsSync(activityPath) ? JSON.parse(readFileSync(activityPath, "utf8")) : {};
  const saveActivity = (patch) => {
    const next = { ...readActivity(), ...patch };
    const tmp = `${activityPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, activityPath);
  };
  const blobPath = (sha) => join(blobsDir, sha);
  const partPath = (sha) => join(partialDir, `${sha}.part`);
  const deliveryPath = (id) => join(deliveriesDir, `${id}.json`);
  const readDelivery = (id) => {
    try {
      return JSON.parse(readFileSync(deliveryPath(id), "utf8"));
    } catch {
      return null;
    }
  };
  const writeDelivery = (d) => {
    const tmp = `${deliveryPath(d.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, deliveryPath(d.id));
  };
  const allDeliveries = () =>
    readdirSync(deliveriesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readDelivery(f.slice(0, -5)))
      .filter(Boolean);
  const usedBytes = (uploading) => {
    const filesBytes = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []).reduce((sum, entry) => {
      const path = join(dir, entry.name);
      return entry.isFile() && !uploading.has(path) ? sum + (sizeOf(path) ?? 0) : sum;
    }, 0);
    let active = 0;
    for (const upload of uploading.values()) {
      if (upload.root === root) active += upload.total;
    }
    return filesBytes(blobsDir) + filesBytes(partialDir) + active;
  };
  return { root, ensure, blobsDir, partialDir, blobPath, partPath, readDelivery, writeDelivery, allDeliveries, usedBytes, readActivity, saveActivity };
}

export function createRelayServer({
  dataDir,
  pushToken,
  pullToken,
  machinePublicKey,
  allowLegacyTokens = machinePublicKey == null,
  minFreeBytes = MIN_FREE_BYTES,
  retentionMs = RETENTION_MS,
  freeBytes = null,
  now = () => Date.now(),
  log = () => {},
  sweepEveryMs = 3600e3,
} = {}) {
  if (!dataDir) throw new Error("relay：缺数据目录");
  if (allowLegacyTokens && (!pushToken || !pullToken)) throw new Error("relay：推送 token 和拉取 token 都要有");
  if (allowLegacyTokens && pushToken === pullToken) throw new Error("relay：推送 token 和拉取 token 不能相同");
  if (!allowLegacyTokens && machinePublicKey == null) throw new Error("relay：关闭固定令牌后必须配置 Hifabu 验签公钥");
  const verifyMachine = machinePublicKey == null ? null : createMachineTokenVerifier(machinePublicKey, { clock: now });
  const verifyControl = machinePublicKey == null ? null : createRelayControlVerifier(machinePublicKey, now);

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const legacy = storageAt(dataDir);
  if (allowLegacyTokens) legacy.ensure();
  const uploading = new Map();
  const activeAccounts = new Map();
  // Store only hashed IDs, outside the deleted directory, until all outstanding machine tokens expire.
  const revocationsDir = join(dataDir, ".revoked-accounts");
  const revocationPath = (accountId) => join(revocationsDir, digest(accountId).toString("hex"));
  const revoked = (path, at) => existsSync(path) && Number(readFileSync(path, "utf8")) > at;
  const reservedBytes = () => {
    let bytes = 0;
    for (const [part, upload] of uploading) {
      bytes += Math.max(0, upload.total - (sizeOf(part) ?? 0));
    }
    return bytes;
  };
  const free = () => {
    if (freeBytes) return freeBytes();
    const s = statfsSync(dataDir);
    return Number(s.bavail) * Number(s.bsize);
  };
  const lowDisk = (incoming = 0) => {
    const reserved = reservedBytes();
    const left = free();
    return left - reserved - incoming < minFreeBytes
      ? `中转空间不够：云端磁盘剩余 ${gb(left)}，${left < minFreeBytes ? "不足" : "上传后会不足"} ${gb(minFreeBytes)}。先清理云端磁盘，或等已入库的文件满 7 天自动清理`
      : null;
  };

  /** 对外只给发布机需要的字段。 */
  const view = (d) => ({
    id: d.id,
    group: d.group,
    state: d.state,
    manifest: d.manifest,
    blobs: d.blobs,
    created_at: d.created_at,
    updated_at: d.updated_at,
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.error_code ? { error_code: d.error_code } : {}),
    ...(d.next_step ? { next_step: d.next_step } : {}),
    ...(d.summary ? { summary: d.summary } : {}),
    ...(d.progress ? { progress: d.progress } : {}),
    ...(d.ingested_at ? { ingested_at: d.ingested_at } : {}),
    ...(d.files_purged ? { files_purged: true } : {}),
  });

  /** 已入库满保留期的投递：文件不再被任何还需要它的投递引用时删掉。 */
  function sweepStorage(storage, at, account) {
    const { allDeliveries, blobPath, writeDelivery, blobsDir, partialDir } = storage;
    const all = allDeliveries();
    const keep = new Set();
    const due = [];
    for (const d of all) {
      const expired = d.state === "ingested" && d.ingested_at != null && at - d.ingested_at >= retentionMs;
      if (expired) due.push(d);
      else if (!d.files_purged) for (const b of d.blobs ?? []) keep.add(b.sha256);
    }
    let removed = 0;
    for (const d of due) {
      for (const b of d.blobs ?? []) {
        if (keep.has(b.sha256) || !existsSync(blobPath(b.sha256))) continue;
        rmSync(blobPath(b.sha256), { force: true });
        removed += 1;
      }
      if (!d.files_purged) writeDelivery({ ...d, files_purged: true, updated_at: at });
    }
    let partials = 0;
    for (const f of readdirSync(partialDir)) {
      const p = join(partialDir, f);
      if (uploading.has(p)) continue;
      if (at - statSync(p).mtimeMs >= STALE_PARTIAL_MS) {
        rmSync(p, { force: true });
        partials += 1;
      }
    }
    // 上传完成但没有建投递的文件也会占容量，给断点续传和重试保留七天。
    if (account) {
      for (const sha of readdirSync(blobsDir)) {
        const path = blobPath(sha);
        if (keep.has(sha) || at - statSync(path).mtimeMs < STALE_PARTIAL_MS) continue;
        rmSync(path, { force: true });
        removed += 1;
      }
    }
    return { removed, partials };
  }

  function sweep({ at = now() } = {}) {
    if (existsSync(revocationsDir)) {
      for (const name of readdirSync(revocationsDir)) {
        const path = join(revocationsDir, name);
        if (SHA.test(name.slice(0, -4)) && name.endsWith(".tmp")) rmSync(path, { force: true });
        else if (SHA.test(name) && !revoked(path, at)) rmSync(path, { force: true });
      }
    }
    let removed = 0;
    let partials = 0;
    if (allowLegacyTokens || existsSync(legacy.blobsDir)) {
      legacy.ensure();
      ({ removed, partials } = sweepStorage(legacy, at, false));
    }
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ACCOUNT_ID.test(entry.name)) continue;
      const storage = storageAt(join(dataDir, entry.name));
      storage.ensure();
      const result = sweepStorage(storage, at, true);
      removed += result.removed;
      partials += result.partials;
    }
    if (removed || partials) log(`[relay] 清理了 ${removed} 个过期成片、${partials} 个过期的半截上传`);
    return { removed, partials };
  }

  // ---------------------------------------------------------------- HTTP

  const send = (res, status, body, headers = {}) => {
    const payload = body == null ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...headers });
    res.end(payload);
  };
  const drain = (req) => req.resume();

  async function readJson(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_JSON) throw Object.assign(new Error("请求体太大"), { status: 413 });
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw Object.assign(new Error("请求体不是合法的 JSON"), { status: 400 });
    }
  }

  const bearerOf = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const authOf = (req) => {
    const token = bearerOf(req);
    if (!token) return null;
    if (allowLegacyTokens) {
      if (sameToken(token, pushToken)) return { role: "push", storage: legacy };
      if (sameToken(token, pullToken)) return { role: "pull", storage: legacy };
    }
    const claims = verifyMachine?.(token);
    if (!claims || revoked(revocationPath(claims.sub), now())) return null;
    return {
      accountId: claims.sub,
      role: claims.role === "maker" ? "push" : "pull",
      relayEnabled: claims.relayEnabled,
      capacityBytes: claims.capacityBytes,
      storage: storageAt(join(dataDir, claims.sub)),
    };
  };

  async function putBlob(req, res, sha, url, { storage, capacityBytes }) {
    const { root, blobPath, partPath, usedBytes, saveActivity } = storage;
    const total = Number(url.searchParams.get("total"));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > total) {
      drain(req);
      return send(res, 400, { error: "bad_request", message: "缺 total 或 offset" });
    }
    if (existsSync(blobPath(sha))) {
      drain(req);
      return send(res, 200, { complete: true, received: sizeOf(blobPath(sha)) });
    }
    const part = partPath(sha);
    const have = sizeOf(part) ?? 0;
    if (offset !== have) {
      drain(req);
      return send(res, 409, { error: "offset_mismatch", received: have, message: `续传位置不对：云端已收到 ${have} 字节` });
    }
    const incoming = total - have;
    if (capacityBytes != null) {
      const remainingBytes = Math.max(0, capacityBytes - usedBytes(uploading));
      if (incoming > remainingBytes) {
        drain(req);
        log(`[relay] quota_exceeded 传片容量不足，剩余 ${remainingBytes} 字节`);
        return send(res, 413, { error: "quota_exceeded", remainingBytes, message: `Hifabu 账号的传片容量不足，还剩 ${remainingBytes} 字节。等已入库的文件满 7 天清理后再试。` });
      }
    }
    const low = lowDisk(incoming);
    if (low) {
      drain(req);
      log("[relay] disk_low 磁盘不足，拒收");
      return send(res, 507, { error: "disk_low", message: low });
    }
    if (Number(req.headers["content-length"]) > incoming) {
      drain(req);
      return send(res, 422, { error: "size_mismatch", message: "上传的文件超过声明的大小，请核对素材后重新上传" });
    }
    const started = performance.now();
    let remaining = incoming;
    let oversized = false;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        if (chunk.length > remaining) oversized = true;
        remaining -= chunk.length;
        callback(null, oversized ? undefined : chunk);
      },
    });
    uploading.set(part, { root, total });
    try {
      await pipeline(req, limit, createWriteStream(part, { flags: offset ? "a" : "w", mode: 0o600 }));
      if (oversized) {
        rmSync(part, { force: true });
        return send(res, 422, { error: "size_mismatch", message: "上传的文件超过声明的大小，请核对素材后重新上传" });
      }
      const elapsed = performance.now() - started;
      const got = sizeOf(part) ?? 0;
      if (got < total) return send(res, 202, { complete: false, received: got });
      const h = createHash("sha256");
      await pipeline(createReadStream(part), h);
      if (h.digest("hex") !== sha) {
        rmSync(part, { force: true });
        return send(res, 422, { error: "hash_mismatch", message: "上传的文件和声明的 sha256 对不上，已丢弃，请重新上传" });
      }
      renameSync(part, blobPath(sha));
      if (elapsed >= 100 && got > have) saveActivity({ uploadBytesPerSecond: Math.round((got - have) * 1000 / elapsed) });
      return send(res, 201, { complete: true, received: got });
    } catch (err) {
      if (!["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(err.code)) throw err;
    } finally {
      uploading.delete(part);
    }
  }

  function getBlob(req, res, sha, { blobPath }) {
    const p = blobPath(sha);
    const size = sizeOf(p);
    if (size == null) return send(res, 404, { error: "not_found", message: "没有这个文件（可能已清理）" });
    let start = 0;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (range) start = Number(range[1]);
    if (start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(range ? 206 : 200, {
      "content-type": "application/octet-stream",
      "content-length": size - start,
      "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${start}-${size - 1}/${size}` } : {}),
    });
    return pipeline(createReadStream(p, { start }), res).catch(() => {});
  }

  async function postDelivery(req, res, { readDelivery, writeDelivery, blobPath }) {
    const body = await readJson(req);
    const { id, group, manifest, blobs } = body;
    if (!DELIVERY_ID.test(id ?? "")) return send(res, 400, { error: "bad_request", message: "投递 id 不合法" });
    const old = readDelivery(id);
    if (old) return send(res, 200, view(old)); // 幂等：重试不重复建
    if (typeof group !== "string" || !group.trim()) return send(res, 400, { error: "bad_request", message: "缺账号组" });
    if (!manifest || typeof manifest !== "object") return send(res, 400, { error: "bad_request", message: "缺清单" });
    if (!Array.isArray(blobs) || !blobs.length || blobs.some((b) => !SHA.test(b?.sha256 ?? "") || !Number.isInteger(b?.size) || typeof b?.name !== "string")) {
      return send(res, 400, { error: "bad_request", message: "文件列表不合法" });
    }
    const low = lowDisk();
    if (low) return send(res, 507, { error: "disk_low", message: low });
    const missing = blobs.filter((b) => sizeOf(blobPath(b.sha256)) !== b.size).map((b) => b.sha256);
    if (missing.length) return send(res, 409, { error: "missing_blobs", missing, message: "还有文件没传完，先把文件传完再建投递" });
    const at = now();
    const d = { id, group: group.trim(), manifest, blobs: blobs.map(({ sha256, size, name }) => ({ sha256, size, name })), state: "pending", created_at: at, updated_at: at };
    writeDelivery(d);
    log(`[relay] 收到投递 ${id}（${d.blobs.length} 个文件）`);
    return send(res, 201, view(d));
  }

  async function postState(req, res, id, { readDelivery, writeDelivery, saveActivity }) {
    const { state, reason, summary, progress, errorCode, nextStep, downloadBytesPerSecond } = await readJson(req);
    const d = readDelivery(id);
    if (!d) return send(res, 404, { error: "not_found", message: "没有这个投递" });
    if (!["downloading", "downloaded", "ingested", "failed"].includes(state)) return send(res, 400, { error: "bad_request", message: "投递回报状态不合法" });
    // 已入库的不再倒退：重复回报是幂等的。
    if (d.state === "ingested" || (d.state === "failed" && ["downloading", "downloaded"].includes(state))) return send(res, 200, view(d));
    const at = now();
    const next = { ...d, state: state === "downloading" ? d.state : state, updated_at: at };
    delete next.progress;
    if (state === "downloading" && progress != null) {
      const total = d.blobs.reduce((n, b) => n + b.size, 0);
      const { received, bytesPerSecond } = progress;
      if (!Number.isSafeInteger(received) || received < 0 || received > total) return send(res, 400, { error: "bad_request", message: "下载进度字节数不合法" });
      next.progress = { received, total, ...(bytesPerSecond > 0 && Number.isFinite(bytesPerSecond) ? { bytesPerSecond } : {}), at };
    }
    if (state === "downloaded" && downloadBytesPerSecond > 0 && Number.isFinite(downloadBytesPerSecond)) {
      saveActivity({ downloadBytesPerSecond });
    }
    if (state === "ingested") {
      next.ingested_at = at;
      if (typeof reason === "string" && reason) next.reason = reason.slice(0, 500);
      else delete next.reason;
      delete next.error_code;
      delete next.next_step;
      if (summary && typeof summary === "object" && !Array.isArray(summary)) next.summary = summary;
    }
    if (state === "failed") {
      next.reason = String(reason ?? "").slice(0, 500) || "发布机没说原因";
      if (typeof errorCode === "string") next.error_code = errorCode.slice(0, 80);
      if (typeof nextStep === "string") next.next_step = nextStep.slice(0, 500);
    }
    writeDelivery(next);
    log(`[relay] 投递 ${id} → ${state}`);
    return send(res, 200, view(next));
  }

  function controlAccount(req, res, accountId) {
    drain(req);
    if (!verifyControl?.(bearerOf(req), req.method, accountId)) {
      log("[relay] account.control_denied 传片管理凭据无效");
      return send(res, 401, { error: "unauthorized", message: "传片管理凭据无效。" });
    }
    const root = join(dataDir, accountId);
    if (req.method === "GET") {
      return send(res, 200, { usedBytes: storageAt(root).usedBytes(uploading), freeBytes: free() });
    }
    if (activeAccounts.has(accountId)) {
      log("[relay] account.delete_busy 账号还有传片请求正在处理");
      return send(res, 409, { error: "account_busy", message: "这个账号正在传片，请稍后重试删除。" });
    }
    try {
      mkdirSync(revocationsDir, { recursive: true, mode: 0o700 });
      const marker = revocationPath(accountId);
      const pending = `${marker}.tmp`;
      writeFileSync(pending, String(now() + machineTokenTtlMs), { mode: 0o600 });
      renameSync(pending, marker);
      rmSync(root, { recursive: true, force: true });
    } catch {
      log("[relay] account.delete_failed 无法删除账号的传片目录");
      return send(res, 500, { error: "account_delete_failed", message: "无法删除账号的传片目录，请稍后重试。" });
    }
    log("[relay] account.deleted 已删除账号的传片目录");
    return send(res, 200, { deleted: true });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://relay.local");
    const controlId = /^\/v1\/control\/accounts\/([^/]+)$/.exec(url.pathname)?.[1];
    if (controlId) return controlAccount(req, res, controlId);
    const auth = authOf(req);
    const deny = () => send(res, 401, { error: "unauthorized", message: "中转不认这个 token。请核对这台机器的 Hifabu 登录、机器角色和中转连接。" });
    if (!auth) {
      drain(req);
      return deny();
    }
    if (auth.relayEnabled === false) {
      drain(req);
      log("[relay] relay_disabled Hifabu 账号未开通传片");
      return send(res, 403, { error: "relay_disabled", message: "你的 Hifabu 账号还没开通两台电脑之间传片。请到我的 Hifabu 申请开通。" });
    }
    const { accountId } = auth;
    if (!accountId) return handleDelivery(req, res, url, auth, deny);
    activeAccounts.set(accountId, (activeAccounts.get(accountId) ?? 0) + 1);
    try {
      return await handleDelivery(req, res, url, auth, deny);
    } finally {
      const active = activeAccounts.get(accountId) - 1;
      if (active) activeAccounts.set(accountId, active);
      else activeAccounts.delete(accountId);
    }
  }

  function handleDelivery(req, res, url, auth, deny) {
    const { role, storage } = auth;
    const { blobPath, partPath, allDeliveries, readDelivery, readActivity, saveActivity } = storage;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") {
      drain(req);
      return send(res, 404, { error: "not_found" });
    }
    const [, kind, key, tail] = parts;
    const need = (r) => {
      if (role === r) return true;
      drain(req);
      deny();
      return false;
    };
    storage.ensure();
    const m = req.method;

    if (kind === "ping" && m === "GET") {
      const details = url.searchParams.get("details") === "1";
      return send(res, 200, { ok: true, role, ...(details ? { ...readActivity(), freeBytes: free(), minFreeBytes } : {}) });
    }
    if (kind === "blobs" && SHA.test(key ?? "")) {
      if (tail === "status" && m === "GET") {
        if (!need("push")) return;
        const done = sizeOf(blobPath(key));
        return send(res, 200, done != null ? { complete: true, received: done } : { complete: false, received: sizeOf(partPath(key)) ?? 0 });
      }
      if (!tail && m === "PUT") {
        if (!need("push")) return;
        // 上一条连接的文件流可能还在关闭，等它结束再追加，防止两个 PUT 从同一位置写。
        if (uploading.has(partPath(key))) {
          drain(req);
          return send(res, 409, { error: "upload_busy", received: sizeOf(partPath(key)) ?? 0, message: "中转还在收同一个文件，稍后续传" });
        }
        return putBlob(req, res, key, url, auth);
      }
      if (!tail && m === "GET") return need("pull") && getBlob(req, res, key, storage);
    }
    if (kind === "deliveries") {
      if (!key && m === "POST") return need("push") && postDelivery(req, res, storage);
      if (!key && m === "GET") {
        if (url.searchParams.get("view") === "maker") {
          if (!need("push")) return;
          const rows = allDeliveries().sort((a, b) => b.created_at - a.created_at);
          const activity = readActivity();
          return send(res, 200, { deliveries: rows.map(view), lastPullAt: activity.lastPullAt ?? null, downloadBytesPerSecond: activity.downloadBytesPerSecond ?? null });
        }
        if (!need("pull")) return;
        saveActivity({ lastPullAt: now() });
        const want = (url.searchParams.get("state") ?? "pending,downloaded").split(",").filter((s) => STATES.includes(s));
        const rows = allDeliveries().filter((d) => want.includes(d.state)).sort((a, b) => a.created_at - b.created_at);
        return send(res, 200, { deliveries: rows.map(view) });
      }
      if (DELIVERY_ID.test(key ?? "")) {
        if (!tail && m === "GET") {
          const d = readDelivery(key);
          const activity = d && readActivity();
          return d
            ? send(res, 200, { ...view(d), lastPullAt: activity.lastPullAt ?? null, downloadBytesPerSecond: activity.downloadBytesPerSecond ?? null })
            : send(res, 404, { error: "not_found", message: "没有这个投递" });
        }
        if (tail === "state" && m === "POST") return need("pull") && postState(req, res, key, storage);
      }
    }
    drain(req);
    return send(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[relay] 处理请求出错：${err.message}`);
      if (!res.headersSent) send(res, err.status ?? 500, { error: "error", message: err.status ? err.message : "云端出错了，稍后再试" });
      else res.destroy();
    });
  });

  let timer = null;
  return {
    server,
    sweep,
    /** 只绑 127.0.0.1：公网入口由反向代理给。 */
    listen: ({ port = 0 } = {}) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          try {
            sweep();
          } catch (err) {
            log(`[relay] 启动清理失败：${err.message}`);
          }
          timer = setInterval(() => {
            try {
              sweep();
            } catch (err) {
              log(`[relay] 清理失败：${err.message}`);
            }
          }, sweepEveryMs);
          timer.unref?.();
          resolve(server.address().port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (timer) clearInterval(timer);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
