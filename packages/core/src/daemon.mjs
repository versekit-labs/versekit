// The daemon: one process owns the database and the queue, and every other face is a client.
//
// Why a daemon at all (BLUEPRINT §3.1): writing from the CLI, the web page and a card handler at
// the same time is how three clients grow three subtly different notions of "published". So the
// CLI talks to this process over a unix socket, the browser will talk to the same dispatch over
// 127.0.0.1, and the socket never listens on a public interface.
//
// The HTTP layer is deliberately thin: route → validate args → call a handler → audit. Anything
// that looks like business logic belongs in handlers.mjs, not here.

import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, newId, open } from "./index.mjs";
import { matchRoute, ROUTES } from "./routes.mjs";
import { findCommand, parseArgs } from "./commands.mjs";
import { createRunner } from "./runner.mjs";
import { applyTerminalFailure, getPublishRow, sweepStuckPublishes } from "./publish-flow.mjs";
import { publishTimeoutMs } from "./config.mjs";
import { startCheckSweeper } from "./scheduler.mjs";
import { deliverPending, handleCardEvent } from "./notify.mjs";
import { getBinding, statusSnapshot, listPublishes, listRuns, listAccounts, countPublished, recordHeartbeat } from "./store.mjs";
import { setupStatus } from "./setup.mjs";
import { verifyApproval, applyApproval } from "./approval.mjs";

const MAX_BODY = 1 << 20;
const MAX_ASSET = 4 * 1024 * 1024 * 1024; // 4GB：单条视频的上限，超了直接拒绝而不是写满磁盘

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * 干净 URL 的显式别名：页面文件用设计稿的文件名，导航路径是 `/today` 这类干净地址。
 * 只映射静态页，不碰 `/api/*`——命令路由仍由 `routes.mjs` 从命令表派生，这里不写第二套。
 *
 * v2 外壳（#148）：四个页面——今天、作品（含详情）、数据、系统。旧的账号墙、总览、矩阵、
 * 日历不再有页面；账号管理并入系统页，发布计划按 PRD 不再单独成页（在「今天」里看接下来要发的）。
 * 登录 / 添加账号 / 账号组 / 任务日志的旧页面已删除（#209），地址见下面的跳转表。
 */
const PAGE_ALIASES = new Map([
  ["/", "today.html"],
  ["/today", "today.html"],
  ["/works", "works.html"],
  ["/work", "work.html"],
  ["/data", "data.html"],
  ["/system", "system.html"],
  ["/accounts", "system.html"],
  ["/plan", "today.html"],
]);

/**
 * 旧地址跳到系统页对应位置（ACC-v2-sys-07）：接入账号和账号组都并进了 /system，
 * 书签、旧页面里的链接、飞书卡片里的老链接都不该 404。302 而不是 301：目标是页面内锚点，别被浏览器永久缓存。
 */
const LEGACY_REDIRECTS = new Map([
  ["/accounts/add", "/system#add"],
  ["/add", "/system#add"],
  ["/add.html", "/system#add"],
  ["/groups", "/system#groups"],
  ["/groups.html", "/system#groups"],
  // 发布台、任务页（ACC-v2-sys-10）：发布内容在 vk publish / 今天，任务失败在系统页「最近出的问题」。
  ["/publish", "/today"],
  ["/publish.html", "/today"],
  ["/runs", "/system#problems"],
  ["/runs.html", "/system#problems"],
  ["/tasks", "/system#problems"],
]);

