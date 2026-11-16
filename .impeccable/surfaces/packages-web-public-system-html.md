---
version: 1
slug: "packages-web-public-system-html"
primary_target: "packages/web/public/system.html"
related_targets: ["packages/web/public/panel.js","packages/web/public/app.css"]
---

# 系统页：TikTok 官方接口的连接与发布设置（审核演示用，#173）

- **Scope**：`packages/web/public/system.html`（账号处的 Connect TikTok）与 `packages/web/public/panel.js`（TikTok 平台稿确认时的设置面板，今天页与作品详情页共用）。样式只加在 `app.css`。
- **为谁**：创作者本人，以及 TikTok 应用审核员（审核视频里要拍到这两处）。界面必须和提交给审核的说明（#143）逐句一致。
- **解决什么**：（1）一键连上 TikTok 账号并看到头像、昵称，确认连对了号；（2）发之前由人亲手选隐私级别、开关、改文案，再选 Post 或 Send to TikTok drafts；（3）发完看到进度和结果，失败说人话。
- **对象模型**：一个 TikTok 官方接口账号 = 一行账号；一条 TikTok 平台稿 = 一块设置面板。设置存在平台稿上（`vk publish edit`），不存在页面里。
- **页面职责**：系统页只管「连账号」；设置面板只管「这一条怎么发」。一页一个任务。
- **状态词表**：未连接 / 等待授权 / 已连接；等你选 / 排队中 / 上传并发布中 / 已发布 / 已送到 TikTok 草稿箱 / 出了问题（带原因）。
- **成功长什么样**：隐私级别默认不选、没选 Post 点不了且说明原因；评论、合拍、拼接默认全关，creator_info 不允许的置灰并说原因；AI 生成标记可见；结果一眼能看出成没成。
- **明确不做**：不预选任何隐私级别；不在代码里写死隐私选项（只来自 creator_info）；不加水印；不做数据采集；不改浏览器自动化后端；不改 API 形状。
- **数据从哪来**：`/api/accounts`（头像、昵称）、`/api/accounts/:id/connect`、`/api/accounts/:id/creator`（creator_info）、`/api/publishes/:id/edit`、`/api/publishes/:id/now`、`/api/works/:id`（轮询状态）。对应命令：`vk account connect` / `vk account creator` / `vk publish edit` / `vk publish now`。
- **Finish**：`npm run ci` 全绿；用本地 mock 的 TikTok 服务端把审核视频四段走一遍并截图（`docs/screenshots/issue-173/`）；不碰真实账号。
