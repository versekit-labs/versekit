// Google OAuth 2.0（Desktop 客户端）：本机 127.0.0.1 临时端口接回调 + PKCE(S256) + state 校验；
// token 存本地凭证目录并在过期前用 refresh_token 续期。结构参照 adapter-tiktok-api/src/auth.mjs。
//
// 用的是**用户自己**的 OAuth 客户端（client id / secret 在系统页填）；授权时用哪个 Google 号由用户在浏览器里选。

import { createServer } from "node:http";
import { AdapterError } from "../../core/src/errors.mjs";
import { callApi, callToken } from "./api.mjs";
import { codeChallenge, newCodeVerifier, newState } from "./pkce.mjs";
import { SCOPES, SCOPE_MANAGE, SCOPE_UPLOAD, authBase, credentialRefFor, readTokens, requireClientCredentials, writeTokens } from "./settings.mjs";

export const CALLBACK_PATH = "/callback/youtube/";
const REFRESH_MARGIN_MS = 5 * 60e3;

export function authorizeUrl({ clientId, redirectUri, state, verifier }) {
  const url = new URL(authBase() + "/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline"); // 要 refresh_token
  url.searchParams.set("prompt", "consent"); // 重新授权时也重新发 refresh_token
  return url.toString();
}

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem"><h1>${title}</h1><p>${body}</p>`;

/**
 * 在 127.0.0.1 的临时端口上等一次回调。拿到结果（成功、被拒、state 不符、超时）就立刻关端口。
 * 返回 { redirectUri, result, closed, server }：result 是 Promise<{ code }>。
 */
export async function listenForCallback({ state, timeoutMs }) {
  let settle;
  const result = new Promise((resolve, reject) => (settle = { resolve, reject }));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const send = (status, title, body) => res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(page(title, body));
    const error = url.searchParams.get("error");
    if (url.searchParams.get("state") !== state) {
      send(400, "授权被拒绝", "回调里的 state 对不上，可能不是你刚才发起的授权。回到系统页重新连接。");
      settle.reject(new Error("Google 回调的 state 对不上（可能是别的页面伪造的回调），已拒绝，没有使用其中的授权码；请到系统页重新连接"));
    } else if (error) {
      send(200, "授权没有完成", "你在 Google 页面上取消了授权。回到 versekit 可以重新开始。");
      settle.reject(new Error(`你在 Google 授权页上取消了授权（${error}）：需要时到系统页重新连接`));
    } else if (!url.searchParams.get("code")) {
      send(400, "授权没有完成", "回调里没有授权码。");
      settle.reject(new Error("Google 回调里没有授权码：请到系统页重新连接"));
    } else {
      send(200, "授权完成", "可以关掉这个页面，回到 versekit。");
      settle.resolve({ code: url.searchParams.get("code") });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
  const timer = setTimeout(
    () => settle.reject(new Error(`${Math.round(timeoutMs / 60e3)} 分钟内没有收到 Google 的授权回调，已取消：到系统页重新连接`)),
    timeoutMs,
  );
  const closed = result
    .then(
      () => {},
      () => {},
    )
    .then(() => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    });
  return { redirectUri, result, closed, server };
}

/** 授权频道的名字与头像：让人确认连对了号。读不到频道说明这个 Google 号还没建 YouTube 频道。 */
export async function fetchChannel(accessToken, { signal } = {}) {
  const data = await callApi("/channels", { token: accessToken, query: { part: "snippet", mine: "true" }, signal });
  const ch = data.items?.[0];
  if (!ch) throw new Error("这个 Google 账号下没有 YouTube 频道：先在 YouTube 里创建频道，再回来授权");
  return { channel_id: ch.id, title: ch.snippet?.title ?? null, avatar_url: ch.snippet?.thumbnails?.default?.url ?? null };
}

function tokenRecord(token, now, { profile, previous }) {
  return {
    version: 1,
    scope: token.scope ?? previous?.scope ?? SCOPES.join(" "),
    access_token: token.access_token,
    expires_at: now + Number(token.expires_in ?? 0) * 1000,
    // Google 续期时不会再给 refresh_token：沿用旧的。
    refresh_token: token.refresh_token ?? previous?.refresh_token ?? null,
    profile: profile ?? previous?.profile ?? null,
    updated_at: now,
  };
}

