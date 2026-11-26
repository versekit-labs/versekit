import { createHash } from "node:crypto";
import { escapeHtml, page, roleLabel } from "./login-page.mjs";
import { cloudRoute } from "./transport.mjs";

const style = `
:root { --side: #f1f1ee; --mark-bg: #fff8dc; --mark-line: #e6c84f; --mark-ink: #6b5d1c; }
@media (prefers-color-scheme: dark) {
  :root { --side: #222327; --mark-bg: #2e2a17; --mark-line: #ccab37; --mark-ink: #f3dd85; }
}
.wide { max-width: 680px; gap: 22px; }
.wide [hidden] { display: none; }
.admin { max-width: 860px; }
h2 { margin: 0; font-size: 18px; letter-spacing: -.01em; }
.top, .who, .actions, .machine-list li { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.top, .machine-list li { justify-content: space-between; }
.top nav { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.top nav a, .top nav button { min-height: 34px; }
.wide .link-text { min-width: 34px; }
.who { color: var(--ink-muted); font-size: 14px; overflow-wrap: anywhere; }
.avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--side); border: 1px solid var(--line); display: grid; place-items: center; color: var(--ink); }
.actions { gap: 12px; }
.panel { min-width: 0; padding: 16px 18px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); display: grid; align-content: start; gap: 12px; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }
.say { background: var(--side); border-radius: 8px; padding: 10px 12px; font-size: 14px; }
.primary { display: inline-flex; align-items: center; min-height: 36px; border: 1px solid var(--ink); border-radius: 8px; background: var(--ink); color: var(--bg); padding: 7px 14px; font-size: 14px; text-decoration: none; }
.wide form { display: contents; }
.wide form.confirm { display: grid; }
.machine-list { margin: 0; padding: 0; list-style: none; }
.machine-list li { padding: 10px 0; }
.machine-list li + li { border-top: 1px solid var(--line); }
.meta { color: var(--ink-muted); font-size: 13px; }
.pill { display: inline-block; white-space: nowrap; border-radius: 999px; border: 1px solid var(--line); padding: 1px 8px; color: var(--ink-muted); font-size: 12px; }
.good { color: var(--success); background: var(--success-bg); border-color: var(--success-line); }
.warn { color: var(--mark-ink); background: var(--mark-bg); border-color: var(--mark-line); }
.bad { color: var(--error); background: var(--error-bg); border-color: var(--error-line); }
meter { --fill: var(--ink-muted); appearance: none; width: 100%; height: 6px; display: block; background: var(--line); border-radius: 3px; }
meter.warn { --fill: var(--mark-line); }
meter.bad { --fill: var(--error); }
meter::-webkit-meter-bar { background: var(--line); border: 0; border-radius: 3px; }
meter::-webkit-meter-optimum-value { background: var(--fill); border-radius: 3px; }
meter::-moz-meter-bar { background: var(--fill); border-radius: 3px; }
.table-wrap { overflow: auto; min-width: 0; }
table { border-collapse: collapse; width: 100%; min-width: 740px; font-size: 14px; }
th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--line); }
th { color: var(--ink-muted); font-size: 12px; white-space: nowrap; }
td:first-child { overflow-wrap: anywhere; width: 25%; }
tr.pending td { background: var(--mark-bg); }
.table-wrap .actions { flex-wrap: nowrap; gap: 8px; }
.table-wrap :is(button, a, td:nth-child(5), time) { white-space: nowrap; }
input { font: inherit; min-height: 36px; padding: 4px 8px; background: var(--paper); color: var(--ink); border: 1px solid var(--control); border-radius: 8px; }
input[type="number"] { width: 7.5ch; }
.confirm input { width: 100%; }
.danger { color: var(--error); }
button.danger { border-color: var(--error); background: var(--error-bg); }
.note { padding-left: 12px; border-left: 3px solid var(--line); }
`;

const copyScript = `
const copyButton = document.querySelector("#copy-install");
const copyStatus = document.querySelector("#copy-status");
copyButton.hidden = false;
copyButton.addEventListener("click", async () => {
  const sentence = document.querySelector("#install-sentence");
  try {
    await navigator.clipboard.writeText(sentence.textContent);
    copyStatus.textContent = "已复制";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(sentence);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyStatus.textContent = "已选中这句话，请手动复制。";
  }
});
`;

const cspHash = (source) => createHash("sha256").update(source).digest("base64");
export const accountStyleHash = cspHash(style);
export const accountScriptHash = cspHash(copyScript);

const gb = 1_000_000_000;
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const relative = new Intl.RelativeTimeFormat("zh-CN");
const day = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "2-digit", day: "2-digit" });

function timeLabel(timestamp, now) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  const date = new Date(timestamp);
  const label = minutes === 0 ? "刚刚" : minutes < 60 ? relative.format(-minutes, "minute") :
    minutes < 1440 ? relative.format(-Math.floor(minutes / 60), "hour") : day.format(date);
  return `<time datetime="${date.toISOString()}" title="${date.toISOString()}">${label}</time>`;
}

