import { createServer } from "node:http";
import { join } from "node:path";
import { CLOUD_COMMANDS } from "../../core/src/commands.mjs";
import { buildRoutes, matchRoute } from "../../core/src/routes.mjs";
import { activityMessage, createActivityLog } from "./activity-log.mjs";
import { openControlStore, sessionTtlMs } from "./control-store.mjs";
import { createGoogleOAuth, GoogleLoginError } from "./google.mjs";
import { loginPage, loginStyleHash, signedInPage } from "./login-page.mjs";

const cloudRoutes = buildRoutes(CLOUD_COMMANDS);
const routesByName = new Map(cloudRoutes.map((route) => [route.command, route]));
const commandsByName = new Map(CLOUD_COMMANDS.map((command) => [command.name, command]));
const googlePath = routesByName.get("session.create").path;
const revokePath = routesByName.get("session.revoke").path;
const callbackPath = "/login/google/callback";
export const sessionCookieName = "__Host-hifabu-session";
const loginCookieName = "__Host-hifabu-login";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const linkPattern = /^[A-Za-z0-9-]{1,32}$/;

export function publicOrigin(value) {
  const url = new URL(value);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Hifabu 公开地址必须是 HTTPS 来源或本地回环来源，且不带路径。");
  }
  return url.origin;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(req, name) {
  const pair = req.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  const token = pair?.slice(name.length + 1);
  return tokenPattern.test(token ?? "") ? token : null;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function validLink(value) {
  return linkPattern.test(value ?? "") ? value : null;
}

async function readLoginForm(req) {
  const type = req.headers["content-type"]?.split(";")[0].trim();
  if (type !== "application/x-www-form-urlencoded") throw new GoogleLoginError("request_invalid");
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 2048) {
      req.resume();
      throw new GoogleLoginError("request_invalid");
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function onlyParam(params, name) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

export function createCloudServer({
  origin: configuredOrigin,
  dataDir,
  logRetentionDays,
  google: googleConfig,
  resolveLink = () => null,
  clock = Date.now,
}) {
  const origin = publicOrigin(configuredOrigin);
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("请配置 Hifabu 独立数据目录。");
  const google = createGoogleOAuth(googleConfig, new URL(callbackPath, origin).href, { clock });
  const log = createActivityLog({ directory: join(dataDir, "logs"), retentionDays: logRetentionDays, clock });
  let store;
  try {
    store = openControlStore(join(dataDir, "control.db"), { clock });
  } catch (error) {
    log.close();
    throw error;
  }

  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; style-src 'sha256-${loginStyleHash}'; form-action 'self' ${google.authorizationOrigin}`,
    // Chrome sends Origin: null on form submissions with no-referrer. Preserve the
    // same-origin Origin header without ever sending the callback URL or its query.
    "Referrer-Policy": "strict-origin",
    "X-Content-Type-Options": "nosniff",
  };

  function html(res, status, body) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  }

  function fail(res, status, code) {
    log.record(code);
    json(res, status, { error_code: code, message: activityMessage(code) });
  }

  async function machineFor(value) {
    const code = validLink(value);
    if (!code) return null;
    // The pairing service supplies this lookup. A caller cannot set its display name or redirect target.
    const name = await resolveLink(code);
    return typeof name === "string" && name ? { code, name } : null;
  }

  async function finishLogin(req, res, params) {
    const state = onlyParam(params, "state");
    const verifier = readCookie(req, loginCookieName);
    const attempt = verifier && tokenPattern.test(state ?? "") && store.consumeLogin(state, verifier);
    if (!attempt) {
      log.record("google_state_invalid");
      html(res, 403, loginPage({ googlePath, message: activityMessage("google_state_invalid") }));
      return;
    }
    const clearLogin = cookie(loginCookieName, "", 0);
    res.setHeader("Set-Cookie", clearLogin);
    const code = onlyParam(params, "code");
    const providerError = onlyParam(params, "error");
    try {
      if (providerError === "access_denied") throw new GoogleLoginError("google_cancelled");
      if (providerError) throw new GoogleLoginError("google_unavailable");
      if (!code || code.length > 2048) throw new GoogleLoginError("google_identity_invalid");
      const identity = await google.exchange({ code, verifier, nonce: attempt.nonce });
      const { token } = store.signIn(identity, readCookie(req, sessionCookieName));
      res.setHeader("Set-Cookie", [clearLogin, cookie(sessionCookieName, token, sessionTtlMs / 1000)]);
      log.record("login_succeeded");
      redirect(res, attempt.link_code ? `/link?${new URLSearchParams({ code: attempt.link_code })}` : "/account");
    } catch (error) {
      if (!(error instanceof GoogleLoginError)) throw error;
      const { code, message } = error;
      const status = code === "google_cancelled" ? 200 : code === "google_unavailable" ? 502 : 403;
      log.record(code);
      html(res, status, loginPage({ googlePath, machine: await machineFor(attempt.link_code), message }));
    }
  }

  const actions = {
    async "session.create"(req, res) {
      const fields = await readLoginForm(req);
      const machine = await machineFor(onlyParam(fields, "code"));
      const attempt = store.beginLogin(machine?.code);
      log.record("login_started");
      res.setHeader("Set-Cookie", cookie(loginCookieName, attempt.verifier, attempt.maxAge));
      redirect(res, google.authorizationUrl(attempt));
    },
    "session.get"(req, res) {
      const session = store.session(readCookie(req, sessionCookieName));
      const data = session ? { user: { id: session.id, email: session.email }, expiresAt: session.expires_at } : { user: null };
      json(res, 200, data);
    },
    "session.revoke"(req, res) {
      store.revokeSession(readCookie(req, sessionCookieName));
      log.record("logout_succeeded");
      res.setHeader("Set-Cookie", cookie(sessionCookieName, "", 0));
      if (req.headers.accept?.includes("text/html")) redirect(res, "/login");
      else json(res, 200, { user: null });
    },
  };

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    try {
      const url = new URL(req.url, origin);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin !== origin) {
        return fail(res, 403, "origin_forbidden");
      }
      const route = matchRoute(req.method, url.pathname, cloudRoutes);
      if (route) {
        const { permission } = commandsByName.get(route.command);
        if (permission !== "public" && permission !== "session") return fail(res, 500, "internal_error");
        if (permission === "session" && !store.session(readCookie(req, sessionCookieName))) {
          return fail(res, 401, "session_required");
        }
        return await actions[route.command](req, res);
      }
      if (req.method === "GET" && url.pathname === callbackPath) return await finishLogin(req, res, url.searchParams);
      if (req.method === "GET" && url.pathname === "/login") {
        return html(res, 200, loginPage({ googlePath, machine: await machineFor(onlyParam(url.searchParams, "code")) }));
      }
      if (req.method === "GET" && url.pathname === "/account") {
        const session = store.session(readCookie(req, sessionCookieName));
        return session ? html(res, 200, signedInPage(session, revokePath)) : redirect(res, "/login");
      }
      json(res, 404, { error_code: "not_found", message: "找不到这一页。" });
    } catch (error) {
      if (error instanceof GoogleLoginError) return fail(res, 400, error.code);
      fail(res, 500, "internal_error");
    }
  });
  server.once("close", () => {
    store.close();
    log.close();
  });
  return server;
}
