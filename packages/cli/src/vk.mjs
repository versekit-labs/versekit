#!/usr/bin/env node
// vk — versekit CLI. Default output is JSON (agents and scripts are the primary caller);
// --human switches to the layout a person reads.
//
// Reads run against the database directly (doctor must work when the daemon is dead); writes go
// through the daemon over the unix socket. That split is the whole point of the architecture:
// one writer, many faces.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { paths, migrate, open, getMeta, isInitialised } from "../../core/src/index.mjs";
import { COMMANDS } from "../../core/src/commands.mjs";
import { loadAdapters, buildHandlers, checkAccount } from "../../core/src/adapters.mjs";
import { createCoreHandlers } from "../../core/src/handlers.mjs";
import { startDaemon } from "../../core/src/daemon.mjs";
import { statusSnapshot, getAccount, getBinding, bindChannel, setAccountState, platformLabelOf, recordPlatformUid, markAccountLoggedOut } from "../../core/src/store.mjs";
import { readConfig, updateConfig, feishuProfileName, feishuAppId } from "../../core/src/config.mjs";
import { fillAndSendCode, clickLoginButton, setInputValue, pageLoggedIn, qrProbe, switchToQr, readQr, refreshQr, qrStateOf, readCreatorId, QR_ACCOUNT_HINT } from "./login-xhs.mjs";
import { doctorReport as buildDoctorReport } from "../../core/src/doctor.mjs";
import channelFeishu from "../../channel-feishu/src/index.mjs";
import { browserReady, openAccount, closeAccount, logoutAccount, closeAllAccounts, adoptOrphanAccounts, closeLoginWindow, cookiePersistenceCheck, hasLiveBrowser, PROFILE, PORT } from "../../driver-browser/src/index.mjs";
import { send, ensureDaemon } from "./client.mjs";
import { createRelayServer } from "../../relay/src/index.mjs";
import { parseArgv, loginCommandOf } from "./argv.mjs";
import * as service from "./service.mjs";
import * as updates from "../../core/src/update.mjs";


// ---------------------------------------------------------------- argv

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
    next: [
      "vk serve --open（打开本地控制台）",
      "vk group add 主矩阵 && vk account add bilibili --group 主矩阵 --name 主号 --credential <cookies.json>",
      "vk doctor --human",
    ],
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
    if (!data.accounts.total) console.log("\n还没有账号：vk group add 主矩阵，然后 vk account add tiktok --group 主矩阵 --name 主号");
  } else out({ ok: true, ...data });
  return data;
}

