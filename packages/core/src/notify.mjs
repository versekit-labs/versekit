// 事件 → 手机，按钮 → 命令。这两段是「手机拍板」的全部逻辑，放在 core 里，
// 通道只负责把 JSON 发出去、把点击收回来。
//
// 两条不可妥协的规则：
//   · 投递幂等：同一个事件不会发两次卡片（delivery 行 + event_id 唯一）
//   · 动作幂等：同一张卡点两次只会执行一次（command_audit.idempotency_key 唯一）

import { open, newId } from "./index.mjs";
import { findCommand, parseArgs } from "./commands.mjs";
import {
  buildEventCard,
  buildNewWorkCard,
  buildConfirmCard,
  buildEditCard,
  buildXhsCard,
  buildCardResult,
  editFieldNames,
  parsePickerTime,
  formatWhen,
  formatPickerTime,
  platformLabel,
  resultCard,
  CARD_TTL_MS,
} from "./cards.mjs";
import { getPublishRow } from "./publish-flow.mjs";
import { approvalLink } from "./approval.mjs";
import { CONFIRMABLE_STATES, PER_ITEM_PLATFORMS, listGroups, effectiveCopy, effectiveTitle } from "./store.mjs";
import { planRules, takenTimes } from "./plan-rules.mjs";
import { basename } from "node:path";

const RETRY_AFTER_MS = 60e3;
const MAX_ATTEMPTS = 3;
/** 新作品卡片晚发这么久，等同一批平台稿建完（#150；ACC-v2-card-01 要求 1 分钟内）。 */
export const NEW_WORK_DELAY_MS = 30e3;

function parsePayload(row) {
  try {
    return { ...row, payload: row.payload_json ? JSON.parse(row.payload_json) : null };
  } catch {
    return { ...row, payload: null };
  }
}

/**
 * Sends cards for events that have no successful delivery yet. Returns what happened so the
 * daemon can log it; failures are retried (with a cap) instead of being dropped.
 */
export async function deliverPending({ channel, binding, log = () => {}, now = Date.now(), limit = 20 } = {}) {
  if (!binding?.external_user_id) return { sent: 0, skipped: "unbound" };
  const conn = open();
  const rows = conn
    .prepare(
      `SELECT e.* FROM event e
         LEFT JOIN delivery d ON d.event_id = e.id AND d.channel = ?
        WHERE e.created_at >= ?
          AND (d.id IS NULL OR (d.state = 'failed' AND d.attempted < ? AND (d.sent_at IS NULL OR d.sent_at < ?)))
        ORDER BY e.created_at ASC LIMIT ?`,
    )
    .all(channel.channel, now - 7 * 24 * 3600e3, MAX_ATTEMPTS, now - RETRY_AFTER_MS, limit);

  let sent = 0;
  for (const raw of rows) {
    const event = parsePayload(raw);
    let card;
    if (event.type === "work.awaiting_confirm") {
      // 为了等一批平台稿建完，晚一点再发（仍在 ACC-v2-card-01 的 1 分钟内）。
      if (now - event.created_at < NEW_WORK_DELAY_MS) continue;
      const summary = newWorkSummary(event.payload?.workId);
      if (!summary.publishCount) {
        // 投递时已经没有等确认的了（在别处确认或取消）：不打扰，也别每 5 秒重判一次。
        markDelivery(conn, event.id, channel.channel, "skipped", null, now);
        continue;
      }
      card = buildNewWorkCard({ ...summary, eventId: event.id, now });
    } else {
      const publish = event.publish_id ? getPublishRow(event.publish_id) : null;
      const approvalUrl =
        publish && ["publish.failed", "publish.needs_human"].includes(event.type) ? approvalLink(publish.id) : null;
      card = buildEventCard(event, { publish, now, approvalUrl });
    }
    if (!card) continue; // 内部 trace，不该打扰人

    try {
      const { messageId } = await channel.send({
        openId: binding.external_user_id,
        card,
        idempotencyKey: `event:${event.id}`.slice(0, 50),
      });
      markDelivery(conn, event.id, channel.channel, "sent", messageId ?? null, now);
      sent += 1;
    } catch (err) {
      const existing = conn.prepare("SELECT id, attempted FROM delivery WHERE event_id=? AND channel=?").get(event.id, channel.channel);
      if (existing) {
        conn.prepare("UPDATE delivery SET state='failed', attempted=attempted+1, sent_at=? WHERE id=?").run(now, existing.id);
      } else {
        conn
          .prepare("INSERT INTO delivery (id, event_id, channel, state, attempted, sent_at) VALUES (?,?,?,'failed',1,?)")
          .run(newId("del"), event.id, channel.channel, now);
      }
      log(`[notify] 投递失败 ${event.type}: ${err.message}`);
    }
  }
  return { sent, considered: rows.length };
}

