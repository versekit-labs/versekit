#!/usr/bin/env node
// vk — versekit CLI. Default output is JSON (agents and scripts are the primary caller);
// --human switches to the layout a person reads.
//
// Reads run against the database directly (doctor must work when the daemon is dead); writes go
// through the daemon over the unix socket. That split is the whole point of the architecture:
// one writer, many faces.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, extname, join } from "node:path";
import { paths, migrate, open, getMeta, isInitialised } from "../../core/src/index.mjs";
import { COMMANDS } from "../../core/src/commands.mjs";
import { loadAdapters, buildHandlers, checkAccount } from "../../core/src/adapters.mjs";
import { createCoreHandlers } from "../../core/src/handlers.mjs";
import { startDaemon } from "../../core/src/daemon.mjs";
import { statusSnapshot, getAccount, getBinding, bindChannel } from "../../core/src/store.mjs";
import { readConfig, updateConfig, feishuProfileName, feishuAppId } from "../../core/src/config.mjs";
import { doctorReport as buildDoctorReport } from "../../core/src/doctor.mjs";
import channelFeishu from "../../channel-feishu/src/index.mjs";
import { browserReady, openAccount, closeAccount, PROFILE, PORT } from "../../driver-browser/src/index.mjs";
import { send, ensureDaemon } from "./client.mjs";

const PKG = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- argv

const VALUE_FLAGS = new Set([
  "--to", "--name", "--handle", "--credential", "--title", "--schedule", "--visibility",
  "--range", "--publish", "--platform", "--concurrency", "--port", "--actor", "--origin",
]);

function parseArgv(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      if (VALUE_FLAGS.has(token)) flags[token] = argv[++i];
      else flags[token] = true;
    } else {
      pos.push(token);
    }
  }
  return { flags, pos };
}

const { flags, pos } = parseArgv(process.argv.slice(2));
const has = (flag) => Boolean(flags[flag]);
const val = (flag) => (typeof flags[flag] === "string" ? flags[flag] : undefined);
const human = has("--human");

const out = (data) => {
  if (!human) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
};
const line = (label, value) => `${label.padEnd(18)}${value}`;

/** "2h" / "30m" / "2026-11-01T10:00" / epoch ms → ms timestamp. */
function parseSchedule(raw) {
  if (raw == null) return null;
  const m = /^(\d+)(m|h|d)$/.exec(String(raw).trim());
  if (m) {
    const unit = { m: 60e3, h: 3600e3, d: 24 * 3600e3 }[m[2]];
    return Date.now() + Number(m[1]) * unit;
  }
  if (/^\d{10,}$/.test(String(raw))) return Number(raw);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) throw new Error(`看不懂的定时时间：${raw}（用 2h / 30m / 2026-11-01T10:00）`);
  return at;
}

// ---------------------------------------------------------------- commands

