// 卡片是产品承诺「手机拍板」的全部界面：一句话结论 + 最多三个按钮。
//
// 这里只做纯函数：事件 + 上下文 → 卡片 JSON。发不发得出去、点了之后怎么执行，都不在这个文件里，
// 这样卡片文案可以在没有飞书、没有网络的情况下被测试。

import { ERROR_CODES } from "./errors.mjs";
import { CARD_VIEWS, cardCallbackValue, findCommand } from "./commands.mjs";
import { relayArrivalMessage } from "./events.mjs";

export const CARD_TTL_MS = 24 * 3600e3;

const TEMPLATE = { critical: "red", warn: "orange", info: "blue" };

function button(label, cmd, args, eventId, now, style = "default") {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: style,
    value: { cmd, args, exp: now + CARD_TTL_MS, key: `${eventId}:${cmd}` },
  };
}

const line = (...parts) => parts.filter(Boolean).join("\n");

/** 事件 → 卡片。返回 null 表示这类事件不发卡片（内部 trace 或还没有对应动作）。 */
export function buildEventCard(event, { publish = null, account = null, now = Date.now(), approvalUrl = null } = {}) {
  const payload = event.payload ?? {};
  const who = publish ? `${publish.platform} ${publish.account_name ?? `@${publish.handle}`}` : payload.platform ? `${payload.platform} @${payload.handle ?? ""}` : "";
  const what = publish?.title ? `「${publish.title}」` : "";
  const reason = payload.code ? ERROR_CODES[payload.code]?.human ?? payload.message ?? "" : payload.message ?? payload.reason ?? "";

  let title = null;
  let template = TEMPLATE[event.severity] ?? "blue";
  let body = "";
  const buttons = [];

  switch (event.type) {
    case "publish.failed":
      title = "发布失败";
      template = "red";
      body = line(`${who} ${what}没有发出去。`, reason && `原因：${reason}`, "可以在手机上重试，或到电脑上看现场。");
      if (publish) buttons.push(button("重试", "publish.retry", { publishId: publish.id }, event.id, now, "primary"));
      if (approvalUrl) buttons.push({ tag: "button", text: { tag: "plain_text", content: "手机打开" }, type: "default", url: approvalUrl });
      break;

    case "publish.needs_human":
      title = "需要你处理";
      template = "orange";
      body = line(`${who} ${what}自动发布没走通。`, reason && `原因：${reason}`, "发完回来点「我已发布」，或者让系统再试一次。");
      if (publish) {
        buttons.push(button("我已发布", "publish.confirm", { publishId: publish.id }, event.id, now, "primary"));
        buttons.push(button("重试", "publish.retry", { publishId: publish.id }, event.id, now));
        if (approvalUrl) buttons.push({ tag: "button", text: { tag: "plain_text", content: "手机打开" }, type: "default", url: approvalUrl });
      }
      break;

    case "publish.needs_followup": {
      title = "还差一步";
      template = "orange";
      const hint = payload.hint ?? "平台侧还有一处要补。";
      body = line(`${who} ${what}已经上线，但平台还要求补一件事：`, hint, "这一步需要你到平台后台完成。");
      break;
    }

    case "account.expiring":
    case "account.expired":
    case "account.banned": {
      title = event.type === "account.expiring" ? "登录快过期了" : "登录失效";
      template = event.type === "account.expiring" ? "orange" : "red";
      body = line(`${payload.platform ?? ""} @${payload.handle ?? ""} 的登录态${event.type === "account.expiring" ? "即将过期" : "已经失效"}。`, payload.detail ?? "", "点下面重新授权，会在这台电脑上打开登录页。");
      if (payload.accountId) {
        buttons.push(button("重新授权", "account.reauth", { accountId: payload.accountId }, event.id, now, "primary"));
        buttons.push(button("转手动", "account.mode", { accountId: payload.accountId, mode: "manual" }, event.id, now));
      }
      break;
    }

    case "collect.degraded":
      title = "数据没抓到";
      template = "orange";
      body = line(`${who} 的一次采集失败了。`, reason && `原因：${reason}`, "可以现在重抓一次。");
      if (publish) buttons.push(button("立即重抓", "collect.now", { publishId: publish.id }, event.id, now));
      break;

    case "digest.daily": {
      title = "昨日数据";
      template = "blue";
      body = payload.summary ?? "打开控制台看完整数据。";
      break;
    }

    case "system.dead":
      title = "守护进程停了";
      template = "red";
      body = line("Hifabu 没有心跳了。", "回到电脑上运行 vk serve --open，队列不会丢。");
      break;

    default:
      return null;
  }

  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: `Hifabu · ${title}` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: body } },
      ...(buttons.length ? [{ tag: "action", actions: buttons }] : []),
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: "按钮 24 小时内有效 · 重复点击只会执行一次" }],
      },
    ],
  };
}

