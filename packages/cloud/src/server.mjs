import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "../../core/src/commands.mjs";
import { matchRoute } from "../../core/src/routes.mjs";
import { accountErrorPage, accountPage, accountScriptHash, accountStyleHash, adminPage, deleteAccountPage } from "./account-page.mjs";
import { activityMessage, createActivityLog } from "./activity-log.mjs";
import { openControlStore, sessionTtlMs } from "./control-store.mjs";
import { createDeviceFlow, DeviceFlowError, linkPath } from "./device-flow.mjs";
import { createGoogleOAuth, GoogleLoginError } from "./google.mjs";
import { linkPage, loginPage, loginStyleHash } from "./login-page.mjs";
import { loadMachineSigner } from "./machine-token.mjs";
import { createRelayControl } from "./relay-control.mjs";
import { cloudCommands, cloudRoute, cloudRoutes, cloudTextArgs, isLoopback, publicOrigin } from "./transport.mjs";

const googlePath = cloudRoute("session.create").path;
const callbackPath = "/login/google/callback";
export const sessionCookieName = "__Host-hifabu-session";
const loginCookieName = "__Host-hifabu-login";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const linkPattern = /^[A-Za-z0-9-]{1,32}$/;
export const machineKeyPath = "/.well-known/hifabu-machine-key.pem";
export { publicOrigin } from "./transport.mjs";

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

async function readSmallBody(req, invalid) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 2048) {
      req.resume();
      throw invalid();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readLoginForm(req) {
  const invalid = () => new GoogleLoginError("request_invalid");
  const type = req.headers["content-type"]?.split(";")[0].trim();
  if (type !== "application/x-www-form-urlencoded") throw invalid();
  return new URLSearchParams(await readSmallBody(req, invalid));
}

async function readCommandArgs(req, route, errorCode) {
  const invalid = () => new DeviceFlowError(errorCode, 400);
  const command = cloudCommands.get(route.command);
  try {
    const raw = req.method === "POST" ? await readSmallBody(req, invalid) : "";
    const type = req.headers["content-type"]?.split(";")[0].trim();
    let fields = {};
    if (raw && type === "application/json") {
      fields = JSON.parse(raw);
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw invalid();
    } else if (raw && type === "application/x-www-form-urlencoded") {
      const params = [...new URLSearchParams(raw)];
      fields = Object.fromEntries(params);
      if (Object.keys(fields).length !== params.length) throw invalid();
      fields = cloudTextArgs(command, fields);
    } else if (raw) {
      throw invalid();
    }
    if (Object.keys(route.params).some((key) => Object.hasOwn(fields, key))) throw invalid();
    return parseArgs(command, { ...fields, ...route.params });
  } catch {
    throw invalid();
  }
}

function deviceCredential(req, invalidCode = "device_inactive") {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1];
  if (!token) throw new DeviceFlowError(invalidCode, 401);
  return token;
}

function onlyParam(params, name) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function macDownloadUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) || url.username || url.password) {
    throw new Error("Mac 安装包地址必须是 HTTPS 或本地回环地址。");
  }
  return url.href;
}

