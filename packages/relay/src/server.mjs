// 云端中转（ADR-0003 的最小一步）：只存成片文件和投递清单。
//
//   · 不是数据库：成片按 sha256 存成文件，投递是一个 JSON 文件；没有 SQLite，不存平台登录态，不连任何平台。
//   · 只监听 127.0.0.1，HTTPS 由反向代理（Caddy）提供。
//   · 两个 token：推送（制作机）和拉取（发布机）。没有 token 或 token 错，所有路径一律 401，
//     也不区分「路径不存在」，不泄露有哪些投递。token 不进日志。
//   · 发布机回报「已入库」满 7 天后清理文件；磁盘剩余不足 2GB 拒收，并说人话。
//
// 协议（都在 /v1 下）：
//   GET  /v1/ping                         任一 token → { ok, role }
//   GET  /v1/blobs/:sha/status            推送 → { complete, received }
//   PUT  /v1/blobs/:sha?offset=N&total=T  推送：从 offset 续传；传满自动核对 sha256
//   GET  /v1/blobs/:sha                   拉取：支持 Range: bytes=N-（断点续传）
//   POST /v1/deliveries                   推送：{ id, group, manifest, blobs:[{sha256,size,name}] }，幂等
//   GET  /v1/deliveries?state=a,b         拉取：默认 pending,downloaded
//   GET  /v1/deliveries/:id               任一 token
//   POST /v1/deliveries/:id/state         拉取：{ state: downloaded|ingested|failed, reason? }

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

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

