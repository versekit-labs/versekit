// TikTok 开放接口客户端：只做 HTTP、错误归类与 429 退避，不碰数据库、不管状态机。
//
// 错误归类（docs/research/platform-rules.md 第三节第 4 条）：
//   · 429                                  → 指数退避后重试；退避用尽 → quota
//   · spam_risk_too_many_posts / spam_risk_user_banned_from_posting / reached_active_user_cap
//                                          → PauseError：立即暂停账号 + 推事件，**不重试**
//   · access_token_invalid / 授权被撤销 / scope 缺失 → auth（转「需要重新登录」）
//   · 文件、时长、帧率不合格               → asset_invalid
//   · 其余 4xx                             → platform_reject；5xx / 网络错误 → unknown（可重试）

import { readEnv } from "../../core/src/env.mjs";
import { AdapterError } from "../../core/src/errors.mjs";
import { proxiedFetch } from "./proxy.mjs";
import { apiBase } from "./settings.mjs";

/** 触发「暂停账号、不重试」的 TikTok 错误码。人话在这里写一次，事件与 CLI 都读它。 */
export const PAUSE_CODES = {
  spam_risk_too_many_posts: {
    human: "TikTok 判定这个账号今天发得太多（spam_risk_too_many_posts）：已暂停这个账号的自动发布，不会重试；明天再说，或在 TikTok App 里手动发",
    banned: false,
  },
  spam_risk_user_banned_from_posting: {
    human: "TikTok 已禁止这个账号发布（spam_risk_user_banned_from_posting）：已暂停并标记为被封禁，不会重试；请到 TikTok App 里查看账号状态",
    banned: true,
  },
  reached_active_user_cap: {
    human: "这个 TikTok 应用今天的活跃发布用户数已到上限（reached_active_user_cap）：已暂停这个账号的自动发布，不会重试；明天再试",
    banned: false,
  },
};

const AUTH_CODES = new Set([
  "access_token_invalid",
  "access_token_expired",
  "scope_not_authorized",
  "scope_permission_missed",
  "invalid_grant",
  "auth_removed",
]);
const ASSET_FAIL_REASONS = new Set(["file_format_check_failed", "duration_check_failed", "frame_rate_check_failed", "picture_size_check_failed"]);

/** 暂停类错误：仍是 platform_reject（终态、不重试），额外带上 pause 说明，由 core 的 handler 暂停账号。 */
export class PauseError extends AdapterError {
  constructor(tiktokCode, { logId = null } = {}) {
    const spec = PAUSE_CODES[tiktokCode];
    super("platform_reject", spec.human);
    this.pause = { code: tiktokCode, banned: spec.banned, logId };
  }
}

/** 把 TikTok 的错误码（含 status/fetch 的 fail_reason）变成 AdapterError。 */
export function classifyError(code, message = "", { status = 0, logId = null } = {}) {
  const text = message ? `${code}：${message}` : String(code);
  if (code in PAUSE_CODES) return new PauseError(code, { logId });
  if (AUTH_CODES.has(code)) return new AdapterError("auth", `TikTok 授权失效（${text}）：到系统页重新授权`);
  if (ASSET_FAIL_REASONS.has(code)) return new AdapterError("asset_invalid", `TikTok 不收这个视频（${text}）：换文件再发`);
  if (code === "rate_limit_exceeded") return new AdapterError("quota", `TikTok 限流（${text}）`);
  if (status >= 500 || code === "internal_error" || code === "internal") return new AdapterError("unknown", `TikTok 服务端出错（${text}）`);
  if (code === "unaudited_client_can_only_post_to_private_accounts") {
    return new AdapterError("platform_reject", `应用还没通过 TikTok 审核，所以 TikTok 要求发布账号本身是私密账号：先在 TikTok App 里设置和隐私 → 隐私 → 私密账号，打开后再重试；应用通过审核后就没有这个限制（${text}）`);
  }
  return new AdapterError("platform_reject", `TikTok 拒绝了这次请求（${text}）`);
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

/** 退避基数：生产 1s、2s、4s、8s；测试用 HIFABU_TIKTOK_BACKOFF_MS 压到几毫秒。 */
const backoffBaseMs = () => {
  const n = Number(readEnv("HIFABU_TIKTOK_BACKOFF_MS"));
  return Number.isFinite(n) && n >= 0 ? n : 1000;
};
export const MAX_429_RETRIES = 4;

/**
 * fetch + 429 指数退避。别的状态码原样交给调用方，由它按 body 里的 error.code 归类。
 * 网络层异常（断网、DNS、代理不通）按 network_unreachable 抛出，可重试；走不走代理见 proxy.mjs。
 */
export async function fetchWithBackoff(url, init = {}, { signal, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await proxiedFetch(url, { ...init, signal });
    } catch (err) {
      if (signal?.aborted) throw new AdapterError("timeout", "发布已被中止");
      throw err; // proxiedFetch 已归类为 network_unreachable，并写明该查哪些代理变量
    }
    if (res.status !== 429) return res;
    await res.arrayBuffer().catch(() => {});
    if (attempt >= MAX_429_RETRIES) {
      throw new AdapterError("quota", `TikTok 持续限流（429，已退避重试 ${MAX_429_RETRIES} 次）：稍后会自动重试`);
    }
    await sleep(backoffBaseMs() * 2 ** attempt, signal);
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _raw: text.slice(0, 200) };
  }
}

/** 调 v2 业务接口：成功返回 data，失败抛归类后的 AdapterError。 */
export async function callApi(path, { method = "POST", token, json, query, signal, sleep } = {}) {
  const url = new URL(apiBase() + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetchWithBackoff(
    url,
    {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(json ? { "Content-Type": "application/json; charset=UTF-8" } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    },
    { signal, sleep },
  );
  const body = await readJson(res);
  const err = body?.error;
  if (res.ok && (!err || err.code === "ok")) return body.data ?? {};
  if (err?.code && err.code !== "ok") throw classifyError(err.code, err.message, { status: res.status, logId: err.log_id });
  throw classifyError(res.status >= 500 ? "internal_error" : "http_error", `HTTP ${res.status}`, { status: res.status });
}

/** OAuth token 端点（表单提交；错误形状是 { error, error_description }）。 */
export async function callToken(form, { signal, sleep } = {}) {
  const res = await fetchWithBackoff(
    apiBase() + "/v2/oauth/token/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
      body: new URLSearchParams(form).toString(),
    },
    { signal, sleep },
  );
  const body = await readJson(res);
  if (res.ok && body.access_token) return body;
  const code = body.error || (res.status >= 500 ? "internal_error" : "http_error");
  throw classifyError(code, body.error_description ?? "", { status: res.status });
}
