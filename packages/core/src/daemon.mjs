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
import { deliverPending, executeAction } from "./notify.mjs";
import { resultCard } from "./cards.mjs";
import { getBinding, statusSnapshot, listPublishes, listRuns, listAccounts, countPublished } from "./store.mjs";
import { setupStatus } from "./setup.mjs";
import { verifyApproval, applyApproval, verifyHandoff, handoffContent, handoffAssetPath, applyHandoff } from "./approval.mjs";

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
 * 干净 URL 的显式别名：账号页沿用设计稿文件名 `account-wall.html`，但导航路径是 `/accounts`。
 * 只映射静态页，不碰 `/api/*`——命令路由仍由 `routes.mjs` 从命令表派生，这里不写第二套。
 */
const PAGE_ALIASES = new Map([
  ["/", "overview.html"],
  ["/accounts", "account-wall.html"],
  ["/accounts/add", "add.html"],
  ["/plan", "calendar.html"],
  ["/publish", "publish.html"],
  ["/works", "work.html"],
  ["/runs", "runs.html"],
  ["/tasks", "runs.html"],
  ["/matrix", "matrix.html"],
]);

/** 静态页只服务 web/public 里的文件；任何越界路径都当 404，不做「聪明」的路径修正。 */
function staticFile(webRoot, pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  let rel = clean === "/" ? (PAGE_ALIASES.get("/") ?? "index.html") : clean.replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return null;
  // 干净 URL：/groups → groups.html（文件存在才映射），账号页用上面的显式别名。
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

  if (data.d === "handoff") return sendHtml(400, page("链接不可用", `<h1>链接不可用</h1><p class="muted">这是交接链接，请打开 /h/ 开头的那个页面。</p>`));

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

const ASSET_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".heic": "image/heic", ".bmp": "image/bmp", ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo", ".flv": "video/x-flv",
};

/** 素材流：支持 Range（iOS Safari 播视频必须有）。路径只来自数据库里的作品，不接受任何客户端路径。 */
function streamAsset(req, res, file) {
  const type = ASSET_MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const { size } = statSync(file);
  const base = { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return req.method === "HEAD" ? res.end() : createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, "content-length": size });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

/**
 * 交接页 `/h/<token>`（ACC-handoff-02）：与 `/a/` 同一道安全边界——局域网可达的第二个路径，
 * 其余接口仍只允许本机。页面本身是静态 handoff.html，数据、素材、回执都走 token 下的子路径，
 * 每一条都先验签与有效期，素材只按序号取（路径来自数据库，不接受客户端路径）。
 */
async function handoffRoute(req, res, { pathname, webRoot }) {
  const rest = pathname.slice(3);
  const slash = rest.indexOf("/");
  let token = "";
  try {
    token = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
  } catch {
    token = ""; // 坏的百分号编码：当作无效链接，下面验签会给出人话
  }
  const sub = slash === -1 ? "" : rest.slice(slash + 1);

  const json = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(JSON.stringify(payload));
  };

  if (sub === "" && (req.method === "GET" || req.method === "HEAD")) {
    // 页面壳不带数据：过期/坏链接也先把页面发出去，由页面向 /data 要「人话」错误。
    const file = join(webRoot, "handoff.html");
    if (!existsSync(file)) return json(404, { ok: false, error: { code: "not_found", message: "交接页文件不存在" } });
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    return req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res);
  }

  let data;
  try {
    data = verifyHandoff(token);
  } catch (err) {
    return json(410, { ok: false, error: { code: "link_invalid", message: err.message } });
  }

  if (sub === "data" && req.method === "GET") {
    const content = handoffContent(data.p);
    if (!content) return json(404, { ok: false, error: { code: "not_found", message: "找不到这条发布" } });
    return json(200, { ok: true, ...content, canAct: content.state === "notify_pending" });
  }

  const asset = /^asset\/(\d+)$/.exec(sub);
  if (asset && (req.method === "GET" || req.method === "HEAD")) {
    const file = handoffAssetPath(data.p, Number(asset[1]));
    if (!file || !existsSync(file)) return json(404, { ok: false, error: { code: "not_found", message: "没有这个素材" } });
    return streamAsset(req, res, file);
  }

  if ((sub === "done" || sub === "skip") && req.method === "POST") {
    let body = {};
    try {
      body = await readBody(req);
    } catch (err) {
      return json(err.status ?? 400, { ok: false, error: { code: "bad_request", message: err.message } });
    }
    try {
      const result = applyHandoff(token, sub, { url: body.url, reason: body.reason, actor: `link:${req.socket.remoteAddress ?? "phone"}` });
      return json(200, result);
    } catch (err) {
      return json(400, { ok: false, error: { code: "handoff_failed", message: err.message } });
    }
  }

  return json(404, { ok: false, error: { code: "not_found", message: `没有这个接口：${req.method} ${pathname}` } });
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
    if (!loopback && !pathname.startsWith("/a/") && !pathname.startsWith("/h/")) {
      return send(res, 403, { ok: false, error: { code: "forbidden", message: "这个接口只允许本机访问" } });
    }

    // 手机交接页：与 /a/ 同一安全边界（局域网第二个路径），其他接口仍只允许本机。
    if (pathname.startsWith("/h/")) return handoffRoute(req, res, { pathname, webRoot });

    // 手机审批页：允许从局域网访问的页面（安全边界见 serve 的 host 设置）。
    if (pathname.startsWith("/a/") && (req.method === "GET" || req.method === "POST")) {
      return approvalPage(req, res, { token: pathname.slice(3) });
    }

    // 浏览器打开的是本地控制台；/api/* 之外只有静态页。
    if ((req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/api/")) {
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
 * Starts the daemon. Both listeners share one dispatcher, so the unix socket and 127.0.0.1 cannot
 * drift apart. `port: 0` is for tests; the real port comes from config.
 */
export async function startDaemon({ handlers = {}, log = () => {}, port = 8787, host = "127.0.0.1", socketPath = paths().socket, runQueue = true, webRoot, channels = [], doctor = null } = {}) {
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
  if (runQueue) {
    runner.loop();
    stopSweeper = startCheckSweeper({ log });

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
          onAction: async (evt) => {
            const current = getBinding(channel.channel);
            const res = await executeAction({
              action: evt.action_value,
              operator: evt.operator_id,
              binding: current,
              handlers,
            });
            log(`[channel] ${res.ok ? "✓" : "✗"} ${res.message}`);
            if (evt.message_id) {
              await channel
                .updateCard({ messageId: evt.message_id, card: resultCard(res.ok ? "已处理" : "没有执行", res.message, { ok: res.ok }) })
                .catch((err) => log(`[channel] 更新卡片失败：${err.message}`));
            }
          },
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
