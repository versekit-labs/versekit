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
import { existsSync, unlinkSync } from "node:fs";
import { paths, newId, open } from "./index.mjs";
import { matchRoute, ROUTES } from "./routes.mjs";
import { findCommand, parseArgs } from "./commands.mjs";
import { createRunner } from "./runner.mjs";
import { applyTerminalFailure } from "./publish-flow.mjs";
import { startCheckSweeper } from "./scheduler.mjs";

const MAX_BODY = 1 << 20;

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

/** Path exists but with a different verb → 405, which is a different bug from 404. */
function pathExists(pathname) {
  return ROUTES.some((route) => route.regex.test(pathname));
}

export function createDispatcher({ handlers, log = () => {} }) {
  return async function dispatch(req, res) {
    const started = Date.now();
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;
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
export async function startDaemon({ handlers = {}, log = () => {}, port = 8787, socketPath = paths().socket, runQueue = true } = {}) {
  const runner = createRunner({
    handlers,
    log,
    // When the queue gives up on a publish, the row has to end somewhere a person can see.
    onRunFailed: (run, err) => {
      if (run.kind === "publish") applyTerminalFailure(run.target_id, err);
    },
  });

  const dispatch = createDispatcher({ handlers, log });
  const httpServer = createServer(dispatch);
  const socketServer = createServer(dispatch);

  await listen(httpServer, { host: "127.0.0.1", port });

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
  if (runQueue) {
    runner.loop();
    stopSweeper = startCheckSweeper({ log });
  }

  const { port: boundPort } = httpServer.address();
  return {
    runner,
    port: boundPort,
    socketPath,
    async close() {
      stopSweeper();
      runner.stop();
      httpServer.closeAllConnections?.();
      socketServer.closeAllConnections?.();
      await Promise.all([
        new Promise((r) => httpServer.close(() => r())),
        new Promise((r) => socketServer.close(() => r())),
      ]);
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          /* best effort */
        }
      }
    },
  };
}
