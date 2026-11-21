// 从平台稿算出「这条要往抖音草稿箱填什么」：纯函数，不开浏览器、不读库，方便单测。
//
// 限制来源：标题 55 字（docs/design 里抖音卡片的 TITLE_MAX）、标题 + 正文 + 话题合计 1000 字
// （core 的 COPY_LIMITS.douyin）。超限在开浏览器之前就报错，不悄悄截断。

import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { AdapterError } from "../../core/src/errors.mjs";

export const MAX_TITLE_CHARS = 55;
export const MAX_COMBINED_CHARS = 1000;
/** 抖音作品描述里最多挂几个话题；超出的不填，写进 notes，不静默丢。 */
export const MAX_TOPICS = 5;
export const MAX_TOPIC_CHARS = 20;
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".m4v"];
export const COVER_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

const chars = (s) => [...String(s ?? "")].length;
const asText = (v) => (v == null ? "" : String(v).trim());

function parseMeta(metaJson) {
  if (!metaJson) return {};
  if (typeof metaJson === "object") return metaJson;
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 话题：去 #、去空白、去重；超长或超个数的不填，返回 dropped 供 notes 说明。 */
export function normaliseTopics(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,，\s]+/) : [];
  const topics = [];
  const dropped = [];
  for (const item of list) {
    const tag = [...String(item ?? "").replace(/^#+/, "").replace(/[\s#]+/g, "")].join("");
    if (!tag || topics.includes(tag) || dropped.includes(tag)) continue;
    if (chars(tag) > MAX_TOPIC_CHARS || topics.length >= MAX_TOPICS) dropped.push(tag);
    else topics.push(tag);
  }
  return { topics, dropped };
}

/**
 * copy 是 core 按平台稿解析好的 { title, body, tags, metaJson }。
 * 封面来自入库清单写进版本 meta 的 cover（图片路径）；没有就是 null（用平台默认封面）。
 */
export function planDraft(copy) {
  const meta = parseMeta(copy?.metaJson);
  const douyin = meta.douyin && typeof meta.douyin === "object" ? meta.douyin : {};
  const title = asText(copy?.title);
  const body = asText(copy?.body);
  const { topics, dropped } = normaliseTopics(copy?.tags ?? meta.tags ?? []);

  if (!title) throw new AdapterError("asset_invalid", "抖音草稿需要标题，这条平台稿的标题是空的；没有开浏览器");
  if (chars(title) > MAX_TITLE_CHARS) {
    throw new AdapterError("asset_invalid", `抖音标题最多 ${MAX_TITLE_CHARS} 字，现在是 ${chars(title)} 字：改短后重试；没有开浏览器`);
  }
  const combined = chars([title, body, topics.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n"));
  if (combined > MAX_COMBINED_CHARS) {
    throw new AdapterError("asset_invalid", `抖音文案（标题、正文、话题合计）最多 ${MAX_COMBINED_CHARS} 字，现在是 ${combined} 字：改短后重试；没有开浏览器`);
  }

  return { title, body, topics, droppedTopics: dropped, cover: asText(douyin.cover ?? meta.cover) || null };
}

/** 素材文件校验：存在、是文件、扩展名对。返回绝对路径。 */
export function requireMedia(value, what, extensions) {
  const text = asText(value);
  if (!text) throw new AdapterError("asset_invalid", `没有${what}路径`);
  const path = isAbsolute(text) ? text : resolve(text);
  if (!existsSync(path) || !statSync(path).isFile()) throw new AdapterError("asset_invalid", `${what}不存在：${path}`);
  const ext = extname(path).toLowerCase();
  if (!extensions.includes(ext)) throw new AdapterError("asset_invalid", `${what}格式不对（${ext || "没有扩展名"}），抖音收 ${extensions.join(" / ")}：${path}`);
  return path;
}

/** 清掉空白方便回读比较（页面会折行、会把空格换成不间断空格）。 */
export const compact = (text) => String(text ?? "").replace(/[\s ]+/g, " ").trim();

/** 去掉全部空白再比较：富文本编辑器怎么折行、怎么渲染空格，不该让回读误报。 */
export const squash = (text) => String(text ?? "").replace(/[\s\u00a0]+/g, "");

/** 回读标题前缀：取前 N 个字做草稿箱里的匹配键（列表会把长标题截断显示）。 */
export const TITLE_KEY_CHARS = 20;
export const titleKey = (title) => [...compact(title)].slice(0, TITLE_KEY_CHARS).join("");
