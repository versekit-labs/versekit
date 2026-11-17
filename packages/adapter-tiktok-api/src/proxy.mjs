// 代理支持（ACC-tiktok-api-07）。Node 22 内置 fetch 只在进程启动时读 NODE_USE_ENV_PROXY，
// 运行中设置无效，也读不到 ALL_PROXY；用户不该为此去改启动方式。所以这里用 node:http/https
// 自己走一遍 CONNECT 隧道，仍然零运行时依赖。没配代理或命中 NO_PROXY 时直接用全局 fetch。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { AdapterError } from "../../core/src/errors.mjs";

export const PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];

const pick = (env, name) => env[name] || env[name.toLowerCase()] || "";

/** 对某个 URL 生效的代理地址（字符串）或 null。 */
export function proxyFor(url, env = process.env) {
  const u = new URL(url);
  if (bypassed(u, pick(env, "NO_PROXY"))) return null;
  const https_ = u.protocol === "https:";
  const raw = (https_ ? pick(env, "HTTPS_PROXY") : pick(env, "HTTP_PROXY")) || pick(env, "ALL_PROXY");
  if (!raw) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

function bypassed(u, noProxy) {
  if (!noProxy) return false;
  const host = u.hostname.toLowerCase();
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  for (let item of noProxy.split(/[,\s]+/).filter(Boolean)) {
    item = item.toLowerCase();
    if (item === "*") return true;
    let p = null;
    const m = /^(.*):(\d+)$/.exec(item);
    if (m && !item.startsWith("[")) [, item, p] = m;
    if (p && p !== port) continue;
    item = item.replace(/^\*?\./, "");
    if (host === item || host.endsWith("." + item)) return true;
  }
  return false;
}

/** 给 doctor 用：当前生效的代理，只含主机和端口，绝不带账号密码。 */
export function describeProxy(env = process.env) {
  const found = [];
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
    const raw = pick(env, name);
    if (!raw) continue;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
      found.push({ var: name, hostport: u.host });
    } catch {
      found.push({ var: name, hostport: "（格式无法解析）" });
    }
  }
  return { proxies: found, noProxy: Boolean(pick(env, "NO_PROXY")) };
}

const hint = (proxy) =>
  `网络或代理问题：连不上${proxy ? `（经代理 ${new URL(proxy).host}）` : ""}，请检查 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY 这几个环境变量`;

/** 把底层网络错误翻成 network_unreachable，人话里带上该查的变量。 */
export function networkError(err, url, env = process.env) {
  const proxy = proxyFor(url, env);
  const why = err?.cause?.code || err?.code || err?.message || "fetch failed";
  return new AdapterError("network_unreachable", `${hint(proxy)}（${why}）`, { cause: err });
}

function connectTunnel(proxyUrl, target, signal) {
  const p = new URL(proxyUrl);
  const mod = p.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { Host: `${target.hostname}:${target.port || 443}` };
    if (p.username) headers["Proxy-Authorization"] = "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64");
    const req = mod.request({ host: p.hostname, port: p.port || (p.protocol === "https:" ? 443 : 80), method: "CONNECT", path: `${target.hostname}:${target.port || 443}`, headers, signal });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error(`代理返回 ${res.statusCode}`), { code: "PROXY_REJECTED" }));
      } else resolve(socket);
    });
    req.once("error", reject);
    req.end();
  });
}

async function viaProxy(url, init, proxy, signal) {
  const u = new URL(url);
  const body = init.body == null ? null : Buffer.from(typeof init.body === "string" ? init.body : init.body);
  const headers = { ...(init.headers ?? {}) };
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) headers["Content-Length"] = String(body.length);
  let reqOpts;
  if (u.protocol === "https:") {
    const socket = await connectTunnel(proxy, u, signal);
    // Node 26 起 servername 不许是 IP（ERR_INVALID_ARG_VALUE）；IP 目标不设 SNI。URL 里的 IPv6 带方括号。
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let tlsSocket;
    try {
      tlsSocket = tls.connect(net.isIP(host) ? { socket } : { socket, servername: host });
    } catch (err) {
      socket.destroy(); // 否则隧道 socket 一直开着，进程/测试文件被挂住
      throw err;
    }
    // agent:false 会新建默认 agent 并忽略 createConnection，隧道就被绕过、直连 host:443；必须用自带 createConnection 的 agent。
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => tlsSocket;
    reqOpts = { agent };
  } else {
    // 明文 http：请求直接发给代理，路径写完整 URL。
    const p = new URL(proxy);
    reqOpts = { host: p.hostname, port: p.port || 80, path: u.href, agent: false };
  }
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).request(
      { method: init.method ?? "GET", headers: { Host: u.host, ...headers }, signal, ...(u.protocol === "https:" ? { path: u.pathname + u.search, host: u.hostname } : {}), ...reqOpts },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) h.append(k, x);
          const nullBody = [101, 204, 205, 304].includes(res.statusCode);
          resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status: res.statusCode, statusText: res.statusMessage, headers: h }));
        });
      },
    );
    req.once("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 官方接口适配器统一的出口：有代理走代理，否则全局 fetch。
 * 网络层失败（超时、拒绝连接、代理不通）抛 network_unreachable；用户主动中止的信号原样抛出由调用方处理。
 */
export async function proxiedFetch(url, init = {}, env = process.env) {
  const href = String(url);
  const proxy = proxyFor(href, env);
  try {
    if (!proxy) return await fetch(href, init);
    const { signal, ...rest } = init;
    return await viaProxy(href, rest, proxy, signal);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw networkError(err, href, env);
  }
}