async function doctorReport() {
  const loaded = await loadAdapters();
  const report = buildDoctorReport({
    browserReady,
    browser: { profile: PROFILE, port: PORT },
    adapters: loaded.adapters,
    adapterErrors: loaded.errors,
  });
  // #100：cookie 存不下来时不能静默——这一项红灯会让整体 ok=false。
  const cookie = cookiePersistenceCheck();
  report.checks.push({ id: "cookie_persist", ok: cookie.ok, detail: cookie.detail, ...(cookie.next ? { next: cookie.next } : {}) });
  report.total = report.checks.length;
  report.passed = report.checks.filter((c) => c.ok).length;
  report.ok = report.ok && cookie.ok;
  return report;
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

/** 还开着的登录窗口数（后台自动更新要等它们结束）；开了太久没动静的当作已被丢下。 */
function activeLogins(now = Date.now()) {
  let n = 0;
  for (const s of loginSessions.values()) {
    const at = s.startedAt ?? s.openedAt ?? s.sentAt ?? now;
    if (now - at < updates.LOGIN_STALE_MS) n += 1;
  }
  return n;
}

/** 创作平台的登录页（所有登录动作都在这个域名下；www.xiaohongshu.com 的扫码会话进不了这里）。 */
async function creatorLoginTab(accountId, { fresh = false } = {}) {
  const tab = await openAccount({
    accountId,
    headless: true,
    reuse: fresh ? false : "creator.xiaohongshu.com",
    ...(fresh ? { url: "https://creator.xiaohongshu.com/login" } : {}),
  });
  const here = await tab.url().catch(() => "");
  if (!/creator\.xiaohongshu\.com/.test(here)) {
    await tab.goto("https://creator.xiaohongshu.com/login", { waitUntil: "domcontentloaded" });
  }
  await tab.waitFor(`!!document.querySelector('input[placeholder*="手机号"]') || !location.pathname.includes('/login')`, [], {
    timeout: 30e3,
    every: 150,
    what: "小红书创作平台登录页",
  });
  return tab;
}

/**
 * 创作平台是否真的登录了。三个证据任一成立：
 *   · cookie 里有 access-token / customer-session / web_session
 *   · 发布页能直接看到上传控件
 */
async function creatorLoggedIn(accountId, knownTab = null) {
  try {
    const tab = knownTab ?? (await openAccount({ accountId, headless: true, reuse: "creator.xiaohongshu.com" }));
    return await pageLoggedIn(tab);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 小红书扫码登录（#101）
//
// 后台用该账号自己的 Chrome profile **无头**打开创作平台登录页 → 切到「APP扫一扫登录」→
// 把页面里的二维码图片（data:image/png）原样交给前端/CLI。人不需要看到任何浏览器窗口。
// 会话只放进程内存（与短信登录一样）：daemon 重启后二维码自然作废，重新点一次即可。

const XHS_CREATOR = "https://creator.xiaohongshu.com";
const XHS_LOGIN = `${XHS_CREATOR}/login`;
const QR_SESSION_MS = 10 * 60e3; // 一次扫码会话最长 10 分钟（中间自动换码）
const QR_PERSIST_MS = 60e3; // 登录成功后最多等 60 秒让会话 cookie 落成持久 cookie
const QR_STALE_MS = 150e3; // 同一张码最多挂 150 秒（平台约 1–2 分钟过期），再久就主动换新
const SESSION_COOKIES = ["web_session", "access-token", "customer-session"];

function setQr(session, qr) {
  session.qr = qr;
  session.qrAt = Date.now();
}

/** 整页重开登录页 → 切扫码 → 取新码。用于「刷新」按钮点不动或页面不显示过期时。 */
async function reloadQr(session) {
  await session.tab.goto(XHS_LOGIN, { waitUntil: "domcontentloaded" });
  await session.tab.waitFor(`/短信登录|扫一扫登录|发送验证码/.test(document.body.innerText || '')`, [], { timeout: 20e3, every: 200, what: "小红书登录页" });
  await switchToQr(session.tab);
  setQr(session, await readQr(session.tab));
}

/**
 * 登录成功后核对平台身份（ACC-acct-iso-02）：读出创作者 id 存到账号上；
 * 同一个小红书号已经接在别的账号上时返回人话，调用方不得把这个账号标成正常。
 * 读不到 id 只记日志、不阻断（没法核对，不等于串号）。
 */
async function bindXhsIdentity(accountId, tab, log = () => {}) {
  const uid = await readCreatorId(tab).catch(() => null);
  if (!uid) {
    log(`[identity] ${accountId} 没读到创作者 id，跳过串号核对`);
    return { ok: true, uid: null };
  }
  const r = recordPlatformUid(accountId, uid);
  if (!r.ok) log(`[identity] ${accountId} 与 ${r.other.accountId} 是同一个小红书号`);
  return r;
}

/** 备用入口：扫码失败（风控、页面改版）时页面和 CLI 都给出这两条，不让人卡住。 */
const QR_FALLBACK = [
  { mode: "sms", label: "短信验证码登录", cli: "vk account login <id> --phone <11 位手机号>" },
  { mode: "window", label: "打开登录窗口", cli: "vk account login <id> --open" },
];
const fallbackFor = (accountId) => QR_FALLBACK.map((f) => ({ ...f, cli: f.cli.replace("<id>", accountId) }));

/** 只看有没有「持久」会话 cookie（expires>0），绝不读取或返回 cookie 的值。 */
async function sessionPersisted(tab) {
  const cookies = await tab.cookies(XHS_CREATOR).catch(() => []);
  return cookies.some((c) => SESSION_COOKIES.includes(c.name) && Boolean(c.value) && c.expires > 0);
}

/** 收尾：只关自己开的东西。账号原本就有活着的浏览器（例如用户的登录窗口）时只关二维码标签页。 */
async function endQrSession(accountId, session) {
  if (loginSessions.get(accountId) === session) loginSessions.delete(accountId);
  if (!session?.tab) return;
  if (session.ownsBrowser) {
    // 自己起的无头实例：整个关掉，Browser.close 会把 cookie 刷到磁盘（关 Chrome 后检查仍为 ok）。
    await closeAccount(accountId).catch(() => {});
  } else {
    await session.tab.close().catch(() => {});
  }
}

function qrFailed(accountId, reason, note) {
  return { mode: "qr", state: "failed", reason, note, fallback: fallbackFor(accountId) };
}

/** account.login.status 的扫码分支。拆出来是为了让 status 主体保持「窗口登录」那条原样。 */
async function qrStatus(accountId, account, session, log = () => {}) {
  // 排队期间会话已被前一次轮询收尾（成功/失败）或被新会话替换：按库里的结果回答，不再碰旧标签页。
  if (loginSessions.get(accountId) !== session) {
    return getAccount(accountId)?.state === "ok"
      ? { mode: "qr", state: "ok", persisted: true, next: "登录成功" }
      : { mode: "qr", state: "idle", note: "这次扫码会话已结束。点「刷新二维码」重新开始。" };
  }
  if (Date.now() - session.startedAt > QR_SESSION_MS) {
    await endQrSession(accountId, session);
    return qrFailed(accountId, "timeout", "10 分钟内没有完成扫码，二维码已作废。点「刷新二维码」重新开始。");
  }
  let probe;
  try {
    probe = await qrProbe(session.tab);
  } catch (err) {
    await endQrSession(accountId, session);
    return qrFailed(accountId, "session_lost", `扫码页面已断开（${err.message}）。点「刷新二维码」重新开始。`);
  }
  const state = session.loggedInAt ? "ok" : qrStateOf(probe);

  if (state === "ok") {
    // 成功判定沿用 creatorLoggedIn 的口径（pageLoggedIn），再要求会话 cookie 已是持久 cookie。
    if (!session.loggedInAt) {
      if (!(await creatorLoggedIn(accountId, session.tab))) return { mode: "qr", state: "pending", note: "已在手机上确认，正在进入创作平台…" };
      session.loggedInAt = Date.now();
    }
    if (await sessionPersisted(session.tab)) {
      const identity = await bindXhsIdentity(accountId, session.tab, log);
      if (!identity.ok) {
        await endQrSession(accountId, session);
        return { mode: "qr", state: "failed", reason: "identity_conflict", note: identity.message, conflict: true };
      }
      if (account.state !== "ok") setAccountState(accountId, "ok");
      await endQrSession(accountId, session);
      log(`[login.qr] ${accountId} 扫码登录成功，登录态已保存`);
      return { mode: "qr", state: "ok", persisted: true, next: "登录成功，登录态已保存到这个账号的浏览器资料里" };
    }
    if (Date.now() - session.loggedInAt > QR_PERSIST_MS) {
      await endQrSession(accountId, session);
      return qrFailed(accountId, "not_persisted", "登录成功了，但小红书只给了临时会话（关掉浏览器就会丢）。请改用「打开登录窗口」登录一次。");
    }
    return { mode: "qr", state: "pending", note: "登录成功，正在确认登录态已保存…" };
  }

  if (state === "expired") {
    // 先点页面自己的「刷新」；点不动再整页重开取新码。两条都不行才停下让人点。
    try {
      setQr(session, await refreshQr(session.tab, session.qr));
    } catch {
      try {
        await reloadQr(session);
      } catch (err) {
        return { mode: "qr", state: "expired", qr: null, note: `二维码已过期，自动换新失败（${err.message}）。点「刷新二维码」再来一次。`, fallback: fallbackFor(accountId) };
      }
    }
    session.refreshes += 1;
    return { mode: "qr", state: "waiting", qr: session.qr, refreshed: true, note: "二维码过期了，已自动换成新的，请重新扫码" };
  }

  if (state === "failed") {
    // 没有风控文案、只是一拍没找到二维码（页面重绘中）时多给两拍，别把正常的刷新当成改版。
    if (!probe.risk && (session.misses = (session.misses ?? 0) + 1) < 3) {
      return { mode: "qr", state: "waiting", qr: session.qr, note: "等待二维码…" };
    }
    await endQrSession(accountId, session);
    const note = probe.risk
      ? `小红书拦下了这次扫码登录：「${probe.risk.trim().slice(0, 60)}」。请改用短信验证码登录，或打开登录窗口自己登录。`
      : "扫码登录页面变了样，没找到二维码。请改用短信验证码登录，或打开登录窗口自己登录。";
    log(`[login.qr] ${accountId} 扫码失败：${probe.risk ? "风控" : "页面结构变化"}`);
    return qrFailed(accountId, probe.risk ? "risk_control" : "page_changed", note);
  }
  session.misses = 0;

  if (state === "scanned") return { mode: "qr", state: "scanned", note: "已扫码，请在手机上确认登录" };

  // 页面自己换了码时把新码带上，前端只在变化时更新图片。
  let refreshed = false;
  if (probe.qr && probe.qr !== session.qr) {
    setQr(session, probe.qr);
    refreshed = true;
  }
  // 兜底：无头页面不一定显示「已失效」（2026-11-14 实测 4 分钟文案不变），
  // 同一张码挂太久还没被扫就主动整页重开换新，免得人扫一张早已作废的码。
  if (!refreshed && Date.now() - session.qrAt > QR_STALE_MS) {
    try {
      await reloadQr(session);
      session.refreshes += 1;
      refreshed = true;
    } catch (err) {
      return { mode: "qr", state: "expired", qr: null, note: `二维码可能已过期，换新失败（${err.message}）。点「刷新二维码」再来一次。`, fallback: fallbackFor(accountId) };
    }
  }
  return { mode: "qr", state: "waiting", qr: session.qr, ...(refreshed ? { refreshed: true } : {}), note: "等待用手机小红书扫码…" };
}

function daemonHandlers(adapters, log) {
  const core = createCoreHandlers({
    adapters,
    log,
    doctor: doctorReport,
    // 更新要停掉守护进程本身，所以交给脱离它的 `vk update --now`（#217）。
    updater: { apply: async () => service.startDetachedUpdate() },
    loginsOpen: activeLogins,
  });
  // 登录也按适配器分派：有 login() 的平台自己决定怎么登录（B站=页面扫码），
  // 没有的继续走下面写死的网页登录地址。命令定义不新增，复用 account.login.* / account.reauth。
  const adapterOf = (platform) => adapters.find((a) => a.platform === platform)?.adapter ?? null;
  return {
    ...buildHandlers(adapters, { log }),
    ...core,
    // 只读：控制台自检页看后台服务的状态；启停卸载只在本机 CLI 做。
    service: async () => service.status(),
    "account.check": async ({ accountId }) => {
      const result = await checkAccount(adapters, accountId);
      const cookie = cookiePersistenceCheck();
      // 登录会掉线是环境问题，账号检查要把话说出来，而不是只报「已登录」。
      return cookie.ok ? result : { ...result, cookie_persist: { ok: false, warning: cookie.detail, next: cookie.next } };
    },

    /**
     * 打开登录窗口，由人自己登录。
     *
     * 为什么不再自动填手机号/验证码：那一段是小红书风控最敏感的地方（受控输入框、
     * 嵌套按钮、倒计时、滑块），自动化踩过的坑比省下的时间多得多；而人自己输一次
     * 只要 20 秒。这里的职责只有两件：把窗口打开、把结果认出来。
     */
    "account.login.open": async ({ accountId }) => {
      const account = getAccount(accountId);
      if (!account) throw new Error(`没有这个账号：${accountId}`);
      // 从扫码切到登录窗口（备用入口）：无头的二维码页先收掉，再起可见窗口。
      const qrSession = loginSessions.get(accountId);
      if (qrSession?.mode === "qr") await endQrSession(accountId, qrSession);
      const adapter = adapterOf(account.platform);
      if (typeof adapter?.login === "function") {
        const result = await adapter.login({ accountId, credentialRef: account.credential_ref ?? null });
        loginSessions.set(accountId, { openedAt: Date.now(), mode: result?.mode ?? "browser" });
        return {
          opened: true,
          url: result?.url ?? null,
          mode: result?.mode ?? "browser",
          next: result?.next ?? `已在 ${account.platform} 的浏览器窗口打开登录页，登录完不用回来点任何按钮，页面会自动识别`,
        };
      }
      const url =
        account.platform === "xiaohongshu"
          ? "https://creator.xiaohongshu.com/login"
          : LOGIN_URL[account.platform];
      if (!url) throw new Error(`${account.platform} 没有网页登录地址`);

      // 有头浏览器：人能看见、能操作。登录成功后这个实例保持运行，发布直接复用。
      const tab = await openAccount({ accountId, url, headless: false });
      loginSessions.set(accountId, { openedAt: Date.now() });
      return {
        opened: true,
        url,
        next: `已在 ${account.platform} 的浏览器窗口打开登录页，登录完不用回来点任何按钮，页面会自动识别`,
      };
    },

    /**
     * 小红书短信验证码登录：扫码登录（account.login.qr）的备用入口，遇到风控时用。
     *
     * 11-07 的审计结论「创作平台只有短信登录」已在 2026-11-14 被推翻：登录卡片右上角
     * 可切到「APP扫一扫登录」，见 account.login.qr。
     */
    "account.login.start": async ({ accountId, phone: rawPhone }) => {
      const account = getAccount(accountId);
      if (!account) throw new Error(`没有这个账号：${accountId}`);
      if (account.platform !== "xiaohongshu") {
        throw new Error(`${account.platform} 不走网页登录：在账号卡上点「登录 / 重新授权」会打开登录页`);
      }
      const phone = String(rawPhone ?? "").trim();
      if (!/^\d{11}$/.test(phone)) throw new Error("手机号要填 11 位数字");
      // 从扫码切到短信（备用入口）：先收掉二维码那一页，免得两个登录页抢同一个会话。
      const qrSession = loginSessions.get(accountId);
      if (qrSession?.mode === "qr") await endQrSession(accountId, qrSession);

      const tab = await creatorLoginTab(accountId, { fresh: true });
      await fillAndSendCode(tab, phone);
      loginSessions.set(accountId, { phone, sentAt: Date.now() });
      // 回给页面和日志的只有打了码的手机号：完整号码只留在这台电脑的内存里（重发要用），不落库。
      return { mode: "sms", phone: `${phone.slice(0, 3)}****${phone.slice(-4)}`, sent: true, next: "验证码已发送，填进页面上的输入框" };
    },

    /**
     * 小红书扫码登录：开始（或重来）。返回二维码图片的 data URL，之后由 account.login.status 轮询。
     * 页面上「刷新二维码」也走这里：旧会话的标签页先收掉，再开一个新的。
     */
    "account.login.qr": async ({ accountId }) => {
      const account = getAccount(accountId);
      if (!account) throw new Error(`没有这个账号：${accountId}`);
      // 适配器自己会取二维码就交给它（视频号）：会话、轮询状态都在适配器里，这里只转发。
      const delegate = adapterOf(account.platform);
      if (typeof delegate?.loginQr === "function") return delegate.loginQr({ accountId });
      if (account.platform !== "xiaohongshu") {
        throw new Error(`${account.platform} 不走这条扫码登录：在账号卡上点「重新登录」`);
      }
      const previous = loginSessions.get(accountId);
      if (previous?.mode === "qr") await endQrSession(accountId, previous);

      const ownsBrowser = !hasLiveBrowser(accountId);
      let tab;
      try {
        tab = await openAccount({ accountId, headless: true });
        await tab.goto(XHS_LOGIN, { waitUntil: "domcontentloaded" });
        // 登录页是 SPA：等卡片渲染出来（短信或扫码任一），或者已经被跳走（本来就登录着）。
        await tab.waitFor(`!location.pathname.includes('/login') || /短信登录|扫一扫登录|发送验证码/.test(document.body.innerText || '')`, [], {
          timeout: 30e3,
          every: 200,
          what: "小红书创作平台登录页",
        });
      } catch (err) {
        if (tab) await endQrSession(accountId, { tab, ownsBrowser });
        throw new Error(`打不开小红书创作平台登录页：${err.message}`);
      }
      const session = { mode: "qr", tab, ownsBrowser, startedAt: Date.now(), qr: null, qrAt: Date.now(), refreshes: 0, misses: 0, loggedInAt: null };
      loginSessions.set(accountId, session);

      if (await pageLoggedIn(tab)) {
        // 本来就登录着：仍要确认是持久会话，交给 status 统一收尾。
        session.loggedInAt = Date.now();
        return { mode: "qr", state: "pending", qr: null, note: "这个账号已经是登录状态，正在确认登录态已保存…" };
      }
      try {
        await switchToQr(tab);
        setQr(session, await readQr(tab));
      } catch (err) {
        await endQrSession(accountId, session);
        log(`[login.qr] ${accountId} 取二维码失败：${err.message}`);
        return qrFailed(accountId, "page_changed", `取不到二维码：${err.message}。可以改用短信验证码登录，或打开登录窗口自己登录。`);
      }
      log(`[login.qr] ${accountId} 已生成二维码（无头）`);
      return {
        mode: "qr",
        state: "waiting",
        qr: session.qr,
        startedAt: session.startedAt,
        next: "用手机小红书扫一扫这个二维码，并在手机上确认登录",
        hint: QR_ACCOUNT_HINT,
      };
    },

    "account.login.resend": async ({ accountId }) => {
      const session = loginSessions.get(accountId);
      if (!session) throw new Error("登录会话已过期，重新填手机号");
      const tab = await creatorLoginTab(accountId);
      await fillAndSendCode(tab, session.phone, { skipPhoneFill: true });
      session.sentAt = Date.now();
      return { sent: true, next: "新验证码已发送，用最新一条" };
    },

    "account.login.status": async ({ accountId }) => {
      const account = getAccount(accountId);
      if (!account) throw new Error(`没有这个账号：${accountId}`);

      // 适配器能读自己的登录窗口时以它为准（B站：cookie 写文件）。写入路径回填到账号行，
      // 之后的 check / 发布 / 采集都只用这一条 credential_ref。
      const adapter = adapterOf(account.platform);
      if (typeof adapter?.loginStatus === "function") {
        const result = await adapter.loginStatus({ accountId, credentialRef: account.credential_ref ?? null });
        if (result?.state === "ok" && result.credentialRef && result.credentialRef !== account.credential_ref) {
          open().prepare("UPDATE account SET credential_ref=? WHERE id=?").run(result.credentialRef, accountId);
        }
        return result;
      }

      // 扫码会话：读无头页面的状态；过期就地换新码，成功后确认持久 cookie 再收尾。
      const qrSession = loginSessions.get(accountId);
      if (qrSession?.mode === "qr") {
        // 页面和 CLI 可能同时在问：串行化，免得两次轮询同时去点「刷新」或整页重开。
        const run = (qrSession.chain ?? Promise.resolve()).then(() => qrStatus(accountId, account, qrSession, log));
        qrSession.chain = run.catch(() => {});
        return run;
      }

      // 只认页面：人在窗口里登录成功后，这里自然变成 ok，不依赖任何内存会话。
      if (await creatorLoggedIn(accountId)) {
        loginSessions.delete(accountId);
        const identity = await bindXhsIdentity(accountId, await openAccount({ accountId, headless: true, reuse: "creator.xiaohongshu.com" }), log).catch(() => ({ ok: true }));
        if (!identity.ok) return { state: "failed", mode: "manual", reason: "identity_conflict", note: identity.message, conflict: true };
        if (account.state !== "ok") setAccountState(accountId, "ok");
        closeLoginWindow(accountId, { cookieUrl: "https://creator.xiaohongshu.com" }).catch(() => {});
        return { state: "ok", mode: "manual" };
      }
      if (!loginSessions.has(accountId)) {
        return { state: "idle", mode: "manual", note: "点「打开登录窗口」，在窗口里登录" };
      }
      return { state: "pending", mode: "manual", note: "等你在浏览器里登录…" };
    },

    "account.login.verify": async ({ accountId, code: rawCode }) => {
      const code = String(rawCode ?? "").trim();
      if (!/^\d{4,8}$/.test(code)) throw new Error("验证码是 4–8 位数字");

      const tab = await creatorLoginTab(accountId);
      await setInputValue(tab, "验证码", code);
      await clickLoginButton(tab);

      // 以「创作平台是否真的登录」为准，最多等 15 秒。
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await creatorLoggedIn(accountId, tab)) {
          loginSessions.delete(accountId);
          const identity = await bindXhsIdentity(accountId, tab, log);
          if (!identity.ok) throw new Error(identity.message);
          // 会话 cookie 已持久化才收登录窗口；小红书若只有内存态会话，closeLoginWindow 会保留窗口。
          const closing = await closeLoginWindow(accountId, { cookieUrl: "https://creator.xiaohongshu.com" }).catch(() => false);
          return { ok: true, state: "ok", next: closing ? "登录成功（登录窗口几秒后自动关闭，登录态已保存）" : "登录成功（浏览器保持登录态，不用再点验证）" };
        }
        const bad = await tab
          .eval(`(() => [...document.querySelectorAll('*')].filter((e) => e.offsetParent && e.children.length === 0 && /错误|失败|不正确|过期|频繁|无效|上限/.test(e.innerText || '')).map((e) => e.innerText.trim()).slice(0, 2).join('；'))()`)
          .catch(() => "");
        if (bad) throw new Error(`登录失败：${bad}`);
      }
      throw new Error("验证码提交了，但创作平台还没放行；可能是验证码错误或需要手机端确认");
    },

    /**
     * 退出登录（#220）：关浏览器、删这个账号自己的 profile、状态变「没连上」。
     * 只动这一个账号；别的账号的 profile 与凭证文件不碰。
     */
    "account.logout": async ({ accountId }) => {
      const account = getAccount(accountId);
      if (!account) throw new Error(`没有这个账号：${accountId}`);
      const session = loginSessions.get(accountId);
      loginSessions.delete(accountId);
      if (session?.mode === "qr") await endQrSession(accountId, session).catch(() => {});
      const r = await logoutAccount(accountId);
      markAccountLoggedOut(accountId);
      log(`[logout] ${accountId} 已退出登录（浏览器资料${r.removed ? "已删除" : "本来就没有"}）`);
      return { accountId, state: "expired", browserClosed: r.closed, profileRemoved: r.removed, next: "现在可以重新登录：vk account login " + accountId + " --qr（或 --phone / --open）" };
    },

    "account.login.cancel": async ({ accountId }) => {
      const session = loginSessions.get(accountId);
      // 扫码会话只收自己开的东西，不碰用户可能正开着的登录窗口。
      if (session?.mode === "qr") {
        await endQrSession(accountId, session);
        return { canceled: true };
      }
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
      // 适配器自带登录流程时用它：B站会打开扫码窗口，不再回一句「去终端跑 biliup」。
      const adapter = adapterOf(account.platform);
      if (typeof adapter?.login === "function") {
        const result = await adapter.login({ accountId, credentialRef: account.credential_ref ?? null });
        log(`[reauth] 打开 ${account.platform} 登录窗口（账号 ${accountId}）`);
        return {
          accountId,
          started: true,
          mode: result?.mode ?? "browser",
          next: result?.next ?? `已在 ${account.platform} 的浏览器窗口打开登录窗口，完成后页面会自动确认`,
        };
      }
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
  if (has("--offline") && has("--detach")) throw new Error("--offline 不支持 --detach：离线服务只在前台跑，用完直接 Ctrl-C");

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

  const offline = has("--offline");
  // 离线模式连适配器都不加载：不会有任何东西能走到真实平台。
  const { adapters, errors } = offline ? { adapters: [], errors: [] } : await loadAdapters();
  const log = (m) => (human ? console.log(m) : console.error(m));
  const handlers = daemonHandlers(adapters, log);
  const port = Number(val("--port") ?? 8787);
  const host = has("--lan") ? "0.0.0.0" : "127.0.0.1";
  updateConfig({ server: { port, host } });
  // 后台自动更新只在「用安装命令装出来的」程序上有意义；源码目录里（开发）不启动。
  const autoUpdate = service.installLayout().installed ? { apply: async () => service.startDetachedUpdate(), busy: activeLogins } : null;
  const daemon = await startDaemon({ handlers, log, port, host, channels: offline ? [] : [channelFeishu], doctor: doctorReport, offline, autoUpdate });
  if (offline) log("离线模式：不会访问任何平台");

  const web = `http://127.0.0.1:${daemon.port}`;
  if (has("--open")) openBrowser(web);
  log(`versekit 守护进程已启动：${web} · socket ${daemon.socketPath}`);
  if (!offline) log(`适配器 ${adapters.length} 个${adapters.length ? "：" + adapters.map((a) => a.platform).join(", ") : "（尚未安装）"}`);
  for (const e of errors) log(`适配器加载失败 ${e.dir}: ${e.message}`);

  // 上一任守护进程（被 kill -9 / 重启）留下的账号 Chrome：接管并纳入空闲回收。
  (offline ? Promise.resolve([]) : adoptOrphanAccounts())
    .then((ids) => ids.length && log(`接管了 ${ids.length} 个遗留的账号浏览器：${ids.join(", ")}（空闲后自动回收）`))
    .catch((err) => log(`接管遗留账号浏览器失败：${err.message}`));

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      log(`\n收到 ${sig}，正在停止`);
      await daemon.close().catch(() => {});
      // Chrome 是 detached 起的，不在这里关就会变成孤儿（#91）。
      const closed = await closeAllAccounts().catch(() => 0);
      if (closed) log(`已关闭 ${closed} 个账号浏览器`);
      process.exit(0);
    });
  }
  await new Promise(() => {});
}

