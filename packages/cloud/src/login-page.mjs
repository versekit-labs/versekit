import { createHash } from "node:crypto";

const style = `
:root {
  --bg: #fafaf8;
  --paper: #fffffe;
  --ink: #1a1c1f;
  --ink-muted: #5f656c;
  --line: #e5e6e3;
  --error: #c4321c;
  --error-bg: #fdf3f0;
  --error-line: #edc3b9;
  --control: #d3d5d1;
  --success: #0f7a4a;
  --success-bg: #edf7f1;
  --success-line: #bfdccb;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #141517;
    --paper: #1c1d20;
    --ink: #ecedef;
    --ink-muted: #a8adb3;
    --line: #2e3034;
    --error: #ff8a73;
    --error-bg: #2d1c18;
    --error-line: #6a3428;
    --control: #3d4045;
    --success: #5fd39a;
    --success-bg: #16271e;
    --success-line: #2d5a41;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 28px 20px;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}
main { max-width: 440px; margin: 0 auto; display: grid; gap: 14px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: -.01em; }
.brand::before { content: ""; width: 14px; height: 14px; border-radius: 4px; background: var(--ink); }
h1 { margin: 0; font-size: 24px; line-height: 1.25; letter-spacing: -.02em; }
p { margin: 0; overflow-wrap: anywhere; }
.sub { color: var(--ink-muted); font-size: 14px; }
a { color: inherit; }
form { display: grid; gap: 12px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); }
button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 7px 14px;
  border: 1px solid var(--ink);
  border-radius: 8px;
  background: var(--ink);
  color: var(--bg);
  font: inherit;
  cursor: pointer;
}
.message {
  padding: 8px 12px;
  border: 1px solid var(--error-line);
  border-radius: 8px;
  background: var(--error-bg);
  color: var(--error);
  font-size: 14px;
}
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
::selection { background: #ffd84a; color: #1a1c1f; }
.link-panel { padding: 16px 18px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); display: grid; gap: 12px; }
.link-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 14px; }
.link-facts dt { color: var(--ink-muted); }
.link-facts dd { margin: 0; overflow-wrap: anywhere; }
.link-code { font: 13px "SF Mono", ui-monospace, Menlo, Consolas, monospace; }
.link-actions { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.link-actions form, .machine-list form { display: contents; }
.link-secondary, .link-text {
  display: inline-flex; align-items: center; justify-content: center; font: inherit;
  font-size: 14px; cursor: pointer; min-height: 36px;
}
.link-secondary { padding: 7px 14px; border: 1px solid var(--control); border-radius: 8px; background: var(--paper); color: var(--ink); text-decoration: none; }
.link-text { background: none; border: 0; border-radius: 0; padding: 0; color: var(--ink-muted); text-decoration: underline; }
.link-success { background: var(--success-bg); border-color: var(--success-line); color: var(--success); }
.machine-list { margin: 0; padding: 0; list-style: none; }
.machine-list li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 8px 0; }
.machine-list li + li { border-top: 1px solid var(--line); }
`;

export const loginStyleHash = createHash("sha256").update(style).digest("base64");

const htmlEntities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => htmlEntities[character]);

function page(title, content) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Hifabu</title>
  <style>${style}</style>
</head>
<body>
  <main>
    <div class="brand">Hifabu</div>
    ${content}
  </main>
