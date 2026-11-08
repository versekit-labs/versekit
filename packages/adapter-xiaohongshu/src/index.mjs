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
import { open } from "../../core/src/index.mjs";
import { AdapterError } from "../../core/src/errors.mjs";
import { openAccount, closeAccount, browserReady, evidencePath, sleep } from "../../driver-browser/src/index.mjs";

const CREATE = "https://creator.xiaohongshu.com/publish/publish?source=official";
const LOGIN = "https://creator.xiaohongshu.com/login";
const DATA = "https://creator.xiaohongshu.com/statistics/data-analysis";
const API = "/api/galaxy/creator/datacenter/note";
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

async function publish({ publishId, dryRun = false } = {}) {
  requireId(publishId);
  let tab = null;
  let accountId = null;
  try {
    const row = load(publishId);
    accountId = row.account_id;
    const note = planNote(row);
    const asset = text(row.asset_path);
    if (!existsSync(asset)) throw new AdapterError("asset_invalid", `找不到素材：${asset}`);

    if (dryRun) {
      return {
        dryRun: true,
        target: { title: note.title, bodyPreview: [...note.body].slice(0, 80).join(""), tags: note.tags, asset },
      };
    }

    tab = await openAccount({ accountId });
    await tab.goto(CREATE);
    const where = await tab.waitFor(
      `location.pathname.includes('/login') ? 'login' : (document.querySelector('input.upload-input, input[type=file][accept*=mp4], input[type=file]') ? 'form' : '')`,
      [],
      { timeout: 90e3, every: 1000, what: "小红书创作服务平台发表页" },
    );
    if (where === "login") throw new AdapterError("auth", LOGIN_DETAIL);

    // 页面可能停在「上传图文」；这条是视频。
    if (!(await tab.eval(`!!document.querySelector('input.upload-input[accept*=mp4], input[type=file][accept*=mp4]')`))) {
      await clickOn(tab, `(R) => [...R.querySelectorAll('*')].filter((e) => e.offsetParent && e.children.length === 0 && e.innerText?.trim() === '上传视频').pop()`, "上传视频");
      await tab.waitFor(`!!document.querySelector('input.upload-input, input[type=file][accept*=mp4]')`, [], { timeout: 30e3, what: "视频上传控件" });
    }

    await tab.upload(`document.querySelector('input.upload-input, input[type=file][accept*=mp4]')`, [asset]);
    await tab.waitFor(
      `(() => !!document.querySelector('input[placeholder*="标题"]') && !/上传中|处理中|正在上传|\\d+%/.test(document.body.innerText))()`,
      [],
      { timeout: 20 * 60e3, every: 2000, what: "视频上传完成" },
    );
    await sleep(1000);

    await clickOn(tab, `(R) => R.querySelector('input[placeholder*="标题"]')`, "标题");
    if (!(await tab.eval(`document.activeElement === document.querySelector('input[placeholder*="标题"]')`))) {
      await tab.eval(`document.querySelector('input[placeholder*="标题"]').focus()`);
    }
    await tab.type(note.title);
    if ((await tab.eval(`document.querySelector('input[placeholder*="标题"]')?.value`)) !== note.title) {
      throw new AdapterError("flaky_ui", "小红书标题没有填进输入框");
    }

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
      await tab.key("Enter", "Enter", 13);
      for (const tag of note.tags) await addTag(tab, tag, missed);
    }

    await tab.waitFor(
      `(() => { const b = document.querySelector('xhs-publish-btn'); return b && b.getAttribute('submit-loading') === 'false' && b.getAttribute('submit-disabled') === 'false' ? 'ready' : ''; })()`,
      [],
      { timeout: 20e3, what: "发布按钮可用" },
    );
    await tab.clickInShadow("xhs-publish-btn", "发布");
    await tab.waitFor(`location.pathname.includes('/publish/success') || /发布成功/.test(document.body.innerText)`, [], { timeout: 120e3, what: "发布成功" });

    return {
      id: note.title,
      url: "https://creator.xiaohongshu.com/new/note-manager",
      visibility: "公开",
      followups: [],
      notes: missed.length ? `没有话题结果、已跳过：${missed.map((t) => `#${t}`).join(" ")}` : null,
    };
  } catch (err) {
    throw await wrap(tab, accountId, "publish")(err);
  } finally {
    await tab?.close().catch(() => {});
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

async function check(ctx = {}) {
  const accountId = ctx?.accountId;
  if (typeof accountId !== "string" || !accountId.trim()) throw new AdapterError("unknown", "check 需要 accountId");
  let tab = null;
  try {
    // 只探测登录态，不需要人看窗口：用无头 Chrome，避免验证时又弹一个浏览器。
    tab = await openAccount({ accountId, headless: true });
    await tab.goto(LOGIN);
    const state = await tab.waitFor(
      `location.pathname.includes('/login') ? 'login' : (document.querySelector('input, textarea, .tiptap') ? 'ok' : '')`,
      [],
      { timeout: 30e3, every: 500, what: "小红书登录态" },
    );
    if (state === "login") return { state: "expired", detail: LOGIN_DETAIL };
    return { state: "ok" };
  } catch (err) {
    throw await wrap(tab, accountId, "check")(err);
  } finally {
    await closeAccount(accountId).catch(() => {});
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
  },
  ready() {
    const reason = browserReady();
    return reason ? `小红书未配置：${reason}` : null;
  },
  check,
  publish,
  collect,
};
