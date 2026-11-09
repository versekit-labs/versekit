// 排期投影：按作品聚合的发布计划 + 撞车检测（docs/design/HANDOFF.md §2–§4，issue #12）。
//
// 没有排期表。一次排期 = 一个 work + N 条 publish（同 scheduled_at），日历只是这些行的投影。
// 原型 docs/design/store.js 里的 aggregate() / conflicts() / counts() 下沉到这里，
// Web 和 CLI 都只读这里的结果——同一个数字只算一遍，才不会「页面 ≠ CLI --json ≠ /api」。

import { open, transitionPublish, emit } from "./index.mjs";

/** 同一账号前后两条排期相隔不超过这个分钟数就算撞车：一个号不可能同时发两条。 */
export const CONFLICT_WINDOW_MIN = 30;
const WINDOW_MS = CONFLICT_WINDOW_MIN * 60e3;

/** 取消排期写进 publish.error_code 的固定码：人主动取消，不是失败，不该叫醒任何人。 */
export const E_USER_CANCELLED = "E_USER_CANCELLED";

/**
 * publish.state → 卡片上的平台状态词。卡片状态取各平台「最差」的那个：
 * failed > needs_human > limited > running > scheduled > published。
 */
const CARD_STATE = {
  failed: "failed",
  blocked: "failed",
  expired: "failed",
  notify_pending: "needs_human",
  draft_pending: "needs_human",
  published_limited: "limited",
  auto_running: "running",
  draft_running: "running",
  queued: "scheduled",
  published: "published",
};
const RANK = { failed: 0, needs_human: 1, limited: 2, running: 3, scheduled: 4, published: 5 };

const RUNNING = new Set(["auto_running", "draft_running"]);

const coded = (code, message) => Object.assign(new Error(message), { code });

export const cardStateOf = (publishState) => CARD_STATE[publishState] ?? "scheduled";

/** 作品状态 = 各平台最差。空列表视为 scheduled（不会出现：没有平台就没有卡）。 */
export function aggregateState(platforms) {
  let worst = "scheduled";
  let best = Infinity;
  for (const p of platforms) {
    const rank = RANK[p.state] ?? 9;
    if (rank < best) {
      best = rank;
      worst = p.state;
    }
  }
  return worst;
}

// ------------------------------------------------------------------ 账号组过滤

/**
 * 账号组由 #11 引入（account.group_id + account_group 表）。这里只读、不建表：
 * 列不存在时传 --group 是明确报错，而不是悄悄忽略过滤条件、把别的组的排期也列出来。
 */
function groupFilter(conn, group) {
  if (group == null || group === "") return { sql: "", params: [] };
  const cols = conn.prepare("PRAGMA table_info(account)").all().map((c) => c.name);
  if (!cols.includes("group_id")) {
    throw coded("E_GROUP_UNSUPPORTED", "还没有账号组（account.group_id 不存在）：先完成账号组迁移，或去掉 --group");
  }
  const hasGroupTable = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_group'").get();
  if (hasGroupTable) {
    const row = conn.prepare("SELECT id FROM account_group WHERE id = ? OR name = ?").get(group, group);
    if (!row) throw coded("E_GROUP_NOT_FOUND", `没有这个账号组：${group}`);
    return { sql: " AND a.group_id = ?", params: [row.id] };
  }
  return { sql: " AND a.group_id = ?", params: [group] };
}

// ------------------------------------------------------------------ 读：投影 + 撞车

/** 时间窗内所有未取消、带定时的发布行（平台粒度）。 */
function scheduledRows(conn, { from, to, group }) {
  const g = groupFilter(conn, group);
  return conn
    .prepare(
      `SELECT p.id AS publish_id, p.work_id, w.title, p.scheduled_at AS at, p.state,
              p.account_id, a.platform, a.handle, p.error_code
         FROM publish p
         JOIN work w ON w.id = p.work_id
         JOIN account a ON a.id = p.account_id
        WHERE p.scheduled_at IS NOT NULL
          AND p.state != 'canceled'
          AND p.scheduled_at BETWEEN ? AND ?${g.sql}
        ORDER BY p.scheduled_at, p.work_id, a.platform`,
    )
    .all(from, to, ...g.params);
}

/**
 * 撞车：同一账号上，两个不同作品的定时相隔 ≤ CONFLICT_WINDOW_MIN。
 * 返回结构化的「谁和谁撞」，不是布尔值——卡片要据此在两张卡上都打标记。
 */
export function detectConflicts(rows) {
  const byAccount = new Map();
  for (const r of rows) {
    if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, []);
    byAccount.get(r.account_id).push(r);
  }
  const out = [];
  for (const list of byAccount.values()) {
    list.sort((x, y) => x.at - y.at);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].at - list[i].at <= WINDOW_MS; j++) {
        const a = list[i];
        const b = list[j];
        if (a.work_id === b.work_id) continue;
        out.push({
          accountId: a.account_id,
          platform: a.platform,
          handle: a.handle,
          gapMin: Math.round((b.at - a.at) / 60e3),
          a: { workId: a.work_id, title: a.title, publishId: a.publish_id, at: a.at },
          b: { workId: b.work_id, title: b.title, publishId: b.publish_id, at: b.at },
        });
      }
    }
  }
  return out;
}

