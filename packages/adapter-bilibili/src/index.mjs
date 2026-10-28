// B站适配器。
//
// 发布走 biliup（社区 CLI，模拟官方投稿客户端接口 + 用户自己的 cookie），所以不需要任何开发者资质；
// 指标走创作中心的稿件列表接口（公开接口对本机海外 IP 返回 412，这是视频工厂踩过的坑）。
//
// 移植自 trustbridge/videos/factory/publishers/bilibili.mjs，但改了两件事：
//   · 账号、分区、素材都从内存数据来，不再写死在代码里
//   · 工厂用一句 `notes` 字符串告诉人"还要去勾 AI 声明 / 传字幕 / 进合集"，
//     这里改成三条 followup：可追踪、可核实、可关闭

import { execFile } from "node:child_process";
import { readFileSync, existsSync, accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { open } from "../../core/src/index.mjs";
import { AdapterError } from "../../core/src/errors.mjs";

const BILIUP = () => process.env.VK_BILIUP_BIN ?? "biliup";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const ARCHIVES = "https://member.bilibili.com/x/web/archives";

/**
 * biliup 在不在。不能只 existsSync("biliup")：那查的是 cwd 下的相对路径，
 * 而用户装在哪都有可能。先看显式配置，再按 PATH 找可执行文件。
 */
function hasBiliup() {
  const configured = process.env.VK_BILIUP_BIN;
  if (configured) return existsSync(configured);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "biliup"), constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** 平台怪癖写在这里，不进业务逻辑：延时发布必须 ≥4 小时，否则立即发。 */
const MIN_SCHEDULE_MS = 4.2 * 3600e3;

function biliup(args, { timeout = 3600e3 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(BILIUP(), args, { timeout, maxBuffer: 64 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}\n${String(stdout ?? "").slice(-800)}${String(stderr ?? "").slice(-800)}`;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

const isAuthError = (err) =>
  /登录|login|cookie|未授权|-101|401|csrf/i.test(err?.message ?? "") || /-101/.test(String(err?.stdout ?? ""));

// ------------------------------------------------------------------ 数据

function load(publishId) {
  const db = open();
  const row = db
    .prepare(
      `SELECT p.*, a.platform, a.handle, a.credential_ref, a.id AS account_id,
              w.title AS work_title, w.asset_path, w.meta_json
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
        WHERE p.id = ?`,
    )
    .get(publishId);
  if (!row) throw new Error(`找不到发布：${publishId}`);
  return { db, row, meta: row.meta_json ? JSON.parse(row.meta_json) : {}, overrides: row.overrides_json ? JSON.parse(row.overrides_json) : {} };
}

function cookiesOf(credentialRef) {
  if (!credentialRef) throw new Error("这个 B站账号没有凭证：先 biliup -u <cookies.json> login，再把路径填进 account.credential_ref");
  if (!existsSync(credentialRef)) throw new Error(`B站登录文件不存在：${credentialRef}（biliup -u ${credentialRef} login，选「浏览器登录」）`);
  const parsed = JSON.parse(readFileSync(credentialRef, "utf8"));
  const list = parsed?.cookie_info?.cookies ?? parsed?.cookies ?? [];
  const pair = (name) => list.find((c) => c.name === name)?.value;
  if (!pair("SESSDATA")) throw new Error(`${credentialRef} 里没有 SESSDATA，登录态无效`);
  return {
    header: list.map((c) => `${c.name}=${c.value}`).join("; "),
    sessdata: pair("SESSDATA"),
    biliJct: pair("bili_jct"),
  };
}

// ------------------------------------------------------------------ 发布

async function publish({ publishId, dryRun = false }) {
  const { row, meta, overrides } = load(publishId);
  const title = String(overrides.title ?? meta.title ?? row.work_title).slice(0, 80);
  const desc = String(overrides.desc ?? meta.description ?? "").slice(0, 2000);
  const tags = (overrides.tags ?? meta.tags ?? []).map((t) => String(t).replace(/[,，]/g, " ").trim().slice(0, 20)).filter(Boolean).slice(0, 10);
  const tid = overrides.tid ?? meta.bilibili?.tid ?? 208; // 知识 · 职业职场
  const cover = overrides.cover ?? meta.bilibili?.cover ?? null;
  const asset = row.asset_path;

  if (!asset || !existsSync(asset)) throw new AdapterError("asset_invalid", `找不到成片：${asset}`);

  const at = row.scheduled_at ? Number(row.scheduled_at) : null;
  const dtime = at && at > Date.now() + MIN_SCHEDULE_MS ? ["--dtime", String(Math.floor(at / 1000))] : [];
  const args = ["upload", asset, "--title", title, "--desc", desc, "--tag", tags.join(","), "--tid", String(tid), "--copyright", "1", ...(cover && existsSync(cover) ? ["--cover", cover] : []), ...dtime];

  if (dryRun) return { dryRun: true, args, title, tags, tid };

  try {
    cookiesOf(row.credential_ref); // 先判登录态，避免传给 biliup 一个坏文件
    await biliup(["-u", row.credential_ref, "renew"]).catch(() => {});
    const out = await biliup(["-u", row.credential_ref, ...args]);
    let bvid = out.match(/BV[0-9A-Za-z]{10}/)?.[0];
    if (!bvid) {
      // 投稿成功但输出里没 BV 号：去稿件列表按标题找一次（工厂同款兜底）
      const list = await biliup(["-u", row.credential_ref, "list"]).catch(() => "");
      bvid = list.split("\n").find((l) => l.includes(title))?.match(/BV[0-9A-Za-z]{10}/)?.[0];
    }
    if (!bvid) throw new AdapterError("unknown", `biliup 投稿完成但没有拿到 BV 号，请在创作中心核对：\n${out.slice(-800)}`);

    const url = `https://www.bilibili.com/video/${bvid}/`;
    // 平台要求人做的事是 followup，不是一句备注：可追踪、可核实、可关闭。
    const followups = [
      { kind: "declare_ai_generated", hint: "创作中心：勾选「AI 生成内容」声明" },
      { kind: "upload_captions", hint: "创作中心：上传字幕文件", verify: "captions" },
      ...(overrides.collection ? [{ kind: "add_to_collection", hint: `创作中心：加入合集「${overrides.collection}」`, verify: "collection" }] : []),
    ];

    return { id: bvid, url, visibility: "public", state: "published", followups };
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    const message = String(err?.message ?? err);
    throw new AdapterError(isAuthError(err) ? "auth" : "unknown", message);
  }
}

// ------------------------------------------------------------------ 指标

function metricsFrom(stat) {
  const m = {};
  if (stat.view != null) m.play = stat.view;
  if (stat.like != null) m.like = stat.like;
  if (stat.favorite != null) m.fav = stat.favorite;
  if (stat.coin != null) m.coin = stat.coin;
  if (stat.share != null) m.share = stat.share;
  if (stat.reply != null) m.comment = stat.reply;
  return m;
}

async function fetchArchives(cookies, { pages = 20 } = {}) {
  const all = new Map();
  for (let pn = 1; pn <= pages; pn++) {
    const res = await fetch(`${ARCHIVES}?status=is_pubing,pubed,not_pubed&pn=${pn}&ps=50`, {
      headers: { "User-Agent": UA, Referer: "https://member.bilibili.com/", Cookie: cookies.header },
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`bilibili archives: ${json.code} ${json.message}`);
    const page = json.data?.arc_audits ?? [];
    for (const a of page) all.set(a.Archive.bvid, a.stat);
    if (page.length < 50) break;
  }
  return all;
}

async function collect({ publishId }) {
  const { row } = load(publishId);
  if (!row.external_id) throw new AdapterError("unknown", "这条发布还没有 B站 BV 号，无法采集");

  let cookies;
  try {
    cookies = cookiesOf(row.credential_ref);
  } catch (err) {
    throw new AdapterError("auth", String(err.message), { cause: err });
  }

  let archives;
  try {
    archives = await fetchArchives(cookies);
  } catch (err) {
    // 页面改版 / 风控 / 登录过期 三者要分开，否则排障只能靠猜
    const auth = isAuthError(err);
    throw new AdapterError(auth ? "auth" : "flaky_ui", String(err.message).slice(0, 300), { cause: err });
  }

  const stat = archives.get(row.external_id);
  if (!stat) throw new AdapterError("unknown", `创作中心稿件列表里找不到 ${row.external_id}`);

  const metrics = metricsFrom(stat);
  return {
    source: "intercept",
    status: metrics.play == null ? "partial" : "ok",
    metrics,
    capturedAt: Date.now(),
  };
}

// ------------------------------------------------------------------ 登录态

/**
 * 主动探测登录态：能读 cookie 文件，且 biliup 愿意用它 refresh。
 * `renew` 会顺带续期，这是我们想要的副作用——每 6 小时一次，登录态不容易放到过期。
 */
async function check({ accountId }) {
  if (!accountId) throw new AdapterError("unknown", "check 需要 accountId");
  const row = open().prepare("SELECT credential_ref FROM account WHERE id = ?").get(accountId);
  if (!row) throw new AdapterError("unknown", `没有这个账号：${accountId}`);
  try {
    cookiesOf(row.credential_ref);
  } catch (err) {
    throw new AdapterError("auth", String(err.message), { cause: err });
  }
  try {
    await biliup(["-u", row.credential_ref, "renew"], { timeout: 60e3 });
  } catch (err) {
    if (isAuthError(err)) throw new AdapterError("auth", `biliup 续期失败：${err.message}`.slice(0, 300), { cause: err });
    throw new AdapterError("flaky_ui", `biliup 调不动：${err.message}`.slice(0, 300), { cause: err });
  }
  return { state: "ok" };
}

// ------------------------------------------------------------------ 契约

export default {
  platform: "bilibili",
  capabilities: {
    publish: "cli", // biliup 是模拟官方客户端的 CLI，按契约归 cli 路线
    collect: "web", // 指标读创作中心接口，不是 biliup
    draft: false, // biliup 没有草稿箱：要么发，要么不发
    requiresQualification: false,
    visibility: [], // 稿件先过审再公开，发布时不能选可见性
    minScheduleLeadMs: MIN_SCHEDULE_MS,
  },
  ready() {
    if (!hasBiliup()) return "B站 未配置：没有安装 biliup（cargo install biliup-cli 或下载 release）";
    return null;
  },
  login: null, // 登录在 biliup CLI 里做（浏览器登录），不需要我们实现
  check,
  publish,
  collect,
};
