// B站登录：页面扫码，不再让人开终端跑 `biliup login`。
//
// 为什么不驱动 `biliup login`（实测 2026-11-12，biliup-cli 0.2.4）：
//   在无 TTY 的进程里执行 `biliup -u x.json login` 直接报 `Error: IO error: not a terminal`，
//   它的二维码是画在终端里的，守护进程既没有 TTY，也没法把二维码送进网页。所以这里走第二条路：
//   在账号自己的 Chrome profile 里打开 B站登录页，让人用 B站 App 扫码；页面把登录后的 cookie
//   读出来，写成 biliup 能直接使用的 cookies 文件。发布/探测仍然只用 `biliup -u <cookies> …`。
//
// 凭证只落本机：文件写到 ~/.config/versekit/credentials/，目录 0700、文件 0600，不上传。

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { paths } from "../../core/src/index.mjs";
import { hasLiveBrowser, openAccount } from "../../driver-browser/src/index.mjs";

export const LOGIN_URL = "https://passport.bilibili.com/login";

// B站 TV 端登录（biliup 自己用的也是这条）：网页 cookie 可以替它确认一次 TV 二维码，
// 换来带 access_token / refresh_token 的完整 LoginInfo。没有 token_info 时 `biliup renew`
// 会返回 -400，登录态就被误判成失效；这一步是让发布/探测链路原样可用的关键。
const APP_KEY = "4409e2ce8ffd12b8";
const APP_SEC = "59b43e04ad6965f34319062b478f83dd";
const AUTH_CODE_URL = "https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code";
const CONFIRM_URL = "https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/confirm";
const POLL_URL = "https://passport.bilibili.com/x/passport-tv-login/qrcode/poll";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/**
 * biliup 登录文件里真正会被用到的 cookie。SESSDATA 是身份、bili_jct 是 CSRF，
 * 缺任何一个都不算登录成功；其余有就带上，biliup renew 会自己补齐 token_info。
 */
const CREDENTIAL_COOKIES = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "default_sites", "sec_ck"];
const REQUIRED_COOKIES = ["SESSDATA", "bili_jct"];

/** 每个账号一个文件：同一台机器可以挂多个 B站账号，固定 bili-cookies.json 会互相覆盖。 */
export function credentialPathFor(accountId, existing = null) {
  if (existing) return existing;
  return join(paths().credentials, `bili-${accountId}.json`);
}

/**
 * Chrome 的 cookie → biliup 登录文件里的 cookie。
 * 只留凭证相关的名字：buvid3/b_nut 这类随机会话 cookie 带进去没有意义，
 * 而且 `expires=-1` 的会话 cookie 会让 biliup 的 u64 反序列化失败。
 */
export function cookiesFrom(list) {
  const byName = new Map((list ?? []).map((c) => [c?.name, c]));
  for (const name of REQUIRED_COOKIES) {
    if (!String(byName.get(name)?.value ?? "").trim()) return null;
  }
  return CREDENTIAL_COOKIES.filter((name) => String(byName.get(name)?.value ?? "").trim()).map((name) => {
    const cookie = byName.get(name);
    const expires = Number(cookie.expires);
    return {
      name,
      value: String(cookie.value),
      expires: Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : 0,
      http_only: name === "SESSDATA" || name === "sec_ck" ? 1 : 0,
      secure: cookie.secure ? 1 : 0,
      same_site: 0,
    };
  });
}

/** biliup-rs 的 LoginInfo 形状（兜底：token 交换失败时先落网页 cookie）。 */
export function cookieFilePayload(cookies) {
  const mid = Number(cookies.find((c) => c.name === "DedeUserID")?.value);
  return {
    cookie_info: {
      cookies,
      domains: [".bilibili.com", ".biligame.com", ".bilibili.cn", ".huasheng.cn"],
    },
    sso: [],
    token_info: {
      access_token: "",
      expires_in: 0,
      mid: Number.isInteger(mid) ? mid : 0,
      refresh_token: "",
    },
    platform: "BiliTV",
  };
}

/** 0600 / 0700：与 core 对凭证目录的约定一致。 */
export function writeCookieFile(file, cookiesOrPayload) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(file), 0o700);
  } catch {
    /* 非 POSIX 文件系统尽力而为 */
  }
  const payload = Array.isArray(cookiesOrPayload) ? cookieFilePayload(cookiesOrPayload) : cookiesOrPayload;
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 同上 */
  }
  return file;
}

// ---------------------------------------------------------------- TV token 交换

function signed(params) {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const sign = createHash("md5").update(query + APP_SEC).digest("hex");
  return { query, sign };
}

async function postForm(url, fields, { cookie = null } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
      Referer: "https://www.bilibili.com/",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: fields,
    signal: AbortSignal.timeout(15e3),
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`B站接口返回 ${json.code}：${json.message ?? "未知错误"}`);
  return json.data;
}

/**
 * 用网页登录拿到的 SESSDATA / bili_jct 确认一次 TV 二维码，换回 biliup 需要的
 * access_token / refresh_token。biliup-rs 的 login_by_web_cookies 也是这两步。
 */
