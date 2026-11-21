// ported from trustbridge@1f9c92f videos/factory/publishers/youtube.mjs
//
// YouTube 官方接口适配器（platform = "youtube"）：Data API v3。
//
// 搬过来的（已验证）：可续传上传、退避重试（api.mjs）、publishAt 预约、「视频已在之后其余步骤尽力而为、不重传」、
// privacyStatus 回读、statistics 回读。
// 剥掉的（工厂里为某个频道写死的）：播放列表名与简介、类目 28、defaultLanguage=en 与只发英文版、
// containsSyntheticMedia=true、话题过滤与 #Shorts、filesOf()/episode/en/tiktok.json 目录约定、
// ~/.config/assurelane 下的凭证文件。这些现在全是**平台稿参数**或来自 core 传入的文案与素材。
// 新做的：网页授权（auth.mjs）、分块续传（工厂是整个文件读进内存）、ready / check / collect / dry-run、配额记账。
//
// 适配器不写库：只 open() 读行，返回结果或抛带码的 AdapterError；暂停账号、推事件、状态迁移归 core。
//
// 平台稿参数（逐条放在平台稿 overrides.youtube，或作品 / 成片 meta.youtube；逐条的优先）：
//   privacy          public | unlisted | private（缺省用平台稿的可见性）
//   category_id      类目 id（缺省 config 的 youtube.default_category_id，再缺省 22）
//   contains_synthetic_media   true | false（缺省不声明；meta.ai_generated 为 true 时按 true）
//   made_for_kids    缺省 false
//   playlist         按名字找已有播放列表（找不到只记 notes，不新建）；playlist_id 直接指定 id
//   captions         { path, language, name } 字幕文件（可选）
// 缩略图用成片版本 meta.cover。默认不加播放列表、不传字幕。

import { closeSync, existsSync, openSync, readSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { open } from "../../core/src/index.mjs";
import { AdapterError } from "../../core/src/errors.mjs";
import { resolvePublishCopy } from "../../core/src/publish-flow.mjs";
import { callApi, classifyError, QuotaExceededError, readJson, requestJson, backoffBaseMs } from "./api.mjs";
import { connect, ensureAccessToken, hasScope } from "./auth.mjs";
import { mp4Info, shortsVerdict } from "./mp4.mjs";
import { proxiedFetch } from "./proxy.mjs";
import * as quota from "./quota.mjs";
import {
  PLATFORM, SCOPE_ANALYTICS, SCOPE_MANAGE, MISSING_CLIENT_HINT, analyticsBase, apiBase, clientCredentials, credentialStatus, defaultCategoryId,
  saveClientCredentials,
} from "./settings.mjs";

export const MAX_TITLE_CHARS = 100;
export const MAX_DESCRIPTION_CHARS = 5000;
/** 离现在不到这么久的「预约」按现在发：YouTube 的 publishAt 要晚于当前时间。 */
export const MIN_SCHEDULE_LEAD_MS = 15 * 60e3;
const DEFAULT_CHUNK = 8 * 1024 * 1024;
const CHUNK_UNIT = 256 * 1024; // 续传协议要求每块（最后一块除外）是 256 KB 的整数倍
const MAX_RESUMES = 8;
const VIDEO_TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".m4v": "video/mp4" };
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** 测试钩子：每次从文件读多少字节（断言「分块读，不整段进内存」）。生产里是空的。 */
export const hooks = { onRead: null };

const VISIBILITY_OF = { public: "public", unlisted: "friends", private: "private" };
const PRIVACIES = Object.keys(VISIBILITY_OF);

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
const chars = (s) => [...String(s ?? "")].length;

/** 分块方案：每块是 256 KB 的整数倍（默认 8 MiB）；不足一块就一整块。 */
export function planChunks(size) {
  const override = Number(process.env.VK_YOUTUBE_CHUNK_BYTES);
  const unit = Number.isFinite(override) && override >= CHUNK_UNIT ? Math.floor(override / CHUNK_UNIT) * CHUNK_UNIT : DEFAULT_CHUNK;
  return { chunkSize: unit, total: Math.max(1, Math.ceil(size / unit)) };
}

