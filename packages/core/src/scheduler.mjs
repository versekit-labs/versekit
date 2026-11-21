// Proactive account health (ARCHITECTURE §4.1).
//
// G3 says the system must find an expired login before the person does. That only holds if there
// is a clock doing it: without this sweep, "expired" is discovered at the next publish, which is
// exactly the failure the product promises to prevent.
//
// The sweep is deliberately dumb — who is due, queue a check — so it can be tested without a
// browser and cannot get stuck mid-way.

import { open, enqueue } from "./index.mjs";
import { readConfig } from "./config.mjs";

export const CHECK_INTERVAL_MS = 6 * 3600e3;

// ---------------------------------------------------------------- 只在需要时查登录的平台（视频号，#275）
//
// 视频号的登录撑不了多久，工厂里「每隔几小时打开首页续命」的保活被所有者验证过不管用。所以这些平台：
//   · 不进上面 6 小时一次的通用体检（dueAccounts 把它们排除）；
//   · 只在这几个时机查一次登录：发布机启动时、每天一次（时间可设，默认 08:00）、人确认平台稿时、
//     计划发布前 2 小时；
//   · 登录态已经是「过期」时不再自动打开页面，等人重新扫码。
// 每天一次用一次性的定时器对准下一个钟点，不是固定小时间隔的轮询。
export const LOGIN_TRACKED = new Set(["shipinhao"]);
export const DEFAULT_LOGIN_CHECK_TIME = "08:00";
export const PRE_PUBLISH_LEAD_MS = 2 * 3600e3;

/** "08:00" → { h, m }；不合法返回 null。 */
export function parseClock(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? "").trim());
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

export function normaliseClock(text) {
  const c = parseClock(text);
  return c ? `${String(c.h).padStart(2, "0")}:${String(c.m).padStart(2, "0")}` : null;
}

/** 每天检查的钟点：设置里的，没有或写坏了用默认 08:00。 */
export function loginCheckTime() {
  return normaliseClock(readConfig().login_check?.time) ?? DEFAULT_LOGIN_CHECK_TIME;
}

