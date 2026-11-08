// Routes derived from the command registry (docs/BLUEPRINT.md §2.2).
//
// There is no second route table to drift from: HTTP is a projection of `commands.mjs`, the same
// way the CLI and the card buttons are. A command with `http: null` is local-only by decision, and
// the parity test makes that decision explicit instead of leaving it as an omission.

import { COMMANDS } from "./commands.mjs";

const HTTP_METHODS = ["GET", "POST", "DELETE"];

/** `/api/publishes/:publishId/retry` → a matcher that also hands back the params. */
function compile(path) {
  const names = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { names, regex: new RegExp(`^${pattern}/?$`) };
}

export function buildRoutes(commands = COMMANDS) {
  const routes = [];
  const seen = new Map();
  for (const cmd of commands) {
    if (cmd.http == null) continue;
    const { method, path } = cmd.http;
    if (!HTTP_METHODS.includes(method)) {
      throw new Error(`命令 ${cmd.name} 的 HTTP 方法不合法：${method}`);
    }
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error(`命令 ${cmd.name} 的 HTTP 路径不合法：${path}`);
    }
    const key = `${method} ${path}`;
    if (seen.has(key)) throw new Error(`路由重复：${key}（${seen.get(key)} 与 ${cmd.name}）`);
    seen.set(key, cmd.name);
    routes.push({ command: cmd.name, method, path, ...compile(path) });
  }
  return routes;
}

export const ROUTES = buildRoutes();

/**
 * Returns `{command, params}` or null. Used by the daemon in Round 1.
 *
 * Callers hand over the raw request target (`/api/stats/works?range=7d`), so the query string is
 * stripped here — once, in the single matcher — instead of every transport growing its own copy.
 */
export function matchRoute(method, pathname, routes = ROUTES) {
  const verb = String(method).toUpperCase();
  const clean = String(pathname).split("?")[0].split("#")[0];
  for (const route of routes) {
    if (route.method !== verb) continue;
    const m = route.regex.exec(clean);
    if (!m) continue;
    // 畸形的百分号编码（/api/accounts/%E0%A4%A/reauth）会让 decodeURIComponent 抛 URIError。
    // 一个坏请求不该变成 500，更不该带崩守护进程：当作没有匹配，由调用方回 404。
    const params = {};
    for (const [i, name] of route.names.entries()) {
      try {
        params[name] = decodeURIComponent(m[i + 1]);
      } catch {
        return null;
      }
    }
    return { command: route.command, params };
  }
  return null;
}

/** Card buttons are a projection too — a button that calls a non-remote command is a bug. */
export function cardButtons(commands = COMMANDS) {
  return commands
    .filter((cmd) => cmd.card != null)
    .map((cmd) => {
      if (!cmd.remote) throw new Error(`命令 ${cmd.name} 有卡片按钮但没有标记 remote`);
      return { command: cmd.name, ...cmd.card };
    });
}
