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
