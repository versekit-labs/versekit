import { extname, resolve } from "node:path";

// 作品清单和文案规则。完整版和制作机都在读取素材或写入之前运行这些校验。
const invalidPlan = (message) => { throw new Error(message); };

export const requireString = (value, field, { max = 500 } = {}) => {
  if (typeof value !== "string" || !value.trim()) invalidPlan(`${field} 不能为空`);
  if (value.length > max) invalidPlan(`${field} 太长（最多 ${max} 字）`);
  return value.trim();
};

/**
 * 清单的校验与规整：只看清单本身，不碰库、不看文件在不在。work.add 入库前用它，
 * 制作机 `vk work push` 上传前也用它——同一套规则，不合格当场报错。
 */
export function checkWorkPlan({ title, source = null, cuts }, { onCopyViolation, deliveryV1 = false } = {}) {
  const t = requireString(title, "作品标题", { max: 200 });
  if (!Array.isArray(cuts) || !cuts.length) invalidPlan("至少要有一支成片");
  const seenCuts = new Set();
  const plan = cuts.map((c, i) => {
    const cutTitle = requireString(c?.title ?? (cuts.length === 1 ? t : ""), `第 ${i + 1} 支成片的标题`, { max: 200 });
    if (seenCuts.has(cutTitle)) invalidPlan(`成片标题重复：${cutTitle}（同一个作品里成片标题不能重名）`);
    seenCuts.add(cutTitle);
    const versions = Array.isArray(c?.versions) ? c.versions : [];
    if (!versions.length) invalidPlan(`成片「${cutTitle}」至少要有一个语言版本`);
    const seenLang = new Set();
    const cutCopy = normaliseCopy(c?.copy, "成片「" + cutTitle + "」的文案", onCopyViolation && ((violation) => onCopyViolation({ ...violation, cut: cutTitle })), { deliveryV1 });
    return {
      title: cutTitle,
      versions: versions.map((v) => {
        const language = requireString(v?.language ?? "", `成片「${cutTitle}」的语言`, { max: 32 });
        if (seenLang.has(language)) invalidPlan(`成片「${cutTitle}」的语言重复：${language}`);
        seenLang.add(language);
        const where = `成片「${cutTitle}」${language} 版本`;
        const copy = mergeCopy(cutCopy, normaliseCopy(v?.copy, `${where}的文案`, onCopyViolation && ((violation) => onCopyViolation({ ...violation, cut: cutTitle, language })), { deliveryV1 }));
        const cover = normaliseCover(v, c, where);
        const meta0 = copy ? { ...(v?.meta ?? {}), copy } : v?.meta ?? null;
        const meta = cover ? { ...(meta0 ?? {}), cover } : meta0;
        return { language, asset: requireString(v?.asset ?? "", `${where}的素材路径`, { max: 4096 }), meta };
      }),
    };
  });
  const src = source == null ? plan[0].versions[0].asset : requireString(source, "来源", { max: 4096 });
  const sourceKey = resolve(src);
  return { t, plan, sourceKey };
}

const COVER_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/** 清单里的 cover：图片路径（成片级打底、版本级覆盖）。没写是 null，写了就必须是图片。 */
function normaliseCover(v, c, where) {
  const raw = v?.cover ?? c?.cover;
  if (raw == null || raw === "") return null;
  const path = requireString(raw, `${where}的封面路径`, { max: 4096 });
  if (!COVER_EXTS.has(extname(path).toLowerCase())) invalidPlan(`${where}的封面要是图片（jpg / png / webp / gif）：${path}`);
  return path;
}

// ------------------------------------------------------------------ 平台文案（ACC-v2-copy-01）
//
// 各平台的标题、正文、话题在入库时由 Claude 写好、随清单交来；versekit 不接 LLM。
// 限制只在这张表里写一次：入库、生成平台稿、`vk doctor` 都读它。超限一律拒绝并指出平台与字段，
// 不悄悄截断。长度按字符（码点）算。
//   title / body / tags:{max,each}  分开计
//   combined                        标题 + 正文 + 话题（带 #）合计
//   verified:false                  查不到官方数字：不校验，只在 `vk doctor` 里列出
export const COPY_LIMITS = Object.freeze({
  bilibili: { label: "B站", title: 80, body: 2000, tags: { max: 10, each: 20 } },
  xiaohongshu: { label: "小红书", title: 20, body: 1000, tags: { max: 10 } },
  douyin: { label: "抖音", combined: 1000 },
  tiktok: { label: "TikTok", combined: 2200 },
  youtube: { label: "YouTube", title: 100, body: 5000 },
});

const COPY_ALIASES = { "tiktok-api": "tiktok", xhs: "xiaohongshu", bili: "bilibili" };
export const copyPlatformOf = (platform) => COPY_ALIASES[String(platform)] ?? String(platform);

/** 表里标了「未核实」的平台（不校验）。 */
export const unverifiedCopyPlatforms = () => Object.entries(COPY_LIMITS).filter(([, l]) => l.verified === false).map(([k]) => k);