async function cmdService() {
  const sub = pos[1];
  const log = (m) => console.error(m);
  const show = (d) => {
    if (!human) return out(d);
    if (!d.installed) return console.log("后台服务：未安装（运行安装命令，或 vk service install）");
    console.log(line("后台服务", `${d.label}（${d.manager}）`));
    console.log(line("状态", d.running ? `运行中${d.pid ? `（pid ${d.pid}）` : ""}` : "已停止"));
    console.log(line("控制台", `${d.url}${d.reachable ? "（能打开）" : "（打不开）"}`));
    console.log(line("日志", d.log));
  };
  let data;
  if (sub === "status") data = await service.status();
  else if (sub === "start") data = await service.start();
  else if (sub === "stop") data = await service.stop();
  else if (sub === "restart") data = await service.restart();
  else if (sub === "install") {
    const port = Number(val("--port") ?? process.env.VERSEKIT_PORT ?? service.DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口不对：${val("--port")}`);
    const offline = has("--offline") || process.env.VERSEKIT_OFFLINE === "1";
    data = await service.install({ port, offline });
    show(data);
    if (!data.up) process.exitCode = 1;
    if (data.note && human) console.log(data.note);
    return data;
  } else if (sub === "uninstall") {
    data = await service.uninstall({ purge: has("--purge"), serviceOnly: has("--service-only"), log: human ? console.log : log });
    if (human) {
      console.log(`后台服务已卸载（${data.label}）${data.removed.length ? "：\n  " + data.removed.join("\n  ") : ""}`);
      if (data.purged.length) console.log(`已删除数据：\n  ${data.purged.join("\n  ")}`);
      else if (data.kept_data.length) console.log(`数据已保留：\n  ${data.kept_data.join("\n  ")}\n（要连数据一起删：vk service uninstall --purge）`);
    } else out(data);
    return data;
  } else throw new Error("用法：vk service status | start | stop | restart | uninstall [--purge]");
  show(data);
  return data;
}

/** vk version：版本号 + 短提交号 + 安装时间（ACC-update-01）。 */
async function cmdVersion() {
  const v = updates.statusView();
  if (has("--json")) return out(v);
  console.log(updates.versionLine(updates.buildInfo()));
  console.log(line("自动更新", v.auto ? `开（每 ${v.intervalHours} 小时检查一次，空闲时更新）` : "关（vk update --auto on 打开）"));
  if (v.lastCheckAt) console.log(line("上次检查", `${new Date(v.lastCheckAt).toLocaleString()}：${v.lastCheck?.message ?? ""}`));
  if (v.lastFailure) console.log(line("最近失败", v.lastFailure.message));
}

/** vk update [--check] [--auto on|off] [--now]（ACC-update-02）：检查 / 开关走和 HTTP 同一个 handler，更新在本进程里做。 */
async function cmdUpdate() {
  const core = createCoreHandlers({});
  // --auto 不在 argv.mjs 的带值参数表里，on|off 就是紧跟在 update 后面的位置参数。
  const auto = has("--auto") ? pos[1] : undefined;
  if (has("--auto") && !["on", "off"].includes(auto)) throw new Error("用法：vk update --auto on|off");
  if (auto != null || has("--check")) {
    const r = await core.update({ check: has("--check"), auto: auto ?? null });
    if (human || auto != null) console.log(r.message);
    else out(r);
    return r;
  }
  const idle = updates.idleState();
  if (!idle.idle && !has("--now")) throw new Error(`现在不适合更新：${idle.reason}。等忙完再试，或加 --now 强制更新`);
  const r = await service.applyUpdate({ log: (m) => console.error(m) });
  if (human) console.log(r.message);
  else out(r);
  if (!r.ok) process.exitCode = 1;
  return r;
}

async function cmdDemo() {
  const sub = pos[1];
  if (sub !== "seed") throw new Error("用法：vk demo seed（在当前 VK_HOME 造演示数据）");
  const { seedDemoAsync } = await import("../../../scripts/demo-seed.mjs");
  const data = await seedDemoAsync();
  if (human) console.log(`演示数据已写入 ${paths().root}：${data.works} 个作品、${data.publishes} 条平台稿`);
  else out(data);
  return data;
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

/** data:image/png;base64,… → 写成本机文件（0600），返回路径。同一账号覆盖同一个文件，换码时路径不变。 */
function writeQrImage(accountId, dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(String(dataUrl ?? ""));
  if (!m) throw new Error("服务端返回的二维码不是图片");
  const dir = join(tmpdir(), "versekit-login");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${accountId.replace(/[^\w.-]/g, "_")}-qr.${m[1] === "jpeg" ? "jpg" : m[1]}`);
  writeFileSync(file, Buffer.from(m[2], "base64"), { mode: 0o600 });
  return file;
}

/**
 * vk account login <id> --qr：取二维码 → 写成图片文件并打印路径 → 每 2 秒问一次状态，
 * 直到成功、失败或整场会话过期。过程信息在 JSON 模式下走 stderr，stdout 只留最终结果。
 */
async function cmdLoginQr(accountId) {
  const say = (m) => (human ? console.log(m) : process.stderr.write(m + "\n"));
  const start = await send("account.login.qr", { accountId }, { timeout: 90e3 });
  if (start.state === "failed") {
    const tips = (start.fallback ?? []).map((f) => `  备用：${f.label} → ${f.cli}`).join("\n");
    throw new Error(`${start.note}${tips ? "\n" + tips : ""}`);
  }
  let qrPath = null;
  if (start.qr) {
    qrPath = writeQrImage(accountId, start.qr);
    say(`二维码图片：${qrPath}`);
    say("用手机小红书扫一扫这张图，并在手机上确认登录（二维码过期会自动换新，路径不变）");
    say(QR_ACCOUNT_HINT);
  } else if (start.note) say(start.note);

  const deadline = Date.now() + 10 * 60e3;
  let lastNote = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await send("account.login.status", { accountId });
    if (status.qr && status.refreshed) {
      qrPath = writeQrImage(accountId, status.qr);
      say(`二维码已过期，已换新：${qrPath}`);
    }
    if (status.state === "ok") {
      const data = { accountId, state: "ok", mode: "qr", persisted: status.persisted === true, qrPath, next: status.next ?? "登录成功" };
      if (human) console.log(data.next);
      else out(data);
      return data;
    }
    if (status.state === "failed" || status.state === "expired" || status.state === "idle") {
      const tips = (status.fallback ?? []).map((f) => `  备用：${f.label} → ${f.cli}`).join("\n");
      throw new Error(`${status.note ?? "扫码登录没有完成"}${tips ? "\n" + tips : ""}`);
    }
    if (status.note && status.note !== lastNote) {
      lastNote = status.note;
      say(status.note);
    }
  }
  await send("account.login.cancel", { accountId }).catch(() => {});
  throw new Error("10 分钟内没有完成扫码，已取消。重新运行 vk account login " + accountId + " --qr");
}

