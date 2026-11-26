import { readEnv } from "../../core/src/env.mjs";
// ported from larksuite/cli@c5fbf1a52df77d5cb9cac2b1501770b2fb9af7d2 internal/auth/app_registration.go
//
// 飞书「应用注册」设备流：begin 拿二维码地址，poll 等用户在飞书里扫码确认，
// 结果里有 client_id / client_secret，以及我们要的 user_info.open_id。
// `lark-cli config init --new` 走的是同一个接口，但把 open_id 丢了——所以这里自己走一遍，
// 整个接飞书只扫这一次码，不再需要第二步 `lark-cli auth login`。
//
// 剥掉了源码里的：Go 的 context/HTTP 客户端、lark-cli 自己的 urlrewrite 与日志扩展。
// 保留：接口路径与参数、轮询间隔与 slow_down 退避、一次跨品牌切换、品牌矛盾报错、过期处理。
//
// 安全：client_secret 只在内存里从 poll 响应传到调用方，这个文件不写日志、不进 argv、不落盘；
// 出错时只把 error / error_description 交出去，绝不带响应原文。

const PATH = "/oauth/v1/app/registration";
const ENDPOINTS = {
  feishu: { open: "https://open.feishu.cn", accounts: "https://accounts.feishu.cn" },
  lark: { open: "https://open.larksuite.com", accounts: "https://accounts.larksuite.com" },
};
const DEFAULT_INTERVAL = 5;
const DEFAULT_EXPIRE_IN = 600;
const MAX_INTERVAL = 60;
const BEGIN_TIMEOUT = 30e3;

/** 注册协议总是先在飞书域名上开始；品牌只决定用户看到的验证页域名。 */
const BOOTSTRAP = "feishu";

/** 测试用：把注册接口指到本地假服务（两个品牌共用一个地址）。 */
const accountsBase = (brand) => readEnv("HIFABU_FEISHU_ACCOUNTS_URL") || ENDPOINTS[brand].accounts;
const openBase = (brand) => readEnv("HIFABU_FEISHU_OPEN_URL") || ENDPOINTS[brand].open;

const parseBrand = (v) => (String(v ?? "").trim().toLowerCase() === "lark" ? "lark" : "feishu");
const str = (o, k) => (typeof o?.[k] === "string" ? o[k] : "");
const num = (o, k) => (Number.isFinite(Number(o?.[k])) ? Number(o[k]) : 0);

/** 终态：带 code，调用方据此翻成人话；message 不含任何凭证。 */
export class RegistrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegistrationError";
    this.code = code; // denied | expired | timeout | brand_mismatch | cancelled | failed
  }
}

async function post(url, form, { signal, timeout } = {}) {
  const signals = [signal, timeout ? AbortSignal.timeout(timeout) : null].filter(Boolean);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** 第一步：拿 device_code 与要给用户扫的地址。 */
export async function beginRegistration({ brand = "feishu", signal } = {}) {
  let r;
  try {
    r = await post(
      accountsBase(BOOTSTRAP) + PATH,
      { action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id tenant_brand" },
      { signal, timeout: BEGIN_TIMEOUT },
    );
  } catch (err) {
    if (signal?.aborted) throw new RegistrationError("cancelled", "已取消");
    throw new RegistrationError("failed", `连不上飞书的注册接口：${err.message}`);
  }
  const { status, data } = r;
  if (!data) throw new RegistrationError("failed", `飞书注册接口返回异常（HTTP ${status}）`);
  if (status >= 400 || data.error !== undefined) {
    throw new RegistrationError("failed", `飞书注册接口拒绝了请求：${str(data, "error_description") || str(data, "error") || "未知原因"}`);
  }
  const deviceCode = str(data, "device_code");
  if (!deviceCode) throw new RegistrationError("failed", "飞书注册接口没有返回 device_code");
  const userCode = str(data, "user_code");
  const expiresIn = num(data, "expire_in") > 0 ? num(data, "expire_in") : num(data, "expires_in") > 0 ? num(data, "expires_in") : DEFAULT_EXPIRE_IN;
  const interval = num(data, "interval") > 0 ? num(data, "interval") : DEFAULT_INTERVAL;
  return {
    deviceCode,
    userCode,
    // 验证页只展示成链接/二维码，不会去请求它。
    verificationUrl: `${openBase(brand)}/page/cli?user_code=${encodeURIComponent(userCode)}&from=cli`,
    expiresIn,
    interval,
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new RegistrationError("cancelled", "已取消"))), { once: true });
  });