const chars = (text) => [...String(text ?? "")].length;
const tagText = (tags) => (tags ?? []).map((t) => `#${t}`).join(" ");

/** 一份文案的结构校验与整理：{ title?, body?, tags? }。空的字段不保留。 */
function normaliseEntry(raw, where) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidPlan(`${where}：文案必须是 { title, body, tags } 对象`);
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!["title", "body", "tags"].includes(key)) invalidPlan(`${where}：文案里没有「${key}」这个字段（只有 title / body / tags）`);
  }
  for (const key of ["title", "body"]) {
    if (raw[key] == null) continue;
    if (typeof raw[key] !== "string") invalidPlan(`${where}：${key} 必须是字符串`);
    if (raw[key].trim()) out[key] = raw[key].trim();
  }
  if (raw.tags != null) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string")) invalidPlan(`${where}：tags 必须是字符串数组（不带 #）`);
    const tags = raw.tags.map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
    if (tags.length) out.tags = tags;
  }
  return out;
}

/** 这份文案放进某平台超限吗？返回人话数组（空 = 合规）。未核实的平台不校验。 */
export function copyViolations(platform, copy) {
  const limit = COPY_LIMITS[copyPlatformOf(platform)];
  if (!limit || limit.verified === false) return [];
  const bad = [];
  const { title = "", body = "", tags = [] } = copy ?? {};
  if (limit.title != null && chars(title) > limit.title) bad.push(`${limit.label} 标题最多 ${limit.title} 字，现在是 ${chars(title)} 字`);
  if (limit.body != null && chars(body) > limit.body) bad.push(`${limit.label} 正文最多 ${limit.body} 字，现在是 ${chars(body)} 字`);
  if (limit.tags?.max != null && tags.length > limit.tags.max) bad.push(`${limit.label} 话题最多 ${limit.tags.max} 个，现在是 ${tags.length} 个`);
  if (limit.tags?.each != null) {
    const long = tags.filter((t) => chars(t) > limit.tags.each);
    if (long.length) bad.push(`${limit.label} 每个话题最多 ${limit.tags.each} 字，超限的有：${long.join("、")}`);
  }
  if (limit.combined != null) {
    const total = chars([title, body, tagText(tags)].filter(Boolean).join("\n"));
    if (total > limit.combined) bad.push(`${limit.label} 文案（标题、正文、话题合计）最多 ${limit.combined} 字，现在是 ${total} 字`);
  }
  return bad;
}

/**
 * 清单里的 `copy` → { default?: {...}, <platform>: {...} }。
 * 写法二选一或并用：`{ title, body, tags }` 是不分平台的默认文案；`{ bilibili: {...}, xiaohongshu: {...} }`
 * 是按平台写；也可以显式写 `default`。平台名写错（表里没有）直接拒绝，免得文案悄悄落空。
 * 平台文案在这里就按平台限制校验；默认文案要到生成平台稿、知道发哪个平台时才能判（plan.apply）。
 */
export function normaliseCopy(raw, where, onViolation, { deliveryV1 = false } = {}) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) invalidPlan(`${where}：copy 必须是对象`);
  const out = {};
  const direct = {};
  for (const [key, value] of Object.entries(raw)) {
    if (["title", "body", "tags"].includes(key)) direct[key] = value;
    else if (key === "default") out.default = normaliseEntry(value, `${where} 的默认文案`);
    else {
      const platform = copyPlatformOf(key);
      if (deliveryV1 && platform === "shipinhao") {
        out[platform] = normaliseEntry(value, where + " 的视频号文案");
        continue;
      }
      if (!COPY_LIMITS[platform]) invalidPlan(`${where}：不认识的平台「${key}」（可选：${Object.keys(COPY_LIMITS).join(" / ")}；不分平台的默认文案直接写 title / body / tags）`);
      const entry = normaliseEntry(value, `${where} 的 ${COPY_LIMITS[platform].label} 文案`);
      const bad = copyViolations(platform, entry);
      if (bad.length) {
        if (!onViolation) invalidPlan(`${where}：${bad.join("；")}（超限不会自动截断，请改短后重新入库）`);
        onViolation({ platform, reason: bad.join("；") });
      }
      out[platform] = entry;
    }
  }
  if (Object.keys(direct).length) out.default = { ...normaliseEntry(direct, `${where} 的默认文案`), ...(out.default ?? {}) };
  return Object.keys(out).length ? out : null;
}

/** 成片级文案打底、语言版本级文案按平台覆盖。 */
const mergeCopy = (base, over) => {
  if (!base) return over ?? null;
  if (!over) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = { ...(base[k] ?? {}), ...v };
  return out;
};

/** 这个平台、这份文案表里该用哪一条：逐字段，平台专属盖住默认。 */
export const copyFor = (copy, platform) => ({ ...(copy?.default ?? {}), ...(copy?.[copyPlatformOf(platform)] ?? {}) });
