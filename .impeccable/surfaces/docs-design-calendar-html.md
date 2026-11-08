---
version: 1
slug: "docs-design-calendar-html"
primary_target: "docs/design/calendar.html"
related_targets: []
---

# 发布计划 · 排期巡航

- **Scope**：`calendar.html`，当前账号组的排期视图，1440 桌面与 390 手机。
- **Mode**：Operate。
- **Audience**：一次只在一个账号组里工作的个人创作者，频率是每天看一眼、每周排一次。
- **Job**：回答"这周要发什么、哪天还空着、有没有撞车"，并能就地改期或取消。
- **Action**：改期、取消、从空白日新建一条；全局动作是回发布台写内容。
- **Proof / Content**：作品标题、发布时间、要去的平台、状态（已排期/已发布/仅自见/失败）、本周条数、空白天数、同平台撞车。
- **Constraints**：中文；系统字体；桌面与手机同一套；零阴影；不抄 Postiz 紫+黑。

## Direction contract

**THESIS**：排期以「作品」为单位，不以「平台」为单位。一个作品发四个平台是一张卡，卡上并排四个平台标识；把作品拆成平台碎片是错的。三种视图各有单一职责：周=这周发什么，月=总量与空档，列表=手机上扫。

**OWN-WORLD**：深海军蓝导航与主按钮，冷灰白场地，白色卡片；状态用绿/琥珀/红细边与文字，不用大面积色块；时间与日期用等宽数字。零阴影，靠 1px 发丝线与留白分层。

**STORY**：用户进来先看到本周条数与空白天数 → 扫过七列，看到每张卡的时间、标题、平台 → 点卡片展开改期/取消 → 改期就地完成并立刻重排。月视图用来跳到某一周，列表视图用来在手机上连续读。

**FIRST VIEWPORT**：左侧常驻导航与账号组切换器；主区依次为标题与说明、视图切换（周/月/列表）+ 日期导航 + 「+ 排一条」、摘要条、七列周视图。手机默认列表视图，周视图纵向堆叠仍可用。

**FORM**：延续账号矩阵页已确立的瓷贴/卡片语言，不引入新视觉体系。seed: seed:a61cb2af8194ee80（历史引用）

**FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Known gaps（交付时如实说明）

- 不能拖拽改期，只能点开改。
- 月视图只做跳转，没有"这天空着，建议补一条"。
- 撞车只提示，不阻止、不自动错开。
- 取消是即时生效，没有二次确认与撤销。
