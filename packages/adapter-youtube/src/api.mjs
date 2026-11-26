// ported from trustbridge@1f9c92f videos/factory/publishers/youtube.mjs（fetchRetry 退避、call 的错误体处理）
//
// YouTube Data API v3 / Google OAuth 客户端：只做 HTTP、错误归类与退避，不碰数据库、不管状态机。
//
// 错误归类（人话在这里写一次，事件与 CLI 都读它）：
//   · 429 / 5xx / 网络错误 / 403 rateLimitExceeded → 指数退避重试（1s、2s、4s、8s）；用尽 → quota / unknown（队列会晚点再试）
//   · 403 quotaExceeded（每日配额用完）           → QuotaExceededError：**立即停下、不重试**，项目暂停到太平洋时间次日零点
//   · uploadLimitExceeded                          → platform_reject（频道今天传得太多），不重试
//   · 401 / 令牌被撤销 / 缺权限                    → auth（转「需要重新登录」）
//   · 其余 4xx                                     → platform_reject，带 Google 返回的原因

import { readEnv } from "../../core/src/env.mjs";
import { AdapterError } from "../../core/src/errors.mjs";
import { proxiedFetch } from "./proxy.mjs";
import { apiBase, tokenBase } from "./settings.mjs";

const REASON_HUMAN = {
  uploadLimitExceeded: "这个 YouTube 频道今天上传的视频数到上限了（uploadLimitExceeded）：这条没有发出去，也不会自动重试；过一天再发，或在 YouTube Studio 里手动传",
  youtubeSignupRequired: "这个 Google 账号还没有 YouTube 频道（youtubeSignupRequired）：先在 YouTube 里创建频道，再回系统页重新授权",
  forbidden: "YouTube 拒绝了这次操作（forbidden）：这个授权没有权限做这件事，到系统页重新授权并勾选全部权限",
  insufficientPermissions: "授权的权限不够（insufficientPermissions）：到系统页重新授权，并勾选全部权限",
  invalidTitle: "标题不合规（invalidTitle）：改标题后再发",
  invalidDescription: "简介不合规（invalidDescription）：简介里不能有尖括号等字符，改后再发",
  invalidTags: "标签不合规（invalidTags）：改标签后再发",
  invalidCategoryId: "类目 id 不合规（invalidCategoryId）：改平台稿里的类目后再发",
  invalidPublishAt: "预约发布时间不合规（invalidPublishAt）：改时间后再发",
};
const AUTH_REASONS = new Set(["authError", "invalidCredentials", "unauthorized", "insufficientPermissions", "authorizationRequired", "invalid_grant", "invalid_token"]);
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** 每日配额用完：仍是 platform_reject（终态、不重试），额外带 pause，由 adapter/core 暂停到配额重置。 */
export class QuotaExceededError extends AdapterError {
  constructor(message, pause) {
    super("platform_reject", message);
    this.platformCode = "quotaExceeded";
    this.pause = pause;
  }
}

/** 取 Google 错误体里的原因与说明。 */
export function errorInfo(body) {
  const e = body?.error;
  if (typeof e === "string") return { reason: e, message: body.error_description ?? "" }; // OAuth 端点：{ error, error_description }
  return { reason: e?.errors?.[0]?.reason ?? e?.status ?? null, message: e?.message ?? body?._raw ?? "" };
}

