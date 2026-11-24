import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { activityMessage } from "./activity-log.mjs";

const googleEndpoints = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  keysUrl: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const requestTimeoutMs = 10_000;

export const randomToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token) => createHash("sha256").update(token).digest("base64url");

export class GoogleLoginError extends Error {
  constructor(code) {
    super(activityMessage(code));
    this.code = code;
  }
}

function endpoint(value) {
  const url = new URL(value);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname));
  if (!secure || url.username || url.password || url.hash) throw new Error("Google 登录端点必须用 HTTPS 或本地回环地址。");
  return url;
}

function invalidIdentity() {
  return new GoogleLoginError("google_identity_invalid");
}

function readIdToken(token) {
  if (typeof token !== "string" || token.length > 16_384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw invalidIdentity();
  }
  const [header, payload, signature] = token.split(".");
  try {
    return {
      header: JSON.parse(Buffer.from(header, "base64url")),
      claims: JSON.parse(Buffer.from(payload, "base64url")),
      signed: Buffer.from(`${header}.${payload}`),
      signature: Buffer.from(signature, "base64url"),
    };
  } catch {
    throw invalidIdentity();
  }
}

async function providerJson(fetch, url, options) {
  try {
    const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch {
    throw new GoogleLoginError("google_unavailable");
  }
}

export function createGoogleOAuth(config, callbackUrl, { fetch = globalThis.fetch, clock = Date.now } = {}) {
  const { clientId, clientSecret, endpoints = googleEndpoints } = config;
  if (typeof clientId !== "string" || !clientId.trim() || typeof clientSecret !== "string" || !clientSecret.trim()) {
    throw new Error("请配置 Hifabu 的 Google client id 和 secret。");
  }
  const authorization = endpoint(endpoints.authorizationUrl);
  const tokenUrl = endpoint(endpoints.tokenUrl);
  const keysUrl = endpoint(endpoints.keysUrl);
  const issuers = new Set(endpoints.issuers);
  if (!issuers.size) throw new Error("请配置 Google 登录的身份签发方。");

  return {
    authorizationOrigin: authorization.origin,

    authorizationUrl({ state, verifier, nonce }) {
      const url = new URL(authorization);
      for (const [key, value] of Object.entries({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        code_challenge: tokenHash(verifier),
        code_challenge_method: "S256",
      })) url.searchParams.set(key, value);
      return url.href;
    },

    async exchange({ code, verifier, nonce }) {
      const tokens = await providerJson(fetch, tokenUrl, {
        method: "POST",
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callbackUrl,
          grant_type: "authorization_code",
          code_verifier: verifier,
        }),
      });
      const { header, claims, signed, signature } = readIdToken(tokens?.id_token);
      if (header?.alg !== "RS256" || typeof header.kid !== "string") throw invalidIdentity();
      const keys = (await providerJson(fetch, keysUrl))?.keys;
      const jwk = Array.isArray(keys) && keys.find(
        (key) => key?.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig"),
      );
      let validSignature = false;
      if (jwk) {
        try {
          validSignature = verify("RSA-SHA256", signed, createPublicKey({ key: jwk, format: "jwk" }), signature);
        } catch {}
      }
      const now = Math.floor(clock() / 1000);
      if (!validSignature || !issuers.has(claims?.iss) || claims.aud !== clientId ||
          (claims.azp !== undefined && claims.azp !== clientId) || claims.nonce !== nonce ||
          !Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.iat) || claims.iat > now + 60 ||
          typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255) {
        throw invalidIdentity();
      }
      if (claims.email_verified !== true) {
        throw new GoogleLoginError("google_email_unverified");
      }
      if (typeof claims.email !== "string" || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(claims.email)) {
        throw invalidIdentity();
      }
      return { provider: "google", subject: claims.sub, email: claims.email };
    },
  };
}
