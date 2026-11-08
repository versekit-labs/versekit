// 手机拍板的第二种通道：签名审批链接。
//
// 不依赖飞书、不依赖账号体系：给一条带 HMAC 的 URL，手机浏览器打开就能看到
// 「发什么、为什么失败」，点批准/取消即执行。链接有有效期、只能做一件事、
// 重复点击按 command_audit 去重。

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { open, enqueue, newId } from "./index.mjs";
import { readConfig, updateConfig } from "./config.mjs";
import { transitionPublish } from "./index.mjs";
import { getPublishRow } from "./publish-flow.mjs";

export const APPROVAL_TTL_MS = 24 * 3600e3;
const RETRYABLE = new Set(["failed", "blocked", "expired", "notify_pending", "draft_pending"]);

function secret() {
  let s = readConfig().approval?.secret;
  if (!s) {
    s = randomBytes(32).toString("hex");
    updateConfig({ approval: { secret: s } });
  }
  return s;
}

const sign = (payload) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function signApproval({ publishId, decision = "retry", exp = Date.now() + APPROVAL_TTL_MS }) {
  const payload = Buffer.from(JSON.stringify({ v: 1, p: publishId, d: decision, e: exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyApproval(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2) throw new Error("审批链接格式不对");
  const [payload, sig] = parts;
  const expect = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("审批链接无效（签名对不上）");
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("审批链接内容坏了");
  }
  if (!data?.p) throw new Error("审批链接缺少发布 ID");
  if (!Number.isFinite(data.e) || data.e < Date.now()) throw new Error("审批链接已过期，请到电脑上重新生成");
  return data;
}

/** 局域网 IP：手机和电脑在同一 WiFi 时可直接打开。 */
export function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "127.0.0.1";
}

export function baseUrl() {
  const cfg = readConfig();
  return (
    process.env.VK_PUBLIC_URL ??
    cfg.server?.public_url ??
    `http://${cfg.server?.host && cfg.server.host !== "127.0.0.1" ? lanIp() : "127.0.0.1"}:${cfg.server?.port ?? 8787}`
  );
}

export function approvalLink(publishId, decision = "retry") {
  return `${baseUrl()}/a/${signApproval({ publishId, decision })}`;
}

export function approvalPath(publishId, decision = "retry") {
  return `/a/${signApproval({ publishId, decision })}`;
}

function audit(conn, { id, name, actor, args, result, reason, key, now }) {
  conn
    .prepare("INSERT OR IGNORE INTO command_audit (id, name, actor, origin, args_json, result, reason, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, name, actor, "link", JSON.stringify(args), result, reason, key, now);
}

/** 执行链接上的决定。retry = 重新排队，cancel = 取消这条。 */
export function applyApproval(token, decision, { actor = "link", now = Date.now() } = {}) {
  const data = verifyApproval(token);
  if (!["retry", "cancel"].includes(decision)) throw new Error(`未知决定：${decision}`);
  const row = getPublishRow(data.p);
  if (!row) throw new Error(`没有这条发布：${data.p}`);

  const conn = open();
  const key = `approval:${data.p}:${decision}`;
  const done = conn.prepare("SELECT result, reason FROM command_audit WHERE idempotency_key=?").get(key);
  if (done) return { ok: done.result === "ok", duplicate: true, publishId: data.p, message: done.reason ?? "已经处理过" };

  if (decision === "cancel") {
    if (row.state === "canceled") return { ok: true, duplicate: true, publishId: data.p, message: "已经是取消状态" };
    if (["published", "published_limited"].includes(row.state)) throw new Error("这条已经发布成功，不能取消");
    transitionPublish(data.p, "canceled", { reason: "rejected_by_operator" });
    audit(conn, { id: newId("cmd"), name: "approval.cancel", actor, args: { publishId: data.p }, result: "ok", reason: "链接取消", key, now });
    return { ok: true, publishId: data.p, state: "canceled", message: "已取消，不会再发。" };
  }

  if (["published", "published_limited"].includes(row.state)) throw new Error("这条已经发布成功，不需要重试");
  if (row.state === "queued") return { ok: true, duplicate: true, publishId: data.p, message: "已经在队列里了" };
  if (!RETRYABLE.has(row.state)) throw new Error(`当前状态 ${row.state} 不能重试`);

  transitionPublish(data.p, "queued", { reason: "approval_retry" });
  enqueue({ kind: "publish", targetType: "publish", targetId: data.p, lane: row.account_id, priority: 100 });
  audit(conn, { id: newId("cmd"), name: "approval.retry", actor, args: { publishId: data.p }, result: "ok", reason: "链接批准重试", key, now });
  return { ok: true, publishId: data.p, state: "queued", message: "已重新排队，马上会再试一次。" };
}
