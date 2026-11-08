// 事件 → 手机，按钮 → 命令。这两段是「手机拍板」的全部逻辑，放在 core 里，
// 通道只负责把 JSON 发出去、把点击收回来。
//
// 两条不可妥协的规则：
//   · 投递幂等：同一个事件不会发两次卡片（delivery 行 + event_id 唯一）
//   · 动作幂等：同一张卡点两次只会执行一次（command_audit.idempotency_key 唯一）

import { open, newId } from "./index.mjs";
import { findCommand, parseArgs } from "./commands.mjs";
import { buildEventCard, CARD_TTL_MS } from "./cards.mjs";
import { getPublishRow } from "./publish-flow.mjs";
import { approvalLink } from "./approval.mjs";

const RETRY_AFTER_MS = 60e3;
const MAX_ATTEMPTS = 3;

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
    const publish = event.publish_id ? getPublishRow(event.publish_id) : null;
    const approvalUrl =
      publish && ["publish.failed", "publish.needs_human"].includes(event.type) ? approvalLink(publish.id) : null;
    const card = buildEventCard(event, { publish, now, approvalUrl });
    if (!card) continue; // 内部 trace，不该打扰人

    try {
      const { messageId } = await channel.send({
        openId: binding.external_user_id,
        card,
        idempotencyKey: `event:${event.id}`.slice(0, 50),
      });
      const existing = conn.prepare("SELECT id, attempted FROM delivery WHERE event_id=? AND channel=?").get(event.id, channel.channel);
      if (existing) {
        conn
          .prepare("UPDATE delivery SET state='sent', external_msg_id=?, attempted=attempted+1, sent_at=? WHERE id=?")
          .run(messageId ?? null, now, existing.id);
      } else {
        conn
          .prepare("INSERT INTO delivery (id, event_id, channel, state, external_msg_id, attempted, sent_at) VALUES (?,?,?,'sent',?,1,?)")
          .run(newId("del"), event.id, channel.channel, messageId ?? null, now);
      }
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
 * Validates and executes one card button press.
 *
 * `operator` is the Feishu open_id that pressed it; anything other than the paired account is
 * refused. All four gates (operator / expiry / remote-allowlist / idempotency) are checked before
 * a handler runs — a card is a remote control, so it needs the same care as any remote command.
 */
export async function executeAction({ action, operator, binding, handlers = {}, now = Date.now() } = {}) {
  if (!binding?.external_user_id) return { ok: false, message: "还没有配对飞书账号。" };
  if (!operator || operator !== binding.external_user_id) {
    return { ok: false, message: "这个按钮不属于当前配对的飞书账号。" };
  }

  let parsed;
  try {
    parsed = typeof action === "string" ? JSON.parse(action) : action;
  } catch {
    return { ok: false, message: "按钮数据坏了，没法执行。" };
  }
  if (!parsed?.cmd) return { ok: false, message: "按钮没有带命令。" };

  if (!Number.isFinite(parsed.exp) || parsed.exp < now) {
    return { ok: false, message: "按钮已过期（24 小时），请到控制台操作。" };
  }

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
