// 配置与本地凭证。client_key / client_secret 只从环境变量或本地配置读，**不进仓库**；
// token 只落发布机本地凭证目录，账号表只存 credential_ref（BLUEPRINT D6）。
//
// 配置来源（环境变量优先）：
//   TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET   或  config.json 的 tiktok.client_key / tiktok.client_secret
//   TIKTOK_API_BASE（默认 https://open.tiktokapis.com）、TIKTOK_AUTH_BASE（默认 https://www.tiktok.com）
//     —— 开发机测试时指向本地 mock，不连真实服务。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { paths } from "../../core/src/index.mjs";
import { readConfig } from "../../core/src/config.mjs";

export const SCOPES = ["user.info.basic", "video.publish", "video.upload"];
export const PLATFORM = "tiktok-api";

const trimSlash = (s) => String(s).replace(/\/+$/, "");

export const apiBase = () => trimSlash(process.env.TIKTOK_API_BASE || readConfig().tiktok?.api_base || "https://open.tiktokapis.com");
export const authBase = () => trimSlash(process.env.TIKTOK_AUTH_BASE || readConfig().tiktok?.auth_base || "https://www.tiktok.com");

export function clientCredentials() {
  const cfg = readConfig().tiktok ?? {};
  return {
    clientKey: process.env.TIKTOK_CLIENT_KEY || cfg.client_key || null,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || cfg.client_secret || null,
  };
}

export const MISSING_CLIENT_HINT =
  "没有 TikTok 应用凭证：设置环境变量 TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET，或写进本机 config.json 的 tiktok.client_key / tiktok.client_secret（不要放进仓库）";

export function requireClientCredentials() {
  const creds = clientCredentials();
  if (!creds.clientKey || !creds.clientSecret) throw new Error(MISSING_CLIENT_HINT);
  return creds;
}

// ------------------------------------------------------------------ 凭证文件

/** credential_ref 是相对凭证目录的路径；拒绝绝对路径与 `..`，不让账号行指到目录外。 */
export function credentialPath(ref) {
  if (typeof ref !== "string" || !ref.trim()) throw new Error("账号没有凭证：先 vk account connect <accountId> 授权");
  const clean = normalize(ref);
  if (isAbsolute(clean) || clean.split(sep).includes("..")) throw new Error(`凭证引用不合法：${ref}`);
  return join(paths().credentials, clean);
}

export const credentialRefFor = (accountId) => `tiktok-api/${String(accountId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`;

export function readTokens(ref) {
  const file = credentialPath(ref);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeTokens(ref, data) {
  const file = credentialPath(ref);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
