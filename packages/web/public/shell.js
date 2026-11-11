/* versekit 全站外壳：侧栏导航只有这一份。
 *
 * 为什么抽出来：导航原先在每个页面里各写一遍，结果出现「计划」在某些页被禁用、
 * 另一些页直接指向旧单页 `/#publish`。页面一多就必然漂移，闸门也拦不住语义。
 * 现在页面只写 `<aside class="sidebar"></aside>` + `<body data-page="...">`，
 * 这里按 data-page 标出当前页，链接一律指向新页面的干净 URL。
 */
(function () {
  // 顺序与设计稿一致：账号 → 发布 → 计划 → 总览 → 任务与日志。
  const NAV = [
    { key: "accounts", href: "/accounts", label: "账号" },
    { key: "publish", href: "/publish", label: "发布" },
    { key: "plan", href: "/plan", label: "计划" },
    { key: "overview", href: "/overview", label: "总览" },
    { key: "runs", href: "/runs", label: "任务与日志" },
  ];

  function render() {
    const el = document.querySelector("aside.sidebar");
    if (!el) return;
    const active = document.body.dataset.page || "";
    const links = NAV.map((item) =>
      `<a href="${item.href}"${item.key === active ? ' aria-current="page"' : ""}>${item.label}</a>`,
    ).join("");
    el.innerHTML =
      '<a class="brand" href="/overview">versekit <span>/ vk</span></a>' +
      '<a class="publish" href="/publish"><b>+</b> 发布内容</a>' +
      `<nav class="nav" aria-label="主导航">${links}</nav>` +
      '<div class="local"><strong><i></i>本地运行中</strong>凭证与数据只在这台电脑</div>';
  }

  window.VKShell = { render, NAV };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
})();