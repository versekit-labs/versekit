// 抖音适配器的本机记账：每个账号因风控暂停到几点。
//
// 记账文件放在本机凭证目录（douyin/_state.json，权限 600），经 core 的 paths() 拼路径，
// 适配器不碰数据库（和 YouTube 的配额记账同一套做法）。「一天」按本机时区的自然日，
// 和 core 的 plan-rules 口径一致。账号 id 只是文件里的键，不进文件名。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../../core/src/index.mjs";

const FILE = ["douyin", "_state.json"];

const file = () => join(paths().credentials, ...FILE);

function readAll() {
  const path = file();
  if (!existsSync(path)) return { version: 1, accounts: {} };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && data.accounts ? data : { version: 1, accounts: {} };
  } catch {
    // 记账文件坏了：按「今天没送过、没暂停」处理会放宽上限，所以宁可当空，让人看到上限由 core 的排期再兜一层。
    return { version: 1, accounts: {} };
  }
}

function writeAll(data) {
  const path = file();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 下一个本机零点（暂停到次日用它）。 */
export const nextLocalMidnight = (t = Date.now()) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

const entry = (data, accountId) => data.accounts[accountId] ?? {};

/** 风控暂停：到哪个时刻为止。 */
export function pauseUntil(accountId, until) {
  const data = readAll();
  data.accounts[accountId] = { ...entry(data, accountId), paused_until: until };
  writeAll(data);
  return until;
}

export function pausedUntil(accountId, now = Date.now()) {
  const until = entry(readAll(), accountId).paused_until;
  return until && until > now ? until : null;
}

/** 暂停到期的账号：返回 id 并清掉记录，core 据此把账号放开。 */
export function lapsedPauses(now = Date.now()) {
  const data = readAll();
  const ids = Object.entries(data.accounts)
    .filter(([, e]) => e.paused_until && e.paused_until <= now)
    .map(([id]) => id);
  if (!ids.length) return [];
  for (const id of ids) data.accounts[id] = { ...data.accounts[id], paused_until: null };
  writeAll(data);
  return ids;
}