/** 严格晚于 now 的下一个 hh:mm（本机时区）。 */
export function nextDailyAt(now, clock = DEFAULT_LOGIN_CHECK_TIME) {
  const { h, m } = parseClock(clock) ?? parseClock(DEFAULT_LOGIN_CHECK_TIME);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const trackedList = () => [...LOGIN_TRACKED];
const marks = () => trackedList().map(() => "?").join(",");

// 触发时机的备注：排队的人说「这次是为什么查的」，check 跑完记进登录记录。进程内存，丢了只是少一个标签。
const triggers = new Map();
export const noteCheckTrigger = (accountId, trigger, extra = {}) => triggers.set(accountId, { trigger, ...extra });
export const takeCheckTrigger = (accountId) => {
  const t = triggers.get(accountId) ?? { trigger: "manual" };
  triggers.delete(accountId);
  return t;
};

/** 把要查登录的账号排进队列。过期的不排（已经知道要重新扫码了，再开页面只会多一次打扰）。 */
export function queueLoginChecks({ trigger, accountIds = null, extra = {} } = {}) {
  const rows = open()
    .prepare(`SELECT id, platform, state FROM account WHERE removed_at IS NULL AND is_manual = 0 AND platform IN (${marks()})`)
    .all(...trackedList())
    .filter((a) => a.state !== "expired" && (!accountIds || accountIds.includes(a.id)));
  for (const a of rows) {
    noteCheckTrigger(a.id, trigger, extra);
    enqueue({ kind: "check", targetType: "account", targetId: a.id, lane: a.id, priority: 250 });
  }
  return rows.map((a) => a.id);
}

const prechecked = new Set();

/** 已确认、排了时间、计划发布前 2 小时之内、还没为它查过登录的视频号平台稿。 */
function prePublishCandidates(now) {
  return open()
    .prepare(
      `SELECT p.id, p.scheduled_at, p.account_id FROM publish p JOIN account a ON a.id = p.account_id
        WHERE a.platform IN (${marks()}) AND a.removed_at IS NULL AND a.state != 'expired' AND p.state = 'queued' AND p.scheduled_at IS NOT NULL
          AND p.scheduled_at > ?
        ORDER BY p.scheduled_at`,
    )
    .all(...trackedList(), now)
    .filter((p) => !prechecked.has(p.id) && !open().prepare("SELECT 1 FROM event WHERE type = 'account.check_result' AND payload_json LIKE ?").get(`%"publishId":"${p.id}"%`));
}

/** 计划发布前 2 小时额外查一次：到点的发布，其账号排一次登录检查。 */
export function queuePrePublishChecks({ now = Date.now() } = {}) {
  const due = prePublishCandidates(now).filter((p) => p.scheduled_at - PRE_PUBLISH_LEAD_MS <= now);
  const queued = [];
  for (const p of due) {
    prechecked.add(p.id);
    const ids = queueLoginChecks({ trigger: "pre_publish", accountIds: [p.account_id], extra: { publishId: p.id } });
    if (ids.length) queued.push(p.id);
  }
  return queued;
}

/** 下一次要为「发布前 2 小时」醒来的时刻；没有就是 null。 */
export function nextPrePublishAt({ now = Date.now() } = {}) {
  const times = prePublishCandidates(now).map((p) => p.scheduled_at - PRE_PUBLISH_LEAD_MS).filter((t) => t > now);
  return times.length ? Math.min(...times) : null;
}

let rearm = () => {};
/** 平台稿被确认、检查时间被改之后调用：重新对准下一个该醒来的时刻。 */
export const rearmLoginChecker = () => rearm();

/**
 * 视频号登录检查的时钟：启动时查一次；之后只在「每天的钟点」和「某条发布前 2 小时」醒来，
 * 每次醒来只排队，真正开页面的是队列里的 check。离线模式什么都不做。
 */
export function startLoginChecker({ log = () => {}, offline = false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (offline) return () => {};
  let timer = null;
  let stopped = false;
  let dailyAt = null;
  const safely = (fn) => {
    try {
      return fn();
    } catch (err) {
      log(`[login-check] 排检查失败：${err.message}`);
      return null;
    }
  };
  const arm = () => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    const t = now();
    dailyAt = nextDailyAt(t, loginCheckTime());
    const pre = safely(() => nextPrePublishAt({ now: t }));
    const next = Math.min(dailyAt, pre ?? Infinity);
    timer = setTimer(fire, Math.max(1000, next - t));
    timer.unref?.();
  };
  const fire = () => {
    const t = now();
    if (dailyAt != null && t >= dailyAt - 1000) {
      const ids = safely(() => queueLoginChecks({ trigger: "daily" })) ?? [];
      if (ids.length) log(`[login-check] 每天一次，排了 ${ids.length} 个视频号登录检查`);
    }
    const pre = safely(() => queuePrePublishChecks({ now: t })) ?? [];
    if (pre.length) log(`[login-check] 发布前 2 小时，排了 ${pre.length} 条的登录检查`);
    arm();
  };
  rearm = () => {
    // 刚确认的平台稿可能已经在发布前 2 小时之内：马上补一次，而不是等下一个钟点。
    safely(() => queuePrePublishChecks({ now: now() }));
    arm();
  };
  const started = safely(() => queueLoginChecks({ trigger: "startup" })) ?? [];
  if (started.length) log(`[login-check] 发布机启动，排了 ${started.length} 个视频号登录检查`);
  safely(() => queuePrePublishChecks({ now: now() }));
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
    rearm = () => {};
  };
}

/** Accounts whose last probe is older than the interval. `manual` accounts are skipped on purpose. */
export function dueAccounts({ now = Date.now(), intervalMs = CHECK_INTERVAL_MS } = {}) {
  return open()
    .prepare(
      `SELECT id, platform, handle, last_checked_at FROM account
        WHERE is_manual = 0 AND removed_at IS NULL
          AND platform NOT IN (SELECT value FROM json_each(?))
          AND (last_checked_at IS NULL OR last_checked_at <= ?)
        ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC`,
    )
    .all(JSON.stringify([...LOGIN_TRACKED]), now - intervalMs);
}

/**
 * Queues one check per due account. Enqueue already dedupes by (kind, target) while a run is
 * queued or running, so calling this every ten minutes does not pile up work.
 */
export function sweepAccountChecks(options = {}) {
  const due = dueAccounts(options);
  for (const account of due) {
    enqueue({ kind: "check", targetType: "account", targetId: account.id, lane: account.id, priority: 300 });
  }
  return due.map((a) => a.id);
}

/** Starts the periodic sweep. Returns a stop function; the timer must not keep the process alive. */
export function startCheckSweeper({ everyMs = 10 * 60e3, intervalMs = CHECK_INTERVAL_MS, log = () => {}, offline = false } = {}) {
  // 离线模式不排任何体检（#180）。
  if (offline) return () => {};
  const run = () => {
    try {
      const queued = sweepAccountChecks({ intervalMs });
      if (queued.length) log(`[scheduler] 排了 ${queued.length} 个账号体检`);
    } catch (err) {
      log(`[scheduler] 体检排单失败：${err.message}`);
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
