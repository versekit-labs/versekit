// PKCE（RFC 7636，Google OAuth 2.0 for Desktop）：code_challenge = BASE64URL(SHA256(verifier))，method=S256。
// 注意与 TikTok 不同（TikTok 是 hex）；两个适配器各自一份，不共用，免得改一个坏另一个。

import { createHash, randomBytes } from "node:crypto";

/** 每次授权新生成：64 个字符，落在 RFC 7636 允许的 43–128 位与字符集内。 */
export function newCodeVerifier() {
  return randomBytes(48).toString("base64url");
}

export function codeChallenge(verifier) {
  return createHash("sha256").update(String(verifier)).digest("base64url");
}

/** 防 CSRF 的 state：回调里必须原样带回。 */
export function newState() {
  return randomBytes(16).toString("hex");
}