function render(title, content, { session, owner, admin = false, copy = false } = {}) {
  const current = (selected) => selected ? ' aria-current="page"' : "";
  const identity = session ? `<div class="who"><span class="avatar" aria-hidden="true">${escapeHtml([...session.email][0].toUpperCase())}</span>${escapeHtml(session.email)}
    <form method="post" action="${cloudRoute("session.revoke").path}"><button class="link-text" type="submit">退出</button></form></div>` : "";
  const header = `<header class="top"><div class="brand">Hifabu</div>
    <nav aria-label="Hifabu"><a class="link-text" href="/download/">下载</a>${owner ? `<a class="link-text" href="/account"${current(!admin)}>我的 Hifabu</a>
    <a class="link-text" href="/admin"${current(admin)}>管理</a>` : ""}
    ${session ? identity : '<a href="/login" class="link-text">登录</a>'}</nav></header>`;
  return page(title, content, { header, extraStyle: style, mainClass: admin ? "wide admin" : "wide", script: copy ? copyScript : "" });
}

function downloadPanel(downloadUrl) {
  const href = downloadUrl || "/download/";
  return `<section class="panel"><h2>下载发布机</h2>
    <p class="sub">装在和你手机同一个网络的那台电脑上。平台账号只在这台电脑上登录。</p>
    <div class="actions"><a class="primary" href="${escapeHtml(href)}">下载 Mac 版</a><span class="sub">Windows 版还没有</span></div>
    <p class="sub">打开下载页查看当前版本、校验值和安装步骤。</p></section>`;
}

function pluginPanel() {
  return `<section class="panel"><h2>给 Claude 装插件</h2>
    <p class="sub">在做视频的那台电脑上，把这句话发给 Claude：</p>
    <p class="say" id="install-sentence">帮我安装 Hifabu 插件，地址是 hifabu.com/plugin</p>
    <div class="actions"><button class="link-secondary" id="copy-install" type="button" hidden>复制这句话</button><span class="sub" id="copy-status" role="status"></span></div>
    <p class="sub">装好后说「交给发布机」，第一次会让你登录。</p></section>`;
}

function machinesPanel(machines, now) {
  const rows = machines.map(({ id, name, role, lastSeenAt, createdAt }) => `<li><div>
    <p>${escapeHtml(name)} <span class="pill">${roleLabel(role)}</span></p>
    <p class="meta">${lastSeenAt == null ? "还没在线" : timeLabel(lastSeenAt, now) + "在线"} ·
      <time datetime="${new Date(createdAt).toISOString()}">${day.format(createdAt)}</time> 接入</p></div>
    <form method="post" action="${cloudRoute("device.revoke", { deviceId: id }).path}">
      <button class="link-secondary" type="submit" aria-label="退出这台 · ${escapeHtml(name)}">退出这台</button>
    </form></li>`).join("");
  return `<section class="panel"><h2>我的机器</h2>${rows ? `<ul class="machine-list">${rows}</ul>` :
    '<p class="sub">还没有机器。装好发布机或插件后，在那边点「登录 Hifabu」，它就会出现在这里。</p>'}</section>`;
}

function usageText(usedBytes, capacityBytes) {
  const magnitude = Math.max(usedBytes, capacityBytes);
  const [factor, unit] = magnitude >= gb ? [gb, "GB"] : magnitude >= 1_000_000 ? [1_000_000, "MB"] :
    magnitude >= 1000 ? [1000, "KB"] : [1, "B"];
  return `${number.format(usedBytes / factor)} / ${number.format(capacityBytes / factor)} ${unit}`;
}

function relayPanel({ enabled, requestedAt, closedAt, capacityBytes, usedBytes }) {
  let content;
  if (!enabled && requestedAt != null) {
    content = '<p class="message warn" role="status">已经申请，等开通。开通后这里会变，机器不用重新登录。</p>';
  } else if (!enabled) {
    content = `${closedAt == null ? "" : '<p class="message warn" role="status">传片已被关闭。</p>'}
      <p>在同一台电脑上做片和发布，不需要这个。</p>
      <p class="sub">分在两台电脑上时，成片要经过我们的服务器传过去。服务器空间有限，现在按人开通。</p>
      <div class="actions"><form method="post" action="${cloudRoute("relay.grant.request").path}"><button class="link-secondary" type="submit">申请开通</button></form></div>`;
  } else if (usedBytes == null) {
    content = '<div><span class="pill good">已开通</span></div><p class="sub">暂时查不到传片用量，请稍后刷新。</p>';
  } else {
    const fraction = capacityBytes === 0 ? 1 : Math.min(1, usedBytes / capacityBytes);
    const [label, tone, detail] = fraction === 1 ? ["满了", "bad", "容量已满，新的成片送不出去，已经送到的成片不受影响。"] :
      fraction >= 0.9 ? ["快满了", "warn", `还能再送约 ${number.format((capacityBytes - usedBytes) / 1_000_000)} MB。`] :
      ["已开通", "good", "成片到达发布机并入库后，服务器上的文件保留 7 天。"];
    content = `<div class="top"><span class="pill ${tone}">${label}</span><span class="sub">已用 ${usageText(usedBytes, capacityBytes)}</span></div>
      <meter class="${tone}" value="${fraction}" aria-label="传片容量已用 ${Math.round(fraction * 100)}%"></meter><p class="sub">${detail}</p>`;
  }
  return `<section class="panel"><h2>两台电脑之间传片</h2>${content}</section>`;
}