async function cmdAccount() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);
  if (sub === "list") {
    const data = await send("account.list", val("--group") ? { group: val("--group") } : {}, { log });
    if (human) {
      if (data.group) console.log(`账号组：${data.group.name}`);
      if (!data.accounts.length) console.log(`还没有账号：vk account add tiktok --group ${data.group?.name ?? "<组>"} --name 主号`);
      for (const a of data.accounts) {
        const who = a.avatar_url && a.display_name ? `  ${a.display_name}（头像 ${a.avatar_url}）` : "";
        console.log(`${a.id.padEnd(16)}${platformLabelOf(a.platform).padEnd(12)}${a.handle.padEnd(18)}${a.state}${who}`);
      }
    } else out(data);
    return data;
  }
  if (sub === "show") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account show <accountId>");
    const data = await send("account.show", { accountId }, { log });
    if (human) {
      const a = data.account;
      console.log(`${a.id}  ${platformLabelOf(a.platform)}  ${a.handle}  ${a.displayState ?? a.state}`);
      if (data.loginClock) console.log(`登录时长：${data.loginClock.label}`);
    } else out(data);
    return data;
  }
  if (sub === "checktime") {
    const time = pos[2];
    const data = time ? await send("login.checktime.set", { time }, { log }) : await send("login.checktime.show", {}, { log });
    if (human) console.log(time ? data.note : `视频号每天 ${data.time} 查一次登录`);
    else out(data);
    return data;
  }
  if (sub === "add") {
    const platform = pos[2];
    if (!platform) throw new Error("用法：vk account add <platform> --group <组> --name <名字>");
    const group = val("--group");
    if (!group) throw new Error("用法：vk account add <platform> --group <组> --name <名字>（账号必须属于一个账号组）");
    const name = val("--name") ?? platform;
    const data = await send(
      "account.add",
      {
        platform,
        name,
        group,
        ...(val("--handle") ? { handle: val("--handle") } : {}),
        ...(val("--credential") ? { credentialRef: val("--credential") } : {}),
      },
      { log },
    );
    if (human) console.log(`已添加 ${platformLabelOf(platform)} ${name}（${data.id}）到账号组「${data.group.name}」\n${data.next ?? ""}`);
    else out(data);
    return data;
  }
  if (sub === "logout") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account logout <accountId>");
    const data = await send("account.logout", { accountId }, { log });
    if (human) console.log(`已退出登录：${accountId} 的浏览器已关闭、浏览器资料已删除，状态是「没连上」\n${data.next}`);
    else out(data);
    return data;
  }
  if (sub === "remove") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account remove <accountId>");
    const data = await send("account.remove", { accountId }, { log });
    if (human) {
      console.log(`已移除 ${data.platform} ${data.handle}（${accountId}）${data.group ? `，${data.group.name} 的这个平台槽位已空出` : ""}`);
      if (data.historyKept) console.log(`历史 ${data.historyKept} 条发布仍保留（只移除账号，不删数据）`);
      console.log("现在可以重新添加这个平台的账号：vk account add <platform> --group <组> --name <名字>");
    } else out(data);
    return data;
  }
  // TikTok 官方接口授权：第一次调用拿到授权链接，之后轮询到完成（会话在守护进程里）。
  if (sub === "connect") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account connect <accountId>");
    let data = await send("account.connect", { accountId }, { log });
    if (data.state === "waiting") {
      // 链接走 stderr：stdout 留给 JSON，管道里的脚本不会被它污染。
      console.error(`请在浏览器里打开下面的链接，用 TikTok 登录并同意授权：\n${data.url}`);
      if (!process.env.VK_NO_BROWSER) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        try {
          spawn(opener, process.platform === "win32" ? ["/c", "start", "", data.url] : [data.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
        } catch {
          /* 打不开浏览器不算失败：链接已经打印 */
        }
      }
      const deadline = Date.now() + 6 * 60e3;
      while (data.state === "waiting" && Date.now() < deadline) {
        data = await send("account.connect", { accountId, timeoutMs: 15000 }, { log });
      }
      if (data.state === "waiting") throw new Error("6 分钟内没有完成授权，已放弃：重新运行 vk account connect " + accountId);
    }
    if (human) console.log(`已连接 TikTok：${data.displayName ?? "（没有昵称）"}${data.avatarUrl ? `\n头像：${data.avatarUrl}` : ""}`);
    else out(data);
    return data;
  }
  // 平台应用凭证（目前只有 TikTok 官方接口）。secret 不进命令行历史：优先 stdin / 环境变量，--client-secret 只是兜底。
  if (sub === "credentials") {
    const platform = pos[2];
    const usage = "用法：vk account credentials tiktok --client-key <key>（secret 从 stdin 或 TIKTOK_CLIENT_SECRET 读，也可 --client-secret <secret>）";
    if (!platform) throw new Error(usage);
    const clientKey = val("--client-key") ?? process.env.TIKTOK_CLIENT_KEY;
    let clientSecret = val("--client-secret") ?? process.env.TIKTOK_CLIENT_SECRET;
    if (!clientSecret && !process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      clientSecret = Buffer.concat(chunks).toString("utf8").trim();
    }
    if (!clientKey || !clientSecret) throw new Error(usage);
    const platformId = platform === "tiktok" ? "tiktok-api" : platform;
    const data = await send("account.credentials", { platform: platformId, clientKey, clientSecret }, { log });
    if (human) console.log(`已保存 ${platformLabelOf(platformId)} 应用凭证（client key ${data.clientKey}），secret 只在本机 config.json（权限 600）。下一步：vk account connect <accountId>`);
    else out(data);
    return data;
  }
  if (sub === "creator") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account creator <accountId>");
    const data = await send("account.creator", { accountId }, { log });
    if (human) {
      console.log(`TikTok 创作者：${data.nickname ?? "?"}`);
      console.log(`可选隐私级别：${data.privacyLevelOptions.join(" / ") || "（TikTok 没有返回可选项）"}`);
      const flag = (off) => (off ? "不允许" : "允许");
      console.log(`评论：${flag(data.commentDisabled)}  合拍：${flag(data.duetDisabled)}  拼接：${flag(data.stitchDisabled)}`);
      console.log(`最长时长：${data.maxVideoPostDurationSec ?? "?"} 秒`);
    } else out(data);
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
    const usage = "用法：vk account login <accountId> --qr | --phone <11 位手机号> | --code <验证码> | --resend | --open | --status | --cancel";
    if (!accountId) throw new Error(usage);
    const cmd = loginCommandOf(accountId, flags);
    if (!cmd) throw new Error(`${usage}（--phone / --code 后面要跟值）`);
    if (cmd.name === "account.login.qr") return cmdLoginQr(accountId);
    const data = await send(cmd.name, cmd.args);
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
  throw new Error("用法：vk account list [--group <组>] | show <accountId> | checktime [时:分] | add <platform> --group <组> --name <名字> | remove <accountId> | mode <accountId> auto|manual | reauth <accountId> | check <accountId> | login …");
}

