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
import { assetKindOf, ASSET_KIND_LABEL } from "../../core/src/asset-kind.mjs";
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

// 发布接口（笔记提交）与笔记管理列表接口。平台改版时只需要改这两个正则。
const PUBLISH_API = /\/web_api\/sns\/v\d+\/note(\?|$)|\/api\/galaxy\/[^?]*note\/(post|publish)/;
const NOTE_LIST_API = /\/api\/galaxy\/[^?]*note\/user\/posted/;
const NOTE_MANAGER = "https://creator.xiaohongshu.com/new/note-manager";

/** 发布接口响应 → 笔记 id；响应不是成功或没有 id 返回 null。 */
export function noteIdFromPublishResponse(body) {
  if (!body || typeof body !== "object") return null;
  if (!(body.success === true || body.code === 0)) return null;
  const d = body.data ?? {};
  const id = d.id ?? d.note_id ?? d.noteId ?? (Array.isArray(d.note_ids) ? d.note_ids[0] : null) ?? d.note?.id;
  return id ? String(id) : null;
}

/** 笔记管理列表里按标题 + 时间找刚发的那条（早于点击时间的同名旧笔记不算）。 */
export function findPostedNote(bodies, title, sinceMs) {
  for (const body of bodies) {
    const notes = body?.data?.notes ?? body?.data?.note_infos ?? [];
    for (const n of notes) {
      if (text(n.display_title ?? n.title) !== title) continue;
      const raw = n.post_time ?? n.time ?? n.create_time ?? n.publish_time;
      if (raw != null) {
        const t = Number(raw);
        const ms = t < 1e12 ? t * 1000 : t;
        if (Number.isFinite(ms) && ms < sinceMs - 5 * 60e3) continue;
      }
      const id = n.id ?? n.note_id;
      if (id) return String(id);
    }
  }
  return null;
}

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

/** 去笔记管理按标题 + 时间核对一次；拿不到（页面/接口异常）当作没核对到，不抛错。 */
async function verifyInNoteManager(tab, title, sinceMs) {
  try {
    const found = await tab.collectJson(NOTE_LIST_API, () => tab.goto(NOTE_MANAGER, { waitUntil: "domcontentloaded" }), {
      timeout: 20e3,
      until: (f) => !!findPostedNote(f.map((x) => x.body), title, sinceMs),
    });
    return findPostedNote(found.map((x) => x.body), title, sinceMs);
  } catch {
    return null;
  }
}

