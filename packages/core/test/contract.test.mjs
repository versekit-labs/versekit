// The contract is a promise made to five adapter authors, so it gets pinned like one.
// These tests are the same assertions CI runs per adapter package (docs/ARCHITECTURE.md §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAdapter,
  normaliseCapabilities,
  assertPublishResult,
  AdapterContractError,
} from "../src/contract.mjs";
import { ERROR_CODES, ERROR_CODE_LIST, AdapterError, toAdapterError, describeError, isRetryable } from "../src/errors.mjs";
import { EVENTS, eventForTransition, requiredEvents, isKnownEvent } from "../src/events.mjs";

const base = (extra = {}) => ({ platform: "x", ready: () => null, async publish() {}, async collect() {}, ...extra });

// ---------------------------------------------------------------- capabilities

test("capabilities default from the methods the adapter actually implements", () => {
  const caps = normaliseCapabilities(base());
  assert.equal(caps.publish, "web");
  assert.equal(caps.collect, "web");
  assert.equal(caps.draft, false);
  assert.deepEqual(caps.visibility, []);
});

test("an explicit capability wins over the derived default", () => {
  const a = base({ capabilities: { publish: "cli", collect: "none", draft: true, visibility: ["public", "private"] } });
  const v = validateAdapter(a, "adapter-bilibili");
  assert.equal(v.publish, "cli");
  assert.equal(v.collect, "none");
  assert.equal(v.draft, true);
  assert.deepEqual(v.visibility, ["public", "private"]);
});

test("unknown visibility values are dropped, not passed through", () => {
  const caps = normaliseCapabilities(base({ capabilities: { visibility: ["public", "unlisted"] } }));
  assert.deepEqual(caps.visibility, ["public"]);
});

test("an adapter that can neither publish nor collect is rejected", () => {
  const a = { platform: "x", ready: () => null, capabilities: { publish: "none", collect: "none" } };
  assert.throws(() => validateAdapter(a, "adapter-dead"), AdapterContractError);
});

test("an unregistered capability value is rejected with the adapter name", () => {
  const a = base({ capabilities: { publish: "magic" } });
  assert.throws(() => validateAdapter(a, "adapter-x"), /adapter-x.*capabilities\.publish/);
});

test("a non-function method is rejected instead of failing at call time", () => {
  const a = base({ publish: "not a function" });
  assert.throws(() => validateAdapter(a, "adapter-x"), /publish 不是函数/);
});

// ---------------------------------------------------------------- publish result

test("a well-formed publish result is accepted, followups included", () => {
  const result = {
    id: "bv1",
    url: "https://example.test/v/1",
    visibility: "public",
    state: "published_limited",
    followups: [{ kind: "add_to_collection", hint: "加入合集", verify: "collection" }],
  };
  assert.equal(assertPublishResult(result), result);
});

test("a publish result without an id is rejected — the id must come from reading the platform back", () => {
  assert.throws(() => assertPublishResult({ url: "u", visibility: "public", state: "published" }), /缺少 id/);
});

test("failed is not a publish result; it is an error", () => {
  assert.throws(() => assertPublishResult({ id: "1", url: "u", visibility: "public", state: "failed" }), /state/);
});

test("an unknown followup kind is rejected", () => {
  const bad = { id: "1", url: "u", visibility: "public", state: "published", followups: [{ kind: "do_magic" }] };
  assert.throws(() => assertPublishResult(bad), /followup kind/);
});

// ---------------------------------------------------------------- error codes

test("every error code explains itself and says what to do", () => {
  for (const code of ERROR_CODE_LIST) {
    const d = describeError(code);
    assert.ok(d.human.length > 4, `${code} 缺少人话`);
    assert.ok(d.action.length > 0, `${code} 缺少下一步`);
  }
});

test("auth failure is not retried; quota does not consume the retry budget", () => {
  assert.equal(isRetryable("auth"), false);
  assert.equal(ERROR_CODES.quota.retryable, true);
  assert.equal(ERROR_CODES.quota.countsAttempt, false);
  assert.equal(ERROR_CODES.platform_reject.retryable, false);
});

test("AdapterError refuses a code nobody registered", () => {
  assert.throws(() => new AdapterError("timeout", "x"), /未登记的错误码/);
});

test("a plain Error becomes unknown, keeping its message", () => {
  const wrapped = toAdapterError(new Error("socket hang up"));
  assert.equal(wrapped.code, "unknown");
  assert.match(wrapped.message, /socket hang up/);
});

// ---------------------------------------------------------------- event catalog

test("the six required events are all in the catalog", () => {
  const required = requiredEvents();
  for (const type of ["account.expiring", "account.expired", "publish.failed", "publish.needs_human", "publish.needs_followup", "collect.degraded", "system.dead"]) {
    assert.ok(required.includes(type), `${type} 必须必推`);
  }
});

test("every event declares a valid severity", () => {
  for (const [type, spec] of Object.entries(EVENTS)) {
    assert.ok(["info", "warn", "critical"].includes(spec.severity), `${type} 的 severity 不合法`);
  }
});

test("publish transitions map to business events, not to invented type names", () => {
  assert.equal(eventForTransition("published").type, "publish.published");
  // limited 的卡片由 followup 逐条发，迁移本身只留 trace，避免同一条发布推两次
  assert.equal(eventForTransition("published_limited").type, "publish.state_changed");
  assert.equal(eventForTransition("notify_pending").type, "publish.needs_human");
  assert.equal(eventForTransition("draft_pending").type, "publish.degraded");
  assert.equal(eventForTransition("failed").type, "publish.failed");
  assert.equal(eventForTransition("failed").severity, "warn");
});

test("running states leave a trace, not a card", () => {
  assert.equal(eventForTransition("auto_running").type, "publish.state_changed");
  assert.equal(EVENTS["publish.state_changed"].card, undefined);
});

test("an unregistered event type is not silently accepted", () => {
  assert.equal(isKnownEvent("publish.exploded"), false);
  assert.equal(isKnownEvent("publish.failed"), true);
});
