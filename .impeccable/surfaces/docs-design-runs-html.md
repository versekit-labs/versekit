---
version: 1
slug: "docs-design-runs-html"
primary_target: "docs/design/runs.html"
related_targets: []
---

# 任务与日志 · 队列与失败现场

- **Scope**：`runs.html`，当前账号组的队列、失败现场与重试。
- **Mode**：Operate。
- **Audience**：发现"有东西没发出去"、需要立刻判断怎么修的创作者。
- **Job**：说清楚现在在跑什么、什么失败了、为什么、下一步点哪里。
- **Action**：筛选状态、展开失败现场、重试、放行、暂停队列。
- **Proof / Content**：错误码、平台原文、尝试次数、任务号、等价命令。
- **Constraints**：失败必须有现场；重试有上限；不静默放弃。

## Direction contract

**THESIS**：失败不是红点，是现场。错误码、平台原话、尝试次数、下一步，全在条目旁边展开，不弹窗。

**OWN-WORLD**：白面板、红色浅底现场区、等宽错误码；状态用文字与小点。

**STORY**：先看四个队列数字 → 筛到失败 → 展开现场 → 转手动、重试或去重登。

**FIRST VIEWPORT**：队列概况四格、状态筛选、任务列表；失败条目默认展开现场。

**FORM**：延续既有列表面板语言；seed: seed:a61cb2af8194ee80

**FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