/** 静态页只服务 web/public 里的文件；任何越界路径都当 404，不做「聪明」的路径修正。 */
function staticFile(webRoot, pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  let rel = clean === "/" ? (PAGE_ALIASES.get("/") ?? "index.html") : clean.replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return null;
  // 干净 URL：/works → works.html（文件存在才映射），账号页用上面的显式别名。
  if (!extname(rel)) {
    const alias = PAGE_ALIASES.get(clean);
    if (alias) rel = alias;
    else if (existsSync(resolve(webRoot, rel + ".html"))) rel += ".html";
  }
  const root = resolve(webRoot);
  const file = resolve(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

function serveStatic(res, file) {
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
}

/* ---------------------------------------------------------------- 素材文件（/media）
 *
 * 今天页要看片：浏览器没法读本机绝对路径，所以 core 把它交出来。安全边界与 /api 完全一样——
 * 先过 dispatcher 顶部的「只允许本机」判断，非本机请求拿不到任何字节。
 *
 * URL 只收一个 id，路径由 core 按 version_id 查库得到，不接受任何来自 URL 的路径片段，
 * 所以既没有 `..` 穿越，也不会把 state/assets 以外的随手文件发出去。
 */
const MEDIA_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/x-m4v"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

/** versionId → 素材绝对路径。只认 cut_version 表里的行；不认识的一律 null。 */
function resolveMediaPath(versionId) {
  if (typeof versionId !== "string" || !versionId.trim()) return null;
  try {
    return open().prepare("SELECT asset_path FROM cut_version WHERE id = ?").get(versionId)?.asset_path ?? null;
  } catch {
    return null;
  }
}

/** `bytes=0-1023` → { start, end }；不合法返回 null（调用方回 416）。 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let start;
  let end;
  if (rawStart === "") {
    // 尾巴：bytes=-500 = 最后 500 字节
    const tail = Number(rawEnd);
    if (!Number.isFinite(tail) || tail <= 0) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function serveMedia(req, res, { versionId }) {
  const asset = resolveMediaPath(versionId);
  if (!asset) {
    return send(res, 404, {
      ok: false,
      error: { code: "not_found", message: `没有这个版本：${versionId}（vk work list 看看有哪些作品）` },
    });
  }
  let stat = null;
  try {
    stat = statSync(asset);
  } catch {
    stat = null;
  }
  // 文件被移走 / 删掉了：说人话，别让页面卡在转圈上。
  if (!stat || !stat.isFile()) {
    return send(res, 404, {
      ok: false,
      error: { code: "media_missing", message: "这个版本的素材文件不在这台电脑上了（可能被移动或删除）" },
    });
  }
  const type = MEDIA_TYPES.get(extname(asset).toLowerCase());
  if (!type) {
    return send(res, 415, {
      ok: false,
      error: { code: "media_unsupported", message: `这个文件不能在这里播放：${basename(asset)}` },
    });
  }

  const size = stat.size;
  const base = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const rangeHeader = req.headers?.range;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": range.end - range.start + 1 });
    if (req.method === "HEAD") return res.end();
    return createReadStream(asset, { start: range.start, end: range.end }).pipe(res);
  }
  res.writeHead(200, { ...base, "content-length": size });
  if (req.method === "HEAD") return res.end();
  return createReadStream(asset).pipe(res);
}

/**
 * 资产上传：浏览器没法给守护进程一个本机路径，所以文件先落到 state/assets/ 再当素材路径用。
 * 这是 publish.create 的传输层，不是新能力——CLI 直接用文件路径就等价，所以不进命令表。
 */
function receiveAsset(req, res, { assetsDir, log }) {
  let name = "asset.bin";
  try {
    name = decodeURIComponent(String(req.headers["x-vk-filename"] ?? "asset.bin"));
  } catch {
    /* 头部坏了就用默认名，下面的清洗会兜住 */
  }
  const safe = basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(-120) || "asset.bin";
  // 目录语义（ACC-publish-06）：带 x-vk-batch 的上传属于同一个「图集目录」，文件按 x-vk-index 前缀
  // 落进 assets/<batch>/，返回的 path 是目录而不是文件（字段与返回结构不变）。不带就是老的单文件。
  const batch = String(req.headers["x-vk-batch"] ?? "").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 64);
  const index = Math.max(0, Math.min(9999, Number.parseInt(String(req.headers["x-vk-index"] ?? "0"), 10) || 0));
  let target;
  let reportPath;
  if (batch) {
    const dir = join(assetsDir, `album-${batch}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    target = join(dir, `${String(index).padStart(4, "0")}-${safe}`);
    reportPath = dir;
  } else {
    mkdirSync(assetsDir, { recursive: true, mode: 0o700 });
    target = join(assetsDir, `${Date.now()}-${safe}`);
    reportPath = target;
  }

  let bytes = 0;
  let failed = null;
  const out = createWriteStream(target, { mode: 0o600 });
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_ASSET && !failed) {
      failed = "too_large";
      req.destroy();
      out.destroy();
      try {
        unlinkSync(target);
      } catch {
        /* 已经没了 */
      }
    }
  });
  req.on("error", () => out.destroy());
  out.on("error", (err) => {
    log(`[daemon] 资产写入失败：${err.message}`);
    if (!res.headersSent) send(res, 500, { ok: false, error: { code: "asset_write_failed", message: err.message } });
  });
  out.on("finish", () => {
    if (failed) return send(res, 413, { ok: false, error: { code: "too_large", message: "素材超过 4GB" } });
    if (bytes === 0) {
      try {
        unlinkSync(target);
      } catch {
        /* 忽略 */
      }
      return send(res, 400, { ok: false, error: { code: "empty_asset", message: "上传的是空文件" } });
    }
    log(`[daemon] 收到素材 ${safe}（${bytes} 字节）`);
    send(res, 200, { ok: true, path: reportPath, bytes });
  });
  req.pipe(out);
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求体超过 1MB"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
        resolve(parsed);
      } catch (err) {
        reject(Object.assign(new Error(`请求体不是合法 JSON：${err.message}`), { status: 400 }));
      }
    });
    req.on("error", reject);
  });

/** /a/:token 的页面只收表单，不走 JSON。 */
function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 64 * 1024) reject(new Error("表单太大了"));
    });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on("error", reject);
  });
}

const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
body{margin:0;background:#0b1117;color:#e6edf3;font:16px/1.6 -apple-system,system-ui,sans-serif;padding:24px}
.card{max-width:560px;margin:0 auto;background:#111a23;border:1px solid #24303c;border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 4px}.muted{color:#8b9bab;font-size:13px}
.row{display:flex;gap:10px;margin-top:16px}
button{flex:1;padding:12px;border-radius:10px;border:1px solid #2b3947;background:#16222e;color:#e6edf3;font-size:15px}
button.primary{background:#2f6fed;border-color:#2f6fed}
button.danger{color:#ff9b9b;border-color:#5a2a2a}
.note{margin-top:14px;color:#8b9bab;font-size:12px}
</style></head><body><div class="card">${body}</div></body></html>`;

/**
 * 手机审批页：GET 展示，POST 执行。链接自带签名与有效期，页面不暴露任何其他能力。
 */
async function approvalPage(req, res, { token }) {
  const sendHtml = (status, html) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  };

  let data;
  try {
    data = verifyApproval(token);
  } catch (err) {
    return sendHtml(400, page("链接不可用", `<h1>链接不可用</h1><p class="muted">${err.message}</p>`));
  }

  const row = getPublishRow(data.p);
  if (!row) return sendHtml(404, page("找不到发布", `<h1>找不到这条发布</h1>`));

  if (req.method === "POST") {
    let form;
    try {
      form = await readForm(req);
    } catch (err) {
      return sendHtml(400, page("提交失败", `<h1>提交失败</h1><p class="muted">${err.message}</p>`));
    }
    const decision = form.decision === "cancel" ? "cancel" : "retry";
    try {
      const result = applyApproval(token, decision, { actor: `link:${req.socket.remoteAddress ?? "phone"}` });
      return sendHtml(
        200,
        page("已处理", `<h1>${result.duplicate ? "已经处理过" : "已处理"}</h1>
          <p>${result.message}</p>
          <p class="muted">${row.platform} @${row.handle} · ${row.title ?? ""}</p>
          <div class="note">可以关掉这个页面了。</div>`),
      );
    } catch (err) {
      return sendHtml(400, page("没处理成", `<h1>没处理成</h1><p>${err.message}</p>`));
    }
  }

  const reason = row.fallback_reason ?? row.error_message ?? "";
  return sendHtml(
    200,
    page("需要你拍板", `<h1>需要你拍板</h1>
      <p class="muted">${row.platform} @${row.handle} · ${row.state}</p>
      <p>${row.title ?? "（无标题）"}</p>
      ${reason ? `<p class="muted">原因：${reason}</p>` : ""}
      <form method="post" action="">
        <div class="row">
          <button class="primary" name="decision" value="retry">重试发布</button>
          <button class="danger" name="decision" value="cancel">取消这条</button>
        </div>
      </form>
      <div class="note">链接 24 小时内有效 · 重复点击只执行一次 · 电脑上也能看到结果</div>`),
  );
}

/**
 * Query strings and JSON bodies arrive as strings. Coerce only where the command's declared arg
 * types say so — guessing types is how `"false"` becomes a truthy retry flag.
 */
export function coerceArgs(command, raw) {
  const out = { ...raw };
  for (const [key, spec] of Object.entries(command.args ?? {})) {
    const type = spec.replace(/\?$/, "");
    const value = out[key];
    if (typeof value !== "string") continue;
    if (type === "number" && /^-?\d+$/.test(value)) out[key] = Number(value);
    else if (type === "boolean" && (value === "true" || value === "false")) out[key] = value === "true";
    else if (type === "string[]") out[key] = value.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return out;
}

function audit({ command, args, origin, actor, result, reason }) {
  if (command.audit !== "always") return;
  try {
    open()
      .prepare("INSERT INTO command_audit (id, name, actor, origin, args_json, result, reason, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(newId("cmd"), command.name, actor, origin, JSON.stringify(args ?? {}), result, reason ? String(reason).slice(0, 500) : null, Date.now());
  } catch {
    // An audit write must never turn a successful action into a failed one; the event log still has it.
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/**
 * 实时状态流（SSE）。控制台靠它把「刚发出去 / 刚失败」立刻显示出来，
 * 而不是每 20 秒才发现。只发变化摘要，不发整页数据——渲染仍在客户端。
 */
function streamState(req, res, { log, doctor = null }) {
  let doctorCache = null;
  let doctorAt = 0;
  const getDoctor = async () => {
    if (!doctor) return null;
    if (Date.now() - doctorAt < 5 * 60e3) return doctorCache;
    try {
      doctorCache = await doctor();
    } catch {
      doctorCache = null;
    }
    doctorAt = Date.now();
    return doctorCache;
  };
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");

  let closed = false;
  const frame = async () => {
    const status = statusSnapshot();
    const { list, ...accounts } = status.accounts;
    const binding = getBinding("feishu");
    const setup = setupStatus({
      doctor: await getDoctor(),
      accounts: listAccounts(),
      channel: { bound: Boolean(binding), who: binding?.external_user_id ?? null },
      publishedCount: countPublished(),
    });
    return {
      at: Date.now(),
      status: { ...status, accounts },
      setup: { nextStep: setup.nextStep, done: setup.done, total: setup.total, steps: setup.steps.map((s) => ({ id: s.id, status: s.status })) },
      publishes: listPublishes({ limit: 20 }).map((p) => ({ id: p.id, state: p.state, updated_at: p.updated_at, platform: p.platform })),
      runs: listRuns({ limit: 20 }).map((r) => ({ id: r.id, kind: r.kind, state: r.state, target_id: r.target_id, attempts: r.attempts })),
    };
  };

  let pushing = false;
  const push = async () => {
    if (closed || pushing) return;
    pushing = true;
    try {
      const data = await frame();
      if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      closed = true;
      log(`[daemon] 实时流写入失败：${err.message}`);
    } finally {
      pushing = false;
    }
  };

  push();
  const timer = setInterval(push, 2000);
  timer.unref?.();
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
}

/** Path exists but with a different verb → 405, which is a different bug from 404. */
function pathExists(pathname) {
  return ROUTES.some((route) => route.regex.test(pathname));
}

export function createDispatcher({ handlers, log = () => {}, doctor = null, webRoot = WEB_ROOT, assetsDir = join(paths().state, "assets") }) {
  return async function dispatch(req, res) {
    const started = Date.now();
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;

    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "" || remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback && !pathname.startsWith("/a/")) {
      return send(res, 403, { ok: false, error: { code: "forbidden", message: "这个接口只允许本机访问" } });
    }

    // 手机审批页：唯一允许从局域网访问的页面（安全边界见 serve 的 host 设置）。
    if (pathname.startsWith("/a/") && (req.method === "GET" || req.method === "POST")) {
      return approvalPage(req, res, { token: pathname.slice(3) });
    }

    // 素材文件（今天页看片）。只在这里按 id 查库，URL 里的任何路径片段都不会被当成路径用。
    if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/media/")) {
      let versionId = "";
      try {
        versionId = decodeURIComponent(pathname.slice("/media/".length)).replace(/\/+$/, "");
      } catch {
        versionId = "";
      }
      return serveMedia(req, res, { versionId });
    }

    // 浏览器打开的是本地控制台；/api/* 之外只有静态页。
    if ((req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/api/")) {
      const moved = LEGACY_REDIRECTS.get(pathname.replace(/\/+$/, "") || "/");
      if (moved) {
        const search = url.search && !moved.includes("?") ? url.search : "";
        const [path, hash = ""] = moved.split("#");
        res.writeHead(302, { location: `${path}${search}${hash ? `#${hash}` : ""}` });
        return res.end();
      }
      const file = staticFile(webRoot, pathname);
      if (file) return serveStatic(res, file);
      return send(res, 404, { ok: false, error: { code: "not_found", message: `没有这个文件：${pathname}` } });
    }
    if (req.method === "POST" && pathname === "/api/assets") {
      return receiveAsset(req, res, { assetsDir, log });
    }
    if (req.method === "GET" && pathname === "/api/stream") {
      return streamState(req, res, { log, doctor });
    }

    const hit = matchRoute(req.method, pathname);

    if (!hit) {
      return send(res, pathExists(pathname) ? 405 : 404, {
        ok: false,
        error: { code: pathExists(pathname) ? "method_not_allowed" : "not_found", message: `没有这个接口：${req.method} ${pathname}` },
      });
    }

    const command = findCommand(hit.command);
    const handler = handlers[hit.command];
    const origin = String(req.headers["x-vk-origin"] ?? "cli");
    const actor = String(req.headers["x-vk-actor"] ?? "local");

    if (!handler) {
      audit({ command, origin, actor, result: "error", reason: "not_implemented" });
      return send(res, 501, { ok: false, error: { code: "not_implemented", message: `命令 ${hit.command} 还没有实现` } });
    }

    let args;
    try {
      const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
      const query = Object.fromEntries(url.searchParams.entries());
      args = parseArgs(command, coerceArgs(command, { ...query, ...body, ...hit.params }));
    } catch (err) {
      audit({ command, origin, actor, result: "rejected", reason: err.message });
      return send(res, err.status ?? 400, { ok: false, error: { code: err.status === 413 ? "too_large" : "bad_request", message: err.message } });
    }

    try {
      const result = (await handler(args)) ?? {};
      audit({ command, args, origin, actor, result: "ok" });
      log(`[daemon] ${command.name} ok ${Date.now() - started}ms`);
      return send(res, 200, { ...result, ok: result.ok ?? true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit({ command, args, origin, actor, result: "error", reason: message });
      log(`[daemon] ${command.name} 失败：${message}`);
      return send(res, 400, { ok: false, error: { code: err.code ?? "command_failed", message } });
    }
  };
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * 离线模式（#180）：验收与演示不得访问真实平台。
 *
 * 会走平台适配器 / 浏览器的 handler 一律换成「拒绝」，只改库的动作原样保留。
 * 队列 kind（publish / check / collect）也一并拒绝，这样即使有人手动把 run 塞进队列也不会触网。
 */
export const OFFLINE_BLOCKED = new Set([
  "publish", "check", "collect", // runner 的 kind
  "account.check", "account.connect", "account.creator", "collect.now",
]);
const OFFLINE_BLOCKED_PREFIXES = ["account.login."];

export function isOfflineBlocked(name) {
  return OFFLINE_BLOCKED.has(name) || OFFLINE_BLOCKED_PREFIXES.some((p) => name.startsWith(p));
}

export function offlineError(name) {
  const err = new Error(`离线模式：不会访问任何平台，「${name}」已拒绝（用不带 --offline 的 vk serve 才能真实操作）`);
  err.code = "offline_mode";
  return err;
}

export function offlineHandlers(handlers) {
  const out = {};
  for (const [name, fn] of Object.entries(handlers)) {
    out[name] = isOfflineBlocked(name)
      ? () => {
          throw offlineError(name);
        }
      : fn;
  }
  // 命令层可能没有注册这些 handler（没装适配器）；仍要给出 offline_mode 而不是 not_implemented。
  for (const name of ["account.check", "account.connect", "account.creator", "collect.now", "account.login.open", "account.login.start", "account.login.qr", "account.login.resend", "account.login.status", "account.login.verify", "account.login.cancel"]) {
    out[name] ??= () => {
      throw offlineError(name);
    };
  }
  return out;
}

/**
 * Starts the daemon. Both listeners share one dispatcher, so the unix socket and 127.0.0.1 cannot
 * drift apart. `port: 0` is for tests; the real port comes from config.
 */
export async function startDaemon({ handlers = {}, log = () => {}, port = 8787, host = "127.0.0.1", socketPath = paths().socket, runQueue = true, webRoot, channels = [], doctor = null, offline = false } = {}) {
  if (offline) {
    // 离线：不跑队列、不排体检/采集、不接飞书；handler 全部过一遍拦截。
    runQueue = false;
    channels = [];
    handlers = offlineHandlers(handlers);
  }
  const runner = createRunner({
    handlers,
    log,
    // When the queue gives up on a publish, the row has to end somewhere a person can see.
    onRunFailed: (run, err) => {
      if (run.kind === "publish") applyTerminalFailure(run.target_id, err);
    },
  });

  const dispatch = createDispatcher({ handlers, log, doctor, ...(webRoot ? { webRoot } : {}) });
  const httpServer = createServer(dispatch);
  const socketServer = createServer(dispatch);

  await listen(httpServer, { host, port });

  // A leftover socket file from a crashed daemon would make listen() fail with EADDRINUSE.
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* best effort */
    }
  }
  await listen(socketServer, { path: socketPath });
  try {
    const { chmodSync } = await import("node:fs");
    chmodSync(socketPath, 0o600);
  } catch {
    /* non-POSIX */
  }

  let stopSweeper = () => {};
  let stuckTimer = null;
  let heartbeatTimer = null;
  if (runQueue) {
    runner.loop();
    stopSweeper = startCheckSweeper({ log, offline });

    // auto_running 的第二道保险（ACC-publish-05）：handler 的定时器只管进程还活着、run 还在
    // 手上的那一次。这里每 30 秒扫一遍「没有活 run 却还停在 auto_running」的行，按同一个
    // 总时限判 failed——进程崩过、租约卡住都不会留下一条无声卡死的发布。
    const sweep = () => {
      try {
        const { failed } = sweepStuckPublishes({ timeoutMs: publishTimeoutMs() });
        for (const publishId of failed) log(`[publish] 总时限到：${publishId} 停在 auto_running，已判 timeout`);
      } catch (err) {
        log(`[publish] 超时扫描失败：${err.message}`);
      }
    };
    sweep();
    stuckTimer = setInterval(sweep, 30e3);
    stuckTimer.unref?.();

    // 发布机心跳：系统页「发布机」块靠它判断在线（meta.daemon_heartbeat，30 秒一次）。
    const beat = () => {
      try {
        recordHeartbeat();
      } catch (err) {
        log(`[daemon] 写心跳失败：${err.message}`);
      }
    };
    beat();
    heartbeatTimer = setInterval(beat, 30e3);
    heartbeatTimer.unref?.();
  }

  // 通道：投递待发事件 + 订阅按钮回执。任何一步失败都只记日志，不拖垮内核。
  //
  // 授权可能在守护进程启动之后才完成（用户在网页里扫码），所以这里必须是「监督式」的：
  // 每 30 秒重试一次，条件满足就拉起监听，而不是启动时判断一次就放弃。
  const startedChannels = new Map();
  const channelState = new Map();
  let deliveryTimer = null;
  let channelTimer = null;

  const deliverAll = async () => {
    for (const channel of channels) {
      const binding = getBinding(channel.channel);
      if (!binding) continue;
      try {
        const res = await deliverPending({ channel, binding, log });
        if (res.sent) log(`[channel] ${channel.channel} 发出 ${res.sent} 张卡片`);
      } catch (err) {
        log(`[channel] ${channel.channel} 投递失败：${err.message}`);
      }
    }
  };

  const ensureChannels = () => {
    for (const channel of channels) {
      if (startedChannels.has(channel.channel)) continue;
      const missing = channel.ready?.();
      if (missing) {
        if (channelState.get(channel.channel) !== missing) log(`[channel] ${channel.channel} 不可用：${missing}`);
        channelState.set(channel.channel, missing);
        continue;
      }
      const binding = getBinding(channel.channel);
      if (!binding) {
        if (channelState.get(channel.channel) !== "unbound") log(`[channel] ${channel.channel} 还没有配对：vk channel bind ${channel.channel}`);
        channelState.set(channel.channel, "unbound");
        continue;
      }
      channelState.set(channel.channel, "ready");
      try {
        const stop = channel.start({
          log,
          // 新作品确认流程与旧按钮的分流都在 notify.mjs 的 handleCardEvent 里。
          onAction: (evt) => handleCardEvent({ evt, channel, binding: getBinding(channel.channel), handlers, log }),
        });
        startedChannels.set(channel.channel, stop);
        log(`[channel] ${channel.channel} 事件监听已启动`);
      } catch (err) {
        log(`[channel] ${channel.channel} 启动失败：${err.message}`);
      }
    }
  };

  if (runQueue && channels.length) {
    ensureChannels();
    channelTimer = setInterval(ensureChannels, 30e3);
    channelTimer.unref?.();
    deliveryTimer = setInterval(deliverAll, 5000);
    deliveryTimer.unref?.();
    deliverAll();
  }

  const { port: boundPort } = httpServer.address();

  // 谁起的守护进程不重要，重要的是别的客户端能问到它监听在哪。端口不写下来的话，
  // `serve --detach --port 8801` 只能靠猜。
  const infoFile = join(paths().state, "daemon.json");
  try {
    writeFileSync(infoFile, JSON.stringify({ pid: process.pid, port: boundPort, socket: socketPath, started_at: Date.now() }), { mode: 0o600 });
  } catch {
    /* 写不下来就退化成「只能用默认端口」 */
  }

  return {
    runner,
    port: boundPort,
    socketPath,
    async close() {
      stopSweeper();
      if (stuckTimer) clearInterval(stuckTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (deliveryTimer) clearInterval(deliveryTimer);
      if (channelTimer) clearInterval(channelTimer);
      if (deliveryTimer) clearInterval(deliveryTimer);
      for (const stop of startedChannels.values()) {
        try {
          stop();
        } catch {
          /* 已经停了 */
        }
      }
      runner.stop();
      httpServer.closeAllConnections?.();
      socketServer.closeAllConnections?.();
      await Promise.all([
        new Promise((r) => httpServer.close(() => r())),
        new Promise((r) => socketServer.close(() => r())),
      ]);
      for (const file of [socketPath, infoFile]) {
        if (!existsSync(file)) continue;
        try {
          unlinkSync(file);
        } catch {
          /* best effort */
        }
      }
    },
  };
}