/**
 * 这条平台稿要发什么：把 core 解析好的文案、平台稿参数、素材信息合成 videos.insert 的请求体。
 * 纯函数（不联网、不读库）：dry-run 与真发共用它，所以彩排看到的就是真发会提交的。
 */
export function buildRequest({ copy, meta = {}, overrides = {}, visibility = "public", scheduledAt = null, now = Date.now(), shorts = null }) {
  const params = { ...asObject(meta.youtube), ...asObject(overrides.youtube) };
  const title = String(copy.title ?? "").trim();
  if (!title) throw new AdapterError("asset_invalid", "这条平台稿没有标题：YouTube 必须有标题，先补上再发（没有上传）");
  if (chars(title) > MAX_TITLE_CHARS) throw new AdapterError("asset_invalid", `标题 ${chars(title)} 字，YouTube 最多 ${MAX_TITLE_CHARS} 字：改短后再发（没有上传）`);
  const tags = (copy.tags ?? []).map((t) => String(t).replace(/^#+/, "").trim()).filter(Boolean);
  const description = [String(copy.body ?? "").trim(), tags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");
  if (chars(description) > MAX_DESCRIPTION_CHARS) {
    throw new AdapterError("asset_invalid", `简介（正文加话题）${chars(description)} 字，YouTube 最多 ${MAX_DESCRIPTION_CHARS} 字：改短后再发（没有上传）`);
  }

  const wanted = params.privacy ?? visibility;
  const privacy = PRIVACIES.includes(wanted) ? wanted : "private"; // 认不出的可见性按最严的记，宁可私享也不公开
  const scheduled = scheduledAt != null && scheduledAt > now + MIN_SCHEDULE_LEAD_MS;
  // 预约发：先私享上传，带 publishAt，到点由 YouTube 公开；现在发：按平台稿的可见性直接发。
  const status = {
    privacyStatus: scheduled ? "private" : privacy,
    ...(scheduled ? { publishAt: new Date(scheduledAt).toISOString() } : {}),
    selfDeclaredMadeForKids: params.made_for_kids === true,
    embeddable: true,
  };
  const synthetic = typeof params.contains_synthetic_media === "boolean" ? params.contains_synthetic_media : meta.ai_generated === true ? true : null;
  if (synthetic !== null) status.containsSyntheticMedia = synthetic;
  const language = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(copy.language ?? "") ? copy.language : null; // 来自成片的语言版本；default 之类不传
  const snippet = {
    title,
    description,
    ...(tags.length ? { tags } : {}),
    categoryId: String(params.category_id ?? defaultCategoryId()),
    ...(language ? { defaultLanguage: language, defaultAudioLanguage: language } : {}),
  };
  return {
    resource: { snippet, status },
    // 请求里没有的、但真发时要对照的：
    wantedPrivacy: scheduled ? "private" : privacy,
    scheduled,
    publishAt: status.publishAt ?? null,
    shorts,
    steps: {
      thumbnail: typeof meta.cover === "string" && meta.cover ? meta.cover : null,
      captions: params.captions && typeof params.captions === "object" && params.captions.path ? { path: String(params.captions.path), language: params.captions.language ?? language ?? "en", name: params.captions.name ?? "" } : null,
      playlist: params.playlist_id ? { id: String(params.playlist_id) } : params.playlist ? { name: String(params.playlist) } : null,
    },
  };
}

const REJECTION_HUMAN = {
  copyright: "版权问题",
  duplicate: "和已有视频重复",
  inappropriate: "内容不当",
  length: "时长不合规",
  termsOfUse: "违反服务条款",
  trademark: "商标问题",
  uploaderAccountClosed: "上传账号已关闭",
  uploaderAccountSuspended: "上传账号被停用",
  claim: "被版权方认领",
  legal: "法律原因",
};
const ASSET_FAILURES = new Set(["codec", "conversion", "emptyFile", "invalidFile", "tooSmall", "unsupportedCodec"]);

/**
 * 读回的 videos.list 条目 → 结论。视频已经在 YouTube 上了，所以任何不对的地方都**不能**让队列重试
 * （重试 = 再传一遍）：被拒是 platform_reject（转待人处理），文件损坏是 asset_invalid（终态），
 * 可见性被锁是「已发出但打了折」（published_limited，由 core 落库并留事件）。
 */
export function judgeReadback(item, { id, wantedPrivacy, scheduled, publishAt }) {
  const st = item?.status ?? {};
  if (st.uploadStatus === "rejected") {
    const why = REJECTION_HUMAN[st.rejectionReason] ?? st.rejectionReason ?? "未说明原因";
    const err = new AdapterError("platform_reject", `YouTube 拒绝了这条视频（${why}，${st.rejectionReason ?? "rejected"}）：视频 ${id} 已在 YouTube 上被标为「已拒绝」，到 YouTube Studio 查看并处理；没有重传`);
    err.platformCode = `rejected_${st.rejectionReason ?? "unknown"}`;
    throw err;
  }
  if (st.uploadStatus === "failed") {
    const reason = st.failureReason ?? "unknown";
    if (ASSET_FAILURES.has(reason)) throw new AdapterError("asset_invalid", `YouTube 处理不了这个视频文件（${reason}）：换一个文件再发（视频 ${id} 在 YouTube 上是失败状态）`);
    const err = new AdapterError("unknown", `YouTube 处理视频失败（${reason}）：视频 ${id} 在 YouTube 上是失败状态，可以重试（会重新上传）`);
    err.platformCode = `failed_${reason}`;
    throw err;
  }
  const actual = st.privacyStatus ?? "private";
  const forcedPrivate = actual === "private" && wantedPrivacy !== "private";
  // 预约发：请求的就是 private + publishAt；YouTube 把 publishAt 丢了，到点就不会公开。
  const lostSchedule = scheduled && !st.publishAt;
  if (forcedPrivate) {
    return { actual, notice: { code: "visibility_forced_private", message: "YouTube 把这条锁成了私享：接入用的 Google 项目还没过审，需要在 YouTube Studio 里手动改成公开" } };
  }
  if (lostSchedule) {
    return { actual, notice: { code: "visibility_forced_private", message: `YouTube 没有保留预约时间（${publishAt}）：这条现在是私享，到点不会自动公开；接入用的 Google 项目可能还没过审，需要在 YouTube Studio 里手动设置公开` } };
  }
  return { actual, notice: null };
}

// ------------------------------------------------------------------ 取数

// 标题、正文、话题、元数据由 core 按平台稿解析后传入（ACC-v2-copy-03），这里不再 JOIN work 表。
function loadRow(publishId) {
  const row = open()
    .prepare(
      `SELECT p.id, p.mode, p.visibility, p.scheduled_at, p.external_id, p.overrides_json, p.published_at,
              a.id AS account_id, a.credential_ref
         FROM publish p JOIN account a ON a.id = p.account_id
        WHERE p.id = ?`,
    )
    .get(publishId);
  if (!row) throw new AdapterError("unknown", `没有这条发布：${publishId}`);
  return row;
}

const credentialRefOf = (accountId) => {
  const row = open().prepare("SELECT credential_ref FROM account WHERE id = ?").get(accountId);
  if (!row) throw new Error(`没有这个账号：${accountId}`);
  return row.credential_ref ?? null;
};

// ------------------------------------------------------------------ 上传

const sleepMs = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new AdapterError("timeout", "发布已被中止")); }, { once: true });
  });

