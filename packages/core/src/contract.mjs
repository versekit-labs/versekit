// The adapter contract, executable (docs/adapter-contract.md §2).
//
// This module is the single checker used by the loader, by `vk doctor`, and by the contract test
// that runs against every adapter package. Keeping one implementation matters: when the loader is
// lenient and the test is strict, a bad adapter ships and fails in front of a user instead of in CI.

export const CAPABILITY_VALUES = ["api", "web", "cli", "none"];
export const VISIBILITIES = ["public", "private", "friends"];

/** What an adapter may return instead of publishing. `failed` is never a result — it is an error. */
export const PUBLISH_RESULT_STATES = ["published", "published_limited", "draft_pending", "notify_pending"];

export const FOLLOWUP_KINDS = ["declare_ai_generated", "upload_captions", "add_to_collection", "set_visibility_public"];
export const VERIFIERS = ["collection", "captions", "visibility"];

export class AdapterContractError extends Error {
  constructor(where, message) {
    super(`${where}: ${message}`);
    this.name = "AdapterContractError";
    this.where = where;
  }
}

const fail = (where, message) => {
  throw new AdapterContractError(where, message);
};

const isFn = (v) => typeof v === "function";

/**
 * Fills in the capability defaults from the methods the adapter actually implements, so a small
 * adapter does not have to restate what is obvious — but an explicit value always wins, including
 * an explicit "none".
 */
export function normaliseCapabilities(adapter) {
  const caps = adapter?.capabilities ?? {};
  const publish = caps.publish ?? (isFn(adapter?.publish) ? "web" : "none");
  const collect = caps.collect ?? (isFn(adapter?.collect) ? "web" : "none");
  const visibility = Array.isArray(caps.visibility) ? caps.visibility.filter((v) => VISIBILITIES.includes(v)) : [];
  return {
    publish,
    collect,
    // [] means "the platform decides", null/undefined means "the adapter did not say". Both are
    // treated as empty here; the declared value stays visible for docs and for the account wall.
    visibility,
    draft: caps.draft ?? false,
    requiresQualification: caps.requiresQualification ?? false,
    minScheduleLeadMs: caps.minScheduleLeadMs ?? null,
    maxFileSizeMb: caps.maxFileSizeMb ?? null,
  };
}

/**
 * Shape check for one adapter. Returns the normalised view the core works with; throws with the
 * adapter's directory name so a broken package is traceable in `vk doctor` output.
 */
export function validateAdapter(adapter, where = "adapter") {
  if (!adapter || typeof adapter !== "object") fail(where, "没有 default export");
  if (!adapter.platform || typeof adapter.platform !== "string") fail(where, "缺少 platform");
  if (!isFn(adapter.ready)) fail(where, "缺少 ready()");

  for (const m of ["login", "check", "publish", "collect"]) {
    if (adapter[m] != null && !isFn(adapter[m])) fail(where, `${m} 不是函数`);
  }

  const caps = normaliseCapabilities(adapter);

  for (const key of ["publish", "collect"]) {
    if (!CAPABILITY_VALUES.includes(caps[key])) {
      fail(where, `capabilities.${key} 只能是 ${CAPABILITY_VALUES.join(" / ")}，收到 ${JSON.stringify(caps[key])}`);
    }
  }
  if (caps.publish === "none" && caps.collect === "none") {
    fail(where, "publish 与 collect 都是 none，这个适配器没有意义");
  }

  return { platform: adapter.platform, ...caps, adapter };
}

/**
 * The publish result the core is allowed to accept. Called at the adapter boundary, not deep in the
 * runner: a malformed result means the adapter is wrong, and saying so at the source is cheaper
 * than debugging a half-written publish row later.
 */
export function assertPublishResult(result, where = "publish") {
  if (!result || typeof result !== "object") fail(where, "适配器没有返回发布结果");
  if (!result.id) fail(where, "发布结果缺少 id（发布后回读得到的平台作品 id）");
  if (!result.url) fail(where, "发布结果缺少 url");
  if (!VISIBILITIES.includes(result.visibility)) {
    fail(where, `发布结果 visibility 只能是 ${VISIBILITIES.join(" / ")}，收到 ${JSON.stringify(result.visibility)}`);
  }
  if (!PUBLISH_RESULT_STATES.includes(result.state)) {
    fail(where, `发布结果 state 只能是 ${PUBLISH_RESULT_STATES.join(" / ")}，收到 ${JSON.stringify(result.state)}`);
  }
  if (result.followups != null && !Array.isArray(result.followups)) fail(where, "followups 必须是数组");
  for (const f of result.followups ?? []) {
    if (!FOLLOWUP_KINDS.includes(f?.kind)) fail(where, `未知的 followup kind：${JSON.stringify(f?.kind)}`);
    if (f.verify != null && !VERIFIERS.includes(f.verify)) fail(where, `未知的 followup verify：${JSON.stringify(f.verify)}`);
  }
  return result;
}

/** The five questions every adapter must be able to answer (adapter-contract.md §4). */
export const CONTRACT_QUESTIONS = [
  "登录态怎么来、怎么判断过期？",
  "发布前需要哪些素材？",
  "发布中哪一步最容易挂？",
  "发布成功如何核实？",
  "发布后有什么不完整？",
];
