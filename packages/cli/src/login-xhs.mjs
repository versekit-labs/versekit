// 小红书创作服务平台的登录动作（纯函数式：都接收 tab，不碰数据库）。
//
// 抽出来的原因：这块是最容易坏的地方——受控输入框、嵌套按钮、倒计时回读，
// 每一条都踩过坑。放在 vk.mjs 里没法单测，于是「正则写成字符串」「React 收不到
// input 事件」这种错误能一路活到用户面前。现在这些函数都能用假页面测。
//
// 约定：所有 "点击" 都优先元素级 click，坐标只做兜底；所有 "发送/提交" 都要回读结果，
// 不允许只因为点了一下就报成功。

/**
 * 「登录即同意」的复选框不勾，小红书不会真的发码（按钮点了没反应）。
 * 这一步必须在发码之前，且要回读确认，不能假设点上了。
 */
export async function acceptAgreement(tab) {
  const state = await tab.eval(`(() => {
    const boxes = [...document.querySelectorAll('input[type=checkbox]')];
    if (!boxes.length) return "none";
    const c = boxes[0];
    if (!c.checked) c.click();
    return String(c.checked);
  })()`);
  if (state === "false") throw new Error("没能勾上「登录即同意」，页面可能改版了");
  await new Promise((r) => setTimeout(r, 200));
  return state;
}

/**
 * 填受控输入框。CDP 的 Input.insertText 只改 DOM 值，React 的 onChange 未必收到，
 * 于是「发送验证码」拿到空号码、静默不发。这里用原生 setter + input/change 事件。
 */
export async function setInputValue(tab, placeholderPattern, value) {
  // 注意：pattern 是正则源码字符串，页面里要重新构造 RegExp——
  // 直接拼 "/xxx/" 会变成字符串字面量，.test 不存在。
  const ok = await tab.eval(`(() => {
    const re = new RegExp(${JSON.stringify(placeholderPattern)});
    const input = [...document.querySelectorAll('input')].find((x) => x.getBoundingClientRect().width > 0 && re.test(x.placeholder || ''));
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return input.value === ${JSON.stringify(String(value))};
  })()`);
  if (!ok) throw new Error(`填不进「${placeholderPattern}」输入框，页面可能改版了`);
}

