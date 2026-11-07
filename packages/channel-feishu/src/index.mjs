// 飞书通道。
//
// 凭证与长连接都不在我们这里：`lark-cli` 持有 app secret、负责 token 刷新和事件总线
// （`event consume card.action.trigger` 就是官方长连接，不需要公网回调）。
// 这符合零依赖与「凭证不出本机」两条约束，也避免手写飞书 WebSocket 协议。
//
// 通道只做三件事：发一条卡片消息、更新一张卡片、把点按钮事件交回去。
// 它不读数据库、不认识事件类型、不拼业务文案——那些在 core 里。

import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const bin = () => process.env.VK_LARK_BIN ?? "lark-cli";

async function lark(args, { timeout = 25e3 } = {}) {
  let stdout;
  try {
    ({ stdout } = await exec(bin(), args, { timeout, maxBuffer: 16 << 20, encoding: "utf8" }));
  } catch (err) {
    // execFile 的 rejection 只有一句 "Command failed"；真正的原因在 stderr 里。
    const detail = String(err.stderr ?? err.message ?? "").trim().slice(0, 500);
    throw new Error(`lark-cli ${args.slice(0, 2).join(" ")} 失败：${detail}`);
  }
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`lark-cli ${args.slice(0, 2).join(" ")} 返回了非 JSON：${stdout.slice(0, 200)}`);
  }
  if (json.ok === false) throw new Error(json.error?.message ?? JSON.stringify(json.error ?? json).slice(0, 300));
  return json;
}

