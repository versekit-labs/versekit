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
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const bin = () => process.env.VK_LARK_BIN ?? "lark-cli";
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
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(String(err || out).trim().slice(0, 500)))));
    child.stdin.end(input);
  });
}

function profileInfo() {
  const list = spawnSync(bin(), ["profile", "list"], { encoding: "utf8", timeout: 5000 });
  try {
    const profiles = JSON.parse(list.stdout ?? "[]");
    const found = Array.isArray(profiles) ? profiles.find((p) => p.name === profile()) : null;
    return { exists: Boolean(found), appId: found?.appId ?? null };
  } catch {
    return { exists: false, appId: null };
  }
}

const profileExists = () => profileInfo().exists;

async function lark(args, { timeout = 25e3 } = {}) {
  args = [...args, "--profile", profile()];
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

// 授权状态：后台轮询进行中 / 已完成 / 失败。
let authState = { running: false, url: null, qr: null, error: null, completed: false };

// 扫码创建应用：config init --new 会阻塞到浏览器里完成；URL 先给用户扫。
let createState = { running: false, url: null, qr: null, startedAt: 0, child: null };

export default {
  channel: "feishu",

  /** null = 可用；否则一句人能照做的话。这条会被账号墙与 doctor 直接显示。 */
  ready() {
    const probe = spawnSync(bin(), ["--version"], { encoding: "utf8", timeout: 5000 });
    if (probe.error) return "飞书未配置：没有找到 lark-cli（装好后到「接入」页填写你的应用）";
    if (probe.status !== 0) return `飞书未配置：lark-cli 不可用（${String(probe.stderr ?? "").trim().slice(0, 120)}）`;

    if (!profileExists()) {
      return "飞书应用未配置：在「接入」页扫码创建，或填写你自己的 app_id 与 app_secret";
    }

    const status = spawnSync(bin(), ["auth", "status", "--profile", profile()], { encoding: "utf8", timeout: 8000 });
    let st = null;
    try {
      st = JSON.parse(status.stdout ?? "null");
    } catch {
      st = null;
    }
    if (!st?.identities?.user?.openId) return "飞书应用已配置，但还没有授权：在「接入」页点「开始授权」";
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
   * 扫码创建应用：官方流程会在浏览器里建一个应用，并把 app_id/secret 直接写进
   * 当前 profile（钥匙串）。我们只把 URL 截出来给用户扫，不接触 secret。
   */
  async createAppStart() {
    if (createState.running) return { url: createState.url, qr: createState.qr, running: true };

    // 这条命令只有在 TTY 里才会输出二维码和链接；管道下它会直接退出。
    // 用系统自带的 script 分配一个 pty，再照常解析输出。
    const child =
      process.platform === "linux"
        ? spawn("script", ["-q", "-c", `${bin()} config init --new --name ${profile()}`, "/dev/null"], { stdio: ["ignore", "pipe", "pipe"] })
        : spawn("script", ["-q", "/dev/null", bin(), "config", "init", "--new", "--name", profile()], { stdio: ["ignore", "pipe", "pipe"] });
    createState = { running: true, url: null, qr: null, qrError: null, startedAt: Date.now(), child };
    let buffer = "";

    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("30 秒内没有拿到创建应用的链接")), 30e3);
      const onData = (chunk) => {
        buffer += chunk;
        const hit = buffer.match(/https:\/\/[^"'\s]+/)?.[0];
        if (!hit) return;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(hit);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", (c) => (buffer += c));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        if (!createState.url) {
          clearTimeout(timer);
          reject(new Error(`创建应用进程退出了（code ${code}）：${buffer.slice(-200)}`));
        }
        createState.running = false;
      });
    });

    // 二维码只是锦上添花：生成失败也要把链接给出去，否则用户彻底没法继续。
    createState.url = url;
    let qr = null;
    let qrError = null;
    try {
      qr = await this.qr(url);
    } catch (err) {
      qrError = err.message;
    }
    createState.qr = qr;
    createState.qrError = qrError;
    child.stdout.resume();
    return { url, qr, qrError, running: true };
  },

  createAppCancel() {
    try {
      createState.child?.kill("SIGTERM");
    } catch {
      /* 已经退了 */
    }
    createState = { running: false, url: null, qr: null, qrError: null, startedAt: 0, child: null };
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
    };
  },

  /** 保存用户自己的应用（secret 走 stdin，不写文件、不进 argv/日志）。 */
  async configure({ appId, appSecret }) {
    if (typeof appId !== "string" || !/^cli_[0-9a-z]+$/i.test(appId.trim())) throw new Error("app_id 格式不对：应以 cli_ 开头");
    if (typeof appSecret !== "string" || appSecret.trim().length < 8) throw new Error("app_secret 看起来不合法");
    try {
      await lark(["profile", "remove", "--name", profile()], { timeout: 10e3 });
    } catch {
      /* 第一次配置时本来就不存在 */
    }
    await runWithInput(["profile", "add", "--name", profile(), "--app-id", appId.trim(), "--app-secret-stdin"], appSecret.trim() + "\n");
    return { profile: profile(), appId: appId.trim() };
  },

  /** 设备码授权第一步：拿验证地址，交给用户去浏览器确认。 */
  async authStart() {
    if (authState.running) return { ...authState, already: true };
    const json = await lark(["auth", "login", "--no-wait", "--json"]);
    const data = json.data ?? json;
    const verificationUrl = data.verification_url ?? data.verificationUrl ?? null;
    const deviceCode = data.device_code ?? data.deviceCode ?? null;
    const qr = verificationUrl ? await this.qr(verificationUrl) : null;

    authState = { running: Boolean(deviceCode), url: verificationUrl, qr, error: null, completed: false };

    // 设备码在后台自己轮询：用户扫完码、在飞书点确认后，这里会自动完成，
    // 页面只负责轮询状态，不再需要「我已完成授权」按钮。
    if (deviceCode) {
      this.authFinish(deviceCode)
        .then(() => {
          authState.running = false;
          authState.completed = true;
        })
        .catch((err) => {
          authState.running = false;
          authState.error = err.message;
        });
    }

    return { verificationUrl, qr, deviceCode, expiresIn: data.expires_in ?? data.expiresIn ?? null };
  },

  authStatus() {
    return { ...authState };
  },

  /** 设备码授权第二步：用户确认后完成轮询。 */
  async authFinish(deviceCode) {
    if (!deviceCode) throw new Error("缺少 device_code");
    // 设备码轮询最长约 10 分钟；默认 25s 超时会把进程杀掉，用户授权后也收不到结果。
    await lark(["auth", "login", "--device-code", deviceCode], { timeout: 620e3 });
    return { ok: true };
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
          const evt = [obj, obj?.data, obj?.event, obj?.data?.event].find((c) => c && c.action_value !== undefined);
          if (!evt) continue;
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