/**
 * 一类事件算「发哪几类」里的哪一类（系统页「通知」的三个开关）：
 * confirm 要你确认的 / daily 每天的结果 / issue 其余（出了问题的）。
 */
export function cardKindOf(eventType) {
  if (eventType === "work.awaiting_confirm") return "confirm";
  if (eventType === "digest.daily") return "daily";
  return "issue";
}

/** 点完按钮后原地更新的卡片：结论一句，按钮收起来。 */
export function resultCard(title, message, { ok = true } = {}) {
  return {
    config: { wide_screen_mode: true },
    header: { template: ok ? "green" : "red", title: { tag: "plain_text", content: `Hifabu · ${title}` } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: message } }],
  };
}

export const cardButtonCount = (card) =>
  (card?.elements ?? []).filter((e) => e.tag === "action").reduce((n, e) => n + e.actions.length, 0);

// ---------------------------------------------------------------------------------------------
// v2 确认卡片（#150，ACC-v2-card-*）。结构照 docs/design/feishu-cards/：schema 2.0、
// update_multi（原地更新）、表单里不放带回调的重置按钮（取消在表单外面）。
//
// 仍然只是纯函数：行数据由 notify.mjs 在投递/点击那一刻按当前状态查出来再传进来。
// 按钮的 value 沿用 { cmd, args, exp, key }：`publish.*` 是真命令，走 executeAction 的四道闸；
// `card.*` 只是翻页（开始确认 / 改 / 取消），在 commands.mjs 的 CARD_VIEWS 里声明；
// 表单「改好了」提交的就是 publish.edit 命令本身（带 cutId，由 notify.mjs 拆成逐条 publish.edit）。
// ---------------------------------------------------------------------------------------------

export const PLATFORM_LABEL = {
  douyin: "抖音",
  shipinhao: "视频号",
  bilibili: "B站",
  xiaohongshu: "小红书",
  youtube: "YouTube",
  tiktok: "TikTok",
};
export const platformLabel = (platform) => PLATFORM_LABEL[platform] ?? platform;

/** 平台标题长度上限（设计稿里只有抖音与 B 站写了）。 */
const TITLE_MAX = { douyin: 55, bilibili: 80 };

const pad2 = (n) => String(n).padStart(2, "0");
const dayKey = (t) => {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

/** 卡片上给人看的时间：今天 20:00 / 明天 20:00 / 11-16 20:00；没排时间就明说。 */
export function formatWhen(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "还没定时间";
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (dayKey(ms) === dayKey(now)) return `今天 ${hm}`;
  if (dayKey(ms) === dayKey(now + 24 * 3600e3)) return `明天 ${hm}`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

/** picker_datetime 的 initial_datetime：本机时区的 YYYY-MM-DD HH:mm。 */
export function formatPickerTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 表单里时间选择器回来的字符串 → 毫秒。只校验格式（平台规则在 publish.edit 里判，#151）。
 * 认 `2026-11-15 20:00`、`2026-11-15T20:00:00`，后面可以带 `+0800` / `+08:00` / `GMT+8`-式偏移或 Z；
 * 不带偏移就按本机时区。格式不对或日期不存在（13 月）返回 null。
 */
export function parsePickerTime(text) {
  if (typeof text !== "string") return null;
  const m = text
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(?:GMT|UTC)?\s*(Z|[+-]\d{2}(?::?\d{2})?))?$/i);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  let ms;
  if (m[7]) {
    let offset = 0;
    if (m[7].toUpperCase() !== "Z") {
      const sign = m[7][0] === "-" ? -1 : 1;
      const digits = m[7].slice(1).replace(":", "");
      const hh = Number(digits.slice(0, 2));
      const mm = Number(digits.slice(2) || "0");
      if (hh > 14 || mm > 59) return null;
      offset = sign * (hh * 60 + mm);
    }
    ms = Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60e3;
    const check = new Date(ms + offset * 60e3);
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  } else {
    const local = new Date(y, mo - 1, d, h, mi, s);
    if (local.getMonth() !== mo - 1 || local.getDate() !== d) return null;
    ms = local.getTime();
  }
  return ms;
}

