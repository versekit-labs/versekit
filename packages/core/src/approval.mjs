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
import { assetFilesOf, assetKindOf } from "./asset-kind.mjs";
import { basename } from "node:path";

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
  if (data.d === "handoff") throw new Error("这是交接链接，不是审批链接：请在交接页里操作");
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

// ------------------------------------------------------------------ 交给手机（handoff）
//
// 小红书默认不由程序发布：电脑把内容准备好，生成一个签名的交接页 `/h/<token>`，人在手机上
// 打开、复制文案、保存图片、到 App 里点发布，再回来点「我已发布」。程序全程不访问小红书。
// token 复用审批链接的 HMAC 与 24 小时有效期；`d: "handoff"` 把两种链接分开，
// 审批链接打不开交接页，交接链接也做不了「重试 / 取消」。

export const handoffPath = (publishId, exp) => `/h/${signApproval({ publishId, decision: "handoff", ...(exp ? { exp } : {}) })}`;
export const handoffLink = (publishId, exp) => `${baseUrl()}${handoffPath(publishId, exp)}`;

export function verifyHandoff(token) {
  const data = verifyApproval(token);
  if (data.d !== "handoff") throw new Error("交接链接无效（这不是一个交接链接）");
  return data;
}

/** 笔记链接只认小红书自己的域名；粘贴的是整段分享文案时取第一个链接。 */
export function parseNoteUrl(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const hit = text.match(/https?:\/\/[^\s<>"'，。）)]+/i);
  const where = "只接受 xiaohongshu.com 或 xhslink.com 的笔记链接";
  if (!hit) throw new Error(`没找到链接：${where}`);
  let url;
  try {
    url = new URL(hit[0]);
  } catch {
    throw new Error(`链接格式不对：${where}`);
  }
  const host = url.hostname.toLowerCase();
  const ok = ["xiaohongshu.com", "xhslink.com"].some((d) => host === d || host.endsWith(`.${d}`));
  if (!ok) throw new Error(where);
  return url.toString();
}

/** 交接页要展示的全部内容：账号、标题、正文（含话题）、素材清单（只给序号，不给路径）。 */
export function handoffContent(publishId) {
  const row = getPublishRow(publishId);
  if (!row) return null;
  const work = open().prepare("SELECT title, asset_path, meta_json FROM work WHERE id = ?").get(row.work_id);
  let meta = {};
  try {
    meta = work?.meta_json ? JSON.parse(work.meta_json) : {};
  } catch {
    meta = {};
  }
  const title = String(meta.title ?? work?.title ?? "").trim();
  const body = String(meta.body ?? "").trim();
  const tags = Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).trim().replace(/^#/, "")).filter(Boolean) : [];
  const tagLine = tags.map((t) => `#${t}`).join(" ");
  const files = work ? assetFilesOf(work.asset_path) : [];
  const account = open().prepare("SELECT display_name, handle FROM account WHERE id = ?").get(row.account_id);
  return {
    publishId,
    platform: row.platform,
    account: { name: account?.display_name || account?.handle || row.handle, handle: row.handle },
    state: row.state,
    title,
    body,
    tags,
    // 复制「正文」时一并带上话题：App 里粘贴后话题就在正文末尾。
    bodyText: [body, tagLine].filter(Boolean).join("\n\n"),
    assets: files.map((file, index) => ({ index, name: basename(file), kind: assetKindOf(file) })),
    externalUrl: row.external_url ?? null,
    scheduledAt: row.scheduled_at ?? null,
  };
}

/** 第 index 个素材的本机路径；只在 token 校验之后由 daemon 调用，序号越界返回 null。 */
export function handoffAssetPath(publishId, index) {
  const row = getPublishRow(publishId);
  if (!row) return null;
  const work = open().prepare("SELECT asset_path FROM work WHERE id = ?").get(row.work_id);
  const file = work ? assetFilesOf(work.asset_path)[index] : null;
  return file ?? null;
}

const HANDOFF_DONE_STATES = ["published", "published_limited"];

/**
 * 回执：done = 「我已发布」（可带笔记链接），skip = 「这次不发了」。
 * 按 command_audit.idempotency_key 去重：连点两次只记一次，第二次返回 duplicate。
 */
export function applyHandoffDecision(publishId, decision, { url = null, reason = null, actor = "link", origin = "link", now = Date.now() } = {}) {
  if (!["done", "skip"].includes(decision)) throw new Error(`未知回执：${decision}`);
  const row = getPublishRow(publishId);
  if (!row) throw new Error(`没有这条发布：${publishId}`);

  const conn = open();
  const key = `handoff:${publishId}:${decision}`;
  const done = conn.prepare("SELECT result, reason FROM command_audit WHERE idempotency_key=?").get(key);
  if (done && done.result === "ok") return { ok: true, duplicate: true, publishId, state: row.state, message: done.reason ?? "已经记过了" };

  const record = (name, text, args) =>
    conn
      .prepare("INSERT OR IGNORE INTO command_audit (id, name, actor, origin, args_json, result, reason, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(newId("cmd"), name, actor, origin, JSON.stringify(args), "ok", text, key, now);

  if (decision === "done") {
    if (HANDOFF_DONE_STATES.includes(row.state)) return { ok: true, duplicate: true, publishId, state: row.state, message: "已经记为已发布" };
    if (row.state === "canceled") throw new Error("这条已经标成「不发了」，不能再记为已发布");
    if (row.state !== "notify_pending") throw new Error(`这条还没到手机上发布这一步（当前：${row.state}）`);
    const noteUrl = parseNoteUrl(url);
    transitionPublish(publishId, "published", {
      reason: "handoff_done",
      patch: { published_at: row.published_at ?? now, ...(noteUrl ? { external_url: noteUrl } : {}) },
    });
    record("handoff.done", noteUrl ? "已记为已发布（含笔记链接）" : "已记为已发布", { publishId, url: noteUrl });
    return { ok: true, publishId, state: "published", url: noteUrl, message: noteUrl ? "已记为已发布，笔记链接也记下了。" : "已记为已发布。" };
  }

  if (row.state === "canceled") return { ok: true, duplicate: true, publishId, state: "canceled", message: "已经标成不发了" };
  if (HANDOFF_DONE_STATES.includes(row.state)) throw new Error("这条已经发布了，不能再标成不发");
  if (row.state !== "notify_pending") throw new Error(`这条还没到手机上发布这一步（当前：${row.state}）`);
  const why = String(reason ?? "").trim().slice(0, 200);
  transitionPublish(publishId, "canceled", { reason: why ? `handoff_skipped: ${why}` : "handoff_skipped" });
  record("handoff.skip", why ? `这次不发了：${why}` : "这次不发了", { publishId, reason: why || null });
  return { ok: true, publishId, state: "canceled", message: "已记下：这次不发了。" };
}

/** 手机页面用：校验 token 后执行回执。 */
export function applyHandoff(token, decision, options = {}) {
  const data = verifyHandoff(token);
  return applyHandoffDecision(data.p, decision, options);
}