function cmdInit() {
  const p = migrate();
  const config = existsSync(p.configFile) ? JSON.parse(readFileSync(p.configFile, "utf8")) : null;
  if (!config) {
    writeFileSync(
      p.configFile,
      JSON.stringify(
        {
          version: 1,
          created_at: new Date().toISOString(),
          defaults: { mode: "auto", visibility: "public", collect: { offsets: ["1h", "6h", "24h", "3d", "7d", "daily"] } },
          browser: { profile: "${state}/browser", cdp_port: 9333 },
          channel: { feishu: { enabled: false } },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
  const result = {
    ok: true,
    root: p.root,
    db: p.db,
    config: p.configFile,
    schema_version: getMeta("schema_version"),
    next: ["vk serve --open（打开本地控制台）", "vk account add bilibili --name 主号 --credential <cookies.json>", "vk doctor --human"],
  };
  if (human) {
    console.log(line("已初始化", p.state));
    console.log(line("数据库", p.db));
    console.log(line("配置", p.configFile));
    console.log("\n下一步：");
    result.next.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  } else out(result);
  return result;
}

function guard() {
  if (isInitialised()) return true;
  const msg = "还没有初始化：先运行 vk init";
  if (human) console.error(msg);
  else out({ ok: false, error: { code: "not_initialised", message: msg } });
  return false;
}

function cmdNow() {
  if (!guard()) return;
  const data = statusSnapshot();
  if (human) {
    console.log(`账号   ${data.accounts.total} 个（ok ${data.accounts.by_state.ok} · 需处理 ${data.accounts.by_state.expiring + data.accounts.by_state.expired}）`);
    for (const a of data.accounts.list) console.log(`       ${a.platform.padEnd(12)}${a.handle.padEnd(18)}${a.state}`);
    console.log(`队列   待跑 ${data.queue.queued} · 运行中 ${data.queue.running} · 失败 ${data.queue.failed}`);
    console.log(`发布   成功 ${data.publishes.published} · 部分 ${data.publishes.published_limited} · 待确认 ${data.publishes.needs_human}`);
    console.log(`通道   飞书 ${data.channel.feishu === "bound" ? "已连接" : "未配对"}`);
    if (!data.accounts.total) console.log("\n还没有账号：vk account add tiktok --name 主号");
  } else out({ ok: true, ...data });
  return data;
}

async function doctorReport() {
  const loaded = await loadAdapters();
  return buildDoctorReport({
    browserReady,
    browser: { profile: PROFILE, port: PORT },
    adapters: loaded.adapters,
    adapterErrors: loaded.errors,
  });
}

async function cmdDoctor() {
  const data = await doctorReport();
  if (human) {
    for (const c of data.checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.id.padEnd(18)}${c.detail}`);
      if (!c.ok && c.next) console.log(`  ${" ".repeat(19)}→ ${c.next}`);
    }
    console.log(`\n${data.passed}/${data.total} 项通过`);
  } else out(data);
  return data;
}

/**
 * Two kinds of handlers share the daemon: the queue runner takes `run` rows (publish/collect),
 * the dispatcher takes commands (publish.retry …). Names never collide — the dot is the separator.
 */
const LOGIN_URL = {
  tiktok: "https://www.tiktok.com/login",
  xiaohongshu: "https://creator.xiaohongshu.com/login",
  xiaohongshu: "https://creator.xiaohongshu.com/login",
  douyin: "https://creator.douyin.com/",
  youtube: "https://studio.youtube.com/",
};

let subscriptionCache = null;

// 网页登录会话：验证码要跨两次请求，标签页得留在内存里。
// 只放进程内存，不落库；daemon 重启就失效，这是有意的（验证码是一次性的）。
const loginSessions = new Map();

function daemonHandlers(adapters, log) {
  const core = createCoreHandlers({ adapters, log, doctor: doctorReport });
  return {
    ...buildHandlers(adapters, { log }),
    ...core,
    "account.check": ({ accountId }) => checkAccount(adapters, accountId),

    /**
     * 小红书创作平台只有短信登录，没有扫码。把「填手机号 → 发验证码 → 填验证码」做进
     * 网页，而不是让人切到一个单独的 Chrome 窗口。
     */
    "account.login.start": async ({ accountId, phone: rawPhone }) => {
      const account = getAccount(accountId);
      if (!account) throw new Error(`没有这个账号：${accountId}`);
      if (account.platform !== "xiaohongshu") {
        throw new Error(`${account.platform} 不走网页登录：在账号卡上点「登录 / 重新授权」会打开登录页`);
      }
      const phone = String(rawPhone ?? "").trim();

      const old = loginSessions.get(accountId);
      if (old) await old.tab.close().catch(() => {});
      loginSessions.delete(accountId);

      // 不带手机号 = 扫码登录。小红书主站有二维码；创作平台没有，但主站登录后
      // 同一账号的会话通常能带到创作平台，登录完再切过去确认。
      if (!phone) {
        // 登录会话用无头 Chrome：二维码只在我们的页面里出现，不再弹出小红书窗口。
        // 登录态仍写进账号 profile，之后发布用正常窗口即可复用。
        await closeAccount(accountId).catch(() => {});
        const tab = await openAccount({ accountId, headless: true });
        await tab.goto("https://www.xiaohongshu.com/login");
        await tab.waitFor(`document.querySelector('.qrcode-img')?.src?.startsWith('data:image')`, [], { timeout: 30e3, what: "小红书扫码登录二维码" });
        const qr = await tab.eval(`document.querySelector('.qrcode-img').src`);
        loginSessions.set(accountId, { tab, mode: "qr" });
        return { mode: "qr", qr, next: "用小红书 App 扫码；扫完页面会自动检测" };
      }

      if (!/^\d{11}$/.test(phone)) throw new Error("手机号要填 11 位");
      await closeAccount(accountId).catch(() => {});
      const tab = await openAccount({ accountId, headless: true });
      loginSessions.set(accountId, { tab, mode: "sms", phone });
      await tab.goto("https://creator.xiaohongshu.com/login");
      await tab.waitFor(`!!document.querySelector('input[placeholder*="手机号"]')`, [], { timeout: 30e3, what: "小红书登录页" });

      // 填手机号并发验证码。按钮是文字节点，按 rect 点比猜 class 稳。
      await tab.eval(`(() => { const e = document.querySelector('input[placeholder*="手机号"]'); e.focus(); })()`);
      await tab.type(phone);
      const sent = await tab.eval(`(() => {
        const hit = [...document.querySelectorAll('span,button,div')].filter((e) => e.offsetParent && e.children.length <= 1 && /发送验证码|获取验证码/.test(e.innerText || '')).pop();
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      if (!sent) throw new Error("小红书上没找到「发送验证码」按钮，页面可能改版了");
      return { sent: true, phone, next: "把手机收到的验证码填进来" };
    },

    "account.login.status": async ({ accountId }) => {
      const session = loginSessions.get(accountId);
      if (!session) throw new Error("登录会话已过期，重新点一次登录");
      const { tab, mode } = session;

      if (mode === "sms") {
        const moved = !/\/login/.test(await tab.url().catch(() => ""));
        return { state: moved ? "ok" : "pending", mode };
      }

      // 扫码后主站会离开 /login。切到创作平台确认，能进发布页才算真的登录。
      const here = await tab.url().catch(() => "");
      if (!/\/login/.test(here)) {
        await tab.goto("https://creator.xiaohongshu.com/publish/publish?source=official");
        const where = await tab
          .waitFor(`location.pathname.includes('/login') ? 'login' : (document.querySelector('input.upload-input, input[type=file]') ? 'form' : '')`, [], { timeout: 20e3, what: "创作平台登录态" })
          .catch(() => "login");
        if (where === "form") {
          loginSessions.delete(accountId);
          await closeAccount(accountId).catch(() => {});
          return { state: "ok", mode };
        }
        return { state: "pending", mode, note: "主站已登录，但创作平台还没进发布页" };
      }

      const phase = await tab
        .eval(`(() => {
          const t = document.body.innerText || "";
          if (/短信验证码验证/.test(t)) return "sms";
          if (/扫码成功|请在手机上确认/.test(t)) return "confirm";
          return "scan";
        })()`)
        .catch(() => "scan");
      const qr = await tab.eval(`document.querySelector('.qrcode-img')?.src ?? null`).catch(() => null);
      const phone = await tab
        .eval(`(() => { const m = (document.body.innerText||"").match(/验证码已发送至[\s\S]{0,8}(\+86[^\n]+)/); return m ? m[1].trim() : null; })()`)
        .catch(() => null);
      if (phase === "sms") {
        const sent = await tab.eval(`!/验证码将发送至/.test(document.body.innerText)`).catch(() => false);
        return {
          state: "sms_required",
          mode,
          qr,
          phone,
          sent,
          note: sent ? "验证码已发到手机，请填最新的验证码" : "还需要点「发送验证码」，让小红书发一条新的",
        };
      }
      if (phase === "confirm") return { state: "confirm_phone", mode, qr, note: "扫码成功，请在手机上点确认" };
      return { state: "pending", mode, qr };
    },

    "account.login.resend": async ({ accountId }) => {
      const session = loginSessions.get(accountId);
      if (!session || session.mode !== "qr") throw new Error("当前没有扫码登录会话");
      const clicked = await session.tab.eval(`(() => {
        const hit = [...document.querySelectorAll('span,div,button')].find((e) => e.offsetParent && /^(获取验证码|重新发送)$/.test((e.innerText || '').trim()));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      if (!clicked) throw new Error("页面上没有「获取验证码」");
      await new Promise((r) => setTimeout(r, 800));
      return { sent: true, next: "新验证码已发送，用最新一条" };
    },

    "account.login.verify": async ({ accountId, code: rawCode }) => {
      const session = loginSessions.get(accountId);
      if (!session) throw new Error("登录会话已过期，重新点一次登录");
      const code = String(rawCode ?? "").trim();
      if (!/^\d{4,8}$/.test(code)) throw new Error("验证码格式不对");

      const { tab, mode } = session;

      // 扫码后的二次验证：弹窗里填短信验证码，点「验证」，等它放行。
      if (mode === "qr") {
        const typed = await tab.eval(`(() => {
          const e = [...document.querySelectorAll('input[placeholder="请输入验证码"]')].find((x) => x.offsetParent);
          if (!e) return false;
          e.focus();
          return true;
        })()`);
        if (!typed) throw new Error("页面上没有短信验证码输入框，可能已经验证过或页面改版");
        await tab.type(code);
        const clicked = await tab.eval(`(() => {
          const b = [...document.querySelectorAll('div.btn,button')].find((e) => e.offsetParent && e.innerText.trim() === '验证');
          if (!b) return false;
          b.click();
          return true;
        })()`);
        if (!clicked) throw new Error("没找到「验证」按钮");

        const gone = await tab
          .waitFor(`!document.body.innerText.includes('短信验证码验证') || !location.pathname.includes('/login')`, [], { timeout: 12e3, what: "短信验证通过" })
          .then(() => true)
          .catch(() => false);
        if (!gone) {
          const state = await tab.eval(`(() => {
            const t = document.body.innerText || "";
            if (/验证码将发送至/.test(t)) return "还没点「获取验证码」，这一轮没有发码";
            const err = [...document.querySelectorAll('*')].filter((e) => e.offsetParent && e.children.length === 0 && /错误|失败|不正确|过期|频繁|稍后|无效/.test(e.innerText || "")).map((e) => e.innerText.trim()).slice(0, 2).join("；");
            return err || "验证码没有通过";
          })()`).catch(() => "验证码没有通过");
          throw new Error(`验证失败：${state}`);
        }

        // 验证通过后，主站可能已经登录；切到创作平台确认。
        const here = await tab.url().catch(() => "");
        if (!/\/login/.test(here)) {
          await tab.goto("https://creator.xiaohongshu.com/publish/publish?source=official");
        }
        const where = await tab
          .waitFor(`location.pathname.includes('/login') ? 'login' : (document.querySelector('input.upload-input, input[type=file]') ? 'form' : '')`, [], { timeout: 20e3, what: "创作平台登录态" })
          .catch(() => "login");
        if (where === "form") {
          loginSessions.delete(accountId);
          await closeAccount(accountId).catch(() => {});
          return { ok: true, state: "ok", next: "验证通过，点「验证登录」确认状态" };
        }
        return { ok: true, state: "pending", next: "验证通过，但创作平台还没登录；在手机上再确认一次" };
      }
      await tab.eval(`(() => { const e = document.querySelector('input[placeholder*="验证码"]'); e.focus(); })()`);
      await tab.type(code);
      const clicked = await tab.eval(`(() => {
        const btn = [...document.querySelectorAll('button,span')].filter((e) => e.offsetParent && /登\s*录/.test(e.innerText || '')).pop();
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      if (!clicked) throw new Error("小红书上没找到登录按钮，页面可能改版了");

      const moved = await tab
        .waitFor(`!location.pathname.includes('/login')`, [], { timeout: 20e3, every: 500, what: "登录完成" })
        .then(() => true)
        .catch(() => false);
      if (!moved) throw new Error("验证码没有通过，或还需要额外验证；页面还在登录页");

      loginSessions.delete(accountId);
      await closeAccount(accountId).catch(() => {});
      return { ok: true, state: "ok", next: "登录成功，点「验证登录」确认状态" };
    },

    "account.login.cancel": async ({ accountId }) => {
      const session = loginSessions.get(accountId);
      if (!session) return { canceled: false };
      loginSessions.delete(accountId);
      await closeAccount(accountId).catch(() => {});
      return { canceled: true };
    },

    /**
     * 订阅状态探活很贵（要等事件总线就绪，约 10 秒），所以只在绑定后探一次并缓存。
     * 卡片按钮能不能点，全看这一项——它必须是可见的，不能假装通了。
     */
    "channel.subscription": async () => {
      const now = Date.now();
      if (subscriptionCache && now - subscriptionCache.at < 120e3) return subscriptionCache.value;
      const probe = await channelFeishu.probeEvents();
      // 注意：这是「探测结果」，不是「请求失败」。用 subscribed 表达结论，
      // 顶层 ok 留给传输层，否则客户端会把正常结果当成错误抛出来。
      const value = { subscribed: Boolean(probe.ok), detail: probe.detail ?? null, url: probe.url ?? null, checkedAt: now };
      subscriptionCache = { at: now, value };
      return value;
    },

    "channel.status": () => {
      const ready = channelFeishu.ready();
      const cfg = readConfig().channel?.feishu ?? {};
      const create = channelFeishu.createAppStatus();
      const binding = getBinding("feishu");
      return {
        create,
        auth: channelFeishu.authStatus(),
        subscription: subscriptionCache?.value ?? null,
        ready,
        skipped: Boolean(cfg.skipped),
        configured: Boolean(cfg.app_id) || create.configured,
        authorized: ready === null,
        bound: Boolean(binding),
        profile: cfg.profile ?? feishuProfileName(),
        appId: cfg.app_id ?? create.appId ?? null,
        externalUserId: binding?.external_user_id ?? null,
      };
    },

    "channel.skip": () => {
      updateConfig({ channel: { feishu: { skipped: true } } });
      return { skipped: true, next: "已跳过；需要手机拍板时再回来开启" };
    },
    "channel.unskip": () => {
      updateConfig({ channel: { feishu: { skipped: false } } });
      return { skipped: false };
    },

    "channel.app.create.start": () => channelFeishu.createAppStart(),
    "channel.app.create.status": () => channelFeishu.createAppStatus(),
    "channel.app.create.cancel": () => channelFeishu.createAppCancel(),

    "channel.app.set": async ({ appId, appSecret }) => {
      const r = await channelFeishu.configure({ appId, appSecret });
      updateConfig({ channel: { feishu: { profile: r.profile, app_id: r.appId, configured_at: Date.now() } } });
      return { ...r, next: "点「开始授权」，在浏览器里完成飞书授权" };
    },

    "channel.login.start": async () => {
      if (channelFeishu.ready() && !/还没有授权/.test(channelFeishu.ready() ?? "")) throw new Error(channelFeishu.ready());
      const started = await channelFeishu.authStart();
      if (!started.verificationUrl) throw new Error("lark-cli 没有返回验证链接");
      return started;
    },

    "channel.login.wait": async ({ deviceCode }) => {
      await channelFeishu.authFinish(deviceCode);
      const who = await channelFeishu.whoami();
      const bound = bindChannel("feishu", who.openId);
      updateConfig({ channel: { feishu: { authorized_at: Date.now() } } });
      // 顺手探一次订阅：没订阅时按钮收不到点击，界面要能立刻说出来。
      channelFeishu
        .probeEvents()
        .then((probe) => {
          subscriptionCache = { at: Date.now(), value: { subscribed: Boolean(probe.ok), detail: probe.detail ?? null, url: probe.url ?? null, checkedAt: Date.now() } };
        })
        .catch(() => {});
      return { ...bound, who: who.name ?? null };
    },

    "channel.diagnose": async () => {
      const checks = [];
      const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });

      const ready = channelFeishu.ready();
      add("app", ready === null, ready ?? "飞书应用已配置且已授权");

      let status = null;
      try {
        status = await channelFeishu.status();
        add("identity", status.bot?.status === "ready", status.bot?.status === "ready" ? `bot 身份可用${status.appId ? `（${status.appId}）` : ""}` : `bot 身份不可用：${status.bot?.message ?? "未知"}`);
      } catch (err) {
        add("identity", false, `读不到登录身份：${err.message}`);
      }

      const binding = getBinding("feishu");
      add("binding", Boolean(binding), binding ? `已配对（${binding.external_user_id}）` : "还没有配对");

      let probe = { ok: false, detail: "未执行探活", url: null };
      try {
        probe = await channelFeishu.probeEvents();
      } catch (err) {
        probe = { ok: false, detail: `探活失败：${err.message}`, url: null };
      }
      add("subscription", probe.ok, probe.detail, probe.url ? { url: probe.url } : {});

      const healthy = checks.every((c) => c.ok);
      return { ok: true, healthy, checks, subscribeUrl: probe.url ?? null };
    },

    "channel.bind": async ({ openId }) => {
      const who = openId ? { openId, name: null } : await channelFeishu.whoami();
      const bound = bindChannel("feishu", who.openId);
      return { ...bound, who: who.name ?? null };
    },
    "channel.test": async () => {
      const binding = getBinding("feishu");
      if (!binding) throw new Error("还没有配对：先运行 vk channel bind feishu");
      const now = Date.now();
      const card = {
        config: { wide_screen_mode: true },
        header: { template: "blue", title: { tag: "plain_text", content: "versekit · 通道已连通" } },
        elements: [
          {
            tag: "div",
            text: { tag: "lark_md", content: "以后发布失败、登录失效、需要你确认，都会发到这里的卡片上；点下面的按钮，验证「手机点一下、电脑执行」这条闭环。" },
          },
          {
            tag: "action",
            actions: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "点我验证闭环" },
                type: "primary",
                value: { cmd: "stats.works", args: {}, exp: now + 24 * 3600e3, key: `test:${now}` },
              },
            ],
          },
          { tag: "note", elements: [{ tag: "plain_text", content: "按钮 24 小时内有效 · 重复点击只会执行一次" }] },
        ],
      };
      const { messageId } = await channelFeishu.send({ openId: binding.external_user_id, card });
      return { messageId, openId: binding.external_user_id };
    },
    // 控制台的「自检」页与 CLI 用的是同一份检查，避免「网页说没问题、命令行说有问题」。
    doctor: () => doctorReport(),

    /**
     * 「重新授权」要有实际动作：在这个账号自己的 Chrome profile 里打开登录页，
     * 让人扫码。标签页故意不关——关掉就没法扫了。B站走 biliup CLI，没有网页可开，
     * 就沿用核心那句能照做的指引。
     */
    "account.reauth": async ({ accountId }) => {
      const account = getAccount(accountId);
      if (!account) throw new Error(`没有这个账号：${accountId}`);
      const url = LOGIN_URL[account.platform];
      if (!url) return core["account.reauth"]({ accountId });
      await openAccount({ accountId, url });
      log(`[reauth] 打开 ${account.platform} 登录页（账号 ${accountId}）`);
      return {
        accountId,
        started: true,
        next: `已在 ${account.platform} 的浏览器里打开登录页，扫码/登录完成后回来点刷新`,
      };
    },
  };
}

/** 本机打开控制台；打不开也不算失败，URL 已经打印出来了。 */
function openBrowser(url) {
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* 没有图形界面也能用：URL 在输出里 */
  }
}

// 通道只认 versekit 自己的 profile（用户在接入页配置的应用），不碰机器上的其他应用。
process.env.VK_FEISHU_PROFILE = process.env.VK_FEISHU_PROFILE ?? feishuProfileName();

async function cmdServe() {
  if (!guard()) return;

  if (has("--detach")) {
    const wanted = Number(val("--port") ?? 8787);
    const result = await ensureDaemon({ port: wanted, lan: has("--lan") });
    // 端口以守护进程自己写下的为准：它可能比我们先起、跑在别的端口上。
    let running = wanted;
    try {
      running = JSON.parse(readFileSync(join(paths().state, "daemon.json"), "utf8")).port ?? wanted;
    } catch {
      /* 老版本没有这个文件 */
    }
    const url = `http://127.0.0.1:${running}`;
    if (has("--open")) openBrowser(url);
    const data = { ok: true, started: result.started, socket: paths().socket, web: url };
    if (human) console.log(`${result.started ? "守护进程已启动" : "守护进程已经在跑"}：${url}`);
    else out(data);
    return data;
  }

  const { adapters, errors } = await loadAdapters();
  const log = (m) => (human ? console.log(m) : console.error(m));
  const handlers = daemonHandlers(adapters, log);
  const port = Number(val("--port") ?? 8787);
  const host = has("--lan") ? "0.0.0.0" : "127.0.0.1";
  updateConfig({ server: { port, host } });
  const daemon = await startDaemon({ handlers, log, port, host, channels: [channelFeishu], doctor: doctorReport });

  const web = `http://127.0.0.1:${daemon.port}`;
  if (has("--open")) openBrowser(web);
  log(`versekit 守护进程已启动：${web} · socket ${daemon.socketPath}`);
  log(`适配器 ${adapters.length} 个${adapters.length ? "：" + adapters.map((a) => a.platform).join(", ") : "（尚未安装）"}`);
  for (const e of errors) log(`适配器加载失败 ${e.dir}: ${e.message}`);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      log(`\n收到 ${sig}，正在停止`);
      await daemon.close();
      process.exit(0);
    });
  }
  await new Promise(() => {});
}