/** 填手机号 → 勾协议 → 点「发送验证码」。按钮文案可能带加载态，所以按包含匹配并取最小元素。 */
export async function fillAndSendCode(tab, phone, { skipPhoneFill = false } = {}) {
  if (!skipPhoneFill) await setInputValue(tab, "手机号", phone);

  await acceptAgreement(tab);

  const spot = await tab.eval(`(() => {
    const cands = [...document.querySelectorAll('span,button,div')].filter((e) => {
      const t = (e.innerText || '').trim();
      if (!/^(发送验证码|获取验证码|重新发送|重新获取)$/.test(t)) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width < 200;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    const r = cands[0].getBoundingClientRect();
    return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
  })()`);
  if (!spot) throw new Error("找不到「发送验证码」按钮，页面可能改版了");
  // React 的发送按钮用坐标点经常落空（文字层很小），先直接触发元素点击，再兜底坐标。
  const jsClicked = await tab.eval(`(() => {
    const el = [...document.querySelectorAll('div,span,button')].find((e) => (e.innerText || '').trim() === '发送验证码' && getComputedStyle(e).cursor === 'pointer');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!jsClicked) await tab.click(JSON.parse(spot));

  // 回读：真的发出去时按钮会变成倒计时/「重新发送」。没变就是没发出去，
  // 不能报成功让人干等短信。
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const text = await tab
      .eval(`(() => [...document.querySelectorAll('span,button,div')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.width < 200; }).map((e) => (e.innerText || '').trim()).join('|'))()`)
      .catch(() => "");
    if (/\d+\s*s|秒后|重新发送|重新获取/.test(text)) return;
  }
  throw new Error("点了「发送验证码」但没有发出：小红书没进入倒计时（可能是号码格式、风控或网络）");
}

/** 点「登 录」：文案中间有空格，按包含匹配 + 最小元素 + 坐标点。 */
export async function clickLoginButton(tab) {
  const spot = await tab.eval(`(() => {
    const cands = [...document.querySelectorAll('button,div,span')].filter((e) => {
      const t = (e.innerText || '').trim();
      if (!/^登\\s*录$/.test(t)) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width < 260;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    const r = cands[0].getBoundingClientRect();
    return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
  })()`);
  if (spot) {
    await tab.click(JSON.parse(spot));
    return true;
  }
  return tab.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((e) => /登\\s*录/.test((e.innerText || '').trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
}


/**
 * 「现在这个页面是登录成功后的样子吗」。
 *
 * 不看 cookie：小红书的创作平台会话可能只存在页面态里，而且我们读 cookie 时
 * 若拿到的是 about:blank 就会误判。直接看页面本身最可靠：
 *   · 已经离开 /login
 *   · 能看到控制台的标志性入口（发布笔记 / 笔记管理 / 数据看板）
 */
export async function pageLoggedIn(tab) {
  const here = await tab.url().catch(() => "");
  if (!here || /\/login/.test(here)) return false;
  if (!/creator\.xiaohongshu\.com/.test(here)) return false;

  // 1) 有会话 cookie 就是登录了：SPA 首页懒加载，DOM 文案可能一直不出现。
  const cookies = await tab.cookies("https://creator.xiaohongshu.com").catch(() => []);
  if (cookies.some((c) => ["web_session", "access-token", "customer-session"].includes(c.name) && c.value)) return true;

  // 2) 没有 cookie 时再看页面入口文案；两者都不成立才算没登录。
  return tab
    .eval(`/发布笔记|笔记管理|数据看板|发布图文|发布视频|创作服务/.test(document.body.innerText || '')`)
    .catch(() => false);
}

// ---------------------------------------------------------------- 扫码登录（#101）
//
// 2026-11-14 真机验证：创作服务平台登录卡片右上角有个小图标（64px 的 data:image 图片），
// 点它切到「APP扫一扫登录」；二维码本身也是 data:image/png 的 <img>（约 160px）。
// 类名是哈希（css-xxxx），改版就变，所以这里只认「文案 + 图片尺寸 + data: 源」三样东西。
// 页面状态文案：
//   · 已扫未确认：「请在手机上确认登录」
//   · 过期：「二维码已失效，请刷新」+「刷新」按钮（约 1–2 分钟）
//   · 成功：离开 /login，跳到 /new/home

/** 页面里一次性读出扫码相关的全部信号；字符串形式便于在假页面上测。 */
const QR_PROBE = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const imgs = [...document.querySelectorAll('img')].filter((i) => (i.getAttribute('src') || '').startsWith('data:image'))
    .map((i) => ({ i, r: i.getBoundingClientRect() })).filter((x) => x.r.width > 0 && x.r.height > 0);
  const big = imgs.filter((x) => x.r.width >= 100).sort((a, b) => b.r.width - a.r.width)[0];
  return JSON.stringify({
    path: location.pathname,
    qrMode: /扫一扫登录|扫码登录|扫码即同意/.test(text),
    smsMode: /短信登录|发送验证码/.test(text),
    qr: big ? big.i.src : null,
    expired: /二维码已失效|二维码已过期|已失效|已过期/.test(text),
    scanned: /请在手机上确认|手机上确认登录|扫码成功/.test(text),
    risk: (text.match(/[^\\n]*(安全验证|滑块|拖动|风险|异常|频繁|稍后再试)[^\\n]*/) || [null])[0],
  });
})()`;

export async function qrProbe(tab) {
  return JSON.parse(await tab.eval(QR_PROBE));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 切到扫码登录。已经是扫码模式就什么都不做；否则点卡片右上角那个小 data:image 图标
 * （尺寸 40–100px 里最靠右上的一个），再回读确认真的切过去了——只点不回读就会把
 * 「页面改版、点了没反应」报成成功。
 */
export async function switchToQr(tab, { timeout = 8000 } = {}) {
  let probe = await qrProbe(tab);
  if (probe.qrMode) return probe;
  const clicked = await tab.eval(`(() => {
    const icons = [...document.querySelectorAll('img')].filter((i) => (i.getAttribute('src') || '').startsWith('data:image'))
      .map((i) => ({ i, r: i.getBoundingClientRect() })).filter((x) => x.r.width >= 24 && x.r.width < 100 && x.r.height > 0);
    if (!icons.length) return false;
    icons.sort((a, b) => (b.r.right - b.r.top) - (a.r.right - a.r.top));
    icons[0].i.click();
    return true;
  })()`);
  if (!clicked) throw new Error("找不到切换到扫码登录的图标，页面可能改版了");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await pause(250);
    probe = await qrProbe(tab);
    if (probe.qrMode) return probe;
  }
  throw new Error("点了扫码图标但没切到「APP扫一扫登录」，页面可能改版了");
}

/** 等二维码图片出现（切换后是异步渲染的）。返回 data:image/png 源。 */
export async function readQr(tab, { timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const probe = await qrProbe(tab);
    if (probe.qr && !probe.expired) return probe.qr;
    await pause(250);
  }
  throw new Error("扫码登录页没有出现二维码，页面可能改版了");
}

/**
 * 过期后点「刷新」换新码，并回读：新码必须和旧码不同且不再显示「已失效」，
 * 否则就是没换成功，不能把旧码当新码给人扫。
 */
export async function refreshQr(tab, previous = null, { timeout = 10000 } = {}) {
  const clicked = await tab.eval(`(() => {
    const leaves = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^(刷新|点击刷新|刷新二维码)$/.test((e.innerText || '').trim()));
    const el = leaves.find((e) => e.getBoundingClientRect().width > 0) || leaves[0];
    if (!el) return false;
    (el.closest('button,[role=button]') || el).click();
    return true;
  })()`);
  if (!clicked) throw new Error("二维码已失效，但找不到「刷新」按钮，页面可能改版了");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await pause(300);
    const probe = await qrProbe(tab);
    if (probe.qr && !probe.expired && probe.qr !== previous) return probe.qr;
  }
  throw new Error("点了「刷新」但二维码没有换新");
}

/**
 * 一次轮询：把页面状态归成五种之一。成功只看「离开了 /login」这一条页面信号，
 * 真正的「已登录」由调用方再用 pageLoggedIn + 持久 cookie 确认。
 *   ok · waiting · scanned · expired · failed
 */
export function qrStateOf(probe) {
  if (probe.path && !/\/login/.test(probe.path)) return "ok";
  if (probe.risk) return "failed";
  if (probe.expired) return "expired";
  if (probe.scanned) return "scanned";
  if (probe.qrMode && probe.qr) return "waiting";
  return "failed";
}
