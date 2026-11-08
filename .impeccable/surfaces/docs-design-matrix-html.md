---
version: 1
slug: "docs-design-matrix-html"
primary_target: "docs/design/matrix.html"
related_targets: []
---

# 全部账号组 · 跨组矩阵（只读）

- **Scope**：`matrix.html`，跨账号组的平台健康总览。
- **Mode**：Operate。
- **Audience**：有两个以上账号组、想一眼确认"哪里出问题"的创作者。
- **Job**：在离开日常工作区时，快速确认所有组在所有平台的健康与缺口。
- **Action**：点任意格进入那个账号组；从未接入格跳到添加。
- **Proof / Content**：每格的状态、最近发布、最近采集、未接入缺口。
- **Constraints**：只读；不在这里改任何数据；不替代日常账号页。

## Direction contract

**THESIS**：这是总览，不是工作区。只回答"哪里有问题、去哪个组"，不提供编辑动作。

**OWN-WORLD**：灰白场地上的白色瓷贴，状态色只出现在异常格；行列坐标靠对齐与排版。

**STORY**：先看每组每平台的异常 → 点格子进入该组 → 或从缺口去添加。

**FIRST VIEWPORT**：跨组标题与健康摘要、账号组×平台矩阵、图例、返回工作区。

**FORM**：取自账号矩阵页的瓷贴阵，收窄为只读；seed: seed:a61cb2af8194ee80

**FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
