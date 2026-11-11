---
version: 1
slug: "packages-web-public-add-html"
primary_target: "packages/web/public/add.html"
related_targets: ["docs/design/add.html"]
---

# 添加账号 · 实现任务书

- **Scope**：`packages/web/public/add.html`，线上路径 `/accounts/add`；桌面 1440 与手机 390。
- **Mode**：Operate。
- **Audience**：刚建完账号组、要给当前组接入一个平台账号，或补一个空槽位的创作者。
- **Job**：在当前账号组里登记一个平台账号；同组同平台只能有一个，已被占用的平台不能选。
- **Action**：选平台（已接入的灰掉并写明被谁占用）→ 填账号名 → 登记并回到账号页看到新账号。
- **Proof / Content**：锁定的账号组名；五个平台及占用者（handle / 显示名）；每个平台的授权方式；登记成功后的账号 id 与等价 `vk account reauth <id>` 命令。
- **Constraints**：组在此页锁定，不能切换；数据只来自 `/api`；登记走命令表派生的 `POST /api/accounts`（等价 `vk account add <platform> --group <组> --name <名字>`）；不伪造平台扫码结果，授权只如实交还给电脑前的用户；完成回账号页必须能看到新账号；没有当前组时先回 `/groups.html`。

## Direction contract

**THESIS**：授权是一个短流程，登记与授权分开：这个页只负责把平台账号登记进当前组，并诚实告诉人授权要在电脑前完成。已占用的平台先灰掉并写出占用者，避免走到最后才报冲突。

**OWN-WORLD**：白面板、深蓝主按钮、自绘平台标识、文字步骤条、零阴影；沿用 `docs/design/app.css` 的 token 与组件。

**STORY**：读当前组（锁定）→ 选平台（可用/已占用两种状态）→ 填账号名并确认「这个平台只挂一个账号」→ 完成，看到新账号 id 与 `vk account reauth <id>` → 回到账号页确认新账号在槽位上。

**FIRST VIEWPORT**：页头「添加账号 / 为当前账号组接入一个平台账号」、锁定的账号组提示、三步指示、平台选择网格（两列，已占用灰掉并写「已接入 @handle」）。

**FORM**：沿用设计稿添加页的三步流程与卡片语言，seed: seed:a61cb2af8194ee80。

**FINISH**：unreviewed and undocumented is unfinished；以 `npm run design:check`（静态）与 `/accounts/add` 运行时检查收尾，逐条引用 ACC-add-01 / 02。

## 实现与设计稿的差异（有意识决定）

- 原型第二步的假二维码与「已自动排队登录检查与首次采集」删除：当前后端不提供真实扫码会话，写了就是假承诺。第二步改为「登记账号」，授权入口以完成后给出的 `vk account reauth <id>` 命令如实交付。
- 数据从 `store.js` 换成 `api.js`；占用判断读 bootstrap 的账号快照与 `/api/bootstrap.matrix.columns`，不在页面里重算组口径。
- 同一输入同时作为 `name` 与默认 `handle`，与 `vk account add <platform> --group <g> --name <名字>` 完全等价。
- 重新登录（`?mode=reauth`）不在本工单内；账号页的重新登录直接走 `account.reauth`，不绕到本页。