/** 从文件读一块：只分配这一块的大小，不整段读进内存。 */
function readChunk(file, start, length) {
  hooks.onRead?.(length);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const rangeNext = (res) => {
  const m = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "");
  return m ? Number(m[1]) + 1 : 0; // 没有 Range 头 = 一个字节都还没收到
};

async function startSession({ token, resource, size, type, signal }) {
  const url = `${apiBase()}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`;
  const { res, body } = await requestJson(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(size) },
      body: JSON.stringify(resource),
    },
    { signal },
  );
  if (!res.ok) throw classifyError(res.status, body);
  const location = res.headers.get("location");
  if (!location) throw new AdapterError("unknown", "YouTube 没有返回上传地址（Location）：稍后重试");
  return location;
}

/** 问服务端「已经收到多少」：PUT 空体 + Content-Range: bytes * / 总长。返回 { offset } 或 { video }（已经传完）。 */
async function queryOffset({ session, token, size, signal }) {
  const res = await proxiedFetch(session, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Length": "0", "Content-Range": `bytes */${size}` }, signal });
  if (res.status === 308) {
    await res.arrayBuffer().catch(() => {});
    return { offset: rangeNext(res) };
  }
  const body = await readJson(res);
  if (res.status === 200 || res.status === 201) return { video: body };
  if (res.status === 404) throw new AdapterError("unknown", "YouTube 上传会话已过期：重试会重新开始上传");
  throw classifyError(res.status, body);
}

/**
 * 分块上传：每块 PUT 一次，308 说明收到了、继续下一块；200/201 是最后一块、带视频资源。
 * 连接断了、5xx、429：先问服务端偏移再续传（不从头来），退避重试 MAX_RESUMES 次。
 */
async function uploadChunks({ file, session, token, size, type, plan, signal, onStep }) {
  let offset = 0;
  let fails = 0;
  while (true) {
    const end = Math.min(offset + plan.chunkSize, size) - 1;
    onStep?.(`上传视频 ${Math.min(plan.total, Math.floor(offset / plan.chunkSize) + 1)}/${plan.total}`);
    const body = readChunk(file, offset, end - offset + 1);
    let failure = null;
    try {
      const res = await proxiedFetch(session, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": type, "Content-Length": String(body.length), "Content-Range": `bytes ${offset}-${end}/${size}` },
        body,
        signal,
      });
      if (res.status === 308) {
        await res.arrayBuffer().catch(() => {});
        offset = rangeNext(res);
        continue;
      }
      const json = await readJson(res);
      if (res.status === 200 || res.status === 201) return json;
      if (res.status >= 500 || res.status === 429) failure = new AdapterError("unknown", `上传时 HTTP ${res.status}`);
      else if (res.status === 404) throw new AdapterError("unknown", "YouTube 上传会话已过期：重试会重新开始上传");
      else throw classifyError(res.status, json);
    } catch (err) {
      if (signal?.aborted) throw new AdapterError("timeout", "发布已被中止");
      if (!(err instanceof AdapterError) || !["unknown", "network_unreachable"].includes(err.code) || /会话已过期/.test(err.message)) throw err;
      failure = err;
    }
    if (++fails > MAX_RESUMES) throw failure;
    await sleepMs(backoffBaseMs() * 2 ** Math.min(fails - 1, 4), signal);
    onStep?.("上传中断，向 YouTube 查询已收到的位置后续传");
    // 查偏移本身也可能撞上网络抖动：同样计入重试次数。
    while (true) {
      try {
        const q = await queryOffset({ session, token, size, signal });
        if (q.video) return q.video;
        offset = q.offset;
        break;
      } catch (err) {
        if (signal?.aborted) throw new AdapterError("timeout", "发布已被中止");
        if (!(err instanceof AdapterError) || !["unknown", "network_unreachable"].includes(err.code) || /会话已过期/.test(err.message) || ++fails > MAX_RESUMES) throw err;
        await sleepMs(backoffBaseMs() * 2 ** Math.min(fails - 1, 4), signal);
      }
    }
  }
}

