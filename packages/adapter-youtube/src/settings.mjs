// 配置与本地凭证。client id / client secret 是**用户自己**的 Google OAuth 客户端（Cloud Console 里建），
// 只从环境变量或本机配置读，不进仓库、不进库；token 只落发布机本地凭证目录（经 core 的 paths()），
// 账号表只存 credential_ref（BLUEPRINT D6）。哪个 Google 号授权由用户在网页上点，适配器不写死。
//
// 配置来源（环境变量优先）：
//   YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET   或  config.json 的 youtube.client_id / youtube.client_secret
//   YOUTUBE_API_BASE（默认 https://www.googleapis.com）、GOOGLE_AUTH_BASE（默认 https://accounts.google.com）、
//   GOOGLE_TOKEN_BASE（默认 https://oauth2.googleapis.com）、YOUTUBE_ANALYTICS_BASE
//     —— 开发机测试时指向本地 mock，不连真实服务。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { paths } from "../../core/src/index.mjs";
import { readConfig, updateConfig } from "../../core/src/config.mjs";

export const PLATFORM = "youtube";
export const SCOPE_UPLOAD = "https://www.googleapis.com/auth/youtube.upload";
export const SCOPE_MANAGE = "https://www.googleapis.com/auth/youtube.force-ssl"; // 读回、缩略图、字幕、播放列表
export const SCOPE_ANALYTICS = "https://www.googleapis.com/auth/yt-analytics.readonly"; // 观看时长；可选
export const SCOPES = [SCOPE_UPLOAD, SCOPE_MANAGE, SCOPE_ANALYTICS];

const trimSlash = (s) => String(s).replace(/\/+$/, "");
const cfg = () => readConfig().youtube ?? {};

export const apiBase = () => trimSlash(process.env.YOUTUBE_API_BASE || cfg().api_base || "https://www.googleapis.com");
export const authBase = () => trimSlash(process.env.GOOGLE_AUTH_BASE || cfg().auth_base || "https://accounts.google.com");
export const tokenBase = () => trimSlash(process.env.GOOGLE_TOKEN_BASE || cfg().token_base || "https://oauth2.googleapis.com");
export const analyticsBase = () => trimSlash(process.env.YOUTUBE_ANALYTICS_BASE || cfg().analytics_base || "https://youtubeanalytics.googleapis.com");

/** 平台稿没指定类目时用的默认值（YouTube Studio 上传默认的 People & Blogs）；要改写进 config.json 的 youtube.default_category_id。 */
export const defaultCategoryId = () => String(cfg().default_category_id || "22");

export function clientCredentials() {
  const c = cfg();
  return {
    clientId: process.env.YOUTUBE_CLIENT_ID || c.client_id || null,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || c.client_secret || null,
  };
}

/**
 * 应用凭证的来源与是否齐全。只返回「有没有、从哪来、client id 是什么」，**永远不返回 secret**：
 * 这个结果会原样进 HTTP 响应，页面据此决定显示「填应用凭证」还是「Connect」。
 * 字段名沿用 clientKey（系统页与 TikTok 共用同一套展示）。
 */
export function credentialStatus() {
  const c = cfg();
  const pick = (envName, field) => (process.env[envName] ? "env" : c[field] ? "config" : null);
  const idSource = pick("YOUTUBE_CLIENT_ID", "client_id");
  const secretSource = pick("YOUTUBE_CLIENT_SECRET", "client_secret");
  const { clientId } = clientCredentials();
  return { configured: Boolean(idSource && secretSource), clientKey: clientId ?? null, hasSecret: Boolean(secretSource), source: secretSource ?? idSource };
}

/** 写进本机 config.json（文件 0600，writeConfig 保证）。环境变量仍然优先。返回 credentialStatus()，不含 secret。 */
export function saveClientCredentials({ clientKey, clientSecret } = {}) {
  const id = String(clientKey ?? "").trim();
  const secret = String(clientSecret ?? "").trim();
  if (!id || !secret) throw new Error("client id 和 client secret 都要填");
  if (/\s/.test(id) || /\s/.test(secret)) throw new Error("client id / client secret 里不能有空格或换行：检查是不是复制多了");
  updateConfig({ youtube: { client_id: id, client_secret: secret } });
  return credentialStatus();
}

export const MISSING_CLIENT_HINT = "没有 YouTube 应用凭证：到系统页的账号里点「填应用凭证」，填 Google OAuth 客户端的 client id 和 client secret";

export function requireClientCredentials() {
  const creds = clientCredentials();
  if (!creds.clientId || !creds.clientSecret) throw new Error(MISSING_CLIENT_HINT);
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

export const credentialRefFor = (accountId) => `youtube/${String(accountId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`;

export function readJsonFile(ref) {
  const file = credentialPath(ref);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonFile(ref, data) {
  const file = credentialPath(ref);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export const readTokens = readJsonFile;
export const writeTokens = writeJsonFile;