function markDelivery(conn, eventId, channelName, state, messageId, now) {
  const existing = conn.prepare("SELECT id FROM delivery WHERE event_id=? AND channel=?").get(eventId, channelName);
  if (existing) {
    conn
      .prepare("UPDATE delivery SET state=?, external_msg_id=?, attempted=attempted+1, sent_at=? WHERE id=?")
      .run(state, messageId, now, existing.id);
  } else {
    conn
      .prepare("INSERT INTO delivery (id, event_id, channel, state, external_msg_id, attempted, sent_at) VALUES (?,?,?,?,?,1,?)")
      .run(newId("del"), eventId, channelName, state, messageId, now);
  }
}

/** 只给测试与卡片文案用：一个动作值能存活多久。 */
export const actionExpiry = (now = Date.now()) => now + CARD_TTL_MS;

const RESULT_TEXT = {
  "publish.retry": () => "已重新排队，马上会再试一次。",
  "publish.confirm": () => "已记下：这条由你确认发布。",
  "publish.release": () => "已放行公开。",
  "account.reauth": (r) => r?.next ?? "已发起重新授权。",
  "account.mode": (r) => `已切换为${r?.mode === "manual" ? "手动" : "自动"}。`,
  "collect.now": (r) => `已排 ${r?.queued ?? 1} 个采集任务，稍后刷新看数据。`,
};

const describe = (command, result) => (RESULT_TEXT[command]?.(result) ?? "已完成。");

/**
 * 前三道闸里「是谁点的、按钮坏没坏、过没过期」：executeAction 与卡片翻页（card.*）共用同一份，
 * 不会出现两处判断不一致。失败时带 code，通道据此决定要不要动那张卡片（别人点的不该把卡片弄没）。
 */
function preflight({ action, operator, binding, now }) {
  if (!binding?.external_user_id) return { ok: false, code: "unbound", message: "还没有配对飞书账号。" };
  if (!operator || operator !== binding.external_user_id) {
    return { ok: false, code: "operator", message: "这个按钮不属于当前配对的飞书账号。" };
  }
  let parsed;
  try {
    parsed = typeof action === "string" ? JSON.parse(action) : action;
  } catch {
    return { ok: false, code: "broken", message: "按钮数据坏了，没法执行。" };
  }
  if (!parsed?.cmd) return { ok: false, code: "broken", message: "按钮没有带命令。" };
  if (!Number.isFinite(parsed.exp) || parsed.exp < now) {
    return { ok: false, code: "expired", message: "按钮已过期（24 小时），请到控制台操作。" };
  }
  return { ok: true, parsed };
}

/**
 * Validates and executes one card button press.
 *
 * `operator` is the Feishu open_id that pressed it; anything other than the paired account is
 * refused. All four gates (operator / expiry / remote-allowlist / idempotency) are checked before
 * a handler runs — a card is a remote control, so it needs the same care as any remote command.
 */
