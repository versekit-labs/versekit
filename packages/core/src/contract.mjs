// The adapter contract, executable (docs/adapter-contract.md §2).
//
// This module is the single checker used by the loader, by `vk doctor`, and by the contract test
// that runs against every adapter package. Keeping one implementation matters: when the loader is
// lenient and the test is strict, a bad adapter ships and fails in front of a user instead of in CI.

import { ASSET_KINDS } from "./asset-kind.mjs";

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
    // null/undefined = 适配器没声明，不限制；数组 = 这个平台只收这几种素材（如小红书目前只收视频）。
    // 「没声明」和「声明了空数组」必须区分：前者是旧适配器的兼容路径，后者是「什么都不收」的 bug。
    assetTypes: Array.isArray(caps.assetTypes) ? [...new Set(caps.assetTypes)] : null,
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
    // 声明了能力就必须有对应方法：否则契约测试全绿，第一次真发布才炸。
    if (caps[key] !== "none" && !isFn(adapter[key])) {
      fail(where, `capabilities.${key} = ${caps[key]}，但没有 ${key}()`);
    }
  }

  // 作者写了 "unlisted" 这种拼错的值，静默丢掉只会让人以为生效了。声明就要合法。
  const declared = adapter.capabilities?.visibility;
  if (declared != null) {
    if (!Array.isArray(declared)) fail(where, "capabilities.visibility 必须是数组（[] 表示发布时不能选）");
    const bad = declared.filter((v) => !VISIBILITIES.includes(v));
    if (bad.length) fail(where, `capabilities.visibility 含未知值：${bad.join(", ")}（只能是 ${VISIBILITIES.join(" / ")}）`);
  }

  // assetTypes 同理：没声明 = 不限制（旧适配器兼容），声明了就必须是合法且非空的数组。
  // 空数组不是「什么都能发」，而是「什么都不收」——那不该是一个可用的适配器。
  const assetTypes = adapter.capabilities?.assetTypes;
  if (assetTypes != null) {
    if (!Array.isArray(assetTypes)) fail(where, `capabilities.assetTypes 必须是数组（如 ["video"]；不限制就省略）`);
    if (!assetTypes.length) fail(where, "capabilities.assetTypes 不能是空数组：不限制就省略，别声明一个什么都不收的平台");
    const bad = assetTypes.filter((v) => !ASSET_KINDS.includes(v));
    if (bad.length) fail(where, `capabilities.assetTypes 含未知值：${bad.join(", ")}（只能是 ${ASSET_KINDS.join(" / ")}）`);
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