async function cmdBootstrap() {
  const data = await send("bootstrap", {}, { log: (m) => human && console.log(m) });
  if (human) {
    console.log(`当前账号组      ${data.current?.name ?? "未选择（先 vk group add <名字>）"}`);
    console.log(`账号            ${data.accounts.length} 个（当前组 ${data.freshness.total} 个）`);
    console.log(
      `作品 / 发布     ${data.counts.works} 个作品 · ${data.counts.publishes} 条平台发布（${data.counts.publishedPublishes} 条已发布）`,
    );
    console.log(`数据新鲜度      ${data.freshness.ratio} 个账号 1 小时内采集`);
    for (const account of data.accounts.filter((a) => a.group_id === data.current?.id)) {
      console.log(`  ${account.platform.padEnd(12)}${account.handle.padEnd(18)}${account.freshness.level.padEnd(8)}${account.freshness.reason}`);
    }
    console.log(`组 / 矩阵       ${data.groups.length} 个组 · 跨组矩阵只读`);
  } else out(data);
  return data;
}

const clock = (ms) => (ms == null ? "没定时间" : new Date(ms).toLocaleString());
const ratio = (r) => (r.multiple == null ? `不比（${r.reason}）` : `${r.multiple} 倍 · ${r.verdictLabel}`);

async function cmdToday() {
  const data = await send("today", { ...(val("--group") ? { group: val("--group") } : {}) });
  if (!human) return out(data), data;
  console.log(`账号组：${data.group?.name ?? "全部"}`);
  console.log(`\n等确认（${data.awaiting.length} 个作品）`);
  for (const w of data.awaiting) {
    for (const c of w.cuts) {
      console.log(`  ${w.title} / ${c.title}：${c.publishes.map((p) => `${p.platform}${p.perItem ? "（逐条）" : ""}`).join("、")}`);
    }
  }
  console.log(`\n出了问题（${data.problems.length}）`);
  for (const p of data.problems) console.log(`  ${p.workTitle} → ${p.platform} ${p.handle}：${p.error?.message ?? p.state}`);
  console.log(`\n已确认等时间（${data.scheduled.length}）`);
  for (const p of data.scheduled) console.log(`  ${clock(p.scheduledAt)}  ${p.workTitle} → ${p.platform} ${p.handle}`);
  console.log(`\n满 24 小时的结果（${data.results.length}）`);
  for (const r of data.results) console.log(`  ${r.workTitle} → ${r.platform} ${r.handle}：${r.play24h ?? "没数据"} 播放 · ${ratio(r)}`);
  if (data.others.length) console.log(`\n其他组：${data.others.map((o) => `${o.group.name} ${o.total} 件`).join("、")}`);
  return data;
}

async function cmdWork() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);
  const usage = "用法：vk work list [--group <组>] | show <workId> | add <视频文件或图片目录> [--title <标题>] | add <清单.json> | push <清单.json> --group <组名>";
  if (sub === "push") {
    const target = pos[2];
    if (!target) throw new Error(usage);
    if (!val("--group")) throw new Error("vk work push 要 --group <组名>：投递到发布机上的哪个账号组");
    // 上传可能很久（出口带宽窄）：守护进程那一头不设上限，这里也放宽到 3 小时。
    const data = await send("work.push", { manifest: resolve(target), group: val("--group") }, { log, timeout: 3 * 3600e3 });
    if (human) {
      console.log(`已上传：${data.files} 个文件，${(data.bytes / 1048576).toFixed(1)}MB`);
      console.log(`投递 ${data.id} → 账号组「${data.group}」`);
      console.log("等发布机拉取（发布机上入库后一律待确认，不会自动发）");
    } else out(data);
    return data;
  }
  if (sub === "list" || !sub) {
    const data = await send("work.list", { ...(val("--group") ? { group: val("--group") } : {}) }, { log });
    if (human) {
      if (data.group) console.log(`账号组：${data.group.name}`);
      if (!data.works.length) console.log("还没有作品：vk work add <视频文件>");
      for (const w of data.works) {
        console.log(`${w.id.padEnd(18)}${String(w.title).padEnd(24)}${w.status.label.padEnd(12)}${w.cuts} 支成片 · ${w.versions} 个版本 · ${w.publishes} 条平台稿`);
      }
    } else out(data);
    return data;
  }
  if (sub === "show") {
    const workId = pos[2];
    if (!workId) throw new Error(usage);
    const data = await send("work.show", { workId, ...(val("--group") ? { group: val("--group") } : {}) }, { log });
    if (human) {
      const w = data.work;
      console.log(`${w.title}（${w.id}）  ${w.status.label}`);
      for (const c of w.cuts) {
        console.log(`  成片 ${c.title}  ${c.status.label}`);
        for (const v of c.versions) console.log(`    版本 ${v.language.padEnd(10)}${v.asset}`);
        for (const p of c.publishes) {
          console.log(`    平台稿 ${p.platform.padEnd(12)}${p.handle.padEnd(16)}${p.state}${p.language ? `（${p.language}）` : ""}`);
          console.log(`      标题：${p.title || "（空）"}`);
          console.log(`      正文：${p.empty?.includes("body") ? "（没有正文）" : p.body.split("\n")[0].slice(0, 60)}`);
          console.log(`      话题：${p.empty?.includes("tags") ? "（没有话题）" : p.tags.map((t) => `#${t}`).join(" ")}`);
        }
      }
    } else out(data);
    return data;
  }
  if (sub === "add") {
    const target = pos[2];
    if (!target) throw new Error(usage);
    // 路径在这里就解析成绝对的：守护进程的工作目录不是你敲命令的目录。
    let args;
    if (extname(target).toLowerCase() === ".json") {
      if (!existsSync(target)) throw new Error(`找不到清单：${target}`);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(target, "utf8"));
      } catch (err) {
        throw new Error(`清单不是合法的 JSON：${target}（${err.message}）`);
      }
      const base = dirname(resolve(target));
      args = {
        title: val("--title") ?? manifest.title,
        ...(manifest.source ? { source: resolve(base, manifest.source) } : {}),
        cuts: (manifest.cuts ?? []).map((c) => ({
          title: c.title,
          ...(c.copy ? { copy: c.copy } : {}),
          ...(c.cover ? { cover: resolve(base, c.cover) } : {}),
          versions: (c.versions ?? []).map((v) => ({
            language: v.language,
            asset: v.asset ? resolve(base, v.asset) : v.asset,
            ...(v.cover ? { cover: resolve(base, v.cover) } : {}),
            ...(v.meta ? { meta: v.meta } : {}),
            ...(v.copy ? { copy: v.copy } : {}),
          })),
        })),
      };
    } else {
      args = { asset: resolve(target), ...(val("--title") ? { title: val("--title") } : {}) };
    }
    const data = await send("work.add", args, { log });
    if (human) {
      console.log(`${data.updated ? "已更新" : "已入库"}作品「${data.work.title}」（${data.id}）：成片 新建 ${data.cuts.created}/更新 ${data.cuts.updated}，版本 新建 ${data.versions.created}/更新 ${data.versions.updated}`);
    } else out(data);
    return data;
  }
  throw new Error(usage);
}