function cmdCommands() {
  const data = COMMANDS.map((c) => ({
    name: c.name,
    summary: c.summary,
    remote: c.remote,
    localOnly: c.localOnly === true,
    cli: c.cli?.usage ?? null,
    http: c.http ? `${c.http.method} ${c.http.path}` : null,
    card: c.card ? { label: c.card.label, style: c.card.style, confirm: c.card.confirm } : null,
    idempotent: typeof c.idempotent === "function",
    ttl_ms: c.ttlMs ?? null,
  }));
  if (human) for (const c of data) console.log(`${c.name.padEnd(18)}${c.remote ? "远程 ✓" : "远程 ✗"}  ${c.summary}`);
  else out(data);
  return data;
}

async function cmdAccount() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);
  if (sub === "list") {
    const data = await send("account.list", {}, { log });
    if (human) {
      if (!data.accounts.length) console.log("还没有账号：vk account add tiktok --name 主号");
      for (const a of data.accounts) console.log(`${a.id.padEnd(14)}${a.platform.padEnd(12)}${a.handle.padEnd(18)}${a.state}`);
    } else out(data);
    return data;
  }
  if (sub === "add") {
    const platform = pos[2];
    if (!platform) throw new Error("用法：vk account add <platform> --name <名字>");
    const name = val("--name") ?? platform;
    const data = await send(
      "account.add",
      {
        platform,
        name,
        ...(val("--handle") ? { handle: val("--handle") } : {}),
        ...(val("--credential") ? { credentialRef: val("--credential") } : {}),
      },
      { log },
    );
    if (human) console.log(`已添加 ${platform} ${name}（${data.id}）\n${data.next ?? ""}`);
    else out(data);
    return data;
  }
  if (sub === "mode") {
    const [, , accountId, mode] = pos;
    if (!accountId || !mode) throw new Error("用法：vk account mode <accountId> auto|manual");
    const data = await send("account.mode", { accountId, mode }, { log });
    if (human) console.log(`${accountId} → ${mode}`);
    else out(data);
    return data;
  }
  if (sub === "check") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account check <accountId>");
    const data = await send("account.check", { accountId }, { log });
    if (human) console.log(`${accountId} → ${data.state}${data.detail ? `（${data.detail}）` : ""}`);
    else out(data);
    return data;
  }
  if (sub === "login") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account login <accountId> --phone 138... | --code 123456 | --cancel");
    let data;
    if (has("--cancel")) data = await send("account.login.cancel", { accountId });
    else if (has("--status")) data = await send("account.login.status", { accountId });
    else if (has("--resend")) data = await send("account.login.resend", { accountId });
    else if (val("--code")) data = await send("account.login.verify", { accountId, code: val("--code") });
    else if (val("--phone")) data = await send("account.login.start", { accountId, phone: val("--phone") });
    else throw new Error("要指定 --phone 或 --code 或 --cancel");
    if (human) console.log(data.next ?? JSON.stringify(data));
    else out(data);
    return data;
  }

  if (sub === "reauth") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account reauth <accountId>");
    const data = await send("account.reauth", { accountId }, { log });
    if (human) console.log(data.next ?? "已开始");
    else out(data);
    return data;
  }
  throw new Error("用法：vk account list | add | mode | reauth");
}