const withGroup = (title, groupName) => (groupName ? `${groupName} · ${title}` : title);
const md = (content) => ({ tag: "markdown", content });
const grey = (text) => `<font color='grey'>${text}</font>`;

/** value 里的 key 是幂等键：同一次渲染的同一个按钮只执行一次；重新渲染（now 不同）才是新的一次。 */
function callback(cmd, args, { key = null, now }) {
  return [{ type: "callback", value: cardCallbackValue(cmd, args, { key, now, ttlMs: CARD_TTL_MS }) }];
}
// 两种按钮都经 commands.mjs 校验造出：命令按钮是 remote 命令本身，翻页按钮来自 CARD_VIEWS（名字取自表，不手写）。
const commandButton = (name, args, opts) => callback(findCommand(name).name, args, opts);
const viewButton = (name, args, opts) => callback(CARD_VIEWS.find((v) => v.name === name).name, args, opts);

const v2Card = ({ template = "yellow", title, subtitle = null, elements }) => ({
  schema: "2.0",
  config: { update_multi: true },
  header: {
    template,
    title: { tag: "plain_text", content: title },
    ...(subtitle ? { subtitle: { tag: "plain_text", content: subtitle } } : {}),
  },
  body: { elements },
});

const noteLine = (note) => (note ? [md(note.error ? `<font color='red'>${note.text}</font>` : grey(note.text))] : []);

/** 「新作品，等你确认」：只有一个入口——开始确认。数量是投递那一刻的真实状态。 */
export function buildNewWorkCard({ workId, workTitle, cutCount, publishCount, groupName = null, eventId, now = Date.now(), note = null, fromRelay = false }) {
  return v2Card({
    title: withGroup(fromRelay ? relayArrivalMessage(workTitle, publishCount) : "新作品，等你确认", groupName),
    subtitle: fromRelay ? null : workTitle,
    elements: [
      md(`**${cutCount} 支成片 · ${publishCount} 条平台稿**等你确认\n${grey("确认之后才会排进发布；没确认的到时间也不会发。")}`),
      ...noteLine(note),
      {
        tag: "button",
        type: "primary",
        width: "fill",
        text: { tag: "plain_text", content: "开始确认" },
        behaviors: viewButton("card.review", { workId }, { key: `${eventId}:card.review`, now }),
      },
    ],
  });
}

/**
 * 卡片上看到的文案摘要（ACC-v2-copy-04）：正文前几行 + 话题；为空时明确写「没有正文」「没有话题」。
 * 正文只给前 3 行、每行最多 40 字，免得卡片被长文撑开；完整内容到 Web 确认面板里看、改。
 */
const BODY_LINES = 3;
const BODY_LINE_CHARS = 40;
export function copySummary({ body = "", tags = [] } = {}) {
  const clip = (t) => (t.length > BODY_LINE_CHARS ? `${[...t].slice(0, BODY_LINE_CHARS).join("")}…` : t);
  const all = String(body ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const shown = all.slice(0, BODY_LINES).map(clip);
  const more = all.length > BODY_LINES ? "…" : "";
  const bodyText = shown.length ? shown.join("\n") + more : "没有正文";
  const tagList = (tags ?? []).filter(Boolean);
  const tagText = tagList.length ? tagList.map((t) => `#${t}`).join(" ") : "没有话题";
  return { bodyText, tagText, bodyEmpty: !shown.length, tagsEmpty: !tagList.length };
}
const copyLines = (r) => {
  const c = copySummary(r);
  const dim = (empty, t) => (empty ? grey(t) : t);
  return `${dim(c.bodyEmpty, c.bodyText)}\n${dim(c.tagsEmpty, c.tagText)}`;
};

/**
 * 一支成片的确认卡片。rows 是这支成片实际的平台稿（不含小红书）：
 * [{ publishId, platform, title, at }]，所以有几条平台稿就有几行，不是固定 6 行。
 */
export function buildConfirmCard({ cut, index, total, workTitle, rows, groupName = null, now = Date.now(), cardKey = `cut:${cut.id}:${now}`, note = null, when = "scheduled" }) {
  // 现在发还是按时间发：在改单卡片里选，带到这里的确认按钮（ACC-v3-time-05/06）。现在发的行不写时间。
  const immediate = when === "now";
  const lines = [];
  rows.forEach((r, i) => {
    if (i) lines.push({ tag: "hr" });
    lines.push(md(`**${platformLabel(r.platform)}**　${r.title}\n${grey(immediate ? "现在发" : formatWhen(r.at, now))}\n${copyLines(r)}`));
  });
  return v2Card({
    title: withGroup(`${cut.title} · 第 ${index} 支，共 ${total} 支`, groupName),
    subtitle: workTitle,
    elements: [
      ...noteLine(note),
      ...lines,
      md(grey("AI 生成的内容，每个平台都会按要求标注。确认之后才会排进发布；没确认的到时间也不会发。")),
      {
        tag: "button",
        type: "primary",
        width: "fill",
        text: { tag: "plain_text", content: `确认这 ${rows.length} 条，${immediate ? "现在发" : "按时间发"}` },
        behaviors: commandButton("publish.approve", { cutId: cut.id, ...(immediate ? { when: "now" } : {}) }, { key: `${cardKey}:publish.approve`, now }),
      },
      {
        tag: "column_set",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [{ tag: "button", width: "fill", text: { tag: "plain_text", content: "改标题或时间" }, behaviors: viewButton("card.edit", { cutId: cut.id, ...(immediate ? { when: "now" } : {}) }, { now }) }],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "button",
                width: "fill",
                text: { tag: "plain_text", content: "这支先不发" },
                behaviors: commandButton("publish.skip", { cutId: cut.id }, { key: `${cardKey}:publish.skip`, now }),
              },
            ],
          },
        ],
      },
    ],
  });
}