export function createCloudServer({
  origin: configuredOrigin,
  dataDir,
  logRetentionDays,
  google: googleConfig,
  resolveLink = () => null,
  signingKeyFile,
  relayUrl: configuredRelayUrl,
  ownerEmail: configuredOwnerEmail,
  downloadUrl: configuredDownloadUrl,
  clock = Date.now,
}) {
  const origin = publicOrigin(configuredOrigin);
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("请配置 Hifabu 独立数据目录。");
  const google = createGoogleOAuth(googleConfig, new URL(callbackPath, origin).href, { clock });
  const signer = signingKeyFile ? loadMachineSigner(signingKeyFile, { clock }) : null;
  const relayUrl = configuredRelayUrl ? publicOrigin(configuredRelayUrl) : null;
  const ownerEmail = configuredOwnerEmail?.trim().toLowerCase() || null;
  const downloadUrl = macDownloadUrl(configuredDownloadUrl);
  const relayControl = createRelayControl(relayUrl, signer);
  const log = createActivityLog({ directory: join(dataDir, "logs"), retentionDays: logRetentionDays, clock });
  let store;
  try {
    store = openControlStore(join(dataDir, "control.db"), { clock });
  } catch (error) {
    log.close();
    throw error;
  }
  const deleting = new Set();
  const isDeleting = (id) => deleting.has(id);
  const pairing = signer && createDeviceFlow({ store, signer, relayUrl, origin, clock, isDeleting });

  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; style-src 'sha256-${loginStyleHash}' 'sha256-${accountStyleHash}'; script-src 'sha256-${accountScriptHash}'; form-action 'self' ${google.authorizationOrigin}`,
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

  const isOwner = (session) => Boolean(session && session.email === ownerEmail);
  const sessionFor = (req) => store.session(readCookie(req, sessionCookieName));
  const wantsHtml = (req) => req.headers.accept?.includes("text/html");

  function accountFailure(req, res, status, code, session, back, confirmUser) {
    if (!wantsHtml(req)) return fail(res, status, code);
    log.record(code);
    const message = activityMessage(code);
    const body = confirmUser ? deleteAccountPage(session, confirmUser, message) :
      accountErrorPage(message, back, session, isOwner(session));
    return html(res, status, body);
  }

  async function usage(accountId) {
    try {
      return await relayControl.usage(accountId);
    } catch {
      return { usedBytes: null, freeBytes: null };
    }
  }

  async function grantFor(accountId) {
    const grant = store.relayGrant(accountId);
    const usedBytes = grant.enabled ? (await usage(accountId)).usedBytes : null;
    if (grant.enabled && usedBytes == null) log.record("relay_usage_unavailable");
    return { ...grant, usedBytes };
  }

  async function userOverview() {
    const rows = await Promise.all(store.listUsers().map(async (user) => ({ user, ...(await usage(user.id)) })));
    if (rows.some(({ usedBytes }) => usedBytes == null)) log.record("relay_usage_unavailable");
    return {
      users: rows.map(({ user, usedBytes }) => ({ ...user, usedBytes })),
      freeBytes: rows.find(({ freeBytes }) => freeBytes != null)?.freeBytes ?? null,
    };
  }

  async function machineFor(value) {
    const link = pairing?.find(value);
    if (link) return link.state === "waiting" ? { code: value, name: link.name } : null;
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
      redirect(res, attempt.link_code ? linkPath(attempt.link_code) : "/account");
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
      const selectAccount = Boolean(machine && pairing?.find(machine.code) && store.session(readCookie(req, sessionCookieName)));
      redirect(res, google.authorizationUrl({ ...attempt, selectAccount }));
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

  function requirePairing() {
    if (!pairing) throw new DeviceFlowError("device_signing_unavailable", 503);
    return pairing;
  }

  const deviceActions = {
    "device.link.start"(req, res, args) {
      const challenge = requirePairing().start(args);
      log.record("device_link_started");
      json(res, 201, challenge);
    },
    "device.link.poll"(req, res) {
      const result = requirePairing().poll(deviceCredential(req));
      if (result.state === "expired") log.record("device_link_expired");
      json(res, 200, result);
    },
    "device.link.decide"(req, res, { code, decision }, session) {
      if (isDeleting(session.id)) return fail(res, 409, "account_delete_in_progress");
      const link = requirePairing().find(code);
      const waiting = link?.state === "waiting";
      const state = pairing.decide(code, session.id, decision);
      if (waiting) log.record(state === "linked" ? "device_linked" : "device_link_denied");
      if (req.headers.accept?.includes("text/html")) redirect(res, linkPath(code));
      else json(res, 200, { state });
    },
    "device.refresh"(req, res) {
      json(res, 200, requirePairing().refresh(deviceCredential(req)));
    },
    "device.list"(req, res, args, session) {
      json(res, 200, { machines: store.listMachines(session.id) });
    },
    "device.revoke"(req, res, { deviceId }, session) {
      if (!store.revokeMachine(session.id, deviceId)) throw new DeviceFlowError("device_not_found", 404);
      log.record("device_revoked");
      if (req.headers.accept?.includes("text/html")) redirect(res, "/account");
      else json(res, 200, { revoked: true });
    },
    "device.revoke.self"(req, res) {
      const invalid = "device_revoke_credential_invalid";
      if (!store.revokeOwnMachine(deviceCredential(req, invalid))) throw new DeviceFlowError(invalid, 401);
      log.record("device_revoked");
      json(res, 200, { revoked: true });
    },
  };

  const accountActions = {
    async "relay.grant.status"(req, res, args, session) {
      json(res, 200, await grantFor(session.id));
    },
    "relay.grant.request"(req, res, args, session) {
      if (isDeleting(session.id)) return accountFailure(req, res, 409, "account_delete_in_progress", session, "/account");
      const { grant, changed } = store.requestRelay(session.id);
      if (changed) log.record("relay_requested");
      return wantsHtml(req) ? redirect(res, "/account") : json(res, 200, grant);
    },
    "relay.grant.set"(req, res, { accountId, state, capacityGb }, session) {
      const flag = state === "on" || state === "off";
      const capacityBytes = capacityGb == null ? undefined : Math.round(capacityGb * 1_000_000_000);
      if ((!flag && state != null && state !== "keep") || (!flag && capacityBytes == null) ||
          (capacityBytes != null && (capacityGb < 0 || !Number.isSafeInteger(capacityBytes)))) {
        return accountFailure(req, res, 400, "account_request_invalid", session, "/admin");
      }
      if (isDeleting(accountId)) return accountFailure(req, res, 409, "account_delete_in_progress", session, "/admin");
      const result = store.setRelayGrant(accountId, { enabled: flag ? state === "on" : undefined, capacityBytes });
      if (!result) return accountFailure(req, res, 404, "account_not_found", session, "/admin");
      log.record("relay_grant_updated");
      return wantsHtml(req) ? redirect(res, "/admin") : json(res, 200, result);
    },
    async "user.list"(req, res) {
      json(res, 200, await userOverview());
    },
    async "user.delete"(req, res, { accountId, confirmEmail }, session) {
      const user = store.findUser(accountId);
      if (!user) return accountFailure(req, res, 404, "account_not_found", session, "/admin");
      if (confirmEmail.trim().toLowerCase() !== user.email) {
        return accountFailure(req, res, 400, "delete_confirmation_invalid", session, "/admin", user);
      }
      if (isDeleting(accountId)) return accountFailure(req, res, 409, "account_delete_in_progress", session, "/admin", user);
      deleting.add(accountId);
      try {
        try {
          await relayControl.deleteAccount(accountId);
        } catch (error) {
          const busy = error.status === 409;
          return accountFailure(req, res, busy ? 409 : 502, busy ? "account_relay_busy" : "account_relay_unavailable", session, "/admin", user);
        }
        const links = pairing?.linksFor(accountId) ?? [];
        store.deleteUser(accountId, links);
        pairing?.forget(links);
        log.record("account_deleted");
      } finally {
        deleting.delete(accountId);
      }
      if (session.id === accountId) res.setHeader("Set-Cookie", cookie(sessionCookieName, "", 0));
      return wantsHtml(req) ? redirect(res, session.id === accountId ? "/account" : "/admin") : json(res, 200, { deleted: true });
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
        const { permission } = cloudCommands.get(route.command);
        const sessionNeeded = permission === "session" || permission === "owner";
        let session = sessionNeeded ? sessionFor(req) : null;
        const denied = () => permission === "owner" && !isOwner(session) ? [403, "owner_required"] :
          permission === "session" && !session ? [401, "session_required"] : null;
        const rejection = denied();
        if (rejection) return fail(res, ...rejection);
        if (actions[route.command]) return await actions[route.command](req, res);
        const accountAction = accountActions[route.command];
        const args = await readCommandArgs(req, route, accountAction ? "account_request_invalid" : "device_link_invalid");
        if (sessionNeeded) session = sessionFor(req);
        const recheck = denied();
        if (recheck) return fail(res, ...recheck);
        if (accountAction) return await accountAction(req, res, args, session);
        return deviceActions[route.command](req, res, args, session);
      }
      if (req.method === "GET" && url.pathname === callbackPath) return await finishLogin(req, res, url.searchParams);
      if (req.method === "GET" && url.pathname === "/login") {
        const machine = await machineFor(onlyParam(url.searchParams, "code"));
        if (!machine && sessionFor(req)) return redirect(res, "/account");
        return html(res, 200, loginPage({ googlePath, machine }));
      }
      if (req.method === "GET" && url.pathname === "/link") {
        const code = onlyParam(url.searchParams, "code");
        const link = pairing?.find(code);
        const session = store.session(readCookie(req, sessionCookieName));
        if (!link || (link.userId && session && link.userId !== session.id)) {
          return html(res, 410, linkPage());
        }
        if (!session) return html(res, 200, linkPage({ login: linkPath(code, "/login") }));
        return html(res, 200, linkPage({
          link, email: session.email, login: linkPath(code, "/login"),
          decisionPath: cloudRoute("device.link.decide", { code }).path,
        }));
      }
      if (req.method === "GET" && url.pathname === machineKeyPath && signer) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(signer.publicPem);
      }
      if (req.method === "GET" && url.pathname === "/account") {
        const session = sessionFor(req);
        const grant = session && await grantFor(session.id);
        const machines = session ? store.listMachines(session.id) : [];
        return html(res, 200, accountPage({ session, owner: isOwner(session), grant, machines, downloadUrl, now: clock() }));
      }
      if (req.method === "GET" && url.pathname === "/admin") {
        const session = sessionFor(req);
        if (!isOwner(session)) return accountFailure(req, res, 403, "owner_required", session, "/account");
        if (url.searchParams.has("delete")) {
          const user = store.findUser(onlyParam(url.searchParams, "delete"));
          if (!user) return accountFailure(req, res, 404, "account_not_found", session, "/admin");
          return html(res, 200, deleteAccountPage(session, user));
        }
        return html(res, 200, adminPage({ session, ...(await userOverview()), now: clock() }));
      }
      json(res, 404, { error_code: "not_found", message: "找不到这一页。" });
    } catch (error) {
      if (error instanceof GoogleLoginError) return fail(res, 400, error.code);
      if (error instanceof DeviceFlowError) {
        if (error.code === "device_link_expired" && req.headers.accept?.includes("text/html")) {
          log.record(error.code);
          return html(res, error.status, linkPage());
        }
        return fail(res, error.status, error.code);
      }
      fail(res, 500, "internal_error");
    }
  });
  server.once("close", () => {
    store.close();
    log.close();
  });
  return server;
}
