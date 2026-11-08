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
