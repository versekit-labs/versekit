// 小红书适配器：没有面向创作者的发布 API，所以在账号自己的 Chrome 里驱动
// creator.xiaohongshu.com：上传视频 → 填标题/正文 → 话题 → 发布；采集走数据看板接口。
//
// ported from trustbridge/videos/factory/publishers/xiaohongshu.mjs（生产验证过的 254 行）。
// 按 ADR-0001 只搬流程与踩坑知识，契约与数据来源重写：账号、封面、文案、期号全部剥掉，
// 标题/正文/话题来自 work.meta；适配器不写库。
//
// 这个平台最脆的三处（保留原因）：
//   1. 正文编辑器是 tiptap，必须确认焦点在 .tiptap 上，否则标题会填进正文；
//   2. 话题必须从编辑器的「话题面板」选，纯文本 #tag 不会变成可点话题；
//   3. 发布按钮是 <xhs-publish-btn> 的 closed shadow root，页面 JS 看不见，要走 CDP 穿透点击。

import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { open } from "../../core/src/index.mjs";
import { AdapterError } from "../../core/src/errors.mjs";
import { assetSetOf } from "../../core/src/asset-kind.mjs";
import { planImageNote, publishImageNote } from "./image-note.mjs";
import { openAccount, closeAccount, hasLiveBrowser, browserReady, evidencePath, sleep } from "../../driver-browser/src/index.mjs";

const CREATE = "https://creator.xiaohongshu.com/publish/publish?source=official";
const LOGIN = "https://creator.xiaohongshu.com/login";
const DATA = "https://creator.xiaohongshu.com/statistics/data-analysis";
const API = "/api/galaxy/creator/datacenter/note";
const CHECK_URL = "https://creator.xiaohongshu.com/publish/publish";
const LOGIN_DETAIL = "小红书未登录：在账号自己的 Chrome 里打开创作服务平台，用手机号收验证码登录一次，然后重试";
const MAX_TITLE = 20;
const MAX_BODY = 1000;
const MAX_TAGS = 10;

function load(publishId) {
  const row = open()
    .prepare(
      `SELECT p.*, a.platform, a.handle, a.id AS account_id,
              w.title AS work_title, w.asset_path, w.meta_json
         FROM publish p
         JOIN account a ON a.id = p.account_id
         JOIN work w ON w.id = p.work_id
        WHERE p.id = ?`,
    )
    .get(publishId);
  if (!row) throw new AdapterError("unknown", `找不到发布：${publishId}`);
  if (row.platform !== "xiaohongshu") throw new AdapterError("unknown", `账号 ${row.account_id} 不是小红书`);
  return row;
}

const requireId = (publishId) => {
  if (typeof publishId !== "string" || !publishId.trim()) throw new AdapterError("unknown", "publishId 必须是非空字符串");
  return publishId;
};

const text = (v) => (v == null ? "" : String(v).trim());