// ------------------------------------------------------------------ 发布

/** 把每日配额用完这类错误补上暂停信息：项目暂停到太平洋时间次日零点，记下是哪个账号撞上的。 */
function withPause(err, { clientId, accountId }) {
  if (!(err instanceof QuotaExceededError)) return err;
  const until = quota.pauseProject(clientId, accountId);
  const e = new QuotaExceededError(`YouTube 今天的接口配额用完了（quotaExceeded）：已停下，不会重试，这个账号暂停到 ${quota.ptLabel(until)}配额重置；到点后到今天页重试`, { code: "quotaExceeded", until, banned: false });
  return e;
}

async function publish({ publishId, asset, copy: givenCopy = null, dryRun = false, preview = null, signal, onStep } = {}) {
  // CLI 的 `vk publish --dry-run` 还没有平台稿（不写任何行）：core 传 preview 和文案，只走到彩排为止。
  if (!publishId && !(dryRun && preview && givenCopy)) throw new AdapterError("unknown", "缺少发布 id");
  const row = publishId
    ? loadRow(publishId)
    : { id: null, mode: "auto", visibility: preview.visibility ?? "public", scheduled_at: preview.scheduledAt ?? null, external_id: null, overrides_json: null, published_at: null, account_id: preview.accountId ?? null, credential_ref: null };
  const copy = givenCopy ?? resolvePublishCopy(publishId);
  const meta = asObject(copy.metaJson);
  const overrides = asObject(row.overrides_json);
  if (!existsSync(asset)) throw new AdapterError("asset_invalid", `找不到视频文件：${asset}`);
  const size = statSync(asset).size;
  if (!size) throw new AdapterError("asset_invalid", `视频文件是空的：${asset}`);
  const type = VIDEO_TYPES[extname(asset).toLowerCase()];
  const info = mp4Info(asset);
  const verdict = shortsVerdict(info);
  const request = buildRequest({ copy, meta, overrides, visibility: row.visibility, scheduledAt: row.scheduled_at, shorts: verdict });
  const plan = planChunks(size);
  const need = quota.estimate({ thumbnail: Boolean(request.steps.thumbnail), captions: Boolean(request.steps.captions), playlist: Boolean(request.steps.playlist) });

  // 彩排：不联网、不改任何东西，只产出「真发会提交什么」。契约门禁要求 dry-run 不联网、不写库。
  if (dryRun) {
    return {
      dryRun: true,
      request: {
        endpoint: "videos.insert（可续传）",
        resource: request.resource,
        file: { path: asset, bytes: size, contentType: type ?? "video/mp4", chunks: plan.total, chunkBytes: plan.chunkSize },
        scheduled: request.scheduled,
        shorts: verdict,
        steps: request.steps,
        estimatedQuota: need,
      },
    };
  }
  if (!type) throw new AdapterError("asset_invalid", `YouTube 不收这种文件（${extname(asset) || "没有扩展名"}）：换成 mp4 / mov / webm 再发`);

  const { clientId } = clientCredentials();
  const guard = (err) => withPause(err, { clientId, accountId: row.account_id });
  const pausedTo = quota.pausedUntil(clientId);
  if (pausedTo) {
    throw new AdapterError("platform_reject", `YouTube 今天的接口配额用完了：这个项目暂停到 ${quota.ptLabel(pausedTo)}配额重置，这条没有发；到点后到今天页重试`);
  }
  const short = quota.shortfall(clientId, need);
  if (short) {
    const err = new AdapterError("platform_reject", short);
    err.platformCode = "quota_estimate_short";
    throw err;
  }

  onStep?.("检查 YouTube 授权");
  const { token, record } = await ensureAccessToken(row.credential_ref, { signal });
  // 回读核实要读视频状态，没有这个权限就别上传：传完才发现读不了，只会留下一个没法核实的视频。
  if (!hasScope(record, SCOPE_MANAGE)) throw new AdapterError("auth", "YouTube 授权里没有「管理账号」权限，没法回读核实：到系统页重新授权，并勾选全部权限（没有上传）");

  let video;
  try {
    onStep?.("向 YouTube 发起上传");
    const session = await startSession({ token, resource: request.resource, size, type, signal });
    quota.spend(clientId, "insert");
    video = await uploadChunks({ file: asset, session, token, size, type, plan, signal, onStep });
  } catch (err) {
    throw guard(err);
  }
  const id = video?.id;
  if (!id) throw new AdapterError("result_unconfirmed", "上传结束了，但 YouTube 没有返回视频 id：到 YouTube Studio 核对有没有这条视频，没有重传");

  // 视频已经在 YouTube 上：从这里起，任何失败都不能让队列重试（重试 = 再传一遍）。
  // 回读：用 videos.list 核实 id、状态和可见性，不信任上传返回；其余步骤尽力而为，失败只记 notes。
  onStep?.("回读核实");
  const item = await readBack({ token, id, signal, clientId, guard });
  const verdictReadback = judgeReadback(item, { id, wantedPrivacy: request.wantedPrivacy, scheduled: request.scheduled, publishAt: request.publishAt });

  const notes = [];
  const tryStep = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      const e = guard(err);
      notes.push(`${name}失败：${String(e.message).slice(0, 200)}`);
    }
  };
  if (request.steps.thumbnail) await tryStep("缩略图", () => setThumbnail({ token, id, file: request.steps.thumbnail, signal, clientId }));
  if (request.steps.captions) await tryStep("字幕", () => addCaptions({ token, id, captions: request.steps.captions, signal, clientId }));
  if (request.steps.playlist) await tryStep("播放列表", () => addToPlaylist({ token, id, playlist: request.steps.playlist, signal, clientId, notes }));
  if (verdict.reason && !verdict.short && info.height && info.width && info.height >= info.width) notes.push(verdict.reason);

  const forced = verdictReadback.notice;
  return {
    id,
    url: verdict.short ? `https://www.youtube.com/shorts/${id}` : `https://youtu.be/${id}`,
    visibility: VISIBILITY_OF[verdictReadback.actual] ?? "private",
    state: forced ? "published_limited" : "published",
    ...(forced
      ? { notice: forced, followups: [{ kind: "set_visibility_public", hint: forced.message }] }
      : {}),
    ...(notes.length ? { notes } : {}),
  };
}

