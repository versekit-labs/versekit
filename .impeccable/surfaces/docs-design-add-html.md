---
version: 1
slug: "docs-design-add-html"
primary_target: "docs/design/add.html"
related_targets: []
---

# 添加账号 / 重新登录 · 接入与修复

- **Scope**：`add.html`，在当前账号组内接入一个平台账号，或修复失效账号的登录态。
- **Mode**：Operate。
- **Audience**：刚建完账号组、或发现某个号失效的创作者。
- **Job**：把某个平台账号接进当前组；同一平台一组只能有一个账号；重登时保留历史。
- **Action**：选平台、扫码/授权、命名、完成并回到账号页。
- **Proof / Content**：已接入的平台与占用情况、每个平台的授权方式、失败原因。
- **Constraints**：组已锁定不可在此切换；不伪造真实平台授权；原型只写本地演示状态。

## Direction contract

**THESIS**：授权是短流程。三步走完就回账号页；已占用的平台先灰掉并说明被谁占用。

**OWN-WORLD**：白面板、深蓝主按钮、平台自绘标识；步骤条用文字；零阴影。

**STORY**：确认账号组 → 选平台（已接入的灰掉）→ 按平台方式授权 → 完成并回到账号页看到新账号。

**FIRST VIEWPORT**：锁定的账号组提示、三步指示、平台选择网格（含已占用状态）。

**FORM**：延续既有流程与卡片语言；seed: seed:a61cb2af8194ee80

**FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