export function accountPage({ session, owner, grant, machines, downloadUrl, now }) {
  return render("我的 Hifabu", `<h1>我的 Hifabu</h1>
    ${session ? `<div class="two">${downloadPanel(downloadUrl)}${pluginPanel()}</div>
      ${machinesPanel(machines, now)}${relayPanel(grant)}` : downloadPanel(downloadUrl)}`, { session, owner, copy: Boolean(session) });
}

function adminRow({ id, email, providers, machines, enabled, requestedAt, closedAt, capacityBytes, usedBytes, lastActivityAt }, now) {
  const pending = !enabled && requestedAt != null;
  const grantPath = cloudRoute("relay.grant.set", { accountId: id }).path;
  const clearName = escapeHtml(email);
  return `<tr${pending ? ' class="pending"' : ""}><td>${clearName}</td>
    <td>${providers.map((provider) => provider === "google" ? "Google" : provider === "email" ? "邮箱" : escapeHtml(provider)).join("、")}</td>
    <td>${machines}</td>
    <td><div class="actions"><span class="pill ${enabled ? "good" : pending ? "warn" : ""}">${enabled ? "已开通" : pending ? "申请了" : closedAt == null ? "没开" : "已关闭"}</span>
      <form method="post" action="${grantPath}"><button class="${pending ? "link-secondary" : "link-text"}" type="submit" name="state" value="${enabled ? "off" : "on"}">${enabled ? "关闭" : "开通"}</button></form>
    </div></td>
    <td>${usedBytes == null ? "暂不可用" : usageText(usedBytes, capacityBytes)}</td>
    <td><div class="actions"><form method="post" action="${grantPath}">
      <input type="number" name="capacityGb" min="0" step="any" required value="${capacityBytes / gb}" aria-label="${clearName} 的传片容量（GB）">
      <span class="sub">GB</span><button class="link-text" type="submit">保存</button></form></div></td>
    <td>${timeLabel(lastActivityAt, now)}</td><td><a class="link-text danger" href="/admin?delete=${encodeURIComponent(id)}">删除账号</a></td></tr>`;
}

export function adminPage({ session, users, freeBytes, now }) {
  const enabled = users.filter((user) => user.enabled).length;
  const pending = users.filter((user) => !user.enabled && user.requestedAt != null).length;
  return render("管理", `<h1>管理</h1><div class="top"><h2>用户</h2><p class="sub">${pending} 条待处理申请 · 已开通 ${enabled} 人${freeBytes == null ? "" : ` · 服务器还剩 ${number.format(freeBytes / gb)} GB`}</p></div>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Hifabu 账号列表"><table>
    <thead><tr><th scope="col">Hifabu 账号</th><th scope="col">登录方式</th><th scope="col">机器</th><th scope="col">传片</th><th scope="col">已用</th><th scope="col">容量</th><th scope="col">最近活动</th><th scope="col">账号操作</th></tr></thead>
    <tbody>${users.map((user) => adminRow(user, now)).join("")}</tbody></table></div>
    <p class="sub note">关闭传片后，新的成片送不出去，已经送到发布机的不受影响。</p>`, { session, owner: true, admin: true });
}

export function deleteAccountPage(session, user, message) {
  const email = escapeHtml(user.email);
  return render("删除账号", `<h1>删除账号</h1><form class="confirm" method="post" action="${cloudRoute("user.delete", { accountId: user.id }).path}">
    ${message ? `<p class="message" role="alert">${escapeHtml(message)}</p>` : ""}
    <p>将永久删除 <strong>${email}</strong> 的 Hifabu 账号、会话、接入的机器、传片开通记录和服务器上的成片。这个操作无法撤销。</p>
    <label for="confirm-email">输入 ${email} 以确认删除</label>
    <input id="confirm-email" name="confirmEmail" type="email" required autocomplete="off">
    <div class="actions"><button class="danger" type="submit">确认删除</button><a class="link-secondary" href="/admin">取消</a></div></form>`, { session, owner: true, admin: true });
}

export function accountErrorPage(message, back, session, owner = false) {
  return render("请求未完成", `<h1>请求未完成</h1><p class="message" role="alert">${escapeHtml(message)}</p>
    <div><a class="link-secondary" href="${back}">返回</a></div>`, { session, owner, admin: back === "/admin" });
}
