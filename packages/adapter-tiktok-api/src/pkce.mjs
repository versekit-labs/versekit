// PKCE（Login Kit for Desktop）。
//
// TikTok 与 RFC 7636 不同：`code_challenge` 是 code_verifier 的 **SHA256 的 hex 编码**，
// 不是 base64url（https://developers.tiktok.com/doc/login-kit-desktop）。照 RFC 写会得到
// 一个 TikTok 校验不过的 challenge，授权换 token 时才报错，所以这里单独成文件、单测钉住。

import { createHash, randomBytes } from "node:crypto";

/** 每次授权新生成：64 个字符，落在 RFC 7636 允许的 43–128 位与字符集内。 */
export function newCodeVerifier() {
  return randomBytes(48).toString("base64url");
}

/** TikTok 口径：hex(SHA256(verifier))。 */
export function codeChallenge(verifier) {
  return createHash("sha256").update(String(verifier)).digest("hex");
}

/** 防 CSRF 的 state：回调里必须原样带回。 */
export function newState() {
  return randomBytes(16).toString("hex");
}
