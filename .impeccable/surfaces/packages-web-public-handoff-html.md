---
version: 1
slug: "packages-web-public-handoff-html"
primary_target: "packages/web/public/handoff.html"
related_targets: []
---

# 交接页（手机）

- **Scope**：`packages/web/public/handoff.html`，线上路径 `/h/<token>`；手机浏览器经局域网打开（与 `/a/` 同一安全边界）。
- **Audience**：站在手机前、刚收到飞书卡片或扫了电脑上二维码的创作者，要把一条小红书笔记在 App 里发出去。
- **Job**：把电脑上准备好的内容无损带到手机小红书里——复制标题、复制正文（含话题）、保存全部图片，打开 App，发完回来留回执。
- **Success**：375px 宽一屏内看到账号、标题、正文；复制在 http 局域网下也有反馈；「打开小红书」「一键分享」不可用时不报错；点「我已发布」后电脑端状态变为已发布。
- **Not doing**：不登录、不发布、不访问小红书域名（除深链 `xhsdiscover://` 拉起本机 App）；不做编辑器；不展示任何账号凭证；不提供「重试」。
- **Data**：只来自 `/h/<token>/data`、`/h/<token>/asset/<n>`、`/h/<token>/done|skip`；页面自包含（`/app.css`、`/shell.js` 局域网不可达）。
- **Constraints**：触控目标 ≥ 44px；无横向溢出；过期/已终结时说人话并收起按钮；重复点击由 command_audit 去重。
- **Finish**：`npm run ci` 全绿（design:check 含该页 375/390/1440 运行时检查）；真机扫码到 App 发布由用户本人验收。