async function readBack({ token, id, signal, clientId, guard }) {
  // 刚上传完偶尔读不到：退避读几次。仍读不到不是「没发」（视频多半在），是「结果待确认」，绝不重传。
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const data = await callApi("/videos", { token, query: { part: "snippet,status", id }, signal });
      quota.spend(clientId, "list");
      const item = data.items?.find((v) => v.id === id);
      if (item) return item;
    } catch (err) {
      const e = guard(err);
      if (["auth", "platform_reject"].includes(e.code) || e.pause) {
        const out = new AdapterError("result_unconfirmed", `视频 ${id} 已上传，但回读核实失败（${String(e.message).slice(0, 160)}）：到 YouTube Studio 核对状态与可见性；没有重传`);
        out.pause = e.pause;
        out.platformCode = e.platformCode;
        throw out;
      }
    }
    await sleepMs(backoffBaseMs() * 2 ** attempt, signal);
  }
  throw new AdapterError("result_unconfirmed", `视频 ${id} 已上传，但回读读不到它：到 YouTube Studio 核对有没有这条视频；没有重传`);
}

async function setThumbnail({ token, id, file, signal, clientId }) {
  if (!existsSync(file)) throw new Error(`找不到封面文件：${file}`);
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type) throw new Error(`封面只收 png / jpg：${file}`);
  const { res, body } = await requestJson(`${apiBase()}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(id)}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": type }, body: readFileSync(file) }, { signal });
  if (!res.ok) throw classifyError(res.status, body);
  quota.spend(clientId, "thumbnail");
}

async function addCaptions({ token, id, captions, signal, clientId }) {
  if (!existsSync(captions.path)) throw new Error(`找不到字幕文件：${captions.path}`);
  const boundary = `vk${Date.now().toString(36)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ snippet: { videoId: id, language: captions.language, name: captions.name } })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    readFileSync(captions.path),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await requestJson(`${apiBase()}/upload/youtube/v3/captions?uploadType=multipart&part=snippet`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body }, { signal });
  if (!r.res.ok) throw classifyError(r.res.status, r.body);
  quota.spend(clientId, "captions");
}