function metaOf(row) {
  if (!row.meta_json) return {};
  try {
    const parsed = JSON.parse(row.meta_json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 标题/正文/话题的纯逻辑：超限就明确失败，不做静默截断。 */
export function planNote(row) {
  const meta = metaOf(row);
  const title = text(meta.title ?? row.work_title);
  const body = text(meta.body) || title;
  const tags = Array.isArray(meta.tags) ? meta.tags.map(text).filter(Boolean) : [];

  if (!title) throw new AdapterError("asset_invalid", "小红书标题为空");
  if ([...title].length > MAX_TITLE) {
    throw new AdapterError("asset_invalid", `小红书标题超过 ${MAX_TITLE} 字（现在是 ${[...title].length} 字）：用 --title 指定更短的标题`);
  }
  if (body.length > MAX_BODY) throw new AdapterError("asset_invalid", `小红书正文超过 ${MAX_BODY} 字（现在是 ${body.length} 字）`);
  if (tags.length > MAX_TAGS) throw new AdapterError("asset_invalid", `小红书话题最多 ${MAX_TAGS} 个`);
  return { title, body, tags };
}

const at = (tab, find) =>
  tab.eval(`(() => {
    const e = (${find})(document);
    if (!e) return null;
    e.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  })()`);

async function clickOn(tab, find, what) {
  const p = await at(tab, find);
  if (!p) throw new AdapterError("flaky_ui", `小红书发表页上找不到「${what}」，页面可能改版了`);
  await tab.click(p);
  await sleep(600);
}

/** 通过编辑器的话题面板加一个真话题；面板里没有就跳过并记录。 */
async function addTag(tab, tag, missed) {
  const chips = `(() => {
    const ed = [...document.querySelectorAll('div.tiptap')].find((e) => e.offsetParent);
    return ed ? [...ed.querySelectorAll('a.tiptap-topic')].filter((a) => a.innerText.includes(${JSON.stringify(tag)})).length : 0;
  })()`;
  const before = await tab.eval(chips);
  await tab.eval(`(() => { const ed = [...document.querySelectorAll('div.tiptap')].find((e) => e.offsetParent); if (ed && document.activeElement !== ed) ed.focus(); })()`);
  await tab.type("#");
  const opened = await tab.waitFor(`!!document.querySelector('#creator-editor-topic-container')`, [], { timeout: 5e3, every: 200, what: "话题面板" }).catch(() => null);
  const erase = async (n) => {
    for (let i = 0; i < n; i++) await tab.key("Backspace", "Backspace", 8);
  };
  if (!opened) {
    await erase(1);
    missed.push(tag);
    return;
  }
  await tab.type(tag);
  const row = await tab
    .waitFor(
      `(() => {
        const hit = [...document.querySelectorAll('#creator-editor-topic-container .item')]
          .find((r) => r.querySelector('.name')?.innerText.trim() === ${JSON.stringify(`#${tag}`)});
        if (!hit) return '';
        hit.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        const r = hit.getBoundingClientRect();
        return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
      })()`,
      [],
      { timeout: 5e3, every: 200, what: "话题结果" },
    )
    .catch(() => null);
  if (!row) {
    await erase([...tag].length + 1);
    missed.push(tag);
    return;
  }
  await tab.click(JSON.parse(row));
  await sleep(500);
  if ((await tab.eval(chips)) <= before) missed.push(tag);
}

async function capture(tab, accountId, tag) {
  if (!tab) return null;
  try {
    const file = evidencePath(accountId, `xiaohongshu-${tag}`);
    writeFileSync(file, await tab.screenshot());
    return file;
  } catch {
    return null;
  }
}

function wrap(tab, accountId, tag) {
  return async (err) => {
    const shot = await capture(tab, accountId, tag);
    const e = err instanceof AdapterError ? err : new AdapterError("flaky_ui", err.message);
    if (shot && !e.evidence) e.evidence = shot;
    if (shot) e.message += `\n页面截图：${shot}`;
    return e;
  };
}

/** 标题/正文的编辑器动作由视频与图文两条路径共用，避免「话题面板」「tiptap 焦点」两套实现。 */
async function fillTitle(tab, title) {
  await clickOn(tab, `(R) => R.querySelector('input[placeholder*="标题"]')`, "标题");
  if (!(await tab.eval(`document.activeElement === document.querySelector('input[placeholder*="标题"]')`))) {
    await tab.eval(`document.querySelector('input[placeholder*="标题"]').focus()`);
  }
  await tab.type(title);
  if ((await tab.eval(`document.querySelector('input[placeholder*="标题"]')?.value`)) !== title) {
    throw new AdapterError("flaky_ui", "小红书标题没有填进输入框");
  }
}

async function fillBody(tab, body) {
  await clickOn(tab, `(R) => R.querySelector('div[contenteditable="true"]') || R.querySelector('textarea[placeholder*="正文"]')`, "正文");
  if (!(await tab.eval(`document.activeElement?.classList?.contains('tiptap')`))) {
    await tab.eval(`document.querySelector('div.tiptap')?.focus()`);
  }
  const lines = body.split("\n");
  for (const [i, line] of lines.entries()) {
    await tab.type(line);
    if (i < lines.length - 1) await tab.key("Enter", "Enter", 13);
  }
}

async function publish({ publishId, dryRun = false, signal, onStep } = {}) {
  requireId(publishId);
  let tab = null;
  let accountId = null;
  let aborted = false;
  // 内核到总时限会 abort（ACC-publish-05）。适配器这边只做一件事：把为这个账号打开的
  // 浏览器关掉——否则「超时」只是数据库里的一行，Chrome 还停在半截的上传页。
  const onAbort = () => {
    aborted = true;
    if (accountId) closeAccount(accountId).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const step = (label) => {
    try {
      onStep?.(label);
    } catch {
      // 进度回调坏了不能影响发布本身；超时文案退化成「还没进入具体步骤」。
    }
  };
  try {
    const row = load(publishId);
    accountId = row.account_id;
    const note = planNote(row);
    const asset = text(row.asset_path);
    if (!existsSync(asset)) throw new AdapterError("asset_invalid", `找不到素材：${asset}`);

    // 能力声明的本地兜底：内核已在创建前拦过（ACC-publish-04 / ACC-publish-06），但库里可能
    // 还有旧行，或者有人直接调适配器。视频是「一个文件」，图文是「一个目录里的 1–18 张图片」；
    // 混装目录绝不能被当成视频硬传——那正是「发布无声卡死」的起点。
    const set = assetSetOf(asset);
    if (!set.files.length) throw new AdapterError("asset_invalid", `找不到素材文件：${asset}`);
    if (set.mixed) {
      throw new AdapterError(
        "asset_invalid",
        `同一个作品不能把图片和视频混在一起：${basename(asset)} 里两种都有。拆成两个作品再发，或只留其中一种`,
      );
    }
    const kind = set.kind;
    if (!kind) {
      throw new AdapterError(
        "asset_invalid",
        `认不出小红书素材类型：${basename(asset)}。发视频给一个视频文件，发图文给一个 1–18 张图片的目录`,
      );
    }
    if (kind === "video" && set.files.length > 1) {
      throw new AdapterError("asset_invalid", `视频作品只能放一个视频文件：${asset} 里有 ${set.files.length} 个文件`);
    }
    // 图文的平台口径（1–18 张、jpg/png/webp、可见性）在打开浏览器之前就判定。
    const imagePlan = kind === "image" ? planImageNote({ asset, files: set.files, visibility: row.visibility ?? "public" }) : null;

    if (dryRun) {
      return {
        dryRun: true,
        target: {
          title: note.title,
          bodyPreview: [...note.body].slice(0, 80).join(""),
          tags: note.tags,
          asset,
          kind,
          ...(imagePlan ? { images: imagePlan.files, imageCount: imagePlan.count, visibility: imagePlan.visibility } : {}),
        },
      };
    }

    step("打开创作服务平台");
    tab = await openAccount({ accountId });
    await tab.goto(CREATE);
    const where = await tab.waitFor(
      `location.pathname.includes('/login') ? 'login' : (document.querySelector('input.upload-input, input[type=file][accept*=mp4], input[type=file]') ? 'form' : '')`,
      [],
      { timeout: 90e3, every: 1000, what: "小红书创作服务平台发表页" },
    );
    if (where === "login") throw new AdapterError("auth", LOGIN_DETAIL);

    if (imagePlan) {
      // 图文路径：切页签、按顺序传图、标题/正文/话题、谁可以看、发布。细节见 image-note.mjs。
      const published = await publishImageNote(tab, { note, plan: imagePlan, step, clickOn, addTag, fillTitle, fillBody });
      return {
        id: note.title,
        url: "https://creator.xiaohongshu.com/new/note-manager",
        visibility: published.visibility,
        state: published.state,
        // private_then_public：「先发仅自己可见，确认后再放公开」是人的决定、系统执行（ARCHITECTURE §4.1）。
        followups: imagePlan.wantsPublicFollowup
          ? [{ kind: "set_visibility_public", hint: "确认图文无误后改成公开（现在仅自己可见）", verify: "visibility" }]
          : [],
        notes: published.missed.length ? `没有话题结果、已跳过：${published.missed.map((t) => `#${t}`).join(" ")}` : null,
      };
    }

    // 页面可能停在「上传图文」；这条是视频，必须先点回「上传视频」再传文件。
    step("切换到上传视频");
    if (!(await tab.eval(`!!document.querySelector('input.upload-input[accept*=mp4], input[type=file][accept*=mp4]')`))) {
      await clickOn(tab, `(R) => [...R.querySelectorAll('*')].filter((e) => e.offsetParent && e.children.length === 0 && e.innerText?.trim() === '上传视频').pop()`, "上传视频");
      await tab.waitFor(`!!document.querySelector('input.upload-input, input[type=file][accept*=mp4]')`, [], { timeout: 30e3, what: "视频上传控件" });
    }

    step("上传视频文件");
    await tab.upload(`document.querySelector('input.upload-input, input[type=file][accept*=mp4]')`, [set.files[0]]);
    step("等待视频上传完成");
    await tab.waitFor(
      `(() => !!document.querySelector('input[placeholder*="标题"]') && !/上传中|处理中|正在上传|\\d+%/.test(document.body.innerText))()`,
      [],
      { timeout: 20 * 60e3, every: 2000, what: "视频上传完成" },
    );
    await sleep(1000);

    step("填写标题");
    await fillTitle(tab, note.title);

    step("填写正文");
    await fillBody(tab, note.body);

    const missed = [];
    if (note.tags.length) {
      step("添加话题");
      await tab.key("Enter", "Enter", 13);
      for (const tag of note.tags) await addTag(tab, tag, missed);
    }

    step("等待发布按钮可用");
    await tab.waitFor(
      `(() => { const b = document.querySelector('xhs-publish-btn'); return b && b.getAttribute('submit-loading') === 'false' && b.getAttribute('submit-disabled') === 'false' ? 'ready' : ''; })()`,
      [],
      { timeout: 20e3, what: "发布按钮可用" },
    );
    step("等待发布成功");
    await tab.clickInShadow("xhs-publish-btn", "发布");
    await tab.waitFor(`location.pathname.includes('/publish/success') || /发布成功/.test(document.body.innerText)`, [], { timeout: 120e3, what: "发布成功" });

    // 视频路径行为不变（流程与超时都和以前一样）；只把返回的 visibility/state 修正成契约值：
    // 旧值是 "公开" 且没有 state，applyPublishResult 会直接打回，等于平台发完了、库里却记失败。
    return {
      id: note.title,
      url: "https://creator.xiaohongshu.com/new/note-manager",
      visibility: "public",
      state: "published",
      followups: [],
      notes: missed.length ? `没有话题结果、已跳过：${missed.map((t) => `#${t}`).join(" ")}` : null,
    };
  } catch (err) {
    throw await wrap(tab, accountId, "publish")(err);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // 超时中止时关掉整个浏览器（不只是 tab）：发布页不会有后台任务在跑；
    // 正常结束时只关自己开的 tab，账号的浏览器留给下一次复用。
    if (aborted) await closeAccount(accountId).catch(() => {});
    else await tab?.close().catch(() => {});
  }
}

async function collect({ publishId } = {}) {
  requireId(publishId);
  let tab = null;
  let accountId = null;
  try {
    const row = load(publishId);
    accountId = row.account_id;
    const title = text(row.work_title);
    tab = await openAccount({ accountId });
    await tab.goto(DATA);
    await tab.waitFor(`typeof window._webmsxyw === "function"`, [], { timeout: 60e3, every: 500, what: "小红书数据看板（是否已登录？）" });

    const get = async (path) => {
      const body = await tab.eval(async (u) => {
        const s = window._webmsxyw(u, undefined);
        const r = await fetch(u, { headers: { "X-s": s["X-s"], "X-t": String(s["X-t"]) } });
        return `${r.status} ${await r.text()}`;
      }, path);
      const [status, ...rest] = body.split(" ");
      if (status !== "200") throw new AdapterError("flaky_ui", `小红书 ${path.split("?")[0]}：HTTP ${status}`);
      const json = JSON.parse(rest.join(" "));
      if (!json?.success) throw new AdapterError("flaky_ui", `小红书 ${path.split("?")[0]}：${String(rest.join(" ")).slice(0, 160)}`);
      return json.data;
    };

    const notes = new Map();
    for (let page = 1; page <= 20; page++) {
      const list = (await get(`${API}/analyze/list?type=0&page_size=10&page_num=${page}`)).note_infos ?? [];
      for (const n of list) notes.set(n.title.trim(), n);
      if (list.length < 10) break;
    }
    const n = notes.get(title);
    if (!n) throw new AdapterError("unknown", `小红书数据看板里没有标题为「${title}」的笔记（刚发布可能还没出数据）`);
    const d = await get(`${API}/base?note_id=${n.id}`);
    const pct = (v) => Math.round(v * 10) / 1000;
    return {
      播放: n.read_count,
      点赞: n.like_count,
      评论: n.comment_count,
      分享: n.share_count,
      收藏: n.fav_count,
      涨粉: n.increase_fans_count,
      曝光: n.imp_count,
      封面点击率: n.coverClickRate,
      人均观看秒: n.view_time_avg,
      "2秒退出率": pct(d.exit_view2s_rate),
      "5秒完播率": pct(d.finish5s_rate),
      完播率: pct(d.full_view_rate),
    };
  } catch (err) {
    throw await wrap(tab, accountId, "collect")(err);
  } finally {
    await tab?.close().catch(() => {});
  }
}

/**
 * 登录态判定：**看站点把不把你踢回登录页**，不看某个具体 DOM。
 *
 * 上一版要求页面上存在 input/textarea/.tiptap 才算登录；实测登录成功后落在
 * `/new/home`，这一页是懒加载的 SPA，无头浏览器里 DOM 可能一直不出现，于是
 * 「明明登录了」被判定成过期。
 *
 * 现在两个证据，任一成立即为已登录：
 *   1. 访问需要登录的发布页后，URL 仍是 creator 域且不在 /login；
 *   2. cookie 里存在会话类 cookie（web_session / access-token / customer-session）。
 * 只有「被重定向到 /login 且没有会话 cookie」才判定过期——这是站点自己的说法。
 */
async function check(ctx = {}) {
  const accountId = ctx?.accountId;
  if (typeof accountId !== "string" || !accountId.trim()) throw new AdapterError("unknown", "check 需要 accountId");
  let tab = null;
  // 用户可能正开着登录窗口：这时候既不能关它，也不能把它的页面跳走。
  const reusedVisible = hasLiveBrowser(accountId);
  try {
    tab = await openAccount({ accountId, headless: true });
    // 有活窗口时 openAccount 会**新开一个空白标签**（不碰用户正在登录的那一页），
    // 所以这里导航的是我们自己这个标签；cookie 跟着 profile 走，结论同样有效。
    await tab.goto(CHECK_URL, { waitUntil: "domcontentloaded" });

    // 给 SPA 一次客户端跳转的机会：未登录时它会把自己送到 /login。
    await tab
      .waitFor(`location.pathname.includes('/login') || /\/publish|\/new\//.test(location.pathname)`, [], {
        timeout: 20e3,
        every: 300,
        what: "小红书发布页落点",
      })
      .catch(() => {});

    const here = (await tab.url().catch(() => "")) || "";
    const onLogin = /\/login/.test(here);

    const cookies = await tab.cookies("https://creator.xiaohongshu.com").catch(() => []);
    const sessionCookie = cookies.some((c) =>
      ["web_session", "access-token", "customer-session", "customerClientId"].includes(c.name) && c.value,
    );

    if (!onLogin && /creator\.xiaohongshu\.com/.test(here)) return { state: "ok" };
    if (onLogin && sessionCookie) return { state: "ok" }; // 会话 cookie 在手，登录页只是引导
    if (onLogin) return { state: "expired", detail: LOGIN_DETAIL };

    // 落在别处（网络错误 / 风控页）：不冒充成功，也不误判过期。
    throw new AdapterError("flaky_ui", `小红书登录态无法确认：当前在 ${here || "空白页"}`);
  } catch (err) {
    throw await wrap(tab, accountId, "check")(err);
  } finally {
    // 只清理「自己起的无头实例」：用户正开着登录窗口时，closeAccount 会把人家窗口关掉，
    // 登录直接被打断（这就是之前「登录了仍显示未登录」的真正原因之一）。
    if (!reusedVisible) await closeAccount(accountId).catch(() => {});
  }
}

export default {
  platform: "xiaohongshu",
  capabilities: {
    publish: "web",
    collect: "web",
    draft: false,
    visibility: [],
    requiresQualification: false,
    // 视频 + 图文（ACC-publish-06）：图文用「一个目录」当图集（1–18 张，jpg/png/webp），
    // 目录内按文件名自然排序上传。声明出来，发布台才能在创建前拦住发不了的素材（ACC-publish-04）。
    assetTypes: ["video", "image"],
  },
  ready() {
    const reason = browserReady();
    return reason ? `小红书未配置：${reason}` : null;
  },
  check,
  publish,
  collect,
};
