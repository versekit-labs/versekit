// Login Kit for Desktop：本机临时端口接回调 + PKCE + state 校验；token 存本地凭证目录并在过期前续期。

import { createServer } from "node:http";
import { AdapterError } from "../../core/src/errors.mjs";
import { callApi, callToken } from "./api.mjs";
import { codeChallenge, newCodeVerifier, newState } from "./pkce.mjs";
import { SCOPES, authBase, credentialRefFor, readTokens, requireClientCredentials, writeTokens } from "./settings.mjs";

export const CALLBACK_PATH = "/callback/tiktok/";
const REFRESH_MARGIN_MS = 5 * 60e3;
/** 续期令牌（365 天）快到期时提示，不是失败。 */
export const REFRESH_EXPIRING_MS = 7 * 24 * 3600e3;

export function authorizeUrl({ clientKey, redirectUri, state, verifier }) {
  const url = new URL(authBase() + "/v2/auth/authorize/");
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem"><h1>${title}</h1><p>${body}</p>`;

/**
 * 在 127.0.0.1 的临时端口上等一次回调。拿到结果（成功、被拒、state 不符、超时）就立刻关端口。
 * 返回 { redirectUri, result }：result 是 Promise<{ code }>。
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
      send(400, "授权被拒绝", "回调里的 state 对不上，可能不是你刚才发起的授权。回到终端重新运行 vk account connect。");
      settle.reject(new Error("TikTok 回调的 state 对不上（可能是别的页面伪造的回调），已拒绝，没有使用其中的授权码；请重新运行 vk account connect"));
    } else if (error) {
      send(200, "授权没有完成", "你在 TikTok 页面上取消了授权。回到终端可以重新开始。");
      settle.reject(new Error(`你在 TikTok 授权页上取消了授权（${error}）：需要时重新运行 vk account connect`));
    } else if (!url.searchParams.get("code")) {
      send(400, "授权没有完成", "回调里没有授权码。");
      settle.reject(new Error("TikTok 回调里没有授权码：请重新运行 vk account connect"));
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
    () => settle.reject(new Error(`${Math.round(timeoutMs / 60e3)} 分钟内没有收到 TikTok 的授权回调，已取消：重新运行 vk account connect`)),
    timeoutMs,
  );
  const closed = result.then(
    () => {},
    () => {},
  ).then(() => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  });
  return { redirectUri, result, closed, server };
}

/**
 * 完整授权：起临时端口 → 给出授权链接（onUrl）→ 等回调 → 换 token → 读头像昵称 → 存凭证。
 * 不写数据库：返回值交给 core 的 store 落到账号行。
 */
export async function connect({ accountId, onUrl, timeoutMs = 5 * 60e3, signal } = {}) {
  const { clientKey, clientSecret } = requireClientCredentials();
  const verifier = newCodeVerifier();
  const state = newState();
  const listener = await listenForCallback({ state, timeoutMs });
  try {
    const url = authorizeUrl({ clientKey, redirectUri: listener.redirectUri, state, verifier });
    await onUrl?.(url, { redirectUri: listener.redirectUri, state });
    const { code } = await listener.result;
    await listener.closed; // 拿到 code 后先确认端口已关，再去换 token
    const token = await callToken(
      {
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: listener.redirectUri,
        code_verifier: verifier,
      },
      { signal },
    );
    const profile = await fetchProfile(token.access_token, { signal });
    const ref = credentialRefFor(accountId);
    const now = Date.now();
    writeTokens(ref, tokenRecord(token, now, { profile, previous: null }));
    return {
      accountId,
      credentialRef: ref,
      displayName: profile.display_name ?? null,
      avatarUrl: profile.avatar_url ?? null,
      openId: profile.open_id ?? token.open_id ?? null,
      expiresAt: token.refresh_expires_in ? now + Number(token.refresh_expires_in) * 1000 : null,
    };
  } finally {
    // 失败路径也要关端口（state 不符、超时都会走到这里）。
    listener.server.close();
    listener.server.closeAllConnections?.();
  }
}

/** user.info.basic：头像与昵称，界面要显示，让人确认连对了账号。 */
export async function fetchProfile(accessToken, { signal } = {}) {
  const data = await callApi("/v2/user/info/", {
    method: "GET",
    token: accessToken,
    query: { fields: "open_id,avatar_url,display_name" },
    signal,
  });
  return data.user ?? {};
}

function tokenRecord(token, now, { profile, previous }) {
  return {
    version: 1,
    open_id: token.open_id ?? previous?.open_id ?? null,
    scope: token.scope ?? previous?.scope ?? SCOPES.join(","),
    access_token: token.access_token,
    expires_at: now + Number(token.expires_in ?? 0) * 1000,
    refresh_token: token.refresh_token ?? previous?.refresh_token ?? null,
    refresh_expires_at: token.refresh_expires_in != null ? now + Number(token.refresh_expires_in) * 1000 : previous?.refresh_expires_at ?? null,
    profile: profile ?? previous?.profile ?? null,
    updated_at: now,
  };
}

const refreshing = new Map();

/**
 * 返回一个可用的 access_token：离过期不到 5 分钟就用 refresh_token 续期并写回（refresh_token 可能轮换）。
 * 没授权过、refresh_token 过期、续期被拒 → AdapterError("auth")，core 据此转「需要重新登录」。
 */
export async function ensureAccessToken(credentialRef, { now = Date.now(), signal } = {}) {
  const relogin = (why) => new AdapterError("auth", `TikTok 需要重新登录（${why}）：vk account connect <accountId>`);
  const rec = credentialRef ? readTokens(credentialRef) : null;
  if (!rec?.access_token) throw relogin("这个账号还没有授权");
  if (rec.expires_at - now > REFRESH_MARGIN_MS) return { token: rec.access_token, record: rec };
  if (!rec.refresh_token || (rec.refresh_expires_at && rec.refresh_expires_at <= now)) throw relogin("续期令牌已过期");

  if (!refreshing.has(credentialRef)) {
    const job = (async () => {
      const { clientKey, clientSecret } = requireClientCredentials();
      let token;
      try {
        token = await callToken(
          { client_key: clientKey, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: rec.refresh_token },
          { signal },
        );
      } catch (err) {
        // 续期被拒（令牌被撤销、过期）= 需要重新登录；网络与限流照原样抛，不要误判成掉线。
        if (err instanceof AdapterError && ["platform_reject", "auth"].includes(err.code)) throw relogin("续期失败：" + err.message);
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