export default {
  channel: "feishu",

  /** null = 可用；否则一句人能照做的话。这条会被账号墙与 doctor 直接显示。 */
  ready() {
    const probe = spawnSync(bin(), ["--version"], { encoding: "utf8", timeout: 5000 });
    if (probe.error) return "飞书未配置：没有找到 lark-cli（装好后 lark-cli auth login）";
    if (probe.status !== 0) return `飞书未配置：lark-cli 不可用（${String(probe.stderr ?? "").trim().slice(0, 120)}）`;
    return null;
  },

  /** 当前登录的人（open_id）。配对时用它，不需要用户手抄一串 ou_。 */
  async whoami() {
    const json = await lark(["auth", "status"]);
    const openId = json.identities?.user?.openId ?? json.identity?.user?.openId ?? null;
    if (!openId) throw new Error("lark-cli 没有登录用户身份：先运行 lark-cli auth login");
    return { openId, name: json.identities?.user?.userName ?? null };
  },

  /** 当前身份（bot/user）与 bind 的 app，给诊断用。 */
  async status() {
    const json = await lark(["auth", "status"]);
    return {
      appId: json.appId ?? json.identity?.appId ?? null,
      bot: json.identities?.bot ?? json.identity?.bot ?? null,
      user: json.identities?.user ?? json.identity?.user ?? null,
    };
  },

  /** 发一张交互卡片。idempotencyKey 让「同一事件重发」在飞书侧也不会重复。 */
  async send({ openId, card, idempotencyKey = null }) {
    if (!openId) throw new Error("发飞书消息需要 openId");
    const args = ["im", "+messages-send", "--user-id", openId, "--msg-type", "interactive", "--content", JSON.stringify(card), "--as", "bot"];
    if (idempotencyKey) args.push("--idempotency-key", String(idempotencyKey).slice(0, 50));
    const json = await lark(args);
    const messageId = json.data?.message_id ?? json.data?.message?.message_id ?? null;
    return { messageId };
  },

  /**
   * 点完按钮原地更新。按 message_id PATCH（14 天内有效），不用回调 token——
   * token 那条路要带 open_id，参数一错就只回一句 "openid empty"，不如消息 id 稳。
   */
  async updateCard({ messageId, card }) {
    if (!messageId) throw new Error("更新卡片需要 messageId");
    await lark([
      "api",
      "PATCH",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      "--as",
      "bot",
      "--data",
      JSON.stringify({ content: JSON.stringify(card) }),
    ]);
    return { ok: true };
  },

  /**
   * 事件订阅探活：短跑一次 consume，看后台是否真的订阅了 card.action.trigger。
   * 失败时把后台的订阅链接捞出来——这是唯一能让人自助修复的信息。
   */
  async probeEvents({ timeout = 12e3 } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin(), ["event", "consume", "card.action.trigger", "--as", "bot", "--timeout", "4s"], { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        return resolve({ ok: false, detail: err.message, url: null });
      }
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* 已经退了 */
        }
        resolve({ ok: false, detail: "探活超时", url: null });
      }, timeout);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: e.message, url: null });
      });
      child.on("exit", () => {
        clearTimeout(timer);
        const text = `${out}\n${err}`;
        const url = text.match(/https:\/\/open\.feishu\.cn\/page\/launcher[^"\s]+/)?.[0] ?? null;
        // 已经有一个消费者在跑（通常就是 versekit 自己的长连接）——这恰恰说明订阅是生效的，
        // 不能误判成「未订阅」。
        if (/another consumer.*already running/i.test(text)) {
          return resolve({ ok: true, detail: "已有消费者在运行（订阅已生效）" });
        }
        if (/failed_precondition|not subscribed/i.test(text)) {
          return resolve({ ok: false, detail: "开发者后台还没有订阅 card.action.trigger", url });
        }
        resolve({ ok: true, detail: "事件订阅正常" });
      });
    });
  },

  /**
   * 订阅按钮事件。lark-cli 负责长连接与重连；我们只解析 NDJSON。
   * 返回 stop()，daemon 退出时调用。
   */
  start({ onAction, log = () => {} } = {}) {
    let child = null;
    let stopped = false;
    let backoff = 1000;
    let buffer = "";

    const connect = () => {
      if (stopped) return;
      // stdin 必须保持打开：lark-cli 把 stdin EOF 当作退出信号（为 AI 子进程设计），
      // 用 ignore 会让它刚连上就退出。
      child = spawn(bin(), ["event", "consume", "card.action.trigger", "--as", "bot"], { stdio: ["pipe", "pipe", "pipe"] });
      buffer = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (/feishu-websocket: connected|ready event_key/.test(line)) {
            log("[feishu] 长连接已就绪，按钮可以点了");
            continue;
          }
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          const evt = obj?.data?.action_value !== undefined ? obj.data : obj;
          if (!evt || evt.action_value === undefined) continue;
          backoff = 1000;
          Promise.resolve(onAction(evt)).catch((err) => log(`[feishu] 处理按钮失败：${err.message}`));
        }
      });

      child.stderr.setEncoding("utf8");
      let warned = false;
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;
        // 未订阅回调时 lark-cli 会吐一整段 JSON；把它翻成一句能照做的话，并且只提醒一次。
        if (/not subscribed|failed_precondition/i.test(text)) {
          backoff = 5 * 60e3;
          if (!warned) {
            warned = true;
            let hint = "";
            try {
              hint = JSON.parse(text).error?.hint ?? "";
            } catch {
              /* 不是纯 JSON，忽略 */
            }
            log("[feishu] 开发者后台还没订阅 card.action.trigger（卡片按钮收不到点击）。");
            if (hint) log(`[feishu] 打开这个链接完成订阅：${hint}`);
            log("[feishu] 订阅后无需重启，5 分钟内会自动重连。");
          }
          return;
        }
        if (!/ready|subscrib|keepalive/i.test(text)) log(`[feishu] ${text.slice(0, 200)}`);
      });

      child.on("error", (err) => log(`[feishu] 拉不起 lark-cli：${err.message}`));
      child.on("exit", (code) => {
        if (stopped) return;
        log(`[feishu] 事件订阅断开（code ${code}），${Math.round(backoff / 1000)}s 后重连`);
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60e3);
      });
    };

    connect();
    return () => {
      stopped = true;
      try {
        child?.kill("SIGTERM");
      } catch {
        /* 已经退了 */
      }
    };
  },
};