export async function executeAction({ action, operator, binding, handlers = {}, now = Date.now() } = {}) {
  const gate = preflight({ action, operator, binding, now });
  if (!gate.ok) return gate;
  const parsed = gate.parsed;

  const command = findCommand(parsed.cmd);
  if (!command) return { ok: false, message: `命令 ${parsed.cmd} 不存在。` };
  if (!command.remote) return { ok: false, message: `${command.name} 只能在电脑上执行。` };

  const conn = open();
  if (parsed.key) {
    const done = conn.prepare("SELECT result, reason FROM command_audit WHERE idempotency_key=?").get(parsed.key);
    if (done) return { ok: done.result === "ok", duplicate: true, message: `已经执行过：${done.reason ?? done.result}` };
  }

  let args;
  try {
    args = parseArgs(command, parsed.args ?? {});
  } catch (err) {
    return { ok: false, message: err.message };
  }

  const handler = handlers[command.name];
  if (!handler) return { ok: false, message: `${command.name} 还没有实现。` };

  const id = newId("cmd");
  let result;
  try {
    result = await handler(args);
  } catch (err) {
    conn
      .prepare("INSERT OR IGNORE INTO command_audit (id, name, actor, origin, args_json, result, reason, idempotency_key, created_at) VALUES (?,?,?,?,?,'error',?,?,?)")
      .run(id, command.name, `feishu:${operator}`, "feishu", JSON.stringify(args), String(err.message).slice(0, 500), parsed.key ?? null, now);
    return { ok: false, message: err.message };
  }

  const text = describe(command.name, result);
  conn
    .prepare("INSERT OR IGNORE INTO command_audit (id, name, actor, origin, args_json, result, reason, idempotency_key, created_at) VALUES (?,?,?,?,?,'ok',?,?,?)")
    .run(id, command.name, `feishu:${operator}`, "feishu", JSON.stringify(args), text.slice(0, 500), parsed.key ?? null, now);
  return { ok: true, message: text, result };
}

// ---------------------------------------------------------------------------------------------
// 新作品确认流程（#150，ACC-v2-card-*）。
//
//   新作品卡片 ──「开始确认」──▶ 第 1 支成片确认卡片 ──确认 / 先不发──▶ （小红书单独卡片）──▶ 第 2 支 …
//
// 没有会话状态：「下一张发什么」每次都从数据库当前状态推出（作品里按成片顺序第一支还有待确认
// 平台稿的成片），所以守护进程重启、在电脑上改过、两处同时点，都不会发错或发重。
// 真正改数据的只有 publish.* 命令，走 executeAction（四道闸）；这里只管翻页、拼卡片、原地更新。
// ---------------------------------------------------------------------------------------------

const NAV_COMMANDS = new Set(["card.review", "card.edit", "card.show", "card.save_edit"]);
const STATE_COMMANDS = new Set(["publish.approve", "publish.skip", "publish.now", "publish.manual"]);

const peekCmd = (action) => {
  try {
    return (typeof action === "string" ? JSON.parse(action) : action)?.cmd;
  } catch {
    return undefined;
  }
};

const jsonOr = (text, fallback = {}) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/** 「几支成片、几条平台稿」按投递那一刻的真实状态算。 */
function newWorkSummary(workId) {
  const conn = open();
  const work = workId ? conn.prepare("SELECT id, title FROM work WHERE id = ?").get(workId) : null;
  if (!work) return { workId, workTitle: "", cutCount: 0, publishCount: 0, groupName: null };
  const rows = conn
    .prepare(
      `SELECT p.cut_id, a.group_id FROM publish p JOIN account a ON a.id = p.account_id
        WHERE p.work_id = ? AND p.state = 'pending_confirm' AND a.removed_at IS NULL`,
    )
    .all(workId);
  return {
    workId,
    workTitle: work.title,
    cutCount: new Set(rows.map((r) => r.cut_id)).size,
    publishCount: rows.length,
    groupName: groupNameOf(rows[0]?.group_id),
  };
}

/** 账号组多于一个时标题带组名；只有一个时不带（ACC-v2-card-03）。 */
function groupNameOf(groupId) {
  if (!groupId || listGroups().length <= 1) return null;
  return open().prepare("SELECT name FROM account_group WHERE id = ?").get(groupId)?.name ?? null;
}

/** 卡片上这条平台稿的标题 = 适配器真正会发的标题，只读 store.effectiveTitle，不在这里另写回退链。 */
const rowCopy = (r) => effectiveCopy({ overrides: r.overrides_json, versionMeta: r.version_meta, workMeta: r.work_meta_json, cutTitle: r.cut_title, workTitle: r.work_title });

