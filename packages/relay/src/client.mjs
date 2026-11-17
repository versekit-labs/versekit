// 中转的客户端一侧：制作机上传（可断点续传）、发布机下载（Range 续传 + sha256 核对）。
// 不碰数据库、不碰平台；token 只放在 Authorization 头里，不进日志、不进错误信息。

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export class RelayError extends Error {
  constructor(message, { status = null, code = "relay_error", retryable = false, data = null } = {}) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.data = data;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = (url) => String(url).replace(/\/+$/, "");

export async function hashFile(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/** 网络错误和 5xx/408/429 值得重试；401/409/422/507 这类重试也没用。 */
export async function withRetry(fn, { retries = 5, backoffMs = 1000, sleepImpl = sleep, onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = err instanceof RelayError ? err.retryable : true;
      if (!retryable || attempt >= retries) throw err;
      onRetry(err, attempt + 1);
      await sleepImpl(backoffMs * 2 ** Math.min(attempt, 5));
    }
  }
}

async function request({ url, token, method = "GET", path, body, headers = {}, duplex, signal }) {
  let res;
  try {
    res = await fetch(`${base(url)}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body && typeof body === "string" ? { "content-type": "application/json" } : {}), ...headers },
      body,
      duplex,
      signal,
    });
  } catch (err) {
    throw new RelayError(`连不上中转（${err.cause?.code ?? err.message}）`, { code: "unreachable", retryable: true });
  }
  return res;
}

async function failOf(res, fallback) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 没有 JSON 正文 */
  }
  if (res.status === 401) return new RelayError("中转不认这个 token：核对地址和 token 是否配对（推送用推送 token，拉取用拉取 token）", { status: 401, code: "unauthorized", data });
  return new RelayError(data?.message ?? `${fallback}（中转返回 ${res.status}）`, {
    status: res.status,
    code: data?.error ?? "relay_error",
    retryable: res.status >= 500 || res.status === 408 || res.status === 429,
    data,
  });
}

export async function ping({ url, token }) {
  const res = await request({ url, token, path: "/v1/ping" });
  if (!res.ok) throw await failOf(res, "连接中转失败");
  return res.json();
}

/** 读流时盯着进度：停住太久就掐断让重试接上，不然一条死连接会把后台拉取永远挂住。 */
function watch(onBytes, controller, stallMs) {
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    if (stallMs > 0) timer = setTimeout(() => controller.abort(), stallMs);
  };
  arm();
  const t = new Transform({
    transform(chunk, _enc, cb) {
      arm();
      onBytes(chunk.length);
      cb(null, chunk);
    },
    flush(cb) {
      clearTimeout(timer);
      cb();
    },
  });
  t.on("error", () => clearTimeout(timer));
  return { stream: t, stop: () => clearTimeout(timer) };
}

/**
 * 上传一个文件。先问云端收到多少，从那里续传；整个文件传满后云端核对 sha256。
 * `retries` 内的网络失败自动续传，调用方不用管。
 */
export async function pushBlob({ url, token, file, sha256, size, onProgress = () => {}, retries = 5, backoffMs = 1000, stallMs = 60e3 }) {
  return withRetry(
    async () => {
      const st = await request({ url, token, path: `/v1/blobs/${sha256}/status` });
      if (!st.ok) throw await failOf(st, "查询上传进度失败");
      const { complete, received } = await st.json();
      if (complete) {
        onProgress(size, size);
        return { skipped: true };
      }
      const controller = new AbortController();
      const w = watch((n) => onProgress(Math.min(size, (w.sent += n)), size), controller, stallMs);
      w.sent = received;
      onProgress(received, size);
      const body = Readable.toWeb(createReadStream(file, { start: received }).pipe(w.stream));
      let res;
      try {
        res = await request({ url, token, method: "PUT", path: `/v1/blobs/${sha256}?offset=${received}&total=${size}`, body, duplex: "half", signal: controller.signal });
      } catch (err) {
        w.stop();
        throw err;
      }
      w.stop();
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        throw new RelayError("云端收到的位置和本地对不上，从云端的位置重新续传", { status: 409, code: "offset_mismatch", retryable: true, data });
      }
      if (!res.ok) throw await failOf(res, "上传失败");
      const out = await res.json();
      if (!out.complete) throw new RelayError("上传中断，续传", { code: "incomplete", retryable: true });
      return out;
    },
    { retries, backoffMs },
  );
}

/** 上传一次投递：所有文件（同 sha 只传一次）+ 清单。返回投递 id。 */
export async function pushDelivery({ url, token, group, manifest, files, onProgress = () => {}, retries = 5, backoffMs = 1000, id = `dl_${randomBytes(8).toString("hex")}` }) {
  // files: [{ sha256, size, name, path }]
  const unique = [...new Map(files.map((f) => [f.sha256, f])).values()];
  for (const f of unique) await pushBlob({ url, token, file: f.path, sha256: f.sha256, size: f.size, onProgress: (sent, total) => onProgress({ name: f.name, sent, total }), retries, backoffMs });
  const body = JSON.stringify({ id, group, manifest, blobs: unique.map(({ sha256, size, name }) => ({ sha256, size, name })) });
  const delivery = await withRetry(
    async () => {
      const res = await request({ url, token, method: "POST", path: "/v1/deliveries", body });
      if (!res.ok) throw await failOf(res, "建投递失败");
      return res.json();
    },
    { retries, backoffMs },
  );
  return delivery;
}

export async function listDeliveries({ url, token, states = null }) {
  const res = await request({ url, token, path: `/v1/deliveries${states ? `?state=${states.join(",")}` : ""}` });
  if (!res.ok) throw await failOf(res, "读取待拉取的投递失败");
  return (await res.json()).deliveries;
}

export async function reportState({ url, token, id, state, reason }) {
  const res = await request({ url, token, method: "POST", path: `/v1/deliveries/${id}/state`, body: JSON.stringify({ state, ...(reason ? { reason } : {}) }) });
  if (!res.ok) throw await failOf(res, "回报状态失败");
  return res.json();
}

/**
 * 下载一个文件到 dest：半截放 dest.part，用 Range 续传，下完核对 sha256 再改名。
 * 哈希对不上就丢掉半截并抛 `hash_mismatch`（不重试：重下一遍多半还是错，交给人看）。
 */
export async function downloadBlob({ url, token, sha256, size, dest, onProgress = () => {}, retries = 5, backoffMs = 1000, stallMs = 60e3 }) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  if (existsSync(dest)) {
    if (statSync(dest).size === size && (await hashFile(dest)) === sha256) return { cached: true };
    rmSync(dest, { force: true });
  }
  await withRetry(
    async () => {
      let have = existsSync(part) ? statSync(part).size : 0;
      if (have > size) {
        rmSync(part, { force: true });
        have = 0;
      }
      if (have < size) {
        const controller = new AbortController();
        const res = await request({ url, token, path: `/v1/blobs/${sha256}`, headers: have ? { range: `bytes=${have}-` } : {}, signal: controller.signal });
        if (!res.ok) throw await failOf(res, "下载失败");
        if (res.status === 200 && have) have = 0; // 对方没按 Range 回：从头来
        const w = watch((n) => onProgress(Math.min(size, (w.got += n)), size), controller, stallMs);
        w.got = have;
        onProgress(have, size);
        try {
          await pipeline(Readable.fromWeb(res.body), w.stream, createWriteStream(part, { flags: have ? "a" : "w" }));
        } catch (err) {
          throw new RelayError(`下载中断（${err.message}），稍后续传`, { code: "interrupted", retryable: true });
        } finally {
          w.stop();
        }
      }
      if (statSync(part).size !== size) throw new RelayError("下载没下完，续传", { code: "incomplete", retryable: true });
    },
    { retries, backoffMs },
  );
  if ((await hashFile(part)) !== sha256) {
    rmSync(part, { force: true });
    throw new RelayError("下载下来的文件和清单里的 sha256 对不上", { code: "hash_mismatch" });
  }
  renameSync(part, dest);
  return { cached: false };
}
