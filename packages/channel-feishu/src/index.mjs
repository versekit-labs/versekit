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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beginRegistration, pollRegistration, RegistrationError } from "./registration.mjs";

const exec = promisify(execFile);
// 优先级：VK_LARK_BIN（显式覆盖）→ install.sh 装在 versekit 目录下的 lark-cli → PATH 里的 lark-cli。
const bin = () => {
  if (process.env.VK_LARK_BIN) return process.env.VK_LARK_BIN;
  const own = join(process.env.VERSEKIT_PREFIX || join(homedir(), ".versekit"), "bin", "lark-cli");
  return existsSync(own) ? own : "lark-cli";
};
const LARK_TIMEOUT = 25e3;
// 只用 versekit 自己的 profile：用户在自己的应用上配的，不碰机器上别的应用。
const profile = () => process.env.VK_FEISHU_PROFILE ?? "versekit";

/** 需要喂 stdin 的命令（app secret 只能走 stdin，不能进 argv）。 */
function runWithInput(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : (logRaw("profile add", err || out), reject(new Error(explainLarkFailure(err || out))))));
    child.stdin.end(input);
  });
}

/**
 * 把 lark-cli 的原始输出变成一句人话。
 * 不在终端里跑时它先往 stderr 打一大段 `[AI agent] ...` 说明和「等待用户授权...」，
 * 真正的错误 JSON 跟在后面；这里只取 `{"ok":false,"error":{"message":...}}` 的 message。
 * 授权码作废/过期、拒绝翻成人话，其余照原文，最多两行。完整原文只写日志，不进页面。
 */
export function explainLarkFailure(raw) {
  const text = String(raw ?? "");
  let message = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      if (j && j.ok === false) message = j.error?.message ?? (typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? j));
    } catch {
      /* 不是 JSON 行 */
    }
  }
  if (message == null) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const waitAt = lines.findLastIndex((l) => /等待用户授权/.test(l));
    const rest = (waitAt >= 0 ? lines.slice(waitAt + 1) : lines).filter((l) => !/^\[AI agent\]/.test(l));
    message = rest.slice(-2).join(" ");
  }
  const m = String(message || "").trim();
  if (/device_code.*(invalid|expired)|(invalid|expired).*device_code|expired_token|\bexpired\b/i.test(m)) return "二维码过期了，点「重新来」。";
  if (/access_denied|denied|拒绝/i.test(m)) return "你在飞书里点了拒绝。点「重新来」可以再扫一次。";
  const clipped = m.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 160);
  return clipped || "飞书那边没有给出原因。点「重新来」再试一次。";
}

function logRaw(what, raw) {
  console.error(`[feishu] ${what} 原始输出：${String(raw ?? "").trim()}`);
}

function probeLark(args) {
  return spawnSync(bin(), args, { encoding: "utf8", timeout: LARK_TIMEOUT });
}

function probeFailure(result, what) {
  if (result.error?.code === "ETIMEDOUT") return `飞书暂时不可用：lark-cli ${what}超时，请稍后重试`;
  if (result.error) return `飞书暂时不可用：lark-cli ${what}失败（${result.error.message}）`;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim().slice(0, 120) || result.signal || result.status;
    return `飞书暂时不可用：lark-cli ${what}失败（${detail}）`;
  }
  return null;
}

function profileInfo() {
  const list = probeLark(["profile", "list"]);
  const error = probeFailure(list, "读取应用配置");
  if (error) return { exists: false, appId: null, error };
  try {
    const profiles = JSON.parse(list.stdout ?? "[]");
    const found = Array.isArray(profiles) ? profiles.find((p) => p.name === profile()) : null;
    return { exists: Boolean(found), appId: found?.appId ?? null };
  } catch {
    return { exists: false, appId: null };
  }
}

/** 表单回传的值：对象原样用，字符串就当 JSON 解；解不开或没有就是 undefined（不是表单提交）。 */
export function normalizeFormValue(value) {
  if (value == null) return undefined;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" ? value : undefined;
}

async function lark(args, { timeout = LARK_TIMEOUT } = {}) {
  args = [...args, "--profile", profile()];
  let stdout;
  try {
    ({ stdout } = await exec(bin(), args, { timeout, maxBuffer: 16 << 20, encoding: "utf8" }));
  } catch (err) {
    // execFile 的 rejection 只有一句 "Command failed"；真正的原因在 stderr（有时在 stdout）里。
    const raw = `${err.stderr ?? ""}\n${err.stdout ?? ""}`.trim() || String(err.message ?? "");
    logRaw(`lark-cli ${args.slice(0, 2).join(" ")}`, raw);
    throw new Error(explainLarkFailure(raw));
  }
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    logRaw(`lark-cli ${args.slice(0, 2).join(" ")}`, stdout);
    throw new Error(`lark-cli ${args.slice(0, 2).join(" ")} 返回了非 JSON`);
  }
  if (json.ok === false) {
    logRaw(`lark-cli ${args.slice(0, 2).join(" ")}`, stdout);
    throw new Error(explainLarkFailure(stdout));
  }
  return json;
}