function loadCut(cutId) {
  const rows = open()
    .prepare(
      `SELECT p.id AS publish_id, p.state, p.scheduled_at, p.overrides_json, p.account_id, p.version_id, p.work_id,
              a.platform, a.handle, a.removed_at, a.group_id,
              c.id AS cut_id, c.title AS cut_title, w.title AS work_title, w.meta_json AS work_meta_json, v.meta_json AS version_meta
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN cut c ON c.id = p.cut_id
         JOIN work w ON w.id = p.work_id
         LEFT JOIN cut_version v ON v.id = p.version_id
        WHERE p.cut_id = ?
        ORDER BY p.rowid`, // 按建稿顺序：同一毫秒建的不能靠随机 id 排，卡片上的行序会飘
    )
    .all(cutId);
  const live = rows.filter((r) => CONFIRMABLE_STATES.includes(r.state) && !r.removed_at);
  return {
    all: rows,
    batch: live.filter((r) => !PER_ITEM_PLATFORMS.includes(r.platform)),
    perItem: live.filter((r) => PER_ITEM_PLATFORMS.includes(r.platform)),
    first: rows[0] ?? null,
  };
}

const toRow = (r) => ({ publishId: r.publish_id, platform: r.platform, title: effectiveTitle(r), body: rowCopy(r).body, tags: rowCopy(r).tags, at: r.scheduled_at });

/** 这支成片在作品里排第几、一共几支（不算整支已取消的）。 */
function cutPosition(workId, cutId) {
  const ids = open()
    .prepare(
      `SELECT c.id FROM cut c WHERE c.work_id = ?
          AND EXISTS (SELECT 1 FROM publish p WHERE p.cut_id = c.id AND p.state != 'canceled')
        ORDER BY c.position, c.created_at`,
    )
    .all(workId)
    .map((r) => r.id);
  return { index: Math.max(ids.indexOf(cutId), 0) + 1, total: Math.max(ids.length, 1) };
}

const whenOf = (args) => (args?.when === "now" ? "now" : "scheduled");

function renderConfirm(cutId, { now, note = null, when = "scheduled" } = {}) {
  const { batch, first } = loadCut(cutId);
  if (!batch.length) return null;
  const { index, total } = cutPosition(first.work_id, cutId);
  return buildConfirmCard({
    cut: { id: cutId, title: first.cut_title },
    index,
    total,
    workTitle: first.work_title,
    rows: batch.map(toRow),
    groupName: groupNameOf(batch[0].group_id),
    now,
    note,
    when,
  });
}

function renderEdit(cutId, { now, note = null, when = "scheduled" } = {}) {
  const { batch, first } = loadCut(cutId);
  if (!batch.length) return null;
  return buildEditCard({
    cut: { id: cutId, title: first.cut_title },
    rows: batch.map(toRow),
    groupName: groupNameOf(batch[0].group_id),
    now,
    note,
    when,
  });
}

const startOfDay = (t) => new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime();

function renderXhs(publishId, { now } = {}) {
  const r = open()
    .prepare(
      `SELECT p.id AS publish_id, p.state, p.scheduled_at, p.overrides_json, p.account_id, p.version_id,
              a.platform, a.group_id, c.title AS cut_title, w.title AS work_title, w.meta_json AS work_meta_json, v.meta_json AS version_meta
         FROM publish p JOIN account a ON a.id = p.account_id JOIN cut c ON c.id = p.cut_id JOIN work w ON w.id = p.work_id
         LEFT JOIN cut_version v ON v.id = p.version_id
        WHERE p.id = ?`,
    )
    .get(publishId);
  if (!r) return null;
  const version = r.version_id ? open().prepare("SELECT language, asset_path FROM cut_version WHERE id = ?").get(r.version_id) : null;
  const rules = planRules(r.platform);
  const today = takenTimes(r.account_id, r.publish_id).filter((t) => t >= startOfDay(now) && t < startOfDay(now) + 24 * 3600e3).length;
  return buildXhsCard({
    publishId,
    workTitle: r.work_title,
    cutTitle: r.cut_title,
    title: effectiveTitle(r),
    body: rowCopy(r).body,
    tags: rowCopy(r).tags,
    at: r.scheduled_at,
    assetNote: version ? `${version.language} 版本 · ${basename(version.asset_path)}` : null,
    quotaLeft: Math.max(0, rules.dailyCap - today),
    groupName: groupNameOf(r.group_id),
    now,
  });
}

