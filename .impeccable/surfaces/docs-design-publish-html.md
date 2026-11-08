---
version: 1
slug: "docs-design-publish-html"
primary_target: "docs/design/publish.html"
related_targets: []
---

# 发布 · 一条作品发到多个账号

- **Scope**：`publish.html`，当前账号组的写作与提交界面。
- **Mode**：Operate。
- **Audience**：在某个账号组里、手上已有一条素材、准备分发的创作者。
- **Job**：把一条作品发到本组多个平台账号，并且只在"平台真的不同"的字段上做差异。
- **Action**：选账号、改平台差异字段、预演、立即发或定时发。
- **Proof / Content**：哪些账号可用、每个平台的差异字段、预演结果、发布后的落点。
- **Constraints**：不做富文本编辑器；只发当前账号组；凭证不离开本机。

## Direction contract

**THESIS**：一条作品、一张主稿、多处差异。默认全自动，只有平台真正不同的字段才暴露；失败会自动降级并留下原因。

**OWN-WORLD**：深蓝主按钮、灰白场地、白色面板；平台用自绘标识；时间与命令用等宽；零阴影。

**STORY**：先看到素材与账号 → 勾选要发的账号 → 右侧只改需要改的字段 → 预演看清楚会发生什么 → 发布或定时。

**FIRST VIEWPORT**：左侧素材卡与账号勾选列表，右侧主稿、平台差异、定时与动作条，底部等价命令。

**FORM**：延续账号矩阵确立的卡片与列表语言；seed: seed:a61cb2af8194ee80

**FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