/** 平台粒度的行 → 一个作品一张卡。 */
export function aggregateCards(rows, conflicts = []) {
  const cards = new Map();
  for (const r of rows) {
    let card = cards.get(r.work_id);
    if (!card) {
      card = { workId: r.work_id, title: r.title, at: r.at, platforms: [], conflict: false, conflicts: [] };
      cards.set(r.work_id, card);
    }
    card.at = Math.min(card.at, r.at);
    card.platforms.push({
      platform: r.platform,
      handle: r.handle,
      accountId: r.account_id,
      publishId: r.publish_id,
      at: r.at,
      publishState: r.state,
      state: cardStateOf(r.state),
    });
  }
  for (const c of conflicts) {
    for (const [self, other] of [
      [c.a, c.b],
      [c.b, c.a],
    ]) {
      const card = cards.get(self.workId);
      if (!card) continue; // 对方在时间窗外：只给窗内的卡打标记
      card.conflict = true;
      card.conflicts.push({ workId: other.workId, title: other.title, platform: c.platform, at: other.at, gapMin: c.gapMin });
    }
  }
  return [...cards.values()]
    .map((card) => ({ ...card, state: aggregateState(card.platforms) }))
    .sort((x, y) => x.at - y.at || x.workId.localeCompare(y.workId));
}

export function counts(cards) {
  return {
    works: cards.length,
    publishes: cards.reduce((n, c) => n + c.platforms.length, 0),
    conflicts: cards.filter((c) => c.conflict).length,
  };
}

const startOfToday = (now) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** schedule.list：按作品聚合的排期卡片 + 撞车。默认窗口：今天 0 点起 14 天。 */
export function listSchedule({ group = null, from = null, to = null, now = Date.now() } = {}) {
  const conn = open();
  const start = from ?? startOfToday(now);
  const end = to ?? start + 14 * 24 * 3600e3;
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw coded("E_BAD_RANGE", "from / to 必须是毫秒时间戳");
  if (end < start) throw coded("E_BAD_RANGE", "结束时间早于开始时间");

  // 撞车要看窗口边缘之外 30 分钟：窗口最后一条可能和窗口外第一条撞。
  const wide = scheduledRows(conn, { from: start - WINDOW_MS, to: end + WINDOW_MS, group });
  const inWindow = wide.filter((r) => r.at >= start && r.at <= end);
  const conflicts = detectConflicts(wide).filter((c) => (c.a.at >= start && c.a.at <= end) || (c.b.at >= start && c.b.at <= end));
  const cards = aggregateCards(inWindow, conflicts);
  return { group: group ?? null, from: start, to: end, windowMin: CONFLICT_WINDOW_MIN, cards, conflicts, counts: counts(cards) };
}

// ------------------------------------------------------------------ 写：改期 / 取消

function workPublishes(conn, workId) {
  const work = conn.prepare("SELECT id, title FROM work WHERE id = ?").get(workId);
  if (!work) throw coded("E_NOT_FOUND", `没有这个作品：${workId}`);
  const rows = conn
    .prepare(
      `SELECT p.id AS publish_id, p.work_id, p.state, p.scheduled_at AS at, p.account_id, a.platform, a.handle
         FROM publish p JOIN account a ON a.id = p.account_id
        WHERE p.work_id = ?
        ORDER BY a.platform`,
    )
    .all(workId);
  return { work, rows };
}

/** 如果把这个作品的 movable 行挪到 at，会和谁撞。 */
function conflictsIfMoved(conn, work, movable, at) {
  if (!movable.length) return [];
  const accountIds = [...new Set(movable.map((r) => r.account_id))];
  const others = conn
    .prepare(
      `SELECT p.id AS publish_id, p.work_id, w.title, p.scheduled_at AS at, p.account_id, a.platform, a.handle
         FROM publish p JOIN work w ON w.id = p.work_id JOIN account a ON a.id = p.account_id
        WHERE p.scheduled_at BETWEEN ? AND ?
          AND p.state != 'canceled'
          AND p.work_id != ?
          AND p.account_id IN (${accountIds.map(() => "?").join(",")})`,
    )
    .all(at - WINDOW_MS, at + WINDOW_MS, work.id, ...accountIds);
  const moved = movable.map((r) => ({ ...r, title: work.title, at }));
  return detectConflicts([...moved, ...others]);
}

