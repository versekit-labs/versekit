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

  // 登录要撑多久的原始记录（视频号，#275）：每次登录成功、每次检查的结果都记一条，页面和 `vk account show`
  // 从这些记录算「这次登录已多久、平均撑多久」。内部事件，不推手机；过期那一下由 account.expired 负责提醒。
  "account.login_ok": { severity: "info", required: false, internal: true },
  "account.login_failed": { severity: "warn", required: false, internal: true },
  "account.check_result": { severity: "info", required: false, internal: true },

  "publish.published": { severity: "info", required: false, card: null },
  "publish.failed": { severity: "warn", required: true, card: "publish" },
  "publish.degraded": { severity: "warn", required: false, card: "publish" },
  "publish.needs_human": { severity: "warn", required: true, card: "publish" },
  "publish.needs_followup": { severity: "warn", required: true, card: "publish" },
  "publish.state_changed": { severity: "info", required: false, internal: true },

  // 改期不是状态迁移（状态不变，只动时间），但必须留痕：谁把哪个作品从几点挪到了几点。
  "schedule.moved": { severity: "info", required: false, internal: true },

  // 确认前改标题 / 时间（#146）：状态不变，只动这条平台稿的 overrides 与建议时间，同样要留痕。
  "publish.edited": { severity: "info", required: false, internal: true },
  // 红线第二道防线（#146）：队列领到一条不在可发状态的平台稿（例如待确认），没有调用适配器。
  "publish.not_runnable": { severity: "warn", required: false, internal: true },

  // 改组名只影响显示名，不影响任何发布；留痕是为了以后能解释「这组以前叫什么」。
  "group.renamed": { severity: "info", required: false, internal: true },
  // 改账号名只改 VerseKit 里的显示名（#374），不动登录、凭据、平台稿。
  "account.renamed": { severity: "info", required: false, internal: true },

  // 保存平台应用凭证（#208）：只记平台与来源，绝不进 key / secret。
  "account.credentials_saved": { severity: "info", required: false, internal: true },

  // 一个作品出现第一条待确认平台稿时发一次（#150，dedupe_key=work:<id>:awaiting_confirm）。
  // 卡片里的成片数、平台稿数在投递那一刻按当前状态算，不读 payload：为了等一批平台稿建完，通道会晚一点再发。
  "work.awaiting_confirm": { severity: "info", required: false, card: "work" },
  "delivery.failed": { severity: "warn", required: false, internal: true },

  "approval.requested": { severity: "warn", required: true, card: "approval" },

  "collect.degraded": { severity: "warn", required: true, card: "collect" },
  "collect.recovered": { severity: "info", required: false, card: null },

  "digest.daily": { severity: "info", required: false, card: "digest" },
  "metric.milestone": { severity: "info", required: false, card: null },

  // 后台自动更新没成功、已经退回旧版本（#217）：留在系统页「最近出的问题」，不发手机通知（更新是后台的事）。
  "update.failed": { severity: "warn", required: false, internal: true },

  "component.failed": { severity: "warn", required: false, internal: true },
  component_missing: { severity: "warn", required: false, internal: true },

  // 发布机出口位置（#310）：探测、位置变了暂停、恢复、接受新位置、IP 库下载失败。都是内部留痕，页面和 `vk egress` 读它们。
  "egress.moved": { severity: "warn", required: false, internal: true },
  "egress.restored": { severity: "info", required: false, internal: true },
  "egress.accepted": { severity: "info", required: false, internal: true },
  "egress.login_baseline": { severity: "info", required: false, internal: true },
  "egress.probe_failed": { severity: "warn", required: false, internal: true },
  "egress.geodb_failed": { severity: "warn", required: false, internal: true },

  // 飞书通知（#311）：卡片发不出去、接上、断开、改了发哪几类。内部留痕：系统页「通知」读它们，不再为它们发一张卡片。
  "channel.card_failed": { severity: "warn", required: false, internal: true },
  "channel.connected": { severity: "info", required: false, internal: true },
  "channel.disconnected": { severity: "info", required: false, internal: true },
  "channel.settings_changed": { severity: "info", required: false, internal: true },

  "system.alive": { severity: "info", required: false, internal: true },
  "system.dead": { severity: "critical", required: true, card: "system" },

  // Queue-level facts. Internal: they explain a publish that stopped moving, but the person gets
  // the publish-level card instead of a second notification about the same thing.
  "run.failed": { severity: "critical", required: false, internal: true },
  "run.interrupted": { severity: "warn", required: false, internal: true },
};

export const EVENT_TYPES = Object.keys(EVENTS);
export const relayArrivalMessage = (title, count) => `新到 1 期：${title}，${count} 条等你确认`;

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