async function addToPlaylist({ token, id, playlist, signal, clientId, notes }) {
  let playlistId = playlist.id;
  if (!playlistId) {
    const lists = await callApi("/playlists", { token, query: { part: "snippet", mine: "true", maxResults: "50" }, signal });
    quota.spend(clientId, "list");
    playlistId = lists.items?.find((p) => p.snippet?.title === playlist.name)?.id;
    // 找不到就不新建：新建的是公开播放列表，不该由发布动作顺手做。只记下来。
    if (!playlistId) {
      notes.push(`没有加入播放列表：你的频道里没有叫「${playlist.name}」的播放列表，先在 YouTube Studio 建好，再手动加入这条视频。`);
      return;
    }
  }
  await callApi("/playlistItems", { method: "POST", token, query: { part: "snippet" }, json: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId: id } } }, signal });
  quota.spend(clientId, "playlistItem");
}

// ------------------------------------------------------------------ 登录态

async function check({ accountId } = {}) {
  const { clientId } = clientCredentials();
  const { token, record } = await ensureAccessToken(credentialRefOf(accountId));
  if (!hasScope(record, SCOPE_MANAGE)) return { state: "expired", detail: "YouTube 授权里缺「管理账号」权限：到系统页重新授权，并勾选全部权限" };
  // 配额用完时不再探测（探测也要花 1 单位）；token 能续期已经说明授权还在。
  if (!quota.pausedUntil(clientId)) {
    await callApi("/channels", { token, query: { part: "id", mine: "true" } }); // 401 → auth，core 据此转「需要重新登录」
    quota.spend(clientId, "list");
  }
  return { state: "ok" };
}