/**
 * schedule.move：整个作品一起改期——不是逐条改。
 *  · 过去时间直接拦截；
 *  · 有平台正在上传时拒绝（半个作品改期 = 两张卡）；
 *  · 撞车时不保存，返回结构化冲突，force=true 才落盘（「保存前提示」）。
 * 只改时间字段与对应队列的 run_after，状态不变，所以不走 transitionPublish。
 */
export function moveSchedule({ workId, at, force = false, now = Date.now() }) {
  if (!Number.isInteger(at) || at < 0) throw coded("E_BAD_TIME", "改到的时间必须是毫秒时间戳");
  if (at <= now) throw coded("E_SCHEDULE_PAST", `不能改到过去的时间：${new Date(at).toISOString()}`);

  const conn = open();
  const { work, rows } = workPublishes(conn, workId);
  const running = rows.filter((r) => RUNNING.has(r.state));
  if (running.length) {
    throw coded("E_SCHEDULE_RUNNING", `${running.map((r) => r.platform).join("、")} 正在发布，等它结束再改期`);
  }
  const movable = rows.filter((r) => r.state === "queued");
  if (!movable.length) throw coded("E_SCHEDULE_NOTHING", "这个作品没有还在排队的发布，没有可以改期的");
  const skipped = rows
    .filter((r) => r.state !== "queued")
    .map((r) => ({ publishId: r.publish_id, platform: r.platform, state: r.state }));

  const conflicts = conflictsIfMoved(conn, work, movable, at);
  const previous = Math.min(...movable.map((r) => r.at ?? Infinity));
  const base = { workId, title: work.title, from: Number.isFinite(previous) ? previous : null, at, conflicts, skipped };

  if (conflicts.length && !force) {
    // 不用 ok:false：那会被当成调用失败，冲突明细就丢了。saved:false 才是「没保存，原因在这」。
    return {
      ...base,
      saved: false,
      code: "E_SCHEDULE_CONFLICT",
      message: `改到这个时间会和 ${conflicts.length} 条排期撞车，没有保存`,
      next: `确认仍要保存：vk schedule move ${workId} --at ${at} --force`,
      moved: [],
    };
  }

  const ts = Date.now();
  conn.exec("BEGIN");
  try {
    const upd = conn.prepare("UPDATE publish SET scheduled_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'");
    const run = conn.prepare("UPDATE run SET run_after = ? WHERE kind = 'publish' AND target_type = 'publish' AND target_id = ? AND state = 'queued'");
    for (const r of movable) {
      upd.run(at, ts, r.publish_id);
      run.run(at, r.publish_id);
    }
    emit({
      type: "schedule.moved",
      payload: { workId, from: base.from, to: at, publishIds: movable.map((r) => r.publish_id), forced: Boolean(conflicts.length) },
    });
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return { ...base, saved: true, moved: movable.map((r) => ({ publishId: r.publish_id, platform: r.platform })) };
}

/** 可以被「取消排期」收走的状态：还没发出去、也没在上传。 */
const CANCELLABLE = new Set(["queued", "notify_pending", "draft_pending", "failed", "blocked", "expired"]);

/**
 * schedule.cancel：整个作品取消。迁到 canceled 并写 E_USER_CANCELLED，**不删行**，现场保留。
 * 用 canceled 而不是 failed：failed 会触发 publish.failed 卡片叫醒人，而且可以被重试拉回队列。
 */
export function cancelSchedule({ workId }) {
  const conn = open();
  const { work, rows } = workPublishes(conn, workId);
  const running = rows.filter((r) => RUNNING.has(r.state));
  if (running.length) {
    throw coded("E_SCHEDULE_RUNNING", `${running.map((r) => r.platform).join("、")} 正在发布，等它结束再取消`);
  }
  const targets = rows.filter((r) => CANCELLABLE.has(r.state));
  const skipped = rows
    .filter((r) => !CANCELLABLE.has(r.state))
    .map((r) => ({ publishId: r.publish_id, platform: r.platform, state: r.state }));
  if (!targets.length) {
    if (rows.length && rows.every((r) => r.state === "canceled")) {
      return { ok: true, already: true, workId, title: work.title, canceled: [], skipped };
    }
    throw coded("E_SCHEDULE_NOTHING", "这个作品没有可以取消的发布（已发出的不能取消）");
  }

  conn.exec("BEGIN");
  try {
    const run = conn.prepare("UPDATE run SET state = 'canceled' WHERE kind = 'publish' AND target_type = 'publish' AND target_id = ? AND state = 'queued'");
    for (const r of targets) {
      transitionPublish(r.publish_id, "canceled", {
        reason: "schedule_cancelled_by_operator",
        patch: { error_code: E_USER_CANCELLED, error_message: "排期已被手动取消" },
      });
      run.run(r.publish_id);
    }
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return {
    ok: true,
    workId,
    title: work.title,
    canceled: targets.map((r) => ({ publishId: r.publish_id, platform: r.platform, from: r.state })),
    skipped,
  };
}