/** HTTP 状态 + 错误体 → AdapterError（QuotaExceededError 的 pause 由调用方补上，这里不知道账号与项目）。 */
export function classifyError(status, body) {
  const { reason, message } = errorInfo(body);
  const detail = [reason, message].filter(Boolean).join("：").slice(0, 300);
  if (QUOTA_REASONS.has(reason)) return new QuotaExceededError(`YouTube 今天的接口配额用完了（${reason}）：已停下，不会重试；配额在太平洋时间每天零点重置，到点后再发`, null);
  if (REASON_HUMAN[reason]) {
    const err = new AdapterError(reason === "insufficientPermissions" ? "auth" : "platform_reject", REASON_HUMAN[reason]);
    err.platformCode = reason;
    return err;
  }
  if (reason === "invalid_client") return new AdapterError("platform_reject", `Google 不认这个应用凭证（invalid_client）：到系统页重新填 client id 和 client secret`);
  if (status === 401 || AUTH_REASONS.has(reason)) return new AdapterError("auth", `YouTube 授权失效（${detail || status}）：到系统页重新授权`);
  if (status === 429 || RATE_REASONS.has(reason)) return new AdapterError("quota", `YouTube 限流（${detail || status}）`);
  if (status >= 500) return new AdapterError("unknown", `YouTube 服务端出错（HTTP ${status}${detail ? `，${detail}` : ""}）`);
  const err = new AdapterError("platform_reject", `YouTube 拒绝了这次请求（HTTP ${status}${detail ? `，${detail}` : ""}）`);
  err.platformCode = reason ?? `http_${status}`;
  return err;
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AdapterError("timeout", "发布已被中止"));
      },
      { once: true },
    );
  });

/** 退避基数：生产 1s、2s、4s、8s；测试用 HIFABU_YOUTUBE_BACKOFF_MS 压到几毫秒。 */
export const backoffBaseMs = () => {
  const n = Number(readEnv("HIFABU_YOUTUBE_BACKOFF_MS"));
  return Number.isFinite(n) && n >= 0 ? n : 1000;
};
export const MAX_RETRIES = 4;

export async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _raw: text.slice(0, 200) };
  }
}

const retryable = (status, body) => status === 429 || status >= 500 || RATE_REASONS.has(errorInfo(body).reason);

/**
 * fetch + 指数退避：429、5xx、rateLimitExceeded 和网络层错误重试 MAX_RETRIES 次；
 * quotaExceeded、4xx 不重试，原样交给调用方。返回 { res, body }（body 已读成 JSON）。
 */
export async function requestJson(url, init = {}, { signal, sleep = defaultSleep, label = "YouTube" } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    let body;
    try {
      res = await proxiedFetch(url, { ...init, signal });
      body = await readJson(res);
    } catch (err) {
      if (signal?.aborted) throw new AdapterError("timeout", "发布已被中止");
      if (attempt >= MAX_RETRIES) throw err; // proxiedFetch 已归类为 network_unreachable，并写明该查哪些代理变量
      await sleep(backoffBaseMs() * 2 ** attempt, signal);
      continue;
    }
    if (!retryable(res.status, body) || res.ok) return { res, body };
    if (attempt >= MAX_RETRIES) {
      const err = classifyError(res.status, body);
      if (err.code === "quota") throw new AdapterError("quota", `${label} 持续限流（已退避重试 ${MAX_RETRIES} 次）：稍后会自动重试`);
      throw err;
    }
    await sleep(backoffBaseMs() * 2 ** attempt, signal);
  }
}

/** 调 Data API（/youtube/v3 下的路径）：成功返回 JSON，失败抛归类后的 AdapterError。 */
export async function callApi(path, { method = "GET", token, json, query, signal, sleep, base = apiBase() + "/youtube/v3" } = {}) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const { res, body } = await requestJson(
    url,
    {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { "Content-Type": "application/json; charset=UTF-8" } : {}) },
      ...(json ? { body: JSON.stringify(json) } : {}),
    },
    { signal, sleep },
  );
  if (res.ok) return body;
  throw classifyError(res.status, body);
}

/** Google OAuth token 端点（表单提交；错误形状是 { error, error_description }）。 */
export async function callToken(form, { signal, sleep } = {}) {
  const { res, body } = await requestJson(
    tokenBase() + "/token",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() },
    { signal, sleep, label: "Google 授权服务" },
  );
  if (res.ok && body.access_token) return body;
  throw classifyError(res.status, body);
}