// ------------------------------------------------------------------ 采集

async function collect({ publishId } = {}) {
  const row = loadRow(publishId);
  if (!row.external_id) throw new AdapterError("unknown", "这条还没有 YouTube 视频 id，没法采集");
  const { clientId } = clientCredentials();
  const { token, record } = await ensureAccessToken(row.credential_ref);
  let data;
  try {
    data = await callApi("/videos", { token, query: { part: "statistics", id: row.external_id } });
  } catch (err) {
    throw withPause(err, { clientId, accountId: row.account_id });
  }
  quota.spend(clientId, "list");
  const stats = data.items?.[0]?.statistics;
  if (!stats) throw new AdapterError("unknown", `读不到视频 ${row.external_id} 的数据：它可能被删除，或还是私享；到 YouTube Studio 核对`);
  const metrics = {};
  const put = (key, v) => { if (v != null && Number.isFinite(Number(v))) metrics[key] = Number(v); };
  put("play", stats.viewCount);
  put("like", stats.likeCount);
  put("comment", stats.commentCount);
  put("fav", stats.favoriteCount);
  // 观看时长要 Analytics 权限：授权里没有就不取，也不报错；取失败（权限被收回、接口没开）同样不影响播放等指标。
  if (hasScope(record, SCOPE_ANALYTICS)) {
    try {
      const start = new Date(row.published_at ?? Date.now()).toISOString().slice(0, 10);
      const end = new Date().toISOString().slice(0, 10);
      const rep = await callApi("/v2/reports", {
        base: analyticsBase(),
        token,
        query: { ids: "channel==MINE", startDate: start, endDate: end, metrics: "estimatedMinutesWatched,averageViewDuration", filters: `video==${row.external_id}` },
      });
      const r = rep.rows?.[0];
      if (r) {
        put("watch_minutes", r[0]);
        put("avg_view_seconds", r[1]);
      }
    } catch {
      /* 观看时长是锦上添花 */
    }
  }
  return { source: "api", status: metrics.play == null ? "partial" : "ok", metrics };
}

// ------------------------------------------------------------------ 导出

export default {
  platform: PLATFORM,
  capabilities: {
    publish: "api",
    collect: "api",
    draft: false, // 没有「存草稿箱」：要么按平台稿的可见性发，要么私享 + publishAt
    visibility: ["public", "friends", "private"], // friends = 不公开列出（unlisted）
    requiresQualification: true, // 过 Google API 合规审核前上传会被锁私享，见 ACC-youtube-04
    minScheduleLeadMs: MIN_SCHEDULE_LEAD_MS,
    assetTypes: ["video"],
  },
  /** 暂停中的账号不再发（core 的 publish handler 读它）；暂停原因的人话由 pausedWhy 给。 */
  respectsPause: true,
  /** 声明：publish({ dryRun, preview, copy }) 不需要平台稿也能彩排——core 的 vk publish --dry-run 据此输出「真发会提交什么」。 */
  dryRunPreview: true,
  pausedWhy: "YouTube 今天的接口配额用完了",
  /** 预约发是上传时带 publishAt、由 YouTube 到点公开：core 在确认时就让它上传，而不是等到发布时间才开始传。 */
  nativeSchedule: true,
  /** 配额暂停到期：返回该放开的账号 id（core 把它们的暂停清掉）。 */
  lapsedPauses: () => quota.lapsedPauses(clientCredentials().clientId),
  ready() {
    const { clientId, clientSecret } = clientCredentials();
    return clientId && clientSecret ? null : `YouTube 未配置：${MISSING_CLIENT_HINT}`;
  },
  check,
  publish,
  collect,
  connect,
  /** 应用凭证：状态（不含 secret）与保存；core 的 account.credentials 命令只通过它们读写。 */
  credentials: { status: credentialStatus, save: saveClientCredentials },
};