/** 表单控件的 name：`title_<platform>` / `at_<platform>`，与设计稿一致；平台重复时加序号避免串值。 */
export function editFieldNames(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const n = (seen.get(r.platform) ?? 0) + 1;
    seen.set(r.platform, n);
    const suffix = n > 1 ? `_${n}` : "";
    return { publishId: r.publishId, platform: r.platform, title: `title_${r.platform}${suffix}`, at: `at_${r.platform}${suffix}` };
  });
}

/** 改标题或时间：上一张卡片原地换成表单。「取消」在表单外面——飞书不允许表单里的重置按钮带回调。 */
export function buildEditCard({ cut, rows, groupName = null, now = Date.now(), cardKey = `edit:${cut.id}:${now}`, note = null, when = "scheduled" }) {
  const immediate = when === "now";
  const names = editFieldNames(rows);
  // 选现在发时不出现时间输入（ACC-v3-time-06）。
  const fields = rows.flatMap((r, i) => [
    md(`**${platformLabel(r.platform)}**`),
    {
      tag: "input",
      name: names[i].title,
      default_value: r.title,
      ...(TITLE_MAX[r.platform] ? { max_length: TITLE_MAX[r.platform] } : {}),
    },
    ...(immediate
      ? []
      : [
          {
            tag: "picker_datetime",
            name: names[i].at,
            ...(Number.isFinite(r.at) ? { initial_datetime: formatPickerTime(r.at) } : {}),
          },
        ]),
  ]);
  // 「什么时候发」在表单外面：飞书表单里的控件不能带回调。切换会重画卡片，没提交的输入不保留，所以放在最上面先选。
  const half = (label, mode) => ({
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [
      {
        tag: "button",
        width: "fill",
        type: (mode === "now") === immediate ? "primary" : "default",
        text: { tag: "plain_text", content: label },
        behaviors: viewButton("card.edit", { cutId: cut.id, ...(mode === "now" ? { when: "now" } : {}) }, { now }),
      },
    ],
  });
  return v2Card({
    title: withGroup(`${cut.title} · 改标题或时间`, groupName),
    elements: [
      ...noteLine(note),
      md(`**什么时候发**\n${grey(immediate ? "现在发：不用选时间，确认后马上开始发。" : "按时间发：下面每个平台选一个时间。先选这个，再改下面的内容。")}`),
      { tag: "column_set", columns: [half("按时间发", "scheduled"), half("现在发", "now")] },
      {
        tag: "form",
        name: `edit_${cut.id}`,
        elements: [
          ...fields,
          {
            tag: "button",
            type: "primary",
            width: "fill",
            name: "save",
            text: { tag: "plain_text", content: "改好了" },
            form_action_type: "submit",
            behaviors: commandButton("publish.edit", { cutId: cut.id, ...(immediate ? { when: "now" } : {}) }, { key: `${cardKey}:publish.edit`, now }),
          },
        ],
      },
      {
        tag: "button",
        width: "fill",
        text: { tag: "plain_text", content: "取消" },
        behaviors: viewButton("card.show", { cutId: cut.id, ...(immediate ? { when: "now" } : {}) }, { now }),
      },
    ],
  });
}