/** vk relay serve|status|connect|pull|token（#226）。serve 是云端（volc1）上跑的中转，不需要数据库。 */
async function cmdRelay() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);
  const usage = "用法：vk relay serve [--port 8790] [--data <目录>] | status | connect <地址> --token <token> [--push] | disconnect | pull | token push|pull";
  if (sub === "serve") {
    const { mkdirSync, chmodSync: chmod } = await import("node:fs");
    const { randomBytes } = await import("node:crypto");
    const p = paths();
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    const cfg = readConfig().relay ?? {};
    const fresh = {};
    for (const k of ["push_token", "pull_token"]) if (!cfg[k]) fresh[k] = randomBytes(24).toString("base64url");
    if (Object.keys(fresh).length) {
      updateConfig({ relay: fresh });
      chmod(p.configFile, 0o600);
      console.error("[relay] 已生成缺少的 token，写入 config.json（权限 600）；用 vk relay token push|pull 取出");
    }
    const conf = readConfig().relay;
    const dataDir = val("--data") ?? conf.data_dir ?? join(p.state, "relay");
    const port = Number(val("--port") ?? conf.port ?? 8790);
    const relay = createRelayServer({ dataDir, pushToken: conf.push_token, pullToken: conf.pull_token, log: (m) => console.error(m) });
    const bound = await relay.listen({ port });
    console.error(`[relay] 监听 127.0.0.1:${bound}（数据目录 ${dataDir}）；HTTPS 由反向代理提供`);
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => relay.close().then(() => process.exit(0)));
    await new Promise(() => {});
  }
  if (sub === "token") {
    const which = pos[2];
    if (!["push", "pull"].includes(which)) throw new Error(usage);
    const token = readConfig().relay?.[`${which}_token`];
    if (!token) throw new Error("还没有这个 token：先在云端 vk relay serve 一次，它会自动生成");
    console.log(token);
    return;
  }
  if (sub === "status") {
    const data = await send("relay.status", {}, { log });
    if (human) {
      const label = { not_configured: "没配置", never: "已配置，还没拉取过", ok: "正常", error: "连不上" }[data.connection];
      console.log(`中转：${label}${data.url ? `（${data.url}）` : ""}`);
      if (data.lastPullAt) console.log(`上次拉取：${new Date(data.lastPullAt).toLocaleString()}`);
      if (data.lastError) console.log(`上次出错：${data.lastError.message}`);
      for (const d of data.downloading) console.log(`正在下载：${d.id} ${d.name} ${d.percent}%`);
      console.log(`每 ${data.intervalMinutes} 分钟拉取一次；还没拉完的投递 ${data.pending} 个`);
      for (const f of data.failures) console.log(`没入库：${f.id}：${f.message}`);
    } else out(data);
    return data;
  }
  if (sub === "disconnect") {
    const data = await send("relay.disconnect", {}, { log });
    if (human) console.log(data.message);
    else out(data);
    return data;
  }
  if (sub === "connect") {
    if (!pos[2] || !val("--token")) throw new Error(usage);
    const data = await send("relay.connect", { url: pos[2], token: val("--token"), ...(has("--push") ? { push: true } : {}) }, { log });
    if (human) console.log(data.message);
    else out(data);
    return data;
  }
  if (sub === "pull") {
    // 不沉默（ACC-relay-06）：先说有几个投递，每个开始/结束各一行，下载中每 10 秒报一次大小，最后汇总。
    // 进度行 human 时走 stdout，--json 时走 stderr，不污染 JSON。
    const say = (m) => (human ? console.log(m) : console.error(m));
    const mb = (n) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)}MB`;
    const nameOf = (i) => (i.title ? `「${i.title}」` : i.id);
    const t0 = Date.now();
    const seen = new Set();
    let announced = false;
    let lastBytesAt = 0;
    const render = (st) => {
      const rd = st.round;
      if (!rd || (rd.finishedAt && rd.finishedAt < t0)) return; // 上一轮留下的，不是这次的
      if (!announced && (rd.total > 0 || rd.finishedAt)) {
        announced = true;
        say(rd.total ? `这一轮有 ${rd.total} 个投递` : "没有新投递");
      }
      for (const it of rd.items) {
        const tag = `${it.index}/${rd.total}`;
        if (!seen.has(`${it.id}:begin`)) {
          seen.add(`${it.id}:begin`);
          say(`正在下载 ${tag}：${nameOf(it)}${it.size != null ? `，${mb(it.size)}` : ""}`);
        }
        if (it.state !== "downloading" && !seen.has(`${it.id}:end`)) {
          seen.add(`${it.id}:end`);
          if (it.state === "ingested") say(`已入库 ${tag}：${nameOf(it)}，平台稿 ${it.drafts ?? 0} 条待确认`);
          else if (it.state === "failed") say(`没入库 ${tag}：${nameOf(it)}：${it.reason}`);
          else say(`没下完 ${tag}：${nameOf(it)}：${it.reason}（下一轮接着下）`);
        }
      }
      const d = st.downloading?.[0];
      if (d && Date.now() - lastBytesAt >= 10e3) {
        lastBytesAt = Date.now();
        say(`  下载中：${d.title ? `「${d.title}」` : d.name} ${mb(d.received)}/${mb(d.total)}（${d.percent}%）`);
      }
    };
    const first = await send("relay.status", {}, { log });
    const joined = first.pulling;
    if (joined) say("后台正在拉取，进度：");
    let finished = false;
    const job = joined
      ? (async () => {
          while ((await send("relay.status", {}, { log })).pulling) await new Promise((r) => setTimeout(r, 1000));
        })()
      : send("relay.pull", {}, { log, timeout: 3 * 3600e3 });
    const ticker = (async () => {
      while (!finished) {
        await send("relay.status", {}, { log }).then(render, () => {});
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    let data;
    try {
      data = await job;
    } finally {
      finished = true;
      await ticker;
    }
    const last = await send("relay.status", {}, { log });
    render(last);
    const items = last.round?.items ?? [];
    const pick = (state) => items.filter((i) => i.state === state);
    const result = joined || !data
      ? { ingested: pick("ingested").map((i) => i.id), failed: pick("failed").map((i) => ({ id: i.id, reason: i.reason })), pending: pick("pending").map((i) => ({ id: i.id, error: i.reason })) }
      : data;
    const bad = result.failed.map((f) => `${nameOf(items.find((i) => i.id === f.id) ?? f)}：${f.reason}`);
    say(`汇总：入库 ${result.ingested.length}，失败 ${result.failed.length}${bad.length ? `（${bad.join("；")}）` : ""}，没下完 ${result.pending.length}${result.ingested.length ? "；去「今天」页确认平台稿" : ""}`);
    if (!human) out(result);
    return result;
  }
  throw new Error(usage);
}

async function cmdPlan() {
  const sub = pos[1] ?? "show";
  const log = (m) => human && console.log(m);
  const usage = "用法：vk plan show | vk plan set --to <平台,平台> [--kind video|image] [--lang zh|en] [--delay-days N] [--remove] | vk plan reset | vk plan apply <cutId> [--accounts a,b] [--group <组>]";
  const groupArg = val("--group") ? { group: val("--group") } : {};
  const printPlan = (data) => {
    console.log(`发布方案 · ${data.group?.name ?? "（没有账号组）"}${data.isDefault ? "（默认方案）" : ""}`);
    for (const r of data.rows) console.log(`  ${r.label.padEnd(14)}→ ${r.platforms.map((p) => p.name).join("、") || "（还没有接入平台）"}  ${r.rhythm}`);
    console.log("平台规则（每个账号）：");
    for (const r of data.rules) console.log(`  ${r.name.padEnd(10)}每天最多 ${r.dailyCap} 条，两条至少隔 ${r.minGapMinutes} 分钟${r.isDefault ? "（默认值）" : ""}`);
  };
  if (sub === "show" || sub === "set" || sub === "reset") {
    let data;
    if (sub === "show") data = await send("plan.show", groupArg, { log });
    else if (sub === "reset") data = await send("plan.reset", groupArg, { log });
    else {
      const to = val("--to");
      const remove = has("--remove");
      if (!to && !remove) throw new Error(usage);
      const days = val("--delay-days");
      data = await send(
        "plan.set",
        {
          ...(val("--kind") ? { kind: val("--kind") } : {}),
          ...(val("--lang") ? { language: val("--lang") } : {}),
          ...(to ? { platforms: String(to).split(",").map((x) => x.trim()).filter(Boolean) } : {}),
          ...(days != null ? { delayDays: Number(days) } : {}),
          ...(remove ? { remove: true } : {}),
          ...groupArg,
        },
        { log },
      );
    }
    if (human) printPlan(data);
    else out(data);
    return data;
  }
  if (sub !== "apply") throw new Error(usage);
  const cutId = pos[2];
  if (!cutId) throw new Error(usage);
  const accounts = val("--accounts");
  const args = {
    cutId,
    ...(accounts ? { accounts: String(accounts).split(",").map((x) => x.trim()).filter(Boolean) } : {}),
    ...groupArg,
  };
  const data = await send("plan.apply", args, { log });
  if (human) {
    console.log(`成片「${data.cutTitle}」（${data.cutId}，${data.language} 版）`);
    console.log(`建了 ${data.created.length} 条平台稿（都是待确认，不会自动发）`);
    for (const p of data.created) {
      console.log(`  ${p.platform.padEnd(12)}${p.handle.padEnd(16)}建议 ${clock(p.suggestedAt)}  ${p.publishId}`);
      console.log(`    标题：${p.title}${p.empty.includes("body") ? " · 没有正文" : ""}${p.empty.includes("tags") ? " · 没有话题" : ""}`);
    }
    for (const p of data.skipped) console.log(`跳过 ${p.platform} ${p.handle}：${p.reason}（${p.publishId}）`);
    for (const p of data.rejected) console.log(`没建 ${p.platform} ${p.handle}：${p.reason}`);
    if (data.next) console.log(data.next);
  } else out(data);
  return data;
}

async function cmdGroup() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);
  if (sub === "list" || !sub) {
    const data = await send("group.list", {}, { log });
    if (human) {
      if (!data.groups.length) console.log("还没有账号组：vk group add <名字>");
      for (const g of data.groups) {
        const mark = data.current?.id === g.id ? "*" : " ";
        console.log(`${mark} ${g.id.padEnd(16)}${String(g.name).padEnd(18)}${g.account_count} 个账号`);
      }
    } else out(data);
    return data;
  }
  if (sub === "add") {
    const name = pos.slice(2).join(" ") || val("--name");
    if (!name) throw new Error("用法：vk group add <名字>");
    const data = await send("group.add", { name }, { log });
    if (human) console.log(`${data.existed ? "已存在并切换到" : "已新建并进入"}账号组 ${data.name}（${data.id}）\n${data.next}`);
    else out(data);
    return data;
  }
  if (sub === "rename") {
    const group = pos[2];
    const name = pos.slice(3).join(" ");
    if (!group || !name) throw new Error("用法：vk group rename <组 id 或名字> <新名字>");
    const data = await send("group.rename", { group, name }, { log });
    if (human) console.log(data.changed ? `账号组改名：${data.previous} → ${data.name}` : `名字没变：${data.name}`);
    else out(data);
    return data;
  }
  if (sub === "use") {
    const group = pos[2];
    if (!group) throw new Error("用法：vk group use <组 id 或名字>");
    const data = await send("group.use", { group }, { log });
    if (human) console.log(`当前账号组 → ${data.current.name}`);
    else out(data);
    return data;
  }
  throw new Error("用法：vk group list | add <名字> | use <组> | rename <组> <新名字>");
}

/** vk cut edit：改一支成片的内容（cut.edit）。平台稿的改动用 --platforms 给 JSON 或 JSON 文件。 */
async function cmdCut() {
  const [sub] = pos.slice(1);
  if (sub !== "edit") throw new Error("用法：vk cut edit <cutId> --rev <版本号> [--lang <语言>] [--title <通用标题>] [--body <通用正文>] [--tags <话题,逗号分隔>] [--platforms <JSON或文件>]");
  const cutId = pos[2];
  const rev = val("--rev") != null ? Number(val("--rev")) : NaN;
  if (!cutId || !Number.isInteger(rev)) throw new Error("用法：vk cut edit <cutId> --rev <版本号>（版本号在 vk work show 里，每支成片一个）…");
  const tags = val("--tags") != null ? val("--tags").split(/[,，]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean) : undefined;
  const generic = {
    ...(val("--title") != null ? { title: val("--title") } : {}),
    ...(val("--body") != null ? { body: val("--body") } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
  let platforms;
  if (val("--platforms") != null) {
    const raw = val("--platforms");
    platforms = JSON.parse(existsSync(raw) ? readFileSync(raw, "utf8") : raw);
  }
  const data = await send(
    "cut.edit",
    { cutId, rev, ...(val("--lang") ? { language: val("--lang") } : {}), ...(Object.keys(generic).length ? { generic } : {}), ...(platforms ? { platforms } : {}) },
    { log },
  );
  if (human) {
    console.log(`已改「${data.title}」，版本号 ${data.rev}${data.note ? `。${data.note}` : ""}`);
    for (const p of data.publishes) console.log(`  ${platformLabelOf(p.platform).padEnd(10)}${p.title}${p.ownFields.length ? `（单独写的：${p.ownFields.join("、")}）` : "（跟通用）"}`);
  } else out(data);
  return data;
}

async function cmdPublish() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);

  if (sub === "list") {
    const from = parseBound(val("--from"));
    const to = parseBound(val("--to"), { end: true });
    const data = await send("publish.list", {
      ...(val("--state") ? { state: val("--state") } : {}),
      ...(val("--platform") ? { platform: val("--platform") } : {}),
      ...(val("--group") ? { group: val("--group") } : {}),
      ...(from != null ? { from } : {}),
      ...(to != null ? { to } : {}),
    });
    if (human && data.quota) {
      // 日历口径（作品页的周 / 月视图同一份数据）：时间、状态、平台、作品·成片。
      for (const r of data.rows) console.log(`${fmtTime(r.at).padEnd(22)}${r.calLabel.padEnd(8)}${r.platform.padEnd(12)}${r.title}${r.cutCount > 1 && r.cutTitle ? ` · ${r.cutTitle}` : ""}`);
      if (!data.rows.length) console.log("这段时间没有安排");
      for (const q of data.quota) console.log(`额度 ${q.day} ${q.platform} ${q.used} / ${q.cap}${q.over ? "  超了" : ""}`);
    } else if (human) {
      for (const r of data.rows) console.log(`${r.id.padEnd(16)}${r.platform.padEnd(10)}${r.state.padEnd(18)}${String(r.title).slice(0, 30)}`);
      if (!data.rows.length) console.log("还没有发布：vk publish <素材> --to <平台>");
    } else out(data);
    return data;
  }

  // 发布前人确认（#146）。
  if (sub === "approve") {
    const cutId = val("--cut");
    const publishId = val("--publish") ?? pos[2];
    if (!cutId && !publishId) throw new Error("用法：vk publish approve --cut <cutId> | --publish <publishId> [--now]");
    const data = await send("publish.approve", { ...(cutId ? { cutId } : {}), ...(publishId && !cutId ? { publishId } : {}), ...(has("--now") ? { when: "now" } : {}) }, { log });
    if (human) {
      for (const a of data.approved) console.log(`已确认 ${platformLabelOf(a.platform).padEnd(12)}${a.publishId}  ${a.scheduledAt ? fmtTime(a.scheduledAt) : "尽快"}${a.shifted ? `（原定 ${fmtTime(a.originalAt)}，已顺延）` : ""}`);
      for (const x of data.held ?? []) console.log(`没发 ${platformLabelOf(x.platform)} ${x.publishId}：${x.reason}`);
      for (const x of data.incomplete ?? []) console.log(`还不能确认 ${platformLabelOf(x.platform)} ${x.publishId}：${x.reason}`);
      for (const x of data.perItem ?? []) console.log(`待逐条决定 ${x.platform.padEnd(9)}${x.publishId}：vk publish approve --publish ${x.publishId} | now | manual`);
    } else out(data);
    return data;
  }

  if (sub === "skip") {
    const cutId = val("--cut") ?? pos[2];
    if (!cutId) throw new Error("用法：vk publish skip --cut <cutId>");
    const data = await send("publish.skip", { cutId }, { log });
    if (human) {
      if (data.already) console.log(`「${data.title}」已经是先不发`);
      else console.log(`先不发「${data.title}」：${data.skipped.map((x) => x.platform).join("、")}。${data.next}`);
    } else out(data);
    return data;
  }

  if (sub === "edit") {
    const publishId = pos[2];
    const at = val("--at") != null ? parseSchedule(val("--at")) : null;
    // 开关三态：--comment 开、--no-comment 关、都不写 = 不改。
    const toggle = (name) => (has(`--${name}`) ? true : has(`--no-${name}`) ? false : undefined);
    const tiktok = {
      ...(val("--privacy") != null ? { privacy: val("--privacy") } : {}),
      ...(val("--caption") != null ? { caption: val("--caption") } : {}),
      ...Object.fromEntries(["comment", "duet", "stitch", "draft"].map((n) => [n, toggle(n)]).filter(([, v]) => v !== undefined)),
    };
    // 话题用逗号分隔（半角或全角）；--tags "" 表示清空话题。
    const tags = val("--tags") != null ? val("--tags").split(/[,，]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean) : undefined;
    const body = val("--body");
    if (!publishId || (val("--title") == null && body == null && tags === undefined && at == null && !Object.keys(tiktok).length)) {
      throw new Error("用法：vk publish edit <publishId> [--title <标题>] [--body <正文>] [--tags <话题,逗号分隔>] [--at <2026-11-10T20:00|2h>] [--privacy <级别>] [--comment|--no-comment] [--duet|--no-duet] [--stitch|--no-stitch] [--caption <文案>] [--draft|--no-draft]");
    }
    const data = await send("publish.edit", { publishId, ...(val("--title") != null ? { title: val("--title") } : {}), ...(body != null ? { body } : {}), ...(tags !== undefined ? { tags } : {}), ...(at != null ? { at } : {}), ...tiktok }, { log });
    if (human) {
      console.log(`已改 ${platformLabelOf(data.platform)} ${data.publishId}：${data.title ? `标题「${data.title}」 ` : ""}${data.scheduledAt ? fmtTime(data.scheduledAt) : ""}`);
      if (data.tiktok) {
        const on = (v) => (v ? "开" : "关");
        console.log(`  隐私级别：${data.tiktok.privacy_level ?? "（还没选，没选不能发）"}  评论 ${on(data.tiktok.allow_comment)} / 合拍 ${on(data.tiktok.allow_duet)} / 拼接 ${on(data.tiktok.allow_stitch)}`);
        console.log(`  文案：${data.tiktok.caption ?? "（沿用标题）"}  去向：${data.tiktok.draft ? "送到 TikTok 草稿箱" : "直接发布（Post）"}`);
      }
    }
    else out(data);
    return data;
  }

  if (["now", "manual"].includes(sub)) {
    const publishId = pos[2];
    if (!publishId) throw new Error(`用法：vk publish ${sub} <publishId>`);
    const data = await send(`publish.${sub}`, { publishId }, { log });
    if (human) console.log(`${publishId} → ${data.state}${data.next ? `。${data.next}` : ""}`);
    else out(data);
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
    ...(val("--group") ? { group: val("--group") } : {}),
    ...(val("--title") ? { title: val("--title") } : {}),
    ...(val("--body") ? { body: val("--body") } : {}),
    ...(val("--tags") ? { tags: String(val("--tags")).split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(val("--visibility") ? { visibility: val("--visibility") } : {}),
    ...(parseSchedule(val("--schedule")) ? { schedule: parseSchedule(val("--schedule")) } : {}),
    ...(has("--dry-run") ? { dryRun: true } : {}),
  };
  const data = await send("publish.create", args, { log });
  if (human) {
    if (data.group) console.log(`账号组：${data.group.name}${val("--group") ? "" : "（当前组）"}`);
    for (const w of data.warnings ?? []) console.log(`注意：${w.reason}`);
    if (data.dryRun) {
      console.log(`试运行：${data.work.title} → ${data.publishes.map((p) => p.platform).join("、")}`);
      for (const p of data.publishes) {
        const v = p.preview;
        if (!v) continue;
        if (v.error) {
          console.log(`  ${p.platform}：发不出去（${v.error.code}）${v.error.message}`);
          continue;
        }
        const sn = v.resource?.snippet ?? {};
        const st = v.resource?.status ?? {};
        console.log(`  ${p.platform} 将提交：`);
        console.log(`    标题：${sn.title ?? ""}`);
        console.log(`    简介：${(sn.description ?? "").replace(/\n/g, " ⏎ ")}`);
        console.log(`    标签：${(sn.tags ?? []).join("、") || "（无）"}`);
        console.log(`    类目：${sn.categoryId ?? "（默认）"}`);
        console.log(`    可见性：${st.privacyStatus ?? ""}${st.publishAt ? `，预约 ${st.publishAt} 公开` : ""}`);
        if (v.estimatedQuota != null) console.log(`    预计配额：${typeof v.estimatedQuota === "object" ? `上传 ${v.estimatedQuota.inserts} 次 + 其余 ${v.estimatedQuota.units} 单位` : v.estimatedQuota}`);
      }
      console.log("没有写入任何行，也没有对外动作");
    } else {
      console.log(`已创建 ${data.publishes.length} 条发布，等你确认（确认前不会发）：`);
      for (const p of data.publishes) console.log(`  ${p.platform.padEnd(12)}${p.handle.padEnd(18)}${p.publishId}`);
      if (data.next) console.log(data.next);
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
  const data = await send("run.list", {
    ...(has("--failed") ? { state: "failed" } : val("--state") ? { state: val("--state") } : {}),
    ...(val("--group") ? { group: val("--group") } : {}),
  });
  if (human) {
    if (data.group) console.log(`账号组：${data.group.name}`);
    for (const r of data.rows) console.log(`${r.kind.padEnd(9)}${String(r.state).padEnd(10)}${String(r.target_id).padEnd(18)}${r.attempts}/${data.retry_limit ?? "?"} 次  ${r.last_error ?? ""}`);
    if (!data.rows.length) console.log("队列是空的");
  } else out(data);
  return data;
}

async function cmdMachine() {
  const data = await send("machine.status", val("--group") ? { group: val("--group") } : {});
  if (human) {
    const ago = data.heartbeatAgeMs == null ? "还没有心跳" : `${Math.max(1, Math.round(data.heartbeatAgeMs / 60e3))} 分钟内有心跳`;
    console.log(`发布机：${data.online ? "在线" : "不在线"}（${ago}）`);
    console.log(`排着要发：${data.queued.count} 条${data.queued.nextAt ? `，最近一条 ${clock(data.queued.nextAt)}` : ""}`);
    console.log(`正在发：${data.running.count || "没有"}`);
    console.log(`等你确认：${data.awaiting.count} 条（没确认的到时间也不会发）`);
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
    if (val("--group")) throw new Error("stats series 是按单条发布的，不接受 --group；按组看作品用 vk stats works --group");
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
  const data = await send("stats.works", {
    range: val("--range") ?? "all",
    ...(val("--publish") ? { publishId: val("--publish") } : {}),
    ...(val("--group") ? { group: val("--group") } : {}),
  });
  if (human) {
    if (data.group) console.log(`账号组：${data.group.name}`);
    const rows = data.rows.filter((r) => r.latest);
    if (!rows.length) console.log("还没有采集到数据：vk collect --now");
    for (const r of rows) console.log(`${r.platform.padEnd(10)}${String(r.title).slice(0, 24).padEnd(26)}${JSON.stringify(r.latest.metrics)}`);
  } else out(data);
  return data;
}

/** 日期边界：只给日期（2026-11-10）时，--from 取当天 0 点、--to 取当天最后一毫秒（本地时区）。 */
function parseBound(raw, { end = false } = {}) {
  if (raw == null) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (m) {
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return end ? day + 24 * 3600e3 - 1 : day;
  }
  return parseSchedule(raw);
}

const fmtTime = (ms) => (ms == null ? "—" : new Date(ms).toLocaleString());

async function cmdSchedule() {
  const sub = pos[1] ?? "list";
  const log = (m) => human && console.log(m);

  if (sub === "list") {
    const from = parseBound(val("--from"));
    const to = parseBound(val("--to"), { end: true });
    const data = await send("schedule.list", {
      ...(val("--group") ? { group: val("--group") } : {}),
      ...(from != null ? { from } : {}),
      ...(to != null ? { to } : {}),
    });
    if (human) {
      if (!data.cards.length) console.log("这段时间没有排期：vk publish <素材> --to <平台> --schedule 2026-11-10T20:00");
      for (const c of data.cards) {
        const plats = c.platforms.map((p) => `${p.platform}:${p.state}`).join(" ");
        console.log(`${fmtTime(c.at).padEnd(22)}${c.state.padEnd(12)}${String(c.title).slice(0, 24).padEnd(26)}${plats}${c.conflict ? "  ⚠ 撞车" : ""}`);
        for (const x of c.conflicts) console.log(`${"".padEnd(34)}↳ ${x.platform} 与「${x.title}」相隔 ${x.gapMin} 分钟`);
      }
      console.log(`\n${data.counts.works} 个作品 · ${data.counts.publishes} 条发布 · ${data.counts.conflicts} 张卡撞车`);
    } else out(data);
    return data;
  }

  if (sub === "move") {
    const workId = pos[2];
    const at = parseSchedule(val("--at"));
    if (!workId || at == null) throw new Error("用法：vk schedule move <workId> --at <2026-11-10T20:00|2h> [--force]");
    const data = await send("schedule.move", { workId, at, ...(has("--force") ? { force: true } : {}) }, { log });
    if (human) {
      if (data.saved) console.log(`已改期：「${data.title}」${fmtTime(data.from)} → ${fmtTime(data.at)}（${data.moved.map((m) => m.platform).join("、")}）`);
      else {
        console.log(`没有保存：${data.message}`);
        for (const c of data.conflicts) console.log(`  ${c.platform} @${c.handle}：「${c.a.title}」${fmtTime(c.a.at)} ↔「${c.b.title}」${fmtTime(c.b.at)}`);
        console.log(data.next);
      }
    } else out(data);
    if (!data.saved) process.exitCode = 3; // 撞车没保存：脚本要能分辨「成功」和「被拦下」
    return data;
  }

  if (sub === "cancel") {
    const workId = pos[2];
    if (!workId) throw new Error("用法：vk schedule cancel <workId>");
    const data = await send("schedule.cancel", { workId }, { log });
    if (human) {
      if (data.already) console.log(`「${data.title}」已经是取消状态`);
      else console.log(`已取消「${data.title}」：${data.canceled.map((c) => c.platform).join("、")}${data.skipped.length ? `（已发出、未取消：${data.skipped.map((c) => c.platform).join("、")}）` : ""}`);
    } else out(data);
    return data;
  }

  throw new Error("用法：vk schedule list | move <workId> --at <时间> [--force] | cancel <workId>");
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
      "  vk serve --offline [--port 8787]             # 离线模式：不访问任何平台（验收/演示用）",
      "  vk service status|start|stop|restart   # 后台服务（关掉终端也在跑）",
      "  vk service uninstall [--purge]            # 卸载服务和程序文件；默认保留数据，--purge 才删数据",
      "  vk demo seed                                 # 在当前 VK_HOME 造演示数据",
      "  vk commands [--human]",
      "  vk bootstrap [--human]   # 当前组 / 组列表 / 账号 / 新鲜度 / 计数 / 矩阵",
      "  vk group list | add <名字> | use <组 id 或名字>",
      // account.add 的 --group 是 #21 起的必填项，account.remove 也在这里；publish/stats/runs 的
      // --group 是 #22 的组作用域，两者都是真实存在的参数，各留各的。
      "  vk account list [--group <组>] | add <platform> --group <组> --name <名字> | remove <accountId> | mode <id> auto|manual | reauth <id>",
      "  vk today [--group <组>] [--human]   # 现在要我做什么：等确认 / 出问题 / 等时间 / 满 24 小时的结果",
      "  vk work list [--group <组>] | show <workId> [--group <组>] | add <视频文件或图片目录> [--title <标题>] | add <清单.json>",
      "  vk work push <清单.json> --group <组名>                  制作机：把清单和成片传到云端中转，等发布机拉取入库（本机不建作品）",
      "  vk relay serve [--port 8790] [--data <目录>]            云端中转（只存文件和投递清单；只监听 127.0.0.1，HTTPS 由反代提供）",
      "  vk relay connect <地址> --token <token> [--push]        写中转配置：发布机用拉取 token，制作机加 --push 用推送 token",
      "  vk relay status | pull | token push|pull                中转连接状态 / 立刻拉一轮 / 在云端取 token",
      "  vk plan show / set / reset                              看、改、恢复默认的发布方案（哪种成片发到哪些平台）",
      "  vk plan apply <cutId> [--accounts a,b] [--group <组>]   按成片和发布方案生成平台稿（待确认，建议时间守平台规则）",
      "  vk machine [--group <组>]                               发布机：心跳、排着要发、正在发、等你确认",
      "  vk publish <素材> --to tiktok,bilibili [--group <组>] [--title] [--schedule 2h] [--visibility] [--dry-run]",
      "  vk publish retry|release|confirm <publishId>",
      "  vk publish approve --cut <cutId> | --publish <publishId>    确认待确认的平台稿（按成片确认不带小红书）",
      "  vk publish now|manual <publishId>                          小红书逐条：现在发 / 我自己发",
      "  vk publish skip --cut <cutId>                              这支先不发（以后还能再确认）",
      "  vk publish edit <publishId> [--title <标题>] [--at <时间>]  确认前改标题或时间",
      "  vk cut edit <cutId> --rev <版本号> [--title ..] [--platforms <JSON>]  改成片内容（通用文案 + 各平台），一次提交",
      "  vk approval list | link <publishId> | apply <token> retry|cancel",
      "  vk collect [--now] [--platform <p>]",
      "  vk stats works [--range 7d] [--group <组>] | series <publishId>",
      "  vk publish list [--state failed] [--platform tiktok]",
      "  vk schedule list [--group <g>] [--from <日期>] [--to <日期>] | move <workId> --at <时间> [--force] | cancel <workId>",
      "  vk platforms | runs [--state failed] [--group <组>] | events [--since <ms>]",
      "  vk setup [--json] | vk channel bind feishu | test feishu",
      "  vk version [--json]                                     版本号 + 提交号 + 安装时间 + 自动更新状态",
      "  vk update [--check] [--auto on|off] [--now]             更新程序：--check 只看有没有新版本；--auto 开关后台自动更新（空闲时更新，失败自动退回）",
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
  else if (has("--version") || has("-v")) console.log(updates.displayVersion(updates.buildInfo()));
  else if (cmd === "init") cmdInit();
  else if (cmd === "now") cmdNow();
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "commands") cmdCommands();
  else if (cmd === "bootstrap") await cmdBootstrap();
  else if (cmd === "serve") await cmdServe();
  else if (cmd === "demo") await cmdDemo();
  else if (cmd === "service") await cmdService();
  else if (cmd === "version") await cmdVersion();
  else if (cmd === "update") await cmdUpdate();
  else if (cmd === "group") await cmdGroup();
  else if (cmd === "today") await cmdToday();
  else if (cmd === "work") await cmdWork();
  else if (cmd === "plan") await cmdPlan();
  else if (cmd === "relay") await cmdRelay();
  else if (cmd === "account") await cmdAccount();
  else if (cmd === "publish") await cmdPublish();
  else if (cmd === "cut") await cmdCut();
  else if (cmd === "collect") await cmdCollect();
  else if (cmd === "stats") await cmdStats();
  else if (cmd === "schedule") await cmdSchedule();
  else if (cmd === "platforms") await cmdPlatforms();
  else if (cmd === "setup") await cmdSetup();
  else if (cmd === "runs") await cmdRuns();
  else if (cmd === "machine") await cmdMachine();
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
  if (human) console.error(`出错：${message}${err.hint ? `\n下一步：${err.hint}` : ""}`);
  else out({ ok: false, error: { code: err.code ?? "error", message, ...(err.hint ? { hint: err.hint } : {}) } });
  process.exit(1);
}
