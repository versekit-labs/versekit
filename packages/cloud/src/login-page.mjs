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

export function signedInPage(user, revokePath) {
  return page("已登录", `<h1>已登录</h1>
    <p class="sub">${escapeHtml(user.email)}</p>
    <form method="post" action="${escapeHtml(revokePath)}"><button type="submit">退出</button></form>`);
}
