// CLI → daemon client.
//
// The CLI never opens the database for writing (ARCHITECTURE §1): it sends a command over the unix
// socket and prints the answer. If the daemon is not running it is started, because "remember to
// start the service first" is a step users forget and then blame the tool for.

import { request } from "node:http";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paths, isInitialised } from "../../core/src/index.mjs";
import { findCommand } from "../../core/src/commands.mjs";
import { ROUTES } from "../../core/src/routes.mjs";

const CLI = fileURLToPath(new URL("./vk.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fills `/api/publishes/:publishId/retry` from the args, and returns what is left for body/query. */
function buildPath(command, args) {
  const route = ROUTES.find((r) => r.command === command);
  if (!route) return null;
  let path = route.path;
  const rest = { ...args };
  for (const name of route.names) {
    if (rest[name] == null) throw new Error(`缺少参数：${name}`);
    path = path.replace(`:${name}`, encodeURIComponent(String(rest[name])));
    delete rest[name];
  }
  return { route, path, rest };
}

function rawCall({ path, method, body, socketPath, timeout = 30_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body && method !== "GET" ? JSON.stringify(body) : null;
    const req = request(
      {
        socketPath,
        path,
        method,
        timeout,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            return reject(new Error(`守护进程返回了非 JSON（HTTP ${res.statusCode}）：${data.slice(0, 200)}`));
          }
          if (res.statusCode >= 400 || parsed.ok === false) {
            return reject(Object.assign(new Error(parsed.error?.message ?? `HTTP ${res.statusCode}`), { code: parsed.error?.code, status: res.statusCode }));
          }
          resolve(parsed);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`守护进程 ${timeout}ms 没有响应`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Sends one command. Throws with the daemon's message so the CLI can print it verbatim. */
export async function call(commandName, args = {}, { timeout } = {}) {
  const command = findCommand(commandName);
  if (!command) throw new Error(`未登记的命令：${commandName}`);
  const built = buildPath(commandName, args);
  if (!built) {
    throw new Error(`命令 ${commandName} 只能在本地执行（没有 HTTP 路由）：${command.cli?.usage ?? commandName}`);
  }
  const { route, path, rest } = built;
  let target = path;
  let body = null;
  if (route.method === "GET") {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) if (v != null) query.set(k, Array.isArray(v) ? v.join(",") : String(v));
    const qs = query.toString();
    if (qs) target += `?${qs}`;
  } else {
    body = rest;
  }
  return rawCall({ path: target, method: route.method, body, socketPath: paths().socket, timeout });
}

async function alive(socketPath, timeout = 400) {
  try {
    await rawCall({ path: "/api/now", method: "GET", socketPath, timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes sure the daemon is up. Returns `{ started }` so `vk serve --detach` can say what happened
 * instead of hanging; throws only when the daemon genuinely could not come up.
 */
export async function ensureDaemon({ timeoutMs = 6000, port = null, log = () => {} } = {}) {
  if (!isInitialised()) throw new Error("还没有初始化：先运行 vk init");
  const socketPath = paths().socket;
  if (existsSync(socketPath) && (await alive(socketPath))) return { started: false };

  log("守护进程没在跑，正在拉起…");
  const args = [CLI, "serve", ...(port != null ? ["--port", String(port)] : [])];
  // detach 之后控制台就没了：把 stdout/stderr 落到 vk.log，排障才有现场。
  const logFile = paths().log;
  const fd = openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  closeSync(fd);

  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(200);
    if (existsSync(socketPath) && (await alive(socketPath))) return { started: true };
  }
  throw new Error("守护进程没有起来：直接运行 vk serve，看它报什么错");
}

/** One call that also guarantees the daemon exists. */
export async function send(commandName, args = {}, opts = {}) {
  await ensureDaemon({ log: opts.log });
  return call(commandName, args, opts);
}
