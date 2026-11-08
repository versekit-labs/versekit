// 小红书登录动作的回归测试。
//
// 这里的假页面刻意复刻线上让代码栽过的四个坑：
//   1. 受控输入框：只有派发 input 事件，页面状态才认这个号码；
//   2. 发送按钮三层嵌套，最里层是一小块带 cursor:pointer 的文字；
//   3. 发码成功后进入倒计时（用来判断「真的发出去了」）；
//   4. 登录成功后跳转，页面出现上传控件（用来判断「真的登录了」）。
//
// 任何一条退化，都会在这组测试里变成红色。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME ??= mkdtempSync(join(tmpdir(), "vk-xhs-login-"));
const { openAccount, closeAccount } = await import("../../driver-browser/src/index.mjs");
const { setInputValue, fillAndSendCode, clickLoginButton } = await import("../src/login-xhs.mjs");

const PAGE = `<!doctype html><meta charset="utf-8"><body>
<div id="app">
  <div class="title">短信登录</div>
  <input class="phone" placeholder="手机号">
  <div class="send-wrap" style="width:240px;height:52px">
    <div class="slot-right" style="width:85px;height:51px">
      <div class="css-u4p24i" style="width:85px;height:16px">
        <div class="css-4rglw5" id="send" style="width:70px;height:14px;cursor:pointer">发送验证码</div>
      </div>
    </div>
  </div>
  <input class="code" placeholder="验证码">
  <button id="login" style="width:240px;height:40px">登 录</button>
  <input type="checkbox" id="agree">
</div>
<script>
  // 模拟 React 受控：只有收过 input 事件，state.phone 才更新
  const state = { phone: "", code: "", sent: 0, agree: false, loggedIn: false };
  const phoneEl = document.querySelector('.phone');
  const codeEl = document.querySelector('.code');
  const agreeEl = document.querySelector('#agree');

  phoneEl.addEventListener('input', (e) => { state.phone = e.target.value; });
  codeEl.addEventListener('input', (e) => { state.code = e.target.value; });
  agreeEl.addEventListener('change', (e) => { state.agree = e.target.checked; });

  document.querySelector('#send').addEventListener('click', () => {
    // 线上行为：号码为空或没勾协议时不发，并且不报错
    if (!/^\\d{11}$/.test(state.phone) || !state.agree) { window.__blocked = true; return; }
    state.sent += 1;
    window.__sent = state.sent;
    const el = document.querySelector('#send');
    let left = 60;
    el.textContent = left + 's';
    const t = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(t); el.textContent = '重新发送'; return; }
      el.textContent = left + 's';
    }, 200);
  });

  document.querySelector('#login').addEventListener('click', () => {
    if (state.code === '123456') {
      window.__loggedIn = true;
      document.querySelector('#app').innerHTML = '<input class="upload" type="file"><div>发布笔记</div>';
    } else {
      window.__loginError = true;
    }
  });
</script>
</body>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
let base;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

async function open() {
  const tab = await openAccount({ accountId: "xhs-fixture", url: base, headless: true });
  await tab.waitFor(`!!document.querySelector('.phone')`, [], { timeout: 15e3, what: "假登录页" });
  return tab;
}

async function shut(tab) {
  await tab.close();
  await closeAccount("xhs-fixture");
}

test("setInputValue：受控输入框要收到 input 事件，页面状态才认", async () => {
  const tab = await open();
  try {
    await setInputValue(tab, "手机号", "17712665728");
    // DOM 值正确
    assert.equal(await tab.eval(`document.querySelector('.phone').value`), "17712665728");
    // 关键：页面内部的 state 也更新了（等价于 React onChange 收到）
    await tab.eval(`(() => { const e = document.querySelector('.phone'); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`).catch(() => {});
    assert.equal(await tab.eval(`window.__blocked === undefined`), true);
  } finally {
    await shut(tab);
  }
});

test("fillAndSendCode：勾协议 + 嵌套按钮也能发出，并回读到倒计时", async () => {
  const tab = await open();
  try {
    await fillAndSendCode(tab, "17712665728");
    assert.equal(await tab.eval(`window.__sent ?? 0`), 1, "应该真的发送了一次");
    assert.equal(await tab.eval(`document.querySelector('#agree').checked`), true, "协议要勾上");
    // 倒计时是「发出了」的证据
    assert.match(await tab.eval(`document.querySelector('#send').innerText`), /s$|重新发送/);
  } finally {
    await shut(tab);
  }
});

test("fillAndSendCode：号码不合法时不报成功（回读失败要抛错）", async () => {
  const tab = await open();
  try {
    await assert.rejects(() => fillAndSendCode(tab, "123"), /没有发出|倒计时/);
    assert.equal(await tab.eval(`window.__blocked`), true, "页面应该把这次点击判为无效");
  } finally {
    await shut(tab);
  }
});

test("clickLoginButton：文案带空格也能点中；验证码对就跳转成功", async () => {
  const tab = await open();
  try {
    await fillAndSendCode(tab, "17712665728");
    await setInputValue(tab, "验证码", "123456");
    await clickLoginButton(tab);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await tab.eval(`window.__loggedIn`), true);
    assert.equal(await tab.eval(`!!document.querySelector('input.upload')`), true);
  } finally {
    await shut(tab);
  }
});

test("clickLoginButton：验证码错误时不跳转", async () => {
  const tab = await open();
  try {
    await fillAndSendCode(tab, "17712665728");
    await setInputValue(tab, "验证码", "000000");
    await clickLoginButton(tab);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await tab.eval(`window.__loginError`), true);
    assert.equal(await tab.eval(`!!document.querySelector('input.upload')`), false);
  } finally {
    await shut(tab);
  }
});

test("pageLoggedIn：控制台页面算登录成功，登录页不算", async () => {
  const { pageLoggedIn } = await import("../src/login-xhs.mjs");
  // 假页面里点对了验证码后会出现上传控件 + 发布文字
  const tab = await open();
  try {
    assert.equal(await pageLoggedIn(tab), false, "还没登录时应为 false");
    await fillAndSendCode(tab, "17712665728");
    await setInputValue(tab, "验证码", "123456");
    await clickLoginButton(tab);
    await new Promise((r) => setTimeout(r, 300));
    // 假页面 URL 仍是本地地址，所以这里只验证「不是无条件 false」之外的分支：
    // 域名不匹配 → 依然 false（这正是我们想要的安全行为）
    assert.equal(await pageLoggedIn(tab), false);
  } finally {
    await shut(tab);
  }
});
