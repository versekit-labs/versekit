---
version: 1
slug: "docs-design-work-html"
primary_target: "docs/design/work.html"
related_targets: []
---

# 作品详情 · 一条作品在各平台的表现

- **Scope**：`work.html`，单条作品的跨平台数据与采集现场。
- **Mode**：Operate。
- **Audience**：想知道"这条到底跑得怎么样、数据可不可信"的创作者。
- **Job**：解释一条作品在每个平台的结果，以及数据从哪来、什么时候采的。
- **Action**：看跨平台指标、看趋势、看采集记录、进失败现场。
- **Proof / Content**：播放/点赞/收藏、采集来源、采集时间、缺口、发布状态。
- **Constraints**：没有来源的时间戳不允许出现；不接受静默的 0。

## Direction contract

**THESIS**：数据必须可解释。每个数字旁边都要有来源与时间；采集中断要画出来，而不是让曲线假装连续。

**OWN-WORLD**：白面板、发丝线、等宽数字；缺口用浅红区间标注；状态只用细边与文字。

**STORY**：先看四个平台并排的结果 → 看趋势与缺口 → 看采集记录确认可信度 → 看发布结果与失败原因。

**FIRST VIEWPORT**：标题与作品元信息、四个平台卡（指标+来源+时间）、趋势图与采集记录、发布结果与等价命令。

**FORM**：延续既有卡片语言；seed: seed:a61cb2af8194ee80

**FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
