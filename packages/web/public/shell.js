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

  // 侧栏摘要里的平台叫法（与 panel.js 的 PF 一致；这里不依赖 panel.js，它比 shell.js 晚加载）。
  const PLATFORM_NAME = {
    xiaohongshu: "小红书", douyin: "抖音", shipinhao: "视频号", bilibili: "B站", tiktok: "TikTok", "tiktok-api": "TikTok",
    youtube: "YouTube", web: "官网", gongzhonghao: "公众号",
  };

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
   * 出口位置（ACC-v3-egress-02）：灰字 + 墨色地名 + IP；和账号平时的国家不一样时黄点「出口位置变了」。
   * 两条线路出口不一样时侧栏只写第一条，两条都写在系统页。
   */
  function egressLines(machine) {
    const e = machine?.egress;
    if (!e) return [];
    if (e.pausedCount) return [`<div class="nw"><span class="dot" style="background:var(--mark)"></span>出口位置变了</div>`, ...(e.place ? [`<div class="nw ind">${esc(e.place)}${e.ip ? ` · ${esc(e.ip)}` : ""}</div>`] : [])];
    if (e.place) return [`<div class="nw ind"><b style="color:var(--ink);font-weight:500">${esc(e.place)}</b>${e.ip ? ` <span style="color:var(--ink2)">${esc(e.ip)}</span>` : ""}</div>`];
    return [`<div class="nw ind" title="${esc(e.note ?? "")}">出口位置：查不到</div>`];
  }

  /**
   * 侧栏底部摘要：几个账号登录正常、发布机在线、今天还能发几条。
   * 读 account.list 的同一份结果（与系统页账号表同源），所以两处不会各说各话。
   */
  async function renderHealth(nav, current, notify = null) {
    let accounts = [];
    let failed = null;
    let machine = null; // 与系统页「发布机」同源：GET /api/machine（machine.status）
    try {
      accounts = current ? await window.VK.groupAccounts(current.id) : [];
    } catch (err) {
      failed = err;
    }
    try {
      machine = await window.VK.request(`/api/machine${current ? `?group=${encodeURIComponent(current.id)}` : ""}`);
    } catch {
      machine = null;
    }
    const ok = accounts.filter((a) => window.VK.loginState(a).key === "ok").length;
    const bad = accounts.length - ok;
    // 今天还能发：按平台说，不跨平台相加（ACC-v3-fid-04）。不限额的账号不出现。
    const leftBy = new Map();
    for (const a of accounts) {
      if (!a.quota) continue;
      const name = PLATFORM_NAME[a.platform] ?? a.platform;
      leftBy.set(name, (leftBy.get(name) ?? 0) + (a.quota.left ?? 0));
    }
    const leftLines = [...leftBy].map(([name, n]) => `${name} ${n} 条`);
    const quotaLines = !leftLines.length ? []
      : leftLines.length === 1 ? [`<div class="nw"><span class="dot"></span>今天还能发：${esc(leftLines[0])}</div>`]
        : [`<div class="nw"><span class="dot"></span>今天还能发</div>`, ...leftLines.map((t) => `<div class="nw ind">${esc(t)}</div>`)];
    const lines = failed
      ? [`<div><span class="dot bad"></span>读不到账号状态</div>`]
      : [
          // 有问题只写「N 个账号要处理」，全正常写「N 个账号登录正常」：一行放得下，不折行。
          ...(machine?.egress?.pausedCount
            ? [`<div class="nw"><span class="dot" style="background:var(--mark)"></span>${machine.egress.pausedCount} 个账号暂停发布</div>`]
            : []),
          `<div class="nw"><span class="dot${bad ? " bad" : ""}"></span>${
            accounts.length ? (bad ? `${bad} 个账号要处理` : `${ok} 个账号登录正常`) : "还没有接入账号"
          }</div>`,
          machine?.online
            ? `<div class="nw"><span class="dot"></span>发布机在线</div>`
            : `<div class="nw"><span class="dot bad"></span>${machine ? "发布机不在线" : "读不到发布机状态"}</div>`,
          ...egressLines(machine),
          // 飞书卡片发不出去：和系统页「通知」分段同源（today.notify），点进去看原因、重新接。
          ...(notify?.why === "failed" ? [`<div class="nw"><span class="dot bad"></span><a href="/system#tab=notify" style="color:inherit;text-decoration:none">飞书卡片发不出去</a></div>`] : []),
          ...quotaLines,
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
    await renderHealth(nav, current, today?.notify ?? null);
  }

  /** 页面改了账号（登录成功、接入、重新登录）后调用：侧栏摘要重新读一遍。 */
  async function refreshHealth() {
    const nav = document.querySelector("nav.nav");
    if (!nav || !window.VK) return;
    await window.VK.bootstrap({ force: true }).catch(() => {});
    const today = await window.VK.today().catch(() => null);
    await renderHealth(nav, window.VK.current(), today?.notify ?? null);
  }

  /* 发布机换了版本后，已打开的页面跟着换新（ACC-update-07）。
   * 每个页面记下载入时 /api/stream 推来的提交号；变了就：没有编辑中的内容 → 刷新一次；
   * 有未保存的输入 → 只在顶部提示，不动输入。提交号来自服务端 buildInfo()，这里不另造。 */
  function hasUnsavedInput() {
    for (const f of document.querySelectorAll("input, textarea, select, [contenteditable='true']")) {
      if (f.closest("[data-no-dirty]")) continue;
      if (f.isContentEditable && f.tagName !== "INPUT" && f.tagName !== "TEXTAREA") {
        if (f.textContent.trim()) return true;
        continue;
      }
      const type = (f.type || "").toLowerCase();
      if (["hidden", "button", "submit", "reset"].includes(type)) continue;
      if (type === "checkbox" || type === "radio") {
        if (f.checked !== f.defaultChecked) return true;
      } else if (f.tagName === "SELECT") {
        if ([...f.options].some((o) => o.selected !== o.defaultSelected)) return true;
      } else if (f.value !== f.defaultValue) return true;
    }
    return false;
  }

  function showUpdateBanner(version) {
    if (document.querySelector("[data-update-banner]")) return;
    const bar = el(
      `<div data-update-banner role="status" style="position:sticky;top:0;z-index:50;display:flex;gap:12px;align-items:center;justify-content:center;padding:8px 16px;background:#fff6dd;color:#4a3b00;border-bottom:1px solid #e6cf85;font-size:14px">` +
        `<span>发布机已更新到 ${esc(version)}，刷新后能用上新功能</span><button type="button" data-update-reload style="min-height:32px;padding:0 12px">刷新</button></div>`,
    );
    bar.querySelector("[data-update-reload]").addEventListener("click", () => location.reload());
    document.body.prepend(bar);
  }

  /** 收到一帧推送：第一帧记基线，之后提交号变了才动作。导出给测试用。 */
  function makeBuildWatcher({ reload = () => location.reload(), banner = showUpdateBanner, dirty = hasUnsavedInput } = {}) {
    let baseline = null;
    let done = false;
    return (build) => {
      const commit = build?.commit;
      if (!commit || done) return;
      if (baseline === null) {
        baseline = commit;
        return;
      }
      if (commit === baseline) return;
      if (dirty()) {
        banner(build.version ?? commit.slice(0, 7));
        return; // 有输入时每帧都可能再来，banner 自己去重；用户处理完输入后仍可点「刷新」
      }
      done = true;
      reload();
    };
  }

  function watchBuild() {
    if (typeof EventSource === "undefined") return;
    const onBuild = makeBuildWatcher();
    const es = new EventSource("/api/stream");
    es.onmessage = (e) => {
      try {
        onBuild(JSON.parse(e.data).build);
      } catch {
        /* 坏帧忽略 */
      }
    };
  }

  window.VKShell = { render, NAV, toast, pageKey, refreshHealth, makeBuildWatcher, hasUnsavedInput };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => (render(), watchBuild()));
  else (render(), watchBuild());
})();
