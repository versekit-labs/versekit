// 卡片是产品承诺「手机拍板」的全部界面：一句话结论 + 最多三个按钮。
//
// 这里只做纯函数：事件 + 上下文 → 卡片 JSON。发不发得出去、点了之后怎么执行，都不在这个文件里，
// 这样卡片文案可以在没有飞书、没有网络的情况下被测试。

import { ERROR_CODES } from "./errors.mjs";

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
export function buildEventCard(event, { publish = null, account = null, now = Date.now() } = {}) {
  const payload = event.payload ?? {};
  const who = publish ? `${publish.platform} @${publish.handle}` : payload.platform ? `${payload.platform} @${payload.handle ?? ""}` : "";
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
      break;

    case "publish.needs_human":
      title = "需要你处理";
      template = "orange";
      body = line(`${who} ${what}自动发布没走通。`, reason && `原因：${reason}`, "发完回来点「我已发布」，或者让系统再试一次。");
      if (publish) {
        buttons.push(button("我已发布", "publish.confirm", { publishId: publish.id }, event.id, now, "primary"));
        buttons.push(button("重试", "publish.retry", { publishId: publish.id }, event.id, now));
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
      body = line("versekit 没有心跳了。", "回到电脑上运行 vk serve --open，队列不会丢。");
      break;

    default:
      return null;
  }

  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: `versekit · ${title}` } },
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

/** 点完按钮后原地更新的卡片：结论一句，按钮收起来。 */
export function resultCard(title, message, { ok = true } = {}) {
  return {
    config: { wide_screen_mode: true },
    header: { template: ok ? "green" : "red", title: { tag: "plain_text", content: `versekit · ${title}` } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: message } }],
  };
}

export const cardButtonCount = (card) =>
  (card?.elements ?? []).filter((e) => e.tag === "action").reduce((n, e) => n + e.actions.length, 0);
