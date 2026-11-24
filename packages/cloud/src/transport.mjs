import { CLOUD_COMMANDS, parseArgs } from "../../core/src/commands.mjs";
import { buildRoutes } from "../../core/src/routes.mjs";

export const cloudRoutes = buildRoutes(CLOUD_COMMANDS);
export const cloudCommands = new Map(CLOUD_COMMANDS.map((command) => [command.name, command]));
const routesByName = new Map(cloudRoutes.map((route) => [route.command, route]));

export const isLoopback = (url) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

export function publicOrigin(value) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Hifabu 公开地址必须是 HTTPS 来源或本地回环来源，且不带路径。");
  }
  return url.origin;
}

export function cloudRoute(name, params = {}) {
  const route = routesByName.get(name);
  const fields = { ...params };
  const path = route.path.replace(/:([A-Za-z]+)/g, (_, key) => {
    const value = fields[key];
    delete fields[key];
    return encodeURIComponent(value);
  });
  return { path, method: route.method, fields };
}

export async function callCloud(origin, name, args = {}, headers = {}) {
  const { path, method, fields } = cloudRoute(name, parseArgs(cloudCommands.get(name), args));
  let response;
  let data;
  try {
    const body = method === "POST" && Object.keys(fields).length ? JSON.stringify(fields) : undefined;
    response = await fetch(new URL(path, origin), {
      method, redirect: "error", signal: AbortSignal.timeout(10_000), body,
      headers: { Origin: origin, ...headers, ...(body && { "Content-Type": "application/json" }) },
    });
    data = await response.json();
  } catch {
    throw Object.assign(new Error("暂时连不上 Hifabu 账号服务，请检查网络后重试。"), { code: "cloud_unavailable" });
  }
  if (!response.ok) {
    throw Object.assign(new Error(data?.message ?? "Hifabu 账号服务暂时无法处理请求，请重试。"), {
      code: data?.error_code ?? "cloud_unavailable", status: response.status,
    });
  }
  return data;
}
