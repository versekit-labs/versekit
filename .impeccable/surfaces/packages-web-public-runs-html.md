---
version: 1
slug: "packages-web-public-runs-html"
primary_target: "packages/web/public/runs.html"
related_targets: ["docs/design/runs.html"]
---

# 任务与日志（实现版）

- **Scope**：`packages/web/public/runs.html`，线上路径 `/runs`。
- **Audience**：一个人管多个平台账号的创作者；在这里做判断，不在这里做配置。
- **Data**：只来自 `/api`（bootstrap / publishes / runs / schedule），不引用原型 `store.js`。
- **Constraints**：导航来自 `/shell.js` 单一来源；数字带口径；空态必须说明下一步；不伪造平台授权。
- **Finish**：`npm run ci` 全绿 + 对该路由的运行时冒烟。
