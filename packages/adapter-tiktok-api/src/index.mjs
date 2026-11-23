// TikTok 官方接口适配器（platform = "tiktok-api"）：Login Kit + Content Posting API。
//
// 与 packages/adapter-tiktok（TikTok Studio 浏览器自动化）并列，**按账号二选一**：账号的
// platform 写 tiktok 就走浏览器，写 tiktok-api 就走这里；同一个账号不能同时挂两个后端（core 强制）。
// 对人展示的平台名统一是「TikTok」。
//
// 与应用审核表单里写的流程一致（审核视频要拍的就是这条路径）：
//   · Direct Post：发布前 creator_info/query → video/init（FILE_UPLOAD，分片）→ 轮询 status/fetch。
//     隐私级别只来自 creator_info、没选不能发；评论/合拍/拼接默认全关；AI 生成的作品带 is_aigc；不加水印。
//   · Send to drafts：inbox/video/init（video.upload），视频进 TikTok 收件箱，由人在 App 里编辑发布。
//     状态是 draft_pending（已送到草稿箱），**不算已发布**。
//
// 适配器不写库：只 open() 读行，返回结果或抛带码的 AdapterError；暂停账号、推事件、状态迁移归 core。

import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { extname } from "node:path";
import { open } from "../../core/src/index.mjs";
import { AdapterError } from "../../core/src/errors.mjs";
import { resolvePublishCopy } from "../../core/src/publish-flow.mjs";
import { callApi, fetchWithBackoff, classifyError, PauseError, PAUSE_CODES } from "./api.mjs";
import { connect, ensureAccessToken, fetchProfile, REFRESH_EXPIRING_MS } from "./auth.mjs";
import { mp4DurationSeconds } from "./mp4.mjs";
import { clientCredentials, clearTokens, credentialStatus, saveClientCredentials, MISSING_CLIENT_HINT, PLATFORM } from "./settings.mjs";

export { PAUSE_CODES, PauseError };

export const MAX_CAPTION_CHARS = 2200;
const MIN_CHUNK = 5 * 1024 * 1024;
const DEFAULT_CHUNK = 10 * 1024 * 1024;

/** creator_info 的 privacy_level_options → versekit 的可见性。未知级别按最严的 private 记。 */
export const VISIBILITY_OF = {
  PUBLIC_TO_EVERYONE: "public",
  MUTUAL_FOLLOW_FRIENDS: "friends",
  FOLLOWER_OF_CREATOR: "friends",
  SELF_ONLY: "private",
};

// ------------------------------------------------------------------ 纯逻辑（可单测）

const asObject = (v) => {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
};

/** 这条平台稿在确认时填的参数（存在 overrides 里）；默认值就是审核口径：评论/合拍/拼接全关，隐私不预选。 */
export function postSettings(row) {
  const overrides = asObject(row.overrides_json);
  const t = asObject(overrides.tiktok);
  const meta = { ...asObject(row.work_meta), ...asObject(row.version_meta) };
  // 文案由 core 解析进 meta（标题、正文、话题）；人在确认时填的 caption 优先，否则标题 + 正文 + 话题。
  const written = [meta.title ?? row.work_title, meta.body, Array.isArray(meta.tags) ? meta.tags.map((t) => `#${t}`).join(" ") : ""]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  const caption = [overrides.caption, overrides.title, written].find((x) => typeof x === "string" && x.trim());
  return {
    privacyLevel: typeof t.privacy_level === "string" && t.privacy_level ? t.privacy_level : null,
    allowComment: t.allow_comment === true,
    allowDuet: t.allow_duet === true,
    allowStitch: t.allow_stitch === true,
    caption: String(caption ?? "").trim().slice(0, MAX_CAPTION_CHARS),
    draft: overrides.draft === true || row.mode === "draft",
    aigc: meta.ai_generated === true || overrides.ai_generated === true,
  };
}

