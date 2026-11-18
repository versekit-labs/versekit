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
import { readConfig, updateConfig } from "../../core/src/config.mjs";

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

/**
 * 应用凭证的来源与是否齐全。只返回「有没有、从哪来、client key 是什么」，**永远不返回 secret**：
 * 这个结果会原样进 HTTP 响应，页面据此决定显示「填凭证」还是「Connect」。
 */
export function credentialStatus() {
  const cfg = readConfig().tiktok ?? {};
  const pick = (envName, field) => (process.env[envName] ? "env" : cfg[field] ? "config" : null);
  const keySource = pick("TIKTOK_CLIENT_KEY", "client_key");
  const secretSource = pick("TIKTOK_CLIENT_SECRET", "client_secret");
  const { clientKey } = clientCredentials();
  return { configured: Boolean(keySource && secretSource), clientKey: clientKey ?? null, hasSecret: Boolean(secretSource), source: secretSource ?? keySource };
}

/**
 * 把应用凭证写进本机 config.json 的 tiktok.client_key / tiktok.client_secret（文件 0600，
 * writeConfig 保证）。环境变量仍然优先，所以这里写了也可能被环境变量盖住——状态里的 source 会说清楚。
 * 返回值是 credentialStatus()，不含 secret。
 */
export function saveClientCredentials({ clientKey, clientSecret } = {}) {
  const key = String(clientKey ?? "").trim();
  const secret = String(clientSecret ?? "").trim();
  if (!key || !secret) throw new Error("client key 和 client secret 都要填");
  if (/\s/.test(key) || /\s/.test(secret)) throw new Error("client key / client secret 里不能有空格或换行：检查是不是复制多了");
  updateConfig({ tiktok: { client_key: key, client_secret: secret } });
  return credentialStatus();
}

export const MISSING_CLIENT_HINT =
  "没有 TikTok 应用凭证：到系统页的账号里填 TikTok 应用凭证";

export function requireClientCredentials() {
  const creds = clientCredentials();
  if (!creds.clientKey || !creds.clientSecret) throw new Error(MISSING_CLIENT_HINT);
  return creds;
}

// ------------------------------------------------------------------ 凭证文件

/** credential_ref 是相对凭证目录的路径；拒绝绝对路径与 `..`，不让账号行指到目录外。 */
export function credentialPath(ref) {
  if (typeof ref !== "string" || !ref.trim()) throw new Error("账号没有凭证：先到系统页授权这个账号");
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