/**
 * 第二步：轮询到用户确认。首次 poll 与（至多一次）跨品牌切换立即进行；其余等 interval。
 * 返回 { clientId, clientSecret, openId, tenantBrand }。
 * `intervalScale` 只给测试压缩等待时间（假服务不用真等 5 秒）。
 */
export async function pollRegistration(begin, { signal, intervalScale = 1 } = {}) {
  let interval = begin.interval;
  const deadline = Date.now() + begin.expiresIn * 1000 * intervalScale;
  let current = BOOTSTRAP;
  let switched = false;
  let wait = false;
  const ms = (s) => s * 1000 * intervalScale;

  for (;;) {
    if (wait) {
      const left = deadline - Date.now();
      if (left <= 0) throw new RegistrationError("timeout", "等太久了，二维码已经过期，请重新来。");
      await sleep(Math.min(ms(interval), left), signal);
    }
    wait = true;
    if (signal?.aborted) throw new RegistrationError("cancelled", "已取消");
    if (Date.now() >= deadline) throw new RegistrationError("timeout", "等太久了，二维码已经过期，请重新来。");

    let data;
    try {
      ({ data } = await post(accountsBase(current) + PATH, { action: "poll", device_code: begin.deviceCode }, { signal, timeout: Math.max(1, deadline - Date.now()) }));
    } catch {
      if (signal?.aborted) throw new RegistrationError("cancelled", "已取消");
      interval = Math.min(interval + 1, MAX_INTERVAL); // 网络抖一下：退避后接着轮询
      continue;
    }
    if (!data) {
      interval = Math.min(interval + 1, MAX_INTERVAL);
      continue;
    }

    // 飞书报告用户在另一个品牌：切换轮询域名（只一次、立即），不管同时带的是什么状态。
    if (!switched && typeof data.user_info === "object" && data.user_info) {
      const tb = str(data.user_info, "tenant_brand");
      if (tb && parseBrand(tb) !== current) {
        current = parseBrand(tb);
        switched = true;
        wait = false;
        continue;
      }
    }

    const err = str(data, "error");
    if (!err) {
      const clientId = str(data, "client_id");
      const clientSecret = str(data, "client_secret");
      const ui = typeof data.user_info === "object" && data.user_info ? data.user_info : null;
      if (clientId && clientSecret) {
        const tenantBrand = ui ? str(ui, "tenant_brand") : "";
        // 发放凭证的域名说了算；最后一次报告和它矛盾是协议违规，不是「以它为准」。
        if (tenantBrand && parseBrand(tenantBrand) !== current) {
          throw new RegistrationError("brand_mismatch", `飞书返回的租户品牌（${tenantBrand}）和发放凭证的域名（${current}）对不上，为安全起见没有保存。请重新来。`);
        }
        return { clientId, clientSecret, openId: ui ? str(ui, "open_id") : "", tenantBrand: tenantBrand || current };
      }
      continue; // 没出错但凭证不全：接着等
    }
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval = Math.min(interval + 5, MAX_INTERVAL);
      continue;
    }
    if (err === "access_denied") throw new RegistrationError("denied", "你在飞书里点了拒绝。点「重新来」可以再扫一次。");
    if (err === "expired_token" || err === "invalid_grant") throw new RegistrationError("expired", "二维码过期了，点「重新来」。");
    throw new RegistrationError("failed", `飞书注册失败：${(str(data, "error_description") || err).slice(0, 160)}`);
  }
}