/** creator_info 返回体 → 稳定的小对象（CLI 与以后的 Web 都读它）。 */
export function normaliseCreatorInfo(data) {
  return {
    nickname: data.creator_nickname ?? null,
    username: data.creator_username ?? null,
    avatarUrl: data.creator_avatar_url ?? null,
    privacyLevelOptions: Array.isArray(data.privacy_level_options) ? data.privacy_level_options : [],
    commentDisabled: data.comment_disabled === true,
    duetDisabled: data.duet_disabled === true,
    stitchDisabled: data.stitch_disabled === true,
    maxVideoPostDurationSec: Number.isFinite(Number(data.max_video_post_duration_sec)) ? Number(data.max_video_post_duration_sec) : null,
  };
}

/**
 * 发布前对照 creator_info 校验（编排阶段就报错，不要等 TikTok 在处理阶段才拒）。
 * 隐私级别、开关是否允许、时长上限都只认 creator_info，代码里不硬编码任何选项。
 */
export function validateAgainstCreator(settings, creator, { durationSec = null } = {}) {
  const options = creator.privacyLevelOptions;
  if (!settings.privacyLevel) {
    throw new AdapterError(
      "platform_reject",
      `还没选 TikTok 隐私级别，没有发布：先给这条选一个隐私级别（这个账号现在可选：${options.join(" / ") || "无"}）`,
    );
  }
  if (!options.includes(settings.privacyLevel)) {
    throw new AdapterError(
      "platform_reject",
      `隐私级别 ${settings.privacyLevel} 现在不可选（TikTok 返回的可选项：${options.join(" / ") || "无"}）：应用未过审时通常只能「仅自己可见」`,
    );
  }
  for (const [on, disabled, name] of [
    [settings.allowComment, creator.commentDisabled, "评论"],
    [settings.allowDuet, creator.duetDisabled, "合拍"],
    [settings.allowStitch, creator.stitchDisabled, "拼接"],
  ]) {
    if (on && disabled) throw new AdapterError("platform_reject", `你打开了「${name}」，但这个账号在 TikTok 里不允许${name}：关掉它再发`);
  }
  checkDuration(creator, durationSec);
}

export function checkDuration(creator, durationSec) {
  const max = creator.maxVideoPostDurationSec;
  if (durationSec != null && max != null && durationSec > max) {
    throw new AdapterError(
      "asset_invalid",
      `视频 ${Math.ceil(durationSec)} 秒，超过这个账号在 TikTok 允许的最长 ${max} 秒：剪短后再发（没有上传）`,
    );
  }
}

/** 分片方案：< 5MB 一整片；否则每片约 10MB，最后一片吃掉余数（TikTok 要求每片 5–64MB，末片可到 128MB）。 */
export function planChunks(size) {
  const override = Number(process.env.VK_TIKTOK_CHUNK_BYTES);
  const unit = Number.isFinite(override) && override > 0 ? override : DEFAULT_CHUNK;
  if (!(override > 0) && size < MIN_CHUNK) return { chunkSize: size, total: 1 };
  const total = Math.max(1, Math.floor(size / unit));
  return { chunkSize: total === 1 ? size : unit, total };
}

const CONTENT_TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

// ------------------------------------------------------------------ 取数

// 标题、正文、话题、元数据由 core 按平台稿解析后传入（ACC-v2-copy-03），这里不再 JOIN work 表。
function loadRow(publishId, copy = resolvePublishCopy(publishId)) {
  const row = open()
    .prepare(
      `SELECT p.id, p.mode, a.id AS account_id, a.credential_ref
         FROM publish p
         JOIN account a ON a.id = p.account_id
        WHERE p.id = ?`,
    )
    .get(publishId);
  if (!row) throw new AdapterError("unknown", `没有这条发布：${publishId}`);
  return { ...row, overrides_json: copy.overridesJson, work_title: copy.title, work_meta: copy.metaJson, version_meta: null, copy };
}