/** 作品里下一张该发的卡片：按成片顺序第一支还有待确认平台稿的成片；它没有非小红书的了就轮到小红书。 */
function nextTarget(workId) {
  const rows = open()
    .prepare(
      `SELECT p.id, p.cut_id, a.platform FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN cut c ON c.id = p.cut_id
        WHERE p.work_id = ? AND p.state = 'pending_confirm' AND a.removed_at IS NULL
        ORDER BY c.position, c.created_at, p.rowid`,
    )
    .all(workId);
  if (!rows.length) return null;
  const cutId = rows[0].cut_id;
  const inCut = rows.filter((r) => r.cut_id === cutId);
  if (inCut.some((r) => !PER_ITEM_PLATFORMS.includes(r.platform))) return { kind: "cut", cutId };
  return { kind: "xhs", publishId: inCut[0].id };
}

async function sendNext({ workId, channel, binding, now, log }) {
  const target = nextTarget(workId);
  if (!target) return false;
  const card = target.kind === "cut" ? renderConfirm(target.cutId, { now }) : renderXhs(target.publishId, { now });
  if (!card) return false;
  await channel.send({
    openId: binding.external_user_id,
    card,
    idempotencyKey: `card:${target.kind}:${target.cutId ?? target.publishId}:${now}`.slice(0, 50),
  });
  log(`[card] 发出下一张：${target.kind === "cut" ? `成片 ${target.cutId}` : `小红书 ${target.publishId}`}`);
  return true;
}

const cutOfPublish = (publishId) => open().prepare("SELECT cut_id, work_id FROM publish WHERE id = ?").get(publishId) ?? null;

function resultFor(cmd, res, args, cutTitle, now) {
  const r = res.result ?? {};
  if (cmd === "publish.skip") {
    return { title: `${cutTitle} · 先不发`, lines: ["这支先不发。", "以后想发，到作品页再确认。"] };
  }
  if (cmd === "publish.approve" && args.cutId) {
    const immediate = args.when === "now";
    const lines = [`已确认 ${r.approved?.length ?? 0} 条，${immediate ? "现在发：" : "按时间发："}`];
    for (const a of r.approved ?? []) lines.push(`${platformLabel(a.platform)}　${immediate ? "现在发" : formatWhen(a.scheduledAt, now)}`);
    for (const x of r.removed ?? []) lines.push(`没带上：${x.reason}`);
    if (r.perItem?.length) lines.push("小红书要你单独确认，下一张卡片就是。");
    return { title: `${cutTitle} · 已确认`, lines };
  }
  const who = platformLabel(r.platform ?? "xiaohongshu");
  if (cmd === "publish.approve") return { title: `${who} · 已确认`, lines: [`${who}　${formatWhen(r.scheduledAt, now)} 发。`] };
  if (cmd === "publish.now") return { title: `${who} · 现在发`, lines: [`${who}　已排到现在发。`] };
  return { title: `${who} · 你自己发`, lines: [`${who}　不自动发了：在 App 里发完后点「我已发布」。`] };
}

/**
 * 飞书按钮事件的入口（daemon 的 onAction 只调这一个）。
 * `evt` 是通道交回来的：{ action_value, operator_id, message_id, form_value? }。
 * 新作品确认流程里的按钮在这里处理；其余按钮（重试、重新授权…）照旧走 executeAction 再原地更新成一句结论。
 */