async function exchangeForBiliup(cookies) {
  const byName = new Map(cookies.map((c) => [c.name, c.value]));
  const sessdata = byName.get("SESSDATA");
  const csrf = byName.get("bili_jct");

  const ts = String(Math.floor(Date.now() / 1000));
  const authForm = signed({ appkey: APP_KEY, local_id: "0", ts });
  const auth = await postForm(AUTH_CODE_URL, `${authForm.query}&sign=${authForm.sign}`);
  const authCode = auth?.auth_code;
  if (!authCode) throw new Error("B站没有返回 TV 登录 auth_code");

  await postForm(
    CONFIRM_URL,
    new URLSearchParams({ auth_code: authCode, csrf, scanning_type: "3" }).toString(),
    { cookie: `SESSDATA=${sessdata}; bili_jct=${csrf}` },
  );

  // confirm 之后通常 1–2 秒就能拿到 token；最多等 10 秒，超时给出可读原因。
  for (let i = 0; i < 10; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    const pollTs = String(Math.floor(Date.now() / 1000));
    const pollForm = signed({ appkey: APP_KEY, local_id: "0", auth_code: authCode, ts: pollTs });
    const res = await fetch(POLL_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": UA, Referer: "https://www.bilibili.com/" },
      body: `${pollForm.query}&sign=${pollForm.sign}`,
      signal: AbortSignal.timeout(15e3),
    });
    const json = await res.json().catch(() => ({}));
    // 86039 = 二维码尚未确认，继续等；86038 = 已失效。
    if (json.code === 86039) continue;
    if (json.code !== 0) throw new Error(`B站 TV 登录轮询失败：${json.code} ${json.message ?? ""}`.trim());
    const data = json.data ?? {};
    const token = data.token_info ?? data;
    if (!data.cookie_info || !token?.access_token) throw new Error("B站返回的 TV 登录信息不完整");
    return {
      cookie_info: data.cookie_info,
      sso: data.sso ?? [],
      token_info: {
        access_token: token.access_token,
        expires_in: token.expires_in ?? 0,
        mid: token.mid ?? 0,
        refresh_token: token.refresh_token ?? "",
      },
      platform: "BiliTV",
    };
  }
  throw new Error("B站还没确认这次登录（TV 二维码等待超时）");
}

/** 登录窗口留在内存里；daemon 重启后靠账号 profile 的 marker 重新认领。 */
const sessions = new Map();
const inflight = new Map();

async function liveLoginTab(accountId) {
  const session = sessions.get(accountId);
  if (session?.tab) {
    try {
      await session.tab.url();
      return session.tab;
    } catch {
      sessions.delete(accountId);
    }
  }
  if (!hasLiveBrowser(accountId)) return null;
  try {
    // 复用已有窗口里的登录页；找不到就只在这个实例里新开一个标签，不另起浏览器。
    return await openAccount({ accountId, headless: true, reuse: "passport.bilibili.com" });
  } catch {
    return null;
  }
}

/**
 * 打开登录窗口。返回后页面每 2 秒问一次 loginStatus；二维码由 B站自己的页面渲染，
 * 不依赖终端，也不依赖我们把二维码画出来。
 */
export async function login({ accountId, headless = false } = {}) {
  if (!accountId) throw new Error("login 需要 accountId");
  const tab = await openAccount({ accountId, headless, url: LOGIN_URL });
  // 页面加载失败也把窗口留着：人可以在窗口里刷新，登录结果仍然能读到。
  await tab.waitFor("document.readyState === 'complete'", [], { timeout: 20e3, every: 250, what: "B站登录页" }).catch(() => {});
  sessions.set(accountId, { openedAt: Date.now(), tab });
  return {
    opened: true,
    url: LOGIN_URL,
    mode: "browser-qrcode",
    next: "登录窗口已打开：用 B站 App 扫码并确认，页面会自动识别，不用回终端",
  };
}

/**
 * 只读登录窗口的 cookie，不动页面。拿到 SESSDATA + bili_jct 后换一份完整的 biliup
 * LoginInfo（含 token_info）写进本机凭证文件。
 * 真正的「能不能用」仍由 check()（`biliup renew`）确认——这里不冒充登录成功。
 */
export async function loginStatus({ accountId, credentialRef = null } = {}) {
  if (!accountId) throw new Error("loginStatus 需要 accountId");
  // 页面每 2 秒轮询一次，交换 token 要几秒；并发的第二次请求直接等第一次的结果。
  if (inflight.has(accountId)) return inflight.get(accountId);
  const task = readAndExchange({ accountId, credentialRef }).finally(() => inflight.delete(accountId));
  inflight.set(accountId, task);
  return task;
}

async function readAndExchange({ accountId, credentialRef }) {
  const session = sessions.get(accountId);
  // 同一轮登录只交换一次 token：页面在 check 期间可能还会轮询一两次，
  // 每次都换 token 会和 biliup 正在读的凭证文件抢写。
  if (session?.completed) return session.completed;

  const tab = await liveLoginTab(accountId);
  if (!tab) {
    return { state: "idle", mode: "browser-qrcode", note: "登录窗口没有打开：点「重新打开登录窗口」再扫一次" };
  }

  const raw = await tab.cookies("https://www.bilibili.com").catch(() => []);
  const cookies = cookiesFrom(raw);
  if (!cookies) {
    return { state: "pending", mode: "browser-qrcode", note: "等待扫码：在登录窗口里用 B站 App 扫码并确认" };
  }

  const file = credentialPathFor(accountId, credentialRef);
  let payload;
  let note = "已从登录窗口拿到 B站登录信息，写入本机凭证文件；正在用 biliup 确认";
  try {
    payload = await exchangeForBiliup(cookies);
    note = "已拿到完整 B站登录信息（含续期 token），写入本机凭证文件；正在用 biliup 确认";
  } catch (err) {
    // 交换失败不等于网页登录失败：先落网页 cookie，biliup 校验会给出最终结论。
    payload = cookieFilePayload(cookies);
    note = `已保存 B站网页登录信息，但换发 biliup token 失败：${err.message}。biliup 校验可能不通过，可重试`;
  }

  writeCookieFile(file, payload);
  const result = { state: "ok", mode: "browser-qrcode", credentialRef: file, note };
  const live = sessions.get(accountId);
  if (live) live.completed = result;
  return result;
}