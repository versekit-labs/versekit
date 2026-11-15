---
version: 1
slug: "docs-design-today-html"
primary_target: "docs/design/today.html"
related_targets: []
---

# 今天（首页）

**模式**：Operate。只按桌面宽度设计，窄屏不坏即可。
**为谁**：作者自己（一人公司，用 Claude 做内容，发到自己的多个平台账号）。以后给同类创作者：从"一条视频、一种语言、两三个平台"到"多支成片、多语言、七八个平台"都是同一个结构。
**解决什么**：打开就知道现在要我做什么，并且就在这一页做完。
**怎么做**：最新一个等确认的作品直接摊开：看片、扫一眼各平台的标题和时间、点一次确认，自动跳到下一支成片；其余待办各占一条；下面是最近结果。
**成功长什么样**：30 秒内确认完一支成片；没有待办时页面是空的、安静的。
**明确不做**：趋势分析（数据页）、账号与规则（系统页）、作品档案（作品页）、发布日历。
**数据从哪来**：`vk today`：等确认的平台稿、出问题的 run、已确认待发的队列、最近满 24 小时的快照。
**依据**：`docs/PRD.md` v0.2、`docs/design/FLOW-v2.md`。硬规则：没有人确认，一条都不会发。

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个；数字永远和这个账号自己的平时比。参考 Things 3（今天的安静）、Linear（一行一个对象、状态小而清楚）、YouTube Studio（和平时比）。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄 #ffd84a 只表示"等你处理"，红 #c4321c 只表示"出了问题"，绿 #0f7a4a 只表示"比平时好/正常"。系统字体，表格数字等宽对齐。不用装饰性隐喻、卡片墙、跨平台相加的大数字。
FORM：左 208px 侧栏四项（今天、作品、数据、系统）+ 右侧单列内容；只按桌面宽度设计，窄屏不坏即可。手机上只有飞书。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v2/.
FIRST VIEWPORT：标题"今天"+ 日期；一块聚焦面板（作品标题、进度、左视频与平台行、右成片列表与"接下来要发"）；确认按钮吸底。
SIGNATURE：确认按钮把含义写在字上——"确认这 6 条，按时间发"；小红书单独一块黄底，逐条确认。
