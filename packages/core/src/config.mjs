// 配置文件的读写：只存「怎么连」，不存密钥。
//
// 飞书的 app_secret 不落这里，也不落数据库；它通过 stdin 交给 lark-cli，
// 由钥匙串保管。这里只记 profile 名与 app_id，够用来做诊断和展示。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { paths } from "./index.mjs";

export function readConfig() {
  const p = paths();
  if (!existsSync(p.configFile)) return {};
  try {
    return JSON.parse(readFileSync(p.configFile, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(config) {
  const p = paths();
  writeFileSync(p.configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return config;
}

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);

/** 递归合并：channel.feishu 里补一个字段，不能把同级的 app_id 抹掉。 */
function merge(target, patch) {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlain(value) ? merge(isPlain(target?.[key]) ? target[key] : {}, value) : value;
  }
  return out;
}

export function updateConfig(patch) {
  return writeConfig(merge(readConfig(), patch));
}

export const feishuProfileName = () => readConfig().channel?.feishu?.profile ?? "versekit";
export const feishuAppId = () => readConfig().channel?.feishu?.app_id ?? null;

/**
 * 发布总时限（ACC-publish-05）：默认 5 分钟。
 *
 * 优先级：环境变量 `VK_PUBLISH_TIMEOUT_MS` > config.json 的 `publish.timeout_ms` > 默认值。
 * 环境变量优先是为了 CI / 复现时不必改用户配置；配错了（0、负数、NaN）退回默认值，而不是
 * 变成「永远不超时」——一个 0 时限会把所有发布瞬间判死。
 */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 5 * 60e3;

export function publishTimeoutMs() {
  const raw = process.env.VK_PUBLISH_TIMEOUT_MS ?? readConfig().publish?.timeout_ms;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PUBLISH_TIMEOUT_MS;
}
