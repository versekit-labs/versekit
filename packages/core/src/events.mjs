// The event catalog (docs/BLUEPRINT.md §2.9, docs/ARCHITECTURE.md §6).
//
// Every state change leaves an event. The catalog exists so a channel can answer "is this worth
// waking someone up for?" without knowing what the publisher did, and so `required: true` events
// can never be silently muted by a notification preference.
//
// Two kinds of entry:
//   · business facts  — publish.failed, account.expired … these are what cards are made of
//   · state_changed   — the generic trace of a transition that has no business event of its own
//
// The second kind is deliberately internal: it feeds the log and the audit trail, not the phone.

export const EVENTS = {
  "account.expiring": { severity: "warn", required: true, card: "account" },
  "account.expired": { severity: "critical", required: true, card: "account" },
  "account.banned": { severity: "critical", required: true, card: "account" },

  "publish.published": { severity: "info", required: false, card: null },
  "publish.failed": { severity: "warn", required: true, card: "publish" },
  "publish.degraded": { severity: "warn", required: false, card: "publish" },
  "publish.needs_human": { severity: "warn", required: true, card: "publish" },
  "publish.needs_followup": { severity: "warn", required: true, card: "publish" },
  "publish.state_changed": { severity: "info", required: false, internal: true },

  "approval.requested": { severity: "warn", required: true, card: "approval" },

  "collect.degraded": { severity: "warn", required: true, card: "collect" },
  "collect.recovered": { severity: "info", required: false, card: null },

  "digest.daily": { severity: "info", required: false, card: "digest" },
  "metric.milestone": { severity: "info", required: false, card: null },

  "system.alive": { severity: "info", required: false, internal: true },
  "system.dead": { severity: "critical", required: true, card: "system" },

  // Queue-level facts. Internal: they explain a publish that stopped moving, but the person gets
  // the publish-level card instead of a second notification about the same thing.
  "run.failed": { severity: "critical", required: false, internal: true },
  "run.interrupted": { severity: "warn", required: false, internal: true },
};

export const EVENT_TYPES = Object.keys(EVENTS);

export const isKnownEvent = (type) => type in EVENTS;

/** The six (plus system.dead) that can never be turned off. */
export const requiredEvents = () =>
  Object.entries(EVENTS)
    .filter(([, spec]) => spec.required)
    .map(([type]) => type);

/**
 * A publish transition has at most one business meaning. `queued`, `canceled` and the running
 * states are bookkeeping, so they fall through to the generic trace.
 */
const TRANSITION_EVENT = {
  published: "publish.published",
  published_limited: "publish.needs_followup",
  notify_pending: "publish.needs_human",
  draft_pending: "publish.degraded",
  failed: "publish.failed",
};

const TRANSITION_SEVERITY = {
  failed: "warn",
  blocked: "critical",
};

export function eventForTransition(to) {
  return {
    type: TRANSITION_EVENT[to] ?? "publish.state_changed",
    severity: TRANSITION_SEVERITY[to] ?? "info",
  };
}

/** Events that should reach a human; everything else is for the log or the dashboard. */
export const isCardEvent = (type) => Boolean(EVENTS[type]?.card);
