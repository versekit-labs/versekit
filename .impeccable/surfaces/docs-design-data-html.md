---
version: 1
slug: "docs-design-data-html"
primary_target: "docs/design/data.html"
related_targets: []
---

# 数据

**模式**：Operate。只按桌面宽度设计，窄屏不坏即可。
**为谁**：作者自己（一人公司，用 Claude 做内容，发到自己的多个平台账号）。以后给同类创作者：从"一条视频、一种语言、两三个平台"到"多支成片、多语言、七八个平台"都是同一个结构。
**解决什么**：这段时间哪些内容比平时好、哪些差，差多少。
**怎么做**：每个平台一行点图：一个点是一条，位置是它相当于这个账号平时的几倍（对数刻度，平时在正中）；"值得说的"只在有明显高低时出现；下面是每一条的明细，可按平台筛、按倍数或时间排。
**成功长什么样**：一眼看出异常的那几条；不会把不同平台的播放数加在一起或互相比较。
**明确不做**：跨平台总播放、粉丝增长曲线、同行对比、导出报表。
**数据从哪来**：`vk stats --since 30d`：发布满 24 小时的快照 + 每个账号最近 20 条的中位数。
**依据**：`docs/PRD.md` v0.2、`docs/design/FLOW-v2.md`。硬规则：没有人确认，一条都不会发。

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个；数字永远和这个账号自己的平时比。参考 Things 3（今天的安静）、Linear（一行一个对象、状态小而清楚）、YouTube Studio（和平时比）。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄 #ffd84a 只表示"等你处理"，红 #c4321c 只表示"出了问题"，绿 #0f7a4a 只表示"比平时好/正常"。系统字体，表格数字等宽对齐。不用装饰性隐喻、卡片墙、跨平台相加的大数字。
FORM：左 208px 侧栏四项（今天、作品、数据、系统）+ 右侧单列内容；只按桌面宽度设计，窄屏不坏即可。手机上只有飞书。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v2/.
FIRST VIEWPORT：标题 + 条数 + 时间范围；各平台点图；值得说的两条。
SIGNATURE：点图中间一根墨色竖线 = 平时；条数少的平台明说"只能看个大概"。

## v3（2026-11-18）

页面上不出现命令。口径说明（"平时"怎么算）保留为普通文字。