export async function handleCardEvent({ evt, channel, binding, handlers = {}, log = () => {}, now = Date.now() } = {}) {
  const gate = preflight({ action: evt.action_value, operator: evt.operator_id, binding, now });
  const cmd = gate.parsed?.cmd ?? peekCmd(evt.action_value);
  const inFlow = NAV_COMMANDS.has(cmd) || STATE_COMMANDS.has(cmd);

  // 别人点的（或没配对）：照旧拒绝，但不动这张卡片——不该因为别人乱点，把你的确认卡弄没了。
  if (!gate.ok && inFlow && ["operator", "unbound"].includes(gate.code)) {
    log(`[channel] ✗ ${gate.message}`);
    return gate;
  }

  if (!gate.ok || !inFlow) {
    // 旧按钮：行为不变。
    const res = await executeAction({ action: evt.action_value, operator: evt.operator_id, binding, handlers, now });
    log(`[channel] ${res.ok ? "✓" : "✗"} ${res.message}`);
    await updateCard(channel, evt, resultCard(res.ok ? "已处理" : "没有执行", res.message, { ok: res.ok }), log);
    return res;
  }

  const parsed = gate.parsed;
  const args = parsed.args ?? {};
  const op = evt.operator_id;

  if (NAV_COMMANDS.has(cmd)) {
    if (parsed.key && open().prepare("SELECT 1 FROM command_audit WHERE idempotency_key=?").get(parsed.key)) {
      log(`[channel] 重复点击已忽略：${cmd}`);
      return { ok: true, duplicate: true, message: "已经处理过。" };
    }
    return handleNav({ cmd, parsed, args, evt, channel, binding, log, now, handlers });
  }

  // publish.* 真命令：四道闸、审计、幂等都在 executeAction 里。
  const res = await executeAction({ action: parsed, operator: op, binding, handlers, now });
  log(`[channel] ${res.ok ? "✓" : "✗"} ${res.message}`);
  if (res.duplicate) return res; // 原卡片已经是结果了，别拿「已经执行过」盖掉它

  const cutId = args.cutId ?? cutOfPublish(args.publishId)?.cut_id ?? null;
  const workId = cutId ? loadCut(cutId).first?.work_id : null;
  const cutTitle = cutId ? loadCut(cutId).first?.cut_title ?? "" : "";
  const groupName = cutId ? groupNameOf(loadCut(cutId).first?.group_id) : null;

  if (!res.ok) {
    // 没执行成功（比如账号已移除、状态变了）：能留着按钮就留着并说明原因，否则换成红色结果。
    const cutLevel = Boolean(args.cutId);
    const again = cutLevel && cutId ? renderConfirm(cutId, { now, note: { error: true, text: `没有执行：${res.message}` } }) : null;
    await updateCard(channel, evt, again ?? buildCardResult({ title: "没有执行", lines: [res.message], ok: false, groupName }), log);
    return res;
  }

  const shown = resultFor(cmd, res, args, cutTitle, now);
  await updateCard(channel, evt, buildCardResult({ ...shown, groupName }), log);
  if (workId) {
    try {
      await sendNext({ workId, channel, binding, now, log });
    } catch (err) {
      log(`[card] 下一张没发出去：${err.message}`);
      await updateCard(channel, evt, buildCardResult({ ...shown, lines: [...shown.lines, `下一张没发出来（${err.message}），到作品页继续确认。`], groupName }), log);
    }
  }
  return res;
}

async function updateCard(channel, evt, card, log) {
  if (!evt.message_id) return;
  await channel.updateCard({ messageId: evt.message_id, card }).catch((err) => log(`[channel] 更新卡片失败：${err.message}`));
}

function recordNav({ cmd, parsed, args, operator, now, text }) {
  if (!parsed.key) return;
  open()
    .prepare("INSERT OR IGNORE INTO command_audit (id, name, actor, origin, args_json, result, reason, idempotency_key, created_at) VALUES (?,?,?,?,?,'ok',?,?,?)")
    .run(newId("cmd"), cmd, `feishu:${operator}`, "feishu", JSON.stringify(args), text, parsed.key, now);
}

