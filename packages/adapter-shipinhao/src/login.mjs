// 视频号助手的登录：探测（只读）和网页扫码。
//
// ported from trustbridge@1f9c92f videos/factory/keepalive.mjs（登录态判断：落到登录页 = 过期；
// 首页 wujie 里出现「视频号ID」= 已登录）。工厂那份是每隔几小时打开一次首页「续命」，所有者说不管用，
// 这里**不做保活**：只在被问到的时候查一次（启动、每天一次、确认时、发布前 2 小时，由 core 调度）。

import { AdapterError } from "../../core/src/errors.mjs";
import { openAccount, closeAccount, hasLiveBrowser } from "../../driver-browser/src/index.mjs";

export const HOME = "https://channels.weixin.qq.com/platform";
export const LOGIN_PAGE = "https://channels.weixin.qq.com/login.html";
export const EXPIRED_DETAIL = "视频号登录过期了，请重新扫码";
export const QR_SESSION_MS = 10 * 60e3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = `document.querySelector('wujie-app')?.shadowRoot`;

/** 页面在哪：login（二维码页）/ home（已登录首页）/ ''（还没渲染）。 */
export const LOGIN_PROBE = `location.pathname.includes('login') ? 'login' : (${ROOT}?.querySelector('body')?.innerText.includes('视频号ID') ? 'home' : '')`;

/** 打开只读页面判断登录态。拿不准（超时、网络）抛 flaky_ui，不冒充过期也不冒充正常。 */
export async function probeLogin(tab) {
  await tab.goto(HOME, { waitUntil: "domcontentloaded" });
  let where;
  try {
    where = await tab.waitFor(LOGIN_PROBE, [], { timeout: 60e3, every: 500, what: "视频号助手首页" });
  } catch (err) {
    throw new AdapterError("flaky_ui", `视频号登录态无法确认：${err.message}`);
  }
  return where === "home" ? "ok" : "expired";
}

// ---- 网页扫码 ---------------------------------------------------------------------------

const sessions = new Map(); // accountId → { tab, ownsBrowser, startedAt, qr }

async function endSession(accountId, session) {
  if (sessions.get(accountId) === session) sessions.delete(accountId);
  if (!session?.tab) return;
  // 自己起的无头实例整个关掉，Browser.close 才会把 cookie 刷到磁盘。
  if (session.ownsBrowser) await closeAccount(accountId).catch(() => {});
  else await session.tab.close().catch(() => {});
}

/** 登录页上的状态：waiting 等扫码 / scanned 已扫码等手机确认 / expired 二维码过期 / ok 登录完成 / unknown。 */
export const QR_STATE = `(() => {
  if (!location.pathname.includes('login')) return ${ROOT}?.querySelector('body')?.innerText.includes('视频号ID') ? 'ok' : 'unknown';
  const t = document.body.innerText || '';
  if (/二维码已(失效|过期)|已过期|点击刷新|刷新二维码/.test(t)) return 'expired';
  if (/已扫码|扫码成功|请在手机上确认|在手机上点击确认/.test(t)) return 'scanned';
  return 'waiting';
})()`;

/**
 * 取登录页上的二维码，返回 data URL。能直接读到 <img> 就读；读不到（跨域图片）退回整页截图——
 * 二维码在截图里，手机照样能扫。
 */
export async function readQr(tab) {
  const fromImg = await tab
    .eval(`(async () => {
      const docs = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
      for (const d of docs) {
        const img = [...d.querySelectorAll('img')].find((i) => i.naturalWidth >= 100 && Math.abs(i.naturalWidth - i.naturalHeight) <= 8 && /qr|code|login/i.test(i.src + i.className));
        if (!img) continue;
        if (img.src.startsWith('data:')) return img.src;
        try {
          const blob = await (await fetch(img.src, { credentials: 'include' })).blob();
          return await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(blob); });
        } catch { /* 读不到就走截图 */ }
      }
      return null;
    })()`)
    .catch(() => null);
  if (fromImg) return fromImg;
  const png = await tab.screenshot();
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

/** 开始（或换一个）扫码：旧会话先收掉。二维码由发布机取回，登录数据只留在它的浏览器资料里。 */
const defaultTabFor = async (accountId) => ({ ownsBrowser: !hasLiveBrowser(accountId), tab: await openAccount({ accountId, headless: true }) });

export async function startQrLogin({ accountId, tabFor = defaultTabFor }) {
  if (typeof accountId !== "string" || !accountId.trim()) throw new AdapterError("unknown", "取二维码需要 accountId");
  const previous = sessions.get(accountId);
  if (previous) await endSession(accountId, previous);
  let tab;
  let ownsBrowser = false;
  try {
    ({ tab, ownsBrowser } = await tabFor(accountId));
    await tab.clearSiteCookies("weixin.qq.com");
    await tab.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded" });
    await tab.waitFor(`!!document.querySelector('img, canvas, iframe') || !location.pathname.includes('login')`, [], { timeout: 30e3, every: 300, what: "视频号助手登录页" });
  } catch (err) {
    if (tab) await endSession(accountId, { tab, ownsBrowser });
    throw new AdapterError("flaky_ui", `打不开视频号助手登录页：${err.message}`);
  }
  const session = { tab, ownsBrowser, startedAt: Date.now(), qr: null };
  sessions.set(accountId, session);
  if ((await tab.eval(QR_STATE)) === "ok") {
    await endSession(accountId, session);
    return { mode: "qr", state: "failed", reason: "session_not_cleared", note: "登录页仍在使用上次的登录状态，没有给出新二维码。请重新打开登录窗口扫码。" };
  }
  try {
    await sleep(500);
    session.qr = await readQr(tab);
  } catch (err) {
    await endSession(accountId, session);
    return { mode: "qr", state: "failed", reason: "page_changed", note: `取不到二维码：${err.message}。可以在发布机上打开登录窗口自己登录。` };
  }
  return { mode: "qr", state: "waiting", qr: session.qr, startedAt: session.startedAt, next: "用开通视频号的微信扫一扫这个二维码，并在手机上点确认" };
}

/** 轮询：waiting → scanned → ok；二维码过期返回 expired（页面显示「换一个」）。 */
export async function qrLoginStatus({ accountId }) {
  const session = sessions.get(accountId);
  if (!session) return { mode: "qr", state: "idle", note: "这次扫码会话已结束。点「重新登录」重新开始。" };
  if (Date.now() - session.startedAt > QR_SESSION_MS) {
    await endSession(accountId, session);
    return { mode: "qr", state: "expired", qr: null, note: "10 分钟内没有完成扫码，二维码已作废。" };
  }
  let state;
  try {
    state = await session.tab.eval(QR_STATE);
  } catch (err) {
    await endSession(accountId, session);
    return { mode: "qr", state: "failed", reason: "session_lost", note: `扫码页面已断开（${err.message}）。点「重新登录」重新开始。` };
  }
  if (state === "ok") {
    await endSession(accountId, session);
    return { mode: "qr", state: "ok", persisted: true, next: `登录成功，登录态已保存；运行 vk account check ${accountId} 确认并记下这次登录（系统页会自己做）` };
  }
  if (state === "expired") {
    await endSession(accountId, session);
    return { mode: "qr", state: "expired", qr: null, note: "二维码过期了，换一个" };
  }
  if (state === "scanned") return { mode: "qr", state: "scanned", note: "已扫码，请在手机上确认登录" };
  return { mode: "qr", state: "waiting", qr: session.qr, note: "等待用微信扫码…" };
}