</body>
</html>`;
}

export function loginPage({ machine, message, googlePath }) {
  return page("登录", `<h1>登录</h1>
    ${machine ? `<p class="sub">登录后继续接入「${escapeHtml(machine.name)}」。</p>` : ""}
    <form method="post" action="${escapeHtml(googlePath)}">
      ${machine ? `<input type="hidden" name="code" value="${escapeHtml(machine.code)}">` : ""}
      ${message ? `<p class="message" role="alert">${escapeHtml(message)}</p>` : ""}
      <button type="submit">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 8h6.4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>
        用 Google 继续
      </button>
    </form>
    <p class="sub">登录即表示同意<a href="/privacy/">隐私政策</a>。我们只存你的邮箱和接入的机器，不存你的平台登录。</p>`);
}

export function signedInPage(user, revokePath, machines = "") {
  return page("已登录", `<h1>已登录</h1>
    <p class="sub">${escapeHtml(user.email)}</p>
    ${machines}
    <form method="post" action="${escapeHtml(revokePath)}"><button type="submit">退出</button></form>`);
}

const accountLink = '<div class="link-actions"><a href="/account" class="link-secondary">看我的机器</a></div>';
const roleLabel = (role) => role === "maker" ? "制作机" : "发布机";

export function accountMachines(machines, revokePath) {
  if (!machines.length) return "";
  return `<section class="link-panel" aria-label="我的机器"><ul class="machine-list">
    ${machines.map((machine) => `<li><p>${escapeHtml(machine.name)} <span class="sub">${roleLabel(machine.role)}</span></p>
      <form method="post" action="${escapeHtml(revokePath(machine.id))}"><button class="link-secondary" type="submit">退出这台</button></form></li>`).join("")}
  </ul></section>`;
}

export function linkPage({ link, email, login, decisionPath } = {}) {
  if (!link) {
    if (login) return page("接入机器", `<h1>先登录 Hifabu 账号</h1>
      <div class="link-panel"><p>登录后会回到这一页，继续接入这台机器。</p>
      <div class="link-actions"><a href="${escapeHtml(login)}" class="link-secondary">登录 Hifabu</a></div></div>`);
    return page("这次接入过期了", `<h1>这次接入过期了</h1>
      <div class="link-panel"><p>接入要在 10 分钟内点允许。</p>
      <p class="sub">回到那台电脑上重新点「登录 Hifabu」，它会再打开这一页。</p></div>`);
  }

  const name = escapeHtml(link.name);
  const maker = link.role === "maker";
  if (link.state === "linked") {
    return page("接上了", `<h1>接上了</h1><div class="link-panel">
      <p class="message link-success">「${name}」已经接入</p>
      <p class="sub">可以关掉这一页，那台电脑会自己继续。${maker ? "回到 Claude，它会接着把刚才那一期交出去。" : ""}</p>
      ${accountLink}</div>`);
  }
  if (link.state === "denied") {
    return page("已拒绝", `<h1>已拒绝</h1><div class="link-panel">
      <p>「${name}」没有接进来。</p>
      <p class="sub">如果你没有在装 Hifabu，说明有人在试着接入你的账号。到「我的 Hifabu」看一眼有没有不认识的机器。</p>
      ${accountLink}</div>`);
  }

  const purpose = maker ? "用来送作品" : "作为发布机";
  const can = maker ? "把做好的成片、封面、文案送到你的发布机；看送到了没有" : "接收你的制作机送来的成片；按你确认过的时间发布";
  const cannot = maker ? "发布；登录或操作你的平台账号" : "发布你没有确认过的内容；接收别人账号送来的东西";
  return page("接入机器", `<h1>「${name}」想接入你的 Hifabu 账号，${purpose}</h1>
    <p class="sub">你现在登录的是 ${escapeHtml(email)}。<a class="link-text" href="${escapeHtml(login)}">换一个账号</a></p>
    <div class="link-panel">
      <dl class="link-facts">
        <dt>机器</dt><dd>${name} <span class="sub">${roleLabel(link.role)}${link.os ? ` · ${escapeHtml(link.os)}` : ""}</span></dd>
        <dt>它能做</dt><dd>${can}</dd><dt>它不能做</dt><dd>${cannot}</dd>
        <dt>核对码</dt><dd><span class="link-code">${escapeHtml(link.code)}</span> <span class="sub">和那台电脑上显示的一样才点允许</span></dd>
      </dl>
      <div class="link-actions"><form method="post" action="${escapeHtml(decisionPath)}">
        <button type="submit" name="decision" value="allow">允许</button>
        <button type="submit" name="decision" value="deny" class="link-text">不是我</button>
      </form></div>
    </div>`);
}
