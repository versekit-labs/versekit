// The only place an error code is defined (docs/ARCHITECTURE.md §4.3).
//
// Adapters throw `AdapterError` with a code and a raw detail; they never write the sentence a
// person reads. Five adapters inventing five wordings for "login expired" is how a product starts
// feeling like five scripts — so the human text, the disposition and the retry policy live here,
// and the card / CLI / web all read from this table.

/**
 * code → what the core should do about it.
 *
 * `retryable` drives the queue: non-retryable failures go to their terminal state immediately
 * instead of burning three backoff rounds. `countsAttempt: false` is for quota — waiting is not
 * the publish's fault, so it must not consume the retry budget.
 */
export const ERROR_CODES = {
  auth: {
    retryable: false,
    accountState: "expired",
    publishState: "blocked",
    human: "登录过期了，扫一下码就能继续",
    action: "reauth",
  },
  platform_reject: {
    retryable: false,
    publishState: "notify_pending",
    human: "平台没有通过这条内容",
    action: "manual_fix",
  },
  quota: {
    retryable: true,
    countsAttempt: false,
    delayMs: 30 * 60e3,
    human: "今天发得太频了，等一会儿会自动重试",
    action: "wait",
  },
  flaky_ui: {
    retryable: true,
    escalateTo: "draft",
    human: "页面没按预期走，可能改版了",
    action: "retry_or_draft",
  },
  asset_invalid: {
    retryable: false,
    publishState: "failed",
    human: "这个文件平台不收（尺寸 / 时长 / 大小）",
    action: "replace_asset",
  },
  timeout: {
    // 超时不是「重试三次可能好」的瞬时故障：页面已经停在某一步 5 分钟，再自动重试只会
    // 让人多等三个退避周期。直接 failed，由人决定重试还是换素材（ACC-publish-05）。
    retryable: false,
    publishState: "failed",
    human: "发布卡住了，等超时后已中止",
    action: "retry_or_draft",
  },
  unknown: {
    retryable: true,
    human: "发布时出错了，现场已留存",
    action: "inspect",
  },
};

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES);

/** An adapter failure that carries a code the core understands. */
export class AdapterError extends Error {
  constructor(code, detail, { cause = null, evidence = null } = {}) {
    if (!(code in ERROR_CODES)) {
      throw new Error(`未登记的错误码：${code}（只能是 ${ERROR_CODE_LIST.join(" / ")}）`);
    }
    super(detail || ERROR_CODES[code].human);
    this.name = "AdapterError";
    this.code = code;
    this.detail = detail ?? null;
    this.evidence = evidence;
    if (cause) this.cause = cause;
  }
}

/**
 * Normalses anything thrown into `{code, detail, retryable}`. A plain Error becomes `unknown`
 * rather than being dropped: a failure without a code is still a failure, and the queue decision
 * has to be made either way.
 */
export function toAdapterError(err) {
  if (err instanceof AdapterError) return err;
  const code = err?.code in ERROR_CODES ? err.code : "unknown";
  const wrapped = new AdapterError(code, err?.message ?? String(err), { cause: err });
  if (err?.evidence) wrapped.evidence = err.evidence;
  return wrapped;
}

/** What a person should see, and what they can do about it. */
export const describeError = (code) => {
  const spec = ERROR_CODES[code];
  if (!spec) throw new Error(`未登记的错误码：${code}`);
  return { code, human: spec.human, action: spec.action, retryable: spec.retryable };
};

export const isRetryable = (code) => ERROR_CODES[code]?.retryable ?? true;