const credentialRefOf = (accountId) => {
  const row = open().prepare("SELECT credential_ref FROM account WHERE id = ?").get(accountId);
  if (!row) throw new Error(`没有这个账号：${accountId}`);
  return row.credential_ref ?? null;
};

/** creator_info/query：隐私级别、三个开关是否允许、最长时长。发布前、界面展示前都先调它。 */
export async function creatorInfo({ accountId, signal } = {}) {
  const { token } = await ensureAccessToken(credentialRefOf(accountId), { signal });
  return normaliseCreatorInfo(await callApi("/v2/post/publish/creator_info/query/", { token, signal }));
}

// ------------------------------------------------------------------ 发布

const sleepMs = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AdapterError("timeout", "发布已被中止"));
      },
      { once: true },
    );
  });

const pollIntervalMs = () => {
  const n = Number(process.env.VK_TIKTOK_POLL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 3000;
};
const MAX_POLLS = 200;

function readChunk(file, start, length) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

async function uploadChunks({ file, uploadUrl, size, plan, signal, onStep }) {
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "video/mp4";
  for (let i = 0; i < plan.total; i++) {
    const start = i * plan.chunkSize;
    const end = i === plan.total - 1 ? size - 1 : start + plan.chunkSize - 1;
    onStep?.(`上传视频 ${i + 1}/${plan.total}`);
    const body = readChunk(file, start, end - start + 1);
    const res = await fetchWithBackoff(
      uploadUrl,
      { method: "PUT", headers: { "Content-Type": type, "Content-Length": String(body.length), "Content-Range": `bytes ${start}-${end}/${size}` }, body },
      { signal },
    );
    await res.arrayBuffer().catch(() => {});
    if (![200, 201, 206].includes(res.status)) {
      throw classifyError(res.status >= 500 ? "internal_error" : "upload_rejected", `上传第 ${i + 1}/${plan.total} 片时 HTTP ${res.status}`, { status: res.status });
    }
  }
}

/** 轮询 status/fetch 直到终态。draft 的终态是 SEND_TO_USER_INBOX，直发的终态是 PUBLISH_COMPLETE。 */
async function pollStatus({ token, publishId, draft, signal, onStep }) {
  for (let i = 0; i < MAX_POLLS; i++) {
    const data = await callApi("/v2/post/publish/status/fetch/", { token, json: { publish_id: publishId }, signal });
    const status = data.status;
    onStep?.(`TikTok 处理中（${status ?? "?"}）`);
    if (status === "FAILED") throw classifyError(data.fail_reason ?? "unknown_failure", "TikTok 处理视频失败");
    if (draft && status === "SEND_TO_USER_INBOX") return data;
    if (!draft && status === "PUBLISH_COMPLETE") return data;
    await sleepMs(pollIntervalMs(), signal);
  }
  throw new AdapterError("timeout", "等了很久 TikTok 还没处理完：稍后可以在 TikTok 里核对，或重试");
}

async function publish({ publishId, asset, copy: givenCopy = null, dryRun = false, signal, onStep } = {}) {
  // 彩排：契约门禁要求 dry-run 不联网、不改任何东西。
  if (dryRun) return { dryRun: true };

  const row = loadRow(publishId, givenCopy ?? undefined);
  const settings = postSettings(row);
  if (!existsSync(asset)) throw new AdapterError("asset_invalid", `找不到视频文件：${asset}`);
  const size = statSync(asset).size;
  if (!size) throw new AdapterError("asset_invalid", `视频文件是空的：${asset}`);

  onStep?.("检查 TikTok 授权");
  const { token } = await ensureAccessToken(row.credential_ref, { signal });

  let creator = null;
  if (!settings.draft) {
    onStep?.("查询创作者信息");
    creator = normaliseCreatorInfo(await callApi("/v2/post/publish/creator_info/query/", { token, signal }));
    validateAgainstCreator(settings, creator, { durationSec: mp4DurationSeconds(asset) });
  }

  const plan = planChunks(size);
  const sourceInfo = { source: "FILE_UPLOAD", video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.total };
  onStep?.(settings.draft ? "送到 TikTok 草稿箱" : "向 TikTok 发起发布");
  const init = settings.draft
    ? await callApi("/v2/post/publish/inbox/video/init/", { token, json: { source_info: sourceInfo }, signal })
    : await callApi("/v2/post/publish/video/init/", {
        token,
        json: {
          post_info: {
            title: settings.caption,
            privacy_level: settings.privacyLevel,
            disable_comment: !settings.allowComment,
            disable_duet: !settings.allowDuet,
            disable_stitch: !settings.allowStitch,
            // 水印：不加。AI 生成的作品按平台要求打 is_aigc。
            ...(settings.aigc ? { is_aigc: true } : {}),
          },
          source_info: sourceInfo,
        },
        signal,
      });
  if (!init.publish_id || !init.upload_url) {
    throw new AdapterError("unknown", "TikTok 的 init 没有返回 publish_id / upload_url：稍后重试");
  }

  await uploadChunks({ file: asset, uploadUrl: init.upload_url, size, plan, signal, onStep });
  const done = await pollStatus({ token, publishId: init.publish_id, draft: settings.draft, signal, onStep });

  if (settings.draft) {
    return {
      id: init.publish_id,
      url: "https://www.tiktok.com/",
      visibility: "private",
      state: "draft_pending",
      note: "你选了「送到 TikTok 草稿箱」：视频已在 TikTok 收件箱里，请打开 TikTok App 编辑后自己发布（这不是发布失败）",
    };
  }
  const postId = Array.isArray(done.publicaly_available_post_id) ? done.publicaly_available_post_id[0] : done.publicly_available_post_id?.[0];
  return {
    id: String(postId ?? init.publish_id),
    url: postId ? `https://www.tiktok.com/@/video/${postId}` : "https://www.tiktok.com/",
    visibility: VISIBILITY_OF[settings.privacyLevel] ?? "private",
    state: "published",
  };
}

// ------------------------------------------------------------------ 登录态

async function check({ accountId } = {}) {
  const { record } = await ensureAccessToken(credentialRefOf(accountId));
  const refreshExpiresAt = record.refresh_expires_at ?? null;
  if (refreshExpiresAt && refreshExpiresAt - Date.now() < REFRESH_EXPIRING_MS) {
    return { state: "expiring", expiresAt: refreshExpiresAt, detail: "TikTok 授权一周内到期：到期前到系统页重新授权" };
  }
  return { state: "ok", ...(refreshExpiresAt ? { expiresAt: refreshExpiresAt } : {}) };
}

/** 授权：返回头像昵称与 credentialRef，由调用方（CLI handler）经 core 落到账号行。 */
async function connectAccount(args) {
  const result = await connect(args);
  return result;
}

export default {
  platform: PLATFORM,
  capabilities: {
    publish: "api",
    collect: "none", // 数据采集（Display API）等审核通过后另提修订
    draft: true, // inbox/video/init：送到 TikTok 草稿箱
    visibility: [], // 隐私级别在确认时从 creator_info 里选，不在适配器里硬编码
    requiresQualification: true,
    assetTypes: ["video"],
  },
  /** 队列里被暂停的账号不再发（core 的 publish handler 读它）。 */
  respectsPause: true,
  ready() {
    const { clientKey, clientSecret } = clientCredentials();
    return clientKey && clientSecret ? null : `TikTok 官方接口未配置：${MISSING_CLIENT_HINT}`;
  },
  check,
  publish,
  connect: connectAccount,
  /** 退出登录 / 换号：删掉这个账号的授权令牌文件。 */
  logout: ({ credentialRef = null }) => ({ removed: clearTokens(credentialRef) }),
  creatorInfo,
  fetchProfile,
  /** 应用凭证：状态（不含 secret）与保存；core 的 account.credentials 命令只通过它们读写。 */
  credentials: { status: credentialStatus, save: saveClientCredentials },
};