/** 小红书单独确认：三个按钮，各对应一条真命令（按建议时间发 / 现在发 / 我自己发）。 */
export function buildXhsCard({ publishId, workTitle, cutTitle, title, body = "", tags = [], at, assetNote = null, quotaLeft = null, groupName = null, now = Date.now(), cardKey = `xhs:${publishId}:${now}` }) {
  const when = formatWhen(at, now);
  const facts = [assetNote, Number.isFinite(at) ? `建议 ${when} 发` : "还没定时间", Number.isInteger(quotaLeft) ? `今天还能发 ${quotaLeft} 条` : null].filter(Boolean);
  const half = (label, cmd) => ({
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [{ tag: "button", width: "fill", text: { tag: "plain_text", content: label }, behaviors: commandButton(cmd, { publishId }, { key: `${cardKey}:${cmd}`, now }) }],
  });
  return v2Card({
    title: withGroup("小红书，要你单独确认", groupName),
    subtitle: `${workTitle} · ${cutTitle}`,
    elements: [
      md(`**${title}**\n${grey(facts.join(" · "))}\n${copyLines({ body, tags })}`),
      {
        tag: "button",
        type: "primary",
        width: "fill",
        text: { tag: "plain_text", content: Number.isFinite(at) ? `${when} 发` : "按建议时间发" },
        behaviors: commandButton("publish.approve", { publishId }, { key: `${cardKey}:publish.approve`, now }),
      },
      { tag: "column_set", columns: [half("现在发", "publish.now"), half("我自己发", "publish.manual")] },
    ],
  });
}

/** 点完后原地换成的结果：标题变灰、按钮消失（出错时标红，让人看得出没执行）。 */
export function buildCardResult({ title, lines, groupName = null, ok = true }) {
  return v2Card({
    template: ok ? "grey" : "red",
    title: withGroup(title, groupName),
    elements: [md((Array.isArray(lines) ? lines : [lines]).join("\n"))],
  });
}

/** 卡片上还能点的回调按钮（v2 结构：递归找 behaviors）。 */
export function callbackValues(card) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const b of node.behaviors ?? []) if (b?.type === "callback") out.push(b.value);
    Object.values(node).forEach(walk);
  };
  walk(card?.body ?? card);
  return out;
}

/** 一张卡片上所有按钮的 { cmd, ... }：v1（actions[].value）与 v2（behaviors）都收。 */
export function cardActions(card) {
  const out = [...callbackValues(card)];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.tag === "button" && node.value) out.push(node.value);
    Object.values(node).forEach(walk);
  };
  walk(card);
  return out;
}

/**
 * 每种卡片各造一张样例（纯函数、不碰库）：`check:parity` 与 card-parity 测试用它枚举「卡片上所有按钮」。
 * 新增一种卡片 builder 时必须加到这里，否则它的按钮逃过三端一致检查。
 */
export function sampleCards(now = 1_800_000_000_000) {
  const cut = { id: "cut_sample", title: "样例成片" };
  const rows = [
    { publishId: "pub_a", platform: "douyin", title: "抖音标题", at: now + 3600e3 },
    { publishId: "pub_b", platform: "bilibili", title: "B站标题", at: now + 7200e3 },
  ];
  const ev = (type, payload = {}) => ({ id: `evt_${type}`, type, severity: "warn", payload });
  const publish = { id: "pub_a", platform: "douyin", handle: "sample", title: "样例" };
  const eventCard = (type, payload) => buildEventCard(ev(type, payload), { publish, now, approvalUrl: "https://example.invalid/a" });
  return {
    "event:publish.failed": eventCard("publish.failed"),
    "event:publish.needs_human": eventCard("publish.needs_human"),
    "event:account.expired": eventCard("account.expired", { platform: "douyin", handle: "sample", accountId: "acc_a" }),
    "event:collect.degraded": eventCard("collect.degraded"),
    "new-work": buildNewWorkCard({ workId: "work_sample", workTitle: "样例作品", cutCount: 1, publishCount: 2, eventId: "evt_new", now }),
    "confirm:scheduled": buildConfirmCard({ cut, index: 1, total: 1, workTitle: "样例作品", rows, now }),
    "confirm:now": buildConfirmCard({ cut, index: 1, total: 1, workTitle: "样例作品", rows, now, when: "now" }),
    "edit:scheduled": buildEditCard({ cut, rows, now }),
    "edit:now": buildEditCard({ cut, rows, now, when: "now" }),
    xhs: buildXhsCard({ publishId: "pub_x", workTitle: "样例作品", cutTitle: "样例成片", title: "标题", at: now + 3600e3, now }),
  };
}
