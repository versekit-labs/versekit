/* versekit 全站外壳（v2）：侧栏导航与账号组切换只有这一份。
 *
 * 页面只写导航骨架（四个链接，用来在没有 JS 时也能点）和 <body data-page="today">，
 * 这里补三件事：当前页高亮、待办数、账号组切换。
 *
 * 账号组从 /api/bootstrap 来，切换走命令 `group.use`（POST /api/groups/current），
 * 不写 localStorage：换一台浏览器打开还是同一个组，页面记的和 CLI 记的不会不一样。
 */
(function () {
  // 顺序与 docs/design 一致：今天 → 作品 → 数据 → 系统（design:check 会比对）。
  const NAV = [
    { key: "today", href: "/today", label: "今天" },
    { key: "works", href: "/works", label: "作品" },
    { key: "data", href: "/data", label: "数据" },
    { key: "system", href: "/system", label: "系统" },
  ];

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  function pageKey() {
    const key = document.body.dataset.page || "today";
    return NAV.some((item) => item.key === key) ? key : "today";
  }

  /** 导航高亮以页面为准，HTML 里的 aria-current 只是无 JS 时的兜底。 */
  function markCurrent(nav) {
    const key = pageKey();
    for (const item of NAV) {
      const link = nav.querySelector(`a.nv[data-key="${item.key}"]`);
      if (!link) continue;
      if (item.key === key) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function fillTodo(nav, count) {
    const badge = nav.querySelector("[data-todo]");
    if (!badge) return;
    const n = Number(count) || 0;
    badge.textContent = String(n);
    badge.hidden = !n;
  }

  const groupBadge = (group, count) =>
    `<span class="grp-tools">${group.id === window.VK.current()?.id ? '<i class="tick">当前</i>' : ""}${
      count ? `<b class="cnt" title="这个组里有 ${count} 件事等你">${count}</b>` : ""
    }</span>`;

  /**
   * 账号组切换：收起时是「名字 + 一行说明」，展开是组列表（当前组标"当前"，
   * 别的组有待办时带数字）和"新建账号组"（账号组管理在系统页）。
   */
  function renderGroupSwitch(nav, groups, current, pending) {
    if (!current) {
      // 还没建组：不假装有一个组，指向选组/建组页。
      const empty = el(
        `<a class="grp-empty" href="/system#groups">还没有账号组 · 去建一个</a>`,
      );
      nav.querySelector(".brand")?.after(empty);
      return;
    }
    const accountCount = VK.snapshot()?.accounts?.filter((account) => account.groupId === current.id).length ?? 0;
    const sub = groups.length > 1 ? `${accountCount} 个账号 · ${groups.length} 个组` : `${accountCount} 个账号`;
    const menu = groups
      .map((group) => {
        const isCurrent = group.id === current.id;
        const count = isCurrent ? 0 : Number(pending[group.id] ?? 0);
        return `<a href="/system#groups" data-group="${esc(group.id)}"${isCurrent ? ' aria-current="true"' : ""}><span><b>${esc(
          group.name,
        )}</b><small>${isCurrent ? "当前组" : count ? `${count} 件事等你` : "没有等你处理的"}</small></span>${groupBadge(group, count)}</a>`;
      })
      .join("");
    const box = el(
      `<details class="grp"><summary aria-label="账号组：${esc(current.name)}，点开切换"><span><b>${esc(
        current.name,
      )}</b><small>${esc(sub)}</small></span></summary><div class="menu">${menu}<a class="btn" href="/system#groups">新建账号组</a></div></details>`,
    );
    box.addEventListener("click", async (event) => {
      const link = event.target.closest("a[data-group]");
      if (!link) return; // 「新建账号组」是普通链接，浏览器自己走
      event.preventDefault();
      const id = link.dataset.group;
      box.open = false;
      if (id === window.VK.current()?.id) return;
      try {
        await window.VK.useGroup(id);
        location.reload();
      } catch (err) {
        toast(`没切过去：${err.message}`);
      }
    });
    document.addEventListener("click", (event) => {
      if (!box.contains(event.target)) box.open = false;
    });
    nav.querySelector(".brand")?.after(box);
  }

  /**
   * 侧栏底部摘要：几个账号登录正常、发布机在线、今天还能发几条。
   * 读 account.list 的同一份结果（与系统页账号表同源），所以两处不会各说各话。
   */
  async function renderHealth(nav, current) {
    let accounts = [];
    let failed = null;
    try {
      accounts = current ? await window.VK.groupAccounts(current.id) : [];
    } catch (err) {
      failed = err;
    }
    const ok = accounts.filter((a) => window.VK.loginState(a).key === "ok").length;
    const bad = accounts.length - ok;
    const left = accounts.reduce((n, a) => n + (a.quota?.left ?? 0), 0);
    const lines = failed
      ? [`<div><span class="dot bad"></span>读不到账号状态</div>`]
      : [
          `<div><span class="dot${bad ? " bad" : ""}"></span>${
            accounts.length ? `${ok} 个账号登录正常${bad ? `，${bad} 个要处理` : ""}` : "还没有接入账号"
          }</div>`,
          `<div><span class="dot"></span>发布机在线</div>`,
          ...(accounts.length ? [`<div><span class="dot"></span>今天还能发 ${left} 条</div>`] : []),
        ];
    nav.querySelector(".health")?.remove();
    const health = el(`<div class="health" data-health></div>`);
    health.innerHTML = lines.join("");
    nav.append(health);
  }

  let toastTimer = null;
  function toast(message) {
    let box = document.querySelector(".toast");
    if (!box) {
      box = el(`<div class="toast" role="status"></div>`);
      document.body.append(box);
    }
    box.textContent = message;
    box.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove("on"), 2600);
  }

  async function render() {
    // 旧流程页（add / groups / publish / runs）还是旧外壳：它们只写 <aside class="sidebar">。
    // 导航仍只有一份——这里按同一份 NAV 填进去，避免旧页面出现「点了没反应」的空侧栏。
    const legacy = document.querySelector("aside.sidebar");
    if (legacy) return renderLegacySidebar(legacy);

    const nav = document.querySelector("nav.nav");
    if (!nav) return;
    if (!nav.querySelector(".brand")) return; // 不是 v2 页面骨架，不碰
    markCurrent(nav);

    // 无 JS 时导航仍可用：这里只把 href 换成干净 URL，页面本身仍按文件名可达。
    for (const item of NAV) {
      const link = nav.querySelector(`a.nv[data-key="${item.key}"]`);
      if (link) link.setAttribute("href", item.href);
    }

    const VK = window.VK;
    if (!VK) return;
    try {
      await VK.ready();
    } catch (err) {
      nav.append(el(`<div class="health"><div><span class="dot bad"></span>读不到数据：${esc(err.message)}</div></div>`));
      return;
    }
    const current = VK.current();
    const groups = VK.groups();

    // 待办数与其他组的待办数都来自 today：四块里「等确认的成片 + 出了问题的」就是这个人今天要做的事。
    let today = null;
    try {
      today = await VK.today();
    } catch {
      today = null;
    }
    const mine = today ? today.awaiting.length + today.problems.length : 0;
    const pending = {};
    for (const other of today?.others ?? []) pending[other.group.id] = other.total;

    renderGroupSwitch(nav, groups, current, pending);
    fillTodo(nav, mine);
    await renderHealth(nav, current);
  }

  function renderLegacySidebar(sidebar) {
    const path = location.pathname;
    // 旧页面的地址 → 新外壳里的哪一项（账号相关都归到「系统」）。
    const key = path.startsWith("/publish")
      ? "publish"
      : path.startsWith("/runs") || path.startsWith("/tasks")
        ? "runs"
        : path.startsWith("/groups") || path.startsWith("/accounts")
          ? "system"
          : "today";
    const links = NAV.map((item) => {
      const current = item.key === key;
      return `<a href="${item.href}"${current ? ' aria-current="page"' : ""}>${item.label}</a>`;
    }).join("");
    sidebar.innerHTML =
      '<a class="brand" href="/today">versekit <span>/ vk</span></a>' +
      '<a class="publish" href="/publish"><b>+</b> 发布内容</a>' +
      `<nav class="nav" aria-label="主导航">${links}</nav>` +
      '<div class="local"><strong><i></i>本地运行中</strong>凭证与数据只在这台电脑</div>';
  }

  /** 页面改了账号（登录成功、接入、重新登录）后调用：侧栏摘要重新读一遍。 */
  async function refreshHealth() {
    const nav = document.querySelector("nav.nav");
    if (!nav || !window.VK) return;
    await window.VK.bootstrap({ force: true }).catch(() => {});
    await renderHealth(nav, window.VK.current());
  }

  window.VKShell = { render, NAV, toast, pageKey, refreshHealth };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
})();