async function cmdPublish() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);

  if (sub === "list") {
    const data = await send("publish.list", {
      ...(val("--state") ? { state: val("--state") } : {}),
      ...(val("--platform") ? { platform: val("--platform") } : {}),
    });
    if (human) {
      for (const r of data.rows) console.log(`${r.id.padEnd(16)}${r.platform.padEnd(10)}${r.state.padEnd(18)}${String(r.title).slice(0, 30)}`);
      if (!data.rows.length) console.log("还没有发布：vk publish <素材> --to <平台>");
    } else out(data);
    return data;
  }

  if (["retry", "release", "confirm"].includes(sub)) {
    const publishId = pos[2];
    if (!publishId) throw new Error(`用法：vk publish ${sub} <publishId>`);
    const data = await send(`publish.${sub}`, { publishId }, { log });
    if (human) console.log(`${publishId} → ${data.state}`);
    else out(data);
    return data;
  }

  const asset = sub;
  if (!asset) throw new Error("用法：vk publish <素材> --to tiktok,bilibili [--title] [--schedule 2h] [--visibility] [--dry-run]");
  const to = (val("--to") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) throw new Error("要指定平台：--to tiktok,bilibili");
  const args = {
    asset,
    to,
    ...(val("--title") ? { title: val("--title") } : {}),
    ...(val("--body") ? { body: val("--body") } : {}),
    ...(val("--tags") ? { tags: String(val("--tags")).split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(val("--visibility") ? { visibility: val("--visibility") } : {}),
    ...(parseSchedule(val("--schedule")) ? { schedule: parseSchedule(val("--schedule")) } : {}),
    ...(has("--dry-run") ? { dryRun: true } : {}),
  };
  const data = await send("publish.create", args, { log });
  if (human) {
    if (data.dryRun) {
      console.log(`试运行：${data.work.title} → ${data.publishes.map((p) => p.platform).join("、")}`);
      console.log("没有写入任何行，也没有对外动作");
    } else {
      console.log(`已创建 ${data.publishes.length} 条发布：`);
      for (const p of data.publishes) console.log(`  ${p.platform.padEnd(12)}${p.handle.padEnd(18)}${p.publishId}`);
    }
  } else out(data);
  return data;
}

async function cmdCollect() {
  const data = await send("collect.now", { ...(val("--platform") ? { platform: val("--platform") } : {}), ...(val("--publish") ? { publishId: val("--publish") } : {}) }, { log: (m) => human && console.log(m) });
  if (human) console.log(`已排 ${data.queued} 个采集任务`);
  else out(data);
  return data;
}

async function cmdSetup() {
  const data = await send("setup.status", {});
  if (human) {
    console.log(`接入进度 ${data.done}/${data.total}${data.nextStep ? ` · 下一步：${data.steps.find((s) => s.id === data.nextStep)?.title}` : ""}`);
    for (const step of data.steps) {
      const mark = step.status === "ok" ? "✓" : step.status === "blocked" ? "✗" : "○";
      console.log(`${mark} ${step.title.padEnd(12)}${step.intent}`);
      for (const c of step.checks) {
        console.log(`    ${c.ok ? "·" : "!"} ${c.detail}`);
      }
    }
  } else out(data);
  return data;
}

async function cmdPlatforms() {
  const data = await send("platform.list", {});
  if (human) {
    for (const p of data.platforms) console.log(`${p.platform.padEnd(12)}发布=${p.publish.padEnd(5)}采集=${p.collect.padEnd(5)}${p.ready ? `  不可用：${p.ready}` : "  可用"}`);
  } else out(data);
  return data;
}

async function cmdRuns() {
  const data = await send("run.list", { ...(val("--state") ? { state: val("--state") } : {}) });
  if (human) {
    for (const r of data.rows) console.log(`${r.kind.padEnd(9)}${String(r.state).padEnd(10)}${String(r.target_id).padEnd(18)}${r.last_error ?? ""}`);
    if (!data.rows.length) console.log("队列是空的");
  } else out(data);
  return data;
}

async function cmdEvents() {
  const data = await send("event.list", {
    ...(val("--since") ? { since: Number(val("--since")) } : {}),
    ...(val("--limit") ? { limit: Number(val("--limit")) } : {}),
  });
  if (human) {
    for (const e of data.rows) console.log(`${new Date(e.created_at).toLocaleString()}  ${e.type.padEnd(24)}${e.severity}`);
  } else out(data);
  return data;
}

async function cmdApproval() {
  const sub = pos[1] ?? "list";
  const log = (m) => human && console.log(m);

  if (sub === "list") {
    const [pending, failed] = await Promise.all([
      send("publish.list", { state: "notify_pending" }),
      send("publish.list", { state: "failed" }),
    ]);
    const rows = [...pending.rows, ...failed.rows];
    if (human) {
      for (const r of rows) console.log(`${r.id.padEnd(16)}${r.platform.padEnd(10)}${String(r.title ?? "").slice(0, 36)}`);
      if (!rows.length) console.log("没有需要拍板的发布");
    } else out(rows);
    return rows;
  }

  if (sub === "link") {
    const publishId = pos[2];
    if (!publishId) throw new Error("用法：vk approval link <publishId>");
    const data = await send("approval.link", { publishId });
    if (human) console.log(data.url);
    else out(data);
    return data;
  }

  if (sub === "apply" || sub === "retry" || sub === "cancel") {
    const token = sub === "apply" ? pos[2] : pos[2];
    const decision = sub === "cancel" ? "cancel" : sub === "apply" ? (pos[3] ?? "retry") : sub;
    if (!token) throw new Error("用法：vk approval apply <token> retry|cancel");
    const data = await send("approval.apply", { token, decision }, { log });
    if (human) console.log(data.message ?? data.state);
    else out(data);
    return data;
  }

  throw new Error("用法：vk approval list | link <publishId> | apply <token> retry|cancel");
}

async function cmdChannel() {
  const sub = pos[1];
  const name = pos[2] ?? "feishu";
  if (name !== "feishu") throw new Error("目前只支持飞书：vk channel bind feishu");

  if (sub === "status") {
    const data = await send("channel.status", {});
    if (human) {
      console.log(`应用    ${data.configured ? data.appId ?? "已配置" : "未配置"}`);
      console.log(`授权    ${data.authorized ? "已完成" : "未完成"}`);
      console.log(`配对    ${data.bound ? `已配对（${data.externalUserId}）` : "未配对"}`);
      if (data.ready) console.log(`提示    ${data.ready}`);
    } else out(data);
    return data;
  }

  const missing = sub === "diagnose" ? null : channelFeishu.ready();
  if (missing) throw new Error(missing);

  if (sub === "bind") {
    const who = val("--open-id") ? { openId: val("--open-id"), name: null } : await channelFeishu.whoami();
    const bound = await send("channel.bind", { openId: who.openId });
    const test = await send("channel.test", {});
    const data = { ok: true, ...bound, messageId: test.messageId, who: who.name ?? who.openId };
    if (human) {
      console.log(`已配对飞书：${who.name ?? who.openId}`);
      if (bound.existed) console.log("（之前配过，已刷新配对时间）");
      console.log(`测试卡片已发送${test.messageId ? `（${test.messageId}）` : ""}，去飞书里看一眼。`);
    } else out(data);
    return data;
  }

  if (sub === "diagnose") {
    const data = await send("channel.diagnose", {});
    if (human) {
      console.log(`飞书诊断：${data.healthy ? "全部通过" : "有需要处理的地方"}`);
      for (const c of data.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.id.padEnd(14)}${c.detail}`);
      if (data.subscribeUrl) console.log(`\n去订阅：${data.subscribeUrl}`);
    } else out(data);
    return data;
  }

  if (sub === "subscription") {
    const data = await send("channel.subscription", {});
    if (human) {
      console.log(data.subscribed ? "✓ 事件订阅已生效（按钮可以点）" : `✗ ${data.detail ?? "还没有订阅 card.action.trigger"}`);
      if (!data.subscribed && data.url) console.log(`去订阅：${data.url}`);
    } else out(data);
    return data;
  }

  if (sub === "test") {
    const test = await send("channel.test", {});
    if (human) console.log(`测试卡片已发送${test.messageId ? `（${test.messageId}）` : ""}`);
    else out({ ok: true, ...test });
    return test;
  }

  throw new Error("用法：vk channel bind | test | status | diagnose | subscription feishu");
}

async function cmdStats() {
  const sub = pos[1];
  if (sub === "series") {
    const publishId = pos[2] ?? val("--publish");
    if (!publishId) throw new Error("用法：vk stats series <publishId>");
    const data = await send("stats.series", { publishId });
    if (human) {
      if (!data.points.length) console.log("还没有快照：vk collect --now");
      for (const p of data.points) console.log(`${new Date(p.at).toLocaleString()}  ${p.status.padEnd(8)}${JSON.stringify(p.metrics)}`);
    } else out(data);
    return data;
  }
  if (sub !== "works") throw new Error("用法：vk stats works|series …");
  const data = await send("stats.works", { range: val("--range") ?? "all", ...(val("--publish") ? { publishId: val("--publish") } : {}) });
  if (human) {
    const rows = data.rows.filter((r) => r.latest);
    if (!rows.length) console.log("还没有采集到数据：vk collect --now");
    for (const r of rows) console.log(`${r.platform.padEnd(10)}${String(r.title).slice(0, 24).padEnd(26)}${JSON.stringify(r.latest.metrics)}`);
  } else out(data);
  return data;
}

function usage() {
  console.log(
    [
      "vk — versekit CLI（默认 JSON，--human 给人看）",
      "",
      "用法:",
      "  vk init",
      "  vk now [--human]",
      "  vk doctor [--human]",
      "  vk serve [--open] [--detach] [--port 8787]   # --open 打开本地控制台",
      "  vk commands [--human]",
      "  vk account list | add <platform> --name <名字> | mode <id> auto|manual | reauth <id>",
      "  vk publish <素材> --to tiktok,bilibili [--title] [--schedule 2h] [--visibility] [--dry-run]",
      "  vk publish retry|release|confirm <publishId>",
      "  vk approval list | link <publishId> | apply <token> retry|cancel",
      "  vk collect [--now] [--platform <p>]",
      "  vk stats works [--range 7d] | series <publishId>",
      "  vk publish list [--state failed] [--platform tiktok]",
      "  vk platforms | runs [--state failed] | events [--since <ms>]",
      "  vk setup [--json] | vk channel bind feishu | test feishu",
      "  vk --version",
      "",
      "命令总表由 packages/core/src/commands.mjs 派生（与 Web、飞书卡片同源）。",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------- dispatch

const cmd = pos[0];

try {
  if (!cmd || has("--help") || has("-h")) usage();
  else if (has("--version") || has("-v")) console.log(PKG.version);
  else if (cmd === "init") cmdInit();
  else if (cmd === "now") cmdNow();
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "commands") cmdCommands();
  else if (cmd === "serve") await cmdServe();
  else if (cmd === "account") await cmdAccount();
  else if (cmd === "publish") await cmdPublish();
  else if (cmd === "collect") await cmdCollect();
  else if (cmd === "stats") await cmdStats();
  else if (cmd === "platforms") await cmdPlatforms();
  else if (cmd === "setup") await cmdSetup();
  else if (cmd === "runs") await cmdRuns();
  else if (cmd === "events") await cmdEvents();
  else if (cmd === "channel") await cmdChannel();
  else if (cmd === "approval") await cmdApproval();
  else {
    console.error(`未知命令：${cmd}\n`);
    usage();
    process.exit(2);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (human) console.error(`出错：${message}`);
  else out({ ok: false, error: { code: err.code ?? "error", message } });
  process.exit(1);
}