async function publish({ publishId, dryRun = false, signal, onStep } = {}) {
  requireId(publishId);
  let tab = null;
  let accountId = null;
  let aborted = false;
  let clicked = false;
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

    // 能力声明的本地兜底：内核已在创建前拦过一次（ACC-publish-04），但库里可能还有旧行，
    // 或者有人直接调适配器。图片绝不能被当成视频硬传——那正是「发布无声卡死」的起点。
    const kind = assetKindOf(asset);
    if (kind && kind !== "video") {
      throw new AdapterError(
        "asset_invalid",
        `小红书目前只能发${ASSET_KIND_LABEL.video}：${basename(asset)} 是${ASSET_KIND_LABEL[kind]}素材。换成视频，或在发布台取消勾选小红书`,
      );
    }

    if (dryRun) {
      return {
        dryRun: true,
        target: { title: note.title, bodyPreview: [...note.body].slice(0, 80).join(""), tags: note.tags, asset },
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

    // 页面可能停在「上传图文」；这条是视频，必须先点回「上传视频」再传文件。
    step("切换到上传视频");
    if (!(await tab.eval(`!!document.querySelector('input.upload-input[accept*=mp4], input[type=file][accept*=mp4]')`))) {
      await clickOn(tab, `(R) => [...R.querySelectorAll('*')].filter((e) => e.offsetParent && e.children.length === 0 && e.innerText?.trim() === '上传视频').pop()`, "上传视频");
      await tab.waitFor(`!!document.querySelector('input.upload-input, input[type=file][accept*=mp4]')`, [], { timeout: 30e3, what: "视频上传控件" });
    }

    step("上传视频文件");
    await tab.upload(`document.querySelector('input.upload-input, input[type=file][accept*=mp4]')`, [asset]);
    step("等待视频上传完成");
    await tab.waitFor(
      `(() => !!document.querySelector('input[placeholder*="标题"]') && !/上传中|处理中|正在上传|\\d+%/.test(document.body.innerText))()`,
      [],
      { timeout: 20 * 60e3, every: 2000, what: "视频上传完成" },
    );
    await sleep(1000);

    step("填写标题");
    await clickOn(tab, `(R) => R.querySelector('input[placeholder*="标题"]')`, "标题");
    if (!(await tab.eval(`document.activeElement === document.querySelector('input[placeholder*="标题"]')`))) {
      await tab.eval(`document.querySelector('input[placeholder*="标题"]').focus()`);
    }
    await tab.type(note.title);
    if ((await tab.eval(`document.querySelector('input[placeholder*="标题"]')?.value`)) !== note.title) {
      throw new AdapterError("flaky_ui", "小红书标题没有填进输入框");
    }

    step("填写正文");
    await clickOn(tab, `(R) => R.querySelector('div[contenteditable="true"]') || R.querySelector('textarea[placeholder*="正文"]')`, "正文");
    if (!(await tab.eval(`document.activeElement?.classList?.contains('tiptap')`))) {
      await tab.eval(`document.querySelector('div.tiptap')?.focus()`);
    }
    const lines = note.body.split("\n");
    for (const [i, line] of lines.entries()) {
      await tab.type(line);
      if (i < lines.length - 1) await tab.key("Enter", "Enter", 13);
    }

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
    // 点击之后的任何失败都不再是 flaky_ui（可重试 / 转草稿会重复发帖）：见 ACC-publish-09。
    const clickedAt = Date.now();
    clicked = true;
    let noteId = null;
    try {
      let pageOk = false;
      const found = await tab.collectJson(
        PUBLISH_API,
        async () => {
          await tab.clickInShadow("xhs-publish-btn", "发布");
          // 页面信号（URL / 文字）作为补充，后台轮询，接口先到就提前结束。
          (async () => {
            const end = Date.now() + 120e3;
            while (!pageOk && !aborted && Date.now() < end) {
              pageOk = !!(await tab.eval(`location.pathname.includes('/publish/success') || /发布成功/.test(document.body.innerText)`).catch(() => false));
              if (!pageOk) await sleep(1000);
            }
          })();
        },
        { timeout: 120e3, until: (f) => pageOk || f.some((x) => noteIdFromPublishResponse(x.body)) },
      );
      noteId = found.map((x) => noteIdFromPublishResponse(x.body)).find(Boolean) ?? null;
      if (!noteId && !pageOk) {
        step("核对笔记管理");
        noteId = await verifyInNoteManager(tab, note.title, clickedAt);
        if (!noteId) throw new Error("发布接口无成功响应、页面无成功标志、笔记管理里也没查到");
      } else if (!noteId) {
        noteId = await verifyInNoteManager(tab, note.title, clickedAt); // 页面判成功，尽力补笔记 id
      }
    } catch (err) {
      if (aborted) throw err; // 总时限中止由内核按 timeout 处理，不改写
      throw new AdapterError(
        "result_unconfirmed",
        `已点击发布、未确认结果，请到笔记管理核对（${NOTE_MANAGER}）：${err.message}`,
        { cause: err },
      );
    }

    return {
      id: noteId ?? note.title,
      url: noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : NOTE_MANAGER,
      visibility: "公开",
      followups: [],
      notes: missed.length ? `没有话题结果、已跳过：${missed.map((t) => `#${t}`).join(" ")}` : null,
    };
  } catch (err) {
    const out = clicked && !(err instanceof AdapterError) ? new AdapterError("result_unconfirmed", `已点击发布、未确认结果，请到笔记管理核对：${err.message}`, { cause: err }) : err;
    throw await wrap(tab, accountId, "publish")(out);
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
    // 当前只实现了视频发布（图文发布是另一个 issue）。声明出来，发布台才能在创建前拦住
    // 图片素材，而不是让适配器打开浏览器后卡在「上传图文」页（ACC-publish-04）。
    assetTypes: ["video"],
  },
  ready() {
    const reason = browserReady();
    return reason ? `小红书未配置：${reason}` : null;
  },
  check,
  publish,
  collect,
};
