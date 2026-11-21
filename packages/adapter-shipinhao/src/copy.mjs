// 视频号的文案口径：短标题、描述、平台稿参数。纯函数，不碰浏览器，确认之前就能拦。
//
// ported from trustbridge@1f9c92f videos/factory/publishers/channels.mjs（shortTitle / description 的规则）。
// 只搬规则，来源剥掉了：工厂从 YouTube 的元数据文件和 YouTube 文案推导短标题与描述，这里一律来自平台稿
// （core 解析好的 copy），拼不出合规的就明确失败，不替人改字。

import { AdapterError } from "../../core/src/errors.mjs";

export const MAX_SHORT_TITLE = 16;
export const MAX_DESCRIPTION = 950;
/** 短标题里除字母、数字、空格以外只允许这几个标点。 */
export const ALLOWED_PUNCT = "《》“”：+？%°";
export const DEFAULT_LOCATION = "不显示位置";
export const DEFAULT_AI_MARK = "含AI生成内容";

const chars = (s) => [...String(s ?? "")].length;
const asObject = (json) => {
  if (!json) return {};
  if (typeof json === "object") return json;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const text = (v) => (typeof v === "string" ? v.trim() : "");

/** 短标题：最多 16 字（空格也算），标点只能是白名单里的。不合规就说清楚，不悄悄裁掉。 */
export function checkShortTitle(raw) {
  const t = text(raw).replace(/\s+/g, " ");
  if (!t) throw new AdapterError("asset_invalid", "视频号短标题为空：先在这条平台稿里写一个 16 字以内的短标题");
  const bad = [...new Set([...t].filter((c) => !/[\p{L}\p{N}\s]/u.test(c) && !ALLOWED_PUNCT.includes(c)))];
  if (bad.length) {
    throw new AdapterError("asset_invalid", `视频号短标题「${t}」里有平台不允许的符号：${bad.join(" ")}。标点只能用 ${[...ALLOWED_PUNCT].join(" ")}`);
  }
  if (chars(t) > MAX_SHORT_TITLE) {
    throw new AdapterError("asset_invalid", `视频号短标题「${t}」超过 ${MAX_SHORT_TITLE} 字（空格也算，现在是 ${chars(t)} 字）：改短后再确认`);
  }
  return t;
}

/** 描述：正文（没有就用标题）+ 话题，合计最多 950 字。末尾补一个空格，免得最后一个话题的联想列表吃掉后面的操作。 */
export function checkDescription({ body, title, tags = [] }) {
  const main = text(body) || text(title);
  const topics = (tags ?? []).map((t) => `#${String(t).trim().replace(/^#+/, "")}`).filter((t) => t.length > 1).join(" ");
  const full = [main, topics].filter(Boolean).join("\n\n");
  if (!full) throw new AdapterError("asset_invalid", "视频号描述为空：写一段正文或标题");
  if (chars(full) > MAX_DESCRIPTION) {
    throw new AdapterError("asset_invalid", `视频号描述超过 ${MAX_DESCRIPTION} 字（正文加话题合计 ${chars(full)} 字）：删减后再确认`);
  }
  return full;
}

/**
 * 这条平台稿的视频号参数。存在平台稿 overrides.shipinhao（人在确认时填的），其次作品 / 语言版本
 * meta.shipinhao（入库清单里给的）。写死的「含AI生成内容」「不显示位置」改成了参数的默认值。
 *   shortTitle  短标题；不给就用标题——标题本身合规才行，否则要人写一个
 *   location    位置选项的文案，默认「不显示位置」
 *   aiMark      true = 默认标注「含AI生成内容」；字符串 = 选项文案；false = 不标注
 *   cover34 / cover43  入库清单给的封面（3:4 个人主页、4:3 分享）；不给就用平台默认封面
 */
export function shipinhaoParams(copy) {
  const meta = asObject(copy?.metaJson ?? copy?.meta_json);
  const ov = asObject(copy?.overridesJson ?? copy?.overrides_json);
  const p = { ...asObject(meta.shipinhao), ...asObject(ov.shipinhao) };
  const aiMark = p.aiMark === undefined ? DEFAULT_AI_MARK : p.aiMark === true ? DEFAULT_AI_MARK : typeof p.aiMark === "string" && p.aiMark.trim() ? p.aiMark.trim() : null;
  return {
    shortTitle: text(p.shortTitle) || null,
    location: text(p.location) || DEFAULT_LOCATION,
    aiMark,
    cover34: text(p.cover34) || null,
    cover43: text(p.cover43) || null,
  };
}

/** 一条平台稿「点保存草稿会填成什么」。确认前、dry-run、真发都走它，三处口径一个来源。 */
export function planDraft(copy) {
  const params = shipinhaoParams(copy);
  const title = text(copy?.title);
  const shortTitle = checkShortTitle(params.shortTitle ?? title);
  const description = checkDescription({ body: copy?.body, title, tags: copy?.tags });
  return { shortTitle, description, location: params.location, aiMark: params.aiMark, cover34: params.cover34, cover43: params.cover43 };
}
