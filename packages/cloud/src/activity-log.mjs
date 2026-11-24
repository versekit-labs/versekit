import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const dayMs = 86_400_000;
const entries = Object.freeze({
  login_started: ["login.started", "已开始 Google 登录。"],
  login_succeeded: ["login.succeeded", "Google 登录成功。"],
  logout_succeeded: ["logout.succeeded", "已退出 Hifabu 账号。"],
  origin_forbidden: ["request.rejected", "请求来源与 Hifabu 账号服务不符。"],
  request_invalid: ["request.rejected", "登录请求格式有误，请重新登录。"],
  session_required: ["request.rejected", "请先登录 Hifabu 账号。"],
  google_cancelled: ["login.cancelled", "你取消了 Google 登录，可以再试一次。"],
  google_state_invalid: ["login.failed", "这次 Google 登录已失效，请重新登录。"],
  google_identity_invalid: ["login.failed", "无法确认 Google 登录身份，请重新登录。"],
  google_email_unverified: ["login.failed", "这个 Google 邮箱还没有验证。请验证邮箱后再登录。"],
  google_unavailable: ["login.failed", "暂时无法完成 Google 登录，请重试。"],
  device_link_started: ["device.link.started", "机器正在等待允许接入。"],
  device_linked: ["device.link.allowed", "机器已接入。"],
  device_link_denied: ["device.link.denied", "这次机器接入已被拒绝。"],
  device_link_expired: ["device.link.expired", "这次接入过期了。请在那台电脑上重新登录 Hifabu。"],
  device_link_invalid: ["device.link.failed", "机器接入请求格式有误，请重试。"],
  device_link_busy: ["device.link.failed", "当前接入请求过多，请稍后重试。"],
  device_inactive: ["device.refresh.failed", "这台机器已经退出或接入已失效，请重新登录 Hifabu。"],
  device_not_found: ["device.revoke.failed", "找不到这台机器。"],
  device_revoked: ["device.revoked", "机器已退出。"],
  device_signing_unavailable: ["device.request.failed", "Hifabu 暂时无法接入机器，请稍后重试。"],
  owner_required: ["account.admin.denied", "只有 Hifabu 所有者可以访问管理页。"],
  account_request_invalid: ["account.request.failed", "请求格式有误，请检查传片状态、容量或确认邮箱。"],
  account_not_found: ["account.request.failed", "找不到这个 Hifabu 账号。"],
  relay_requested: ["relay.grant.requested", "已记录传片申请。"],
  relay_grant_updated: ["relay.grant.updated", "已更新传片设置。"],
  relay_usage_unavailable: ["relay.usage.failed", "暂时查不到传片用量，请稍后刷新。"],
  delete_confirmation_invalid: ["account.delete.failed", "请输入此账号的完整邮箱以确认删除。"],
  account_delete_in_progress: ["account.delete.busy", "这个账号正在删除，请稍后重试。"],
  account_relay_busy: ["account.delete.failed", "这个账号正在传片，请稍后重试删除。"],
  account_relay_unavailable: ["account.delete.failed", "传片服务未确认删除，账号已保留。请检查服务后重试。"],
  account_deleted: ["account.deleted", "已删除 Hifabu 账号及其传片目录。"],
  internal_error: ["request.failed", "Hifabu 账号服务暂时无法处理请求，请重试。"],
});
const successfulEvents = new Set([
  "login.started", "login.succeeded", "logout.succeeded", "device.link.started", "device.link.allowed", "device.revoked",
  "relay.grant.requested", "relay.grant.updated", "account.deleted",
]);

const dateStamp = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

export const activityMessage = (code) =>
  (Object.hasOwn(entries, code) ? entries[code] : entries.internal_error)[1];

export function createActivityLog({ directory, retentionDays = 30, clock = Date.now }) {
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 30) {
    throw new Error("Hifabu 日志保留期必须在 0 到 30 天之间。");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let timer;

  function prune(now) {
    const cutoff = dateStamp(now - (retentionDays - 1) * dayMs);
    for (const name of readdirSync(directory)) {
      if (/^activity-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) && (!retentionDays || name.slice(9, 19) < cutoff)) {
        unlinkSync(join(directory, name));
      }
    }
  }

  let prunedOn;
  function pruneToday(now) {
    prune(now);
    prunedOn = dateStamp(now);
  }

  function schedulePrune() {
    const now = clock();
    timer = setTimeout(() => {
      try {
        pruneToday(clock());
      } catch {
        console.error("Hifabu 日志清理失败，请检查日志目录。");
      }
      schedulePrune();
    }, dayMs - now % dayMs).unref();
  }

  pruneToday(clock());
  schedulePrune();

  return {
    record(code) {
      if (!retentionDays) return;
      const key = Object.hasOwn(entries, code) ? code : "internal_error";
      const [event, message] = entries[key];
      const now = clock();
      const date = dateStamp(now);
      try {
        if (date !== prunedOn) pruneToday(now);
        const entry = { at: new Date(now).toISOString(), event, message };
        if (!successfulEvents.has(event)) entry.error_code = key;
        appendFileSync(join(directory, `activity-${date}.ndjson`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      } catch {
        console.error("Hifabu 日志写入失败，请检查日志目录。");
      }
    },
    close() {
      clearTimeout(timer);
    },
  };
}