async function handleNav({ cmd, parsed, args, evt, channel, binding, log, now, handlers }) {
  const done = { ok: true, message: "已处理。" };
  const gone = async (cutId) => {
    const first = loadCut(cutId).first;
    await updateCard(channel, evt, buildCardResult({ title: first?.cut_title ?? "这支成片", lines: ["这支成片已经处理过了，没有等确认的平台稿。"], groupName: groupNameOf(first?.group_id) }), log);
    return done;
  };

  if (cmd === "card.review") {
    const eventId = String(parsed.key ?? "").replace(/:card\.review$/, "");
    const summary = newWorkSummary(args.workId);
    try {
      const sent = await sendNext({ workId: args.workId, channel, binding, now, log });
      if (!sent) {
        await updateCard(channel, evt, buildCardResult({ title: "新作品", lines: ["没有等确认的平台稿了。"], groupName: summary.groupName }), log);
      } else {
        await updateCard(
          channel,
          evt,
          buildCardResult({ title: "开始确认", lines: [`「${summary.workTitle}」一支一支发给你，上一支处理完才发下一支。`], groupName: summary.groupName }),
          log,
        );
      }
      recordNav({ cmd, parsed, args, operator: evt.operator_id, now, text: "started" });
    } catch (err) {
      log(`[card] 开始确认失败：${err.message}`);
      await updateCard(channel, evt, buildNewWorkCard({ ...summary, eventId, now, note: { error: true, text: `没发出来：${err.message}。再点一次。` } }), log);
      return { ok: false, message: err.message };
    }
    return done;
  }

  const cutId = args.cutId;
  if (cmd === "card.show") {
    const card = renderConfirm(cutId, { now, when: whenOf(args) });
    return card ? (await updateCard(channel, evt, card, log), done) : gone(cutId);
  }
  if (cmd === "card.edit") {
    const card = renderEdit(cutId, { now, when: whenOf(args) });
    return card ? (await updateCard(channel, evt, card, log), done) : gone(cutId);
  }

  // card.save_edit：逐条把改动交给 publish.edit（平台规则、留痕都在命令里）。这里只校验格式。
  const { batch } = loadCut(cutId);
  if (!batch.length) return gone(cutId);
  const form = evt.form_value ?? {};
  const when = whenOf(args);
  const names = editFieldNames(batch.map(toRow));
  const edits = [];
  const problems = [];
  batch.forEach((r, i) => {
    const label = platformLabel(r.platform);
    const rawTitle = form[names[i].title];
    const rawAt = form[names[i].at];
    const change = { publishId: r.publish_id, label };
    if (typeof rawTitle === "string" && rawTitle.trim() !== effectiveTitle(r)) {
      if (!rawTitle.trim()) problems.push(`${label}：标题不能为空`);
      else change.title = rawTitle.trim();
    }
    // 现在发：卡片上没有时间输入，也就不处理时间（ACC-v3-time-06）。
    if (when !== "now" && typeof rawAt === "string" && rawAt.trim()) {
      const at = parsePickerTime(rawAt);
      if (at == null) problems.push(`${label}：时间「${rawAt}」格式不对，应是 2026-11-15 20:00`);
      // 选择器只到分钟：没动它回来的值和库里（带秒）的时间差不到一分钟，不算改动，别凭空触发一次 publish.edit。
      else if (!Number.isFinite(r.scheduled_at) || formatPickerTime(at) !== formatPickerTime(r.scheduled_at)) change.at = at;
    }
    if (change.title !== undefined || change.at !== undefined) edits.push(change);
  });
  if (problems.length) {
    await updateCard(channel, evt, renderEdit(cutId, { now, when, note: { error: true, text: problems.join("\n") } }), log);
    return { ok: false, message: problems.join("；") };
  }
  const failures = [];
  for (const e of edits) {
    const value = { publishId: e.publishId, ...(e.title !== undefined ? { title: e.title } : {}), ...(e.at !== undefined ? { at: e.at } : {}) };
    const res = await executeAction({
      action: { cmd: "publish.edit", args: value, exp: parsed.exp, key: `${parsed.key}:${e.publishId}` },
      operator: evt.operator_id,
      binding,
      handlers,
      now,
    });
    if (!res.ok && !res.duplicate) failures.push(`${e.label}：${res.message}`);
  }
  if (failures.length) {
    await updateCard(channel, evt, renderEdit(cutId, { now, when, note: { error: true, text: failures.join("\n") } }), log);
    return { ok: false, message: failures.join("；") };
  }
  recordNav({ cmd, parsed, args, operator: evt.operator_id, now, text: `edited ${edits.length}` });
  const card = renderConfirm(cutId, { now, when, note: { text: edits.length ? `已改好 ${edits.length} 处，下面是现在的样子。` : "没有改动。" } });
  if (!card) return gone(cutId);
  await updateCard(channel, evt, card, log);
  return done;
}