export function createRelayServer({
  dataDir,
  pushToken,
  pullToken,
  minFreeBytes = MIN_FREE_BYTES,
  retentionMs = RETENTION_MS,
  freeBytes = null,
  now = () => Date.now(),
  log = () => {},
  sweepEveryMs = 3600e3,
} = {}) {
  if (!dataDir) throw new Error("relay：缺数据目录");
  if (!pushToken || !pullToken) throw new Error("relay：推送 token 和拉取 token 都要有");
  if (pushToken === pullToken) throw new Error("relay：推送 token 和拉取 token 不能相同");

  const blobsDir = join(dataDir, "blobs");
  const partialDir = join(dataDir, "partial");
  const deliveriesDir = join(dataDir, "deliveries");
  for (const dir of [blobsDir, partialDir, deliveriesDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const free = () => {
    if (freeBytes) return freeBytes();
    const s = statfsSync(dataDir);
    return Number(s.bavail) * Number(s.bsize);
  };
  const lowDisk = () => {
    const left = free();
    return left < minFreeBytes ? `云端磁盘剩余 ${gb(left)}，不足 ${gb(minFreeBytes)}，暂时不收新文件：先清理云端磁盘，或等发布机把已投递的拉走（已入库的文件 7 天后自动清理）` : null;
  };

  const blobPath = (sha) => join(blobsDir, sha);
  const partPath = (sha) => join(partialDir, `${sha}.part`);
  const deliveryPath = (id) => join(deliveriesDir, `${id}.json`);
  const sizeOf = (p) => (existsSync(p) ? statSync(p).size : null);
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
    ...(d.ingested_at ? { ingested_at: d.ingested_at } : {}),
    ...(d.files_purged ? { files_purged: true } : {}),
  });

  /** 已入库满保留期的投递：文件不再被任何还需要它的投递引用时删掉。 */
  function sweep({ at = now() } = {}) {
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
      if (at - statSync(p).mtimeMs >= STALE_PARTIAL_MS) {
        rmSync(p, { force: true });
        partials += 1;
      }
    }
    if (removed || partials) log(`[relay] 清理了 ${removed} 个已入库超过 ${Math.round(retentionMs / 864e5)} 天的文件、${partials} 个过期的半截上传`);
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

  const roleOf = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    if (sameToken(m[1], pushToken)) return "push";
    if (sameToken(m[1], pullToken)) return "pull";
    return null;
  };

  async function putBlob(req, res, sha, url) {
    const total = Number(url.searchParams.get("total"));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(offset) || offset < 0) {
      drain(req);
      return send(res, 400, { error: "bad_request", message: "缺 total 或 offset" });
    }
    if (existsSync(blobPath(sha))) {
      drain(req);
      return send(res, 200, { complete: true, received: sizeOf(blobPath(sha)) });
    }
    const low = lowDisk();
    if (low) {
      drain(req);
      log("[relay] 磁盘不足，拒收");
      return send(res, 507, { error: "disk_low", message: low });
    }
    const part = partPath(sha);
    const have = sizeOf(part) ?? 0;
    if (offset !== have) {
      drain(req);
      return send(res, 409, { error: "offset_mismatch", received: have, message: `续传位置不对：云端已收到 ${have} 字节` });
    }
    try {
      await pipeline(req, createWriteStream(part, { flags: offset ? "a" : "w", mode: 0o600 }));
    } catch {
      return; // 连接断了：半截留着，下次从云端收到的位置续传
    }
    const got = sizeOf(part) ?? 0;
    if (got < total) return send(res, 202, { complete: false, received: got });
    const h = createHash("sha256");
    await pipeline(createReadStream(part), h);
    if (got > total || h.digest("hex") !== sha) {
      rmSync(part, { force: true });
      return send(res, 422, { error: "hash_mismatch", message: "上传的文件和声明的 sha256 对不上，已丢弃，请重新上传" });
    }
    renameSync(part, blobPath(sha));
    return send(res, 201, { complete: true, received: got });
  }

  function getBlob(req, res, sha) {
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
    pipeline(createReadStream(p, { start }), res).catch(() => {});
  }

  async function postDelivery(req, res) {
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

  async function postState(req, res, id) {
    const d = readDelivery(id);
    if (!d) return send(res, 404, { error: "not_found", message: "没有这个投递" });
    const { state, reason } = await readJson(req);
    if (!["downloaded", "ingested", "failed"].includes(state)) return send(res, 400, { error: "bad_request", message: "state 只能是 downloaded / ingested / failed" });
    // 已入库的不再倒退：重复回报是幂等的。
    if (d.state === "ingested" || (d.state === "failed" && state === "downloaded")) return send(res, 200, view(d));
    const at = now();
    const next = { ...d, state, updated_at: at };
    if (state === "ingested") {
      next.ingested_at = at;
      if (typeof reason === "string" && reason) next.reason = reason.slice(0, 500);
      else delete next.reason;
    }
    if (state === "failed") next.reason = String(reason ?? "").slice(0, 500) || "发布机没说原因";
    writeDelivery(next);
    log(`[relay] 投递 ${id} → ${state}`);
    return send(res, 200, view(next));
  }

  async function handle(req, res) {
    const role = roleOf(req);
    const deny = () => send(res, 401, { error: "unauthorized", message: "需要有效的 token" });
    if (!role) {
      drain(req);
      return deny();
    }
    const url = new URL(req.url, "http://relay.local");
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
    const m = req.method;

    if (kind === "ping" && m === "GET") return send(res, 200, { ok: true, role });
    if (kind === "blobs" && SHA.test(key ?? "")) {
      if (tail === "status" && m === "GET") {
        if (!need("push")) return;
        const done = sizeOf(blobPath(key));
        return send(res, 200, done != null ? { complete: true, received: done } : { complete: false, received: sizeOf(partPath(key)) ?? 0 });
      }
      if (!tail && m === "PUT") return need("push") && putBlob(req, res, key, url);
      if (!tail && m === "GET") return need("pull") && getBlob(req, res, key);
    }
    if (kind === "deliveries") {
      if (!key && m === "POST") return need("push") && postDelivery(req, res);
      if (!key && m === "GET") {
        if (!need("pull")) return;
        const want = (url.searchParams.get("state") ?? "pending,downloaded").split(",").filter((s) => STATES.includes(s));
        const rows = allDeliveries().filter((d) => want.includes(d.state)).sort((a, b) => a.created_at - b.created_at);
        return send(res, 200, { deliveries: rows.map(view) });
      }
      if (DELIVERY_ID.test(key ?? "")) {
        if (!tail && m === "GET") {
          const d = readDelivery(key);
          return d ? send(res, 200, view(d)) : send(res, 404, { error: "not_found", message: "没有这个投递" });
        }
        if (tail === "state" && m === "POST") return need("pull") && postState(req, res, key);
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