// 扫码建机器人：走飞书应用注册（registration.mjs），一次扫码同时拿到应用凭证与所有者的 open_id。
let createState = { running: false, url: null, qr: null, qrError: null, error: null, startedAt: 0, abort: null };

export default {
  channel: "feishu",

  /** 发布机上有没有飞书组件（lark-cli）。没有就一步都走不通，页面据此写明原因，不让人去敲命令。 */
  installed() {
    const probe = probeLark(["--version"]);
    return !(probe.error?.code === "ENOENT");
  },

  /** null = 可用；否则一句人能照做的话。这条会被账号墙与 doctor 直接显示。 */
  ready() {
    const probe = probeLark(["--version"]);
    if (probe.error?.code === "ENOENT") return "飞书未配置：没有找到 lark-cli（装好后到系统页「通知」里点「接飞书」）";
    const versionError = probeFailure(probe, "版本探测");
    if (versionError) return versionError;

    const info = profileInfo();
    if (info.error) return info.error;
    if (!info.exists) {
      return "飞书应用未配置：在系统页「通知」里点「接飞书」扫码创建";
    }

    // 只看应用配置和机器人（bot）身份：卡片以机器人的身份发，不需要用户身份令牌。
    const status = probeLark(["auth", "status", "--profile", profile()]);
    const statusError = probeFailure(status, "读取应用状态");
    if (statusError) return statusError;
    let st = null;
    try {
      st = JSON.parse(status.stdout ?? "null");
    } catch {
      st = null;
    }
    const bot = st?.identities?.bot;
    if (bot?.status && bot.status !== "ready") return `飞书机器人不可用：${bot.message ?? bot.status}。在「通知」里点「重新接」。`;
    return null;
  },

  /** 把授权链接变成二维码（PNG data URI），页面直接 <img>。 */
  async qr(url) {
    // lark-cli 的输出路径只允许 cwd、/tmp、~/files；macOS 的 tmpdir() 是 /var/folders/…，
    // 不在白名单里，会被拒绝。这里显式用 /tmp。
    const dir = process.platform === "darwin" ? "/tmp" : tmpdir();
    const file = join(dir, `vk-qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    try {
      await exec(bin(), ["auth", "qrcode", url, "-o", file], { timeout: 15e3, encoding: "utf8" });
      const data = readFileSync(file).toString("base64");
      return `data:image/png;base64,${data}`;
    } finally {
      try {
        unlinkSync(file);
      } catch {
        /* 已经没了 */
      }
    }
  },

  /**
   * 扫码创建应用（也是「重新接」）：自己走飞书应用注册 begin / poll，只扫这一次码。
   * 拿到 client_id / client_secret / open_id 后：secret 只经 stdin 交给 `lark-cli profile add`，
   * open_id 交给 onDone({ appId, openId, brand }) 去配对。已有同名应用会被直接覆盖，不要求先删。
   */
  async createAppStart({ onDone = null } = {}) {
    if (createState.running) return { url: createState.url, qr: createState.qr, qrError: createState.qrError, running: true };

    const abort = new AbortController();
    const mine = { running: true, url: null, qr: null, qrError: null, error: null, startedAt: Date.now(), abort };
    createState = mine;
    const fail = (err) => {
      if (createState !== mine) return;
      mine.running = false;
      mine.url = null;
      mine.qr = null;
      mine.error = err instanceof RegistrationError && err.code === "cancelled" ? null : err.message;
    };

    let begin;
    try {
      begin = await beginRegistration({ signal: abort.signal });
    } catch (err) {
      console.error(`[feishu] 应用注册 begin 失败：${err.message}`);
      fail(err);
      throw new Error(`创建应用没有成功：${err.message}`);
    }
    mine.url = begin.verificationUrl;

    // 二维码只是锦上添花：生成失败也要把链接给出去，否则用户彻底没法继续。
    try {
      mine.qr = await this.qr(begin.verificationUrl);
    } catch (err) {
      mine.qrError = err.message;
    }

    // 后台等用户在飞书里扫完确认；页面只轮询状态。
    (async () => {
      try {
        const r = await pollRegistration(begin, { signal: abort.signal, intervalScale: Number(process.env.VK_FEISHU_POLL_SCALE) || 1 });
        if (!r.openId) throw new Error("飞书没有告诉我们你是谁（没有返回 open_id），卡片没法发给你。点「重新来」再扫一次。");
        const brand = r.tenantBrand === "lark" ? "lark" : "feishu";
        await this.configure({ appId: r.clientId, appSecret: r.clientSecret, brand });
        if (createState !== mine) return; // 中途取消了
        await onDone?.({ appId: r.clientId, openId: r.openId, brand });
        if (createState !== mine) return;
        mine.running = false;
        mine.url = null;
        mine.qr = null;
      } catch (err) {
        // 完整原因只写日志（里面没有凭证）；页面只留一句人话和「重新来」，作废的二维码立刻收起。
        if (!(err instanceof RegistrationError && err.code === "cancelled")) console.error(`[feishu] 扫码建应用失败：${err.message}`);
        fail(err);
      }
    })();

    return { url: mine.url, qr: mine.qr, qrError: mine.qrError, running: true };
  },

  createAppCancel() {
    try {
      createState.abort?.abort();
    } catch {
      /* 已经结束 */
    }
    createState = { running: false, url: null, qr: null, qrError: null, error: null, startedAt: 0, abort: null };
    return { running: false };
  },

  createAppStatus() {
    const info = profileInfo();
    return {
      running: createState.running,
      url: createState.url,
      qr: createState.qr,
      qrError: createState.qrError,
      configured: info.exists,
      appId: info.appId,
      // 扫码这一步没走完（二维码过期、在飞书里点了拒绝、品牌矛盾…）：页面据此写明原因，不是悄悄回到「还没接」。
      error: createState.error,
    };
  },

  /** 保存用户自己的应用（secret 走 stdin，不写文件、不进 argv/日志）。 */
  async configure({ appId, appSecret, brand = "feishu" }) {
    if (typeof appId !== "string" || !/^cli_[0-9a-z]+$/i.test(appId.trim())) throw new Error("app_id 格式不对：应以 cli_ 开头");
    if (typeof appSecret !== "string" || appSecret.trim().length < 8) throw new Error("app_secret 看起来不合法");
    try {
      await lark(["profile", "remove", "--name", profile()], { timeout: 10e3 });
    } catch {
      /* 第一次配置时本来就不存在 */
    }
    await runWithInput(["profile", "add", "--name", profile(), "--app-id", appId.trim(), "--app-secret-stdin", ...(brand === "lark" ? ["--brand", "lark"] : [])], appSecret.trim() + "\n");
    return { profile: profile(), appId: appId.trim() };
  },

  /** 当前登录的人（open_id）。配对时用它，不需要用户手抄一串 ou_。 */
  async whoami() {
    const json = await lark(["auth", "status"]);
    const openId = json.identities?.user?.openId ?? json.identity?.user?.openId ?? null;
    if (!openId) throw new Error("没有拿到你的 open_id：在系统页「通知」里点「重新接」重新扫一次码");
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
        child = spawn(bin(), ["event", "consume", "card.action.trigger", "--as", "bot", "--timeout", "4s", "--profile", profile()], { stdio: ["pipe", "pipe", "pipe"] });
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
      child.on("close", () => {
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
    let reconnect;

    const connect = () => {
      if (stopped) return;
      // stdin 必须保持打开：lark-cli 把 stdin EOF 当作退出信号（为 AI 子进程设计），
      // 用 ignore 会让它刚连上就退出。
      child = spawn(bin(), ["event", "consume", "card.action.trigger", "--as", "bot", "--profile", profile()], { stdio: ["pipe", "pipe", "pipe"] });
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
          // lark-cli 可能把事件放在顶层、data 或 event 里；三种都认，避免因为一层包装
          // 就让「点了没反应」重演。
          const found = [obj, obj?.data, obj?.event, obj?.data?.event].find((c) => c && c.action_value !== undefined);
          if (!found) continue;
          // 表单提交（「改好了」）会带每个输入框与时间选择器的值；字段名要在真实飞书里核对，
          // 这里兼容几处常见位置，并把可能是字符串的 JSON 展开，core 只认 { 控件名: 值 }。
          const evt = { ...found, form_value: normalizeFormValue(found.form_value ?? found.action?.form_value ?? found.form) };
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
      child.on("close", (code) => {
        if (stopped) return;
        log(`[feishu] 事件订阅断开（code ${code}），${Math.round(backoff / 1000)}s 后重连`);
        reconnect = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60e3);
      });
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      try {
        child?.kill("SIGTERM");
      } catch {
        /* 已经退了 */
      }
    };
  },
};