/** 授权里有没有勾选某个权限（Google 允许用户只勾部分）。 */
export const hasScope = (record, scope) => String(record?.scope ?? "").split(/[\s,]+/).includes(scope);

/**
 * 完整授权：起临时端口 → 给出授权链接（onUrl）→ 等回调 → 换 token → 读频道 → 存凭证。
 * 不写数据库：返回值交给 core 的 store 落到账号行。
 */
export async function connect({ accountId, onUrl, timeoutMs = 5 * 60e3, signal } = {}) {
  const { clientId, clientSecret } = requireClientCredentials();
  const verifier = newCodeVerifier();
  const state = newState();
  const listener = await listenForCallback({ state, timeoutMs });
  try {
    const url = authorizeUrl({ clientId, redirectUri: listener.redirectUri, state, verifier });
    await onUrl?.(url, { redirectUri: listener.redirectUri, state });
    const { code } = await listener.result;
    await listener.closed; // 拿到 code 后先确认端口已关，再去换 token
    const token = await callToken(
      { client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: listener.redirectUri, code_verifier: verifier },
      { signal },
    );
    if (!token.refresh_token) throw new Error("Google 没有给长期授权（refresh_token）：到 Google 账号的「第三方访问」里移除这个应用，再回系统页重新连接");
    if (!hasScope(token, SCOPE_UPLOAD)) throw new Error("授权时没有勾选「上传视频」权限，没法发布：回系统页重新连接，并勾选全部权限");
    if (!hasScope(token, SCOPE_MANAGE)) throw new Error("授权时没有勾选「管理 YouTube 账号」权限，没法回读核实发布结果：回系统页重新连接，并勾选全部权限");
    const profile = await fetchChannel(token.access_token, { signal });
    const ref = credentialRefFor(accountId);
    writeTokens(ref, tokenRecord(token, Date.now(), { profile, previous: null }));
    return { accountId, credentialRef: ref, displayName: profile.title, avatarUrl: profile.avatar_url, openId: profile.channel_id, expiresAt: null };
  } finally {
    // 失败路径也要关端口（state 不符、超时都会走到这里）。
    listener.server.close();
    listener.server.closeAllConnections?.();
  }
}

const refreshing = new Map();

/**
 * 返回一个可用的 access_token：离过期不到 5 分钟就用 refresh_token 续期并写回。
 * 没授权过、续期被拒（令牌被撤销或过期）→ AdapterError("auth")，core 据此转「需要重新登录」。
 */
export async function ensureAccessToken(credentialRef, { now = Date.now(), signal } = {}) {
  const relogin = (why) => new AdapterError("auth", `YouTube 需要重新登录（${why}）：到系统页重新授权`);
  const rec = credentialRef ? readTokens(credentialRef) : null;
  if (!rec?.access_token) throw relogin("这个账号还没有授权");
  if (rec.expires_at - now > REFRESH_MARGIN_MS) return { token: rec.access_token, record: rec };
  if (!rec.refresh_token) throw relogin("没有长期授权");

  if (!refreshing.has(credentialRef)) {
    const job = (async () => {
      const { clientId, clientSecret } = requireClientCredentials();
      let token;
      try {
        token = await callToken({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: rec.refresh_token }, { signal });
      } catch (err) {
        // 续期被拒（令牌被撤销、过期）= 需要重新登录；网络与限流照原样抛，不要误判成掉线。
        if (err instanceof AdapterError && err.code === "auth") throw relogin("续期失败，授权已被撤销或过期");
        throw err;
      }
      const next = tokenRecord(token, Date.now(), { profile: null, previous: rec });
      writeTokens(credentialRef, next);
      return next;
    })().finally(() => refreshing.delete(credentialRef));
    refreshing.set(credentialRef, job);
  }
  const record = await refreshing.get(credentialRef);
  return { token: record.access_token, record };
}
