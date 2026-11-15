---
version: 1
slug: "docs-design-work-html"
primary_target: "docs/design/work.html"
related_targets: []
---

# 作品详情

**模式**：Operate。只按桌面宽度设计，窄屏不坏即可。
**为谁**：作者自己（一人公司，用 Claude 做内容，发到自己的多个平台账号）。以后给同类创作者：从"一条视频、一种语言、两三个平台"到"多支成片、多语言、七八个平台"都是同一个结构。
**解决什么**：一个作品的全部：每支成片发到了哪里、等不等我确认、结果如何、出过什么事。
**怎么做**：和"今天"同一个成片面板：没确认的成片在这里确认，发过的成片每行换成结果；右侧成片列表与这支成片的经过；出问题时一块红底说明和处理按钮；下面是这支成片各平台和平时的对比。
**成功长什么样**：不用去任何平台后台，就能回答"这支发了吗、发得怎么样、哪里出过问题"。
**明确不做**：改视频本身、跨作品比较（数据页）。
**数据从哪来**：`vk work show <id>`：成片、平台稿、run 事件、快照。
**依据**：`docs/PRD.md` v0.2、`docs/design/FLOW-v2.md`。硬规则：没有人确认，一条都不会发。

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个；数字永远和这个账号自己的平时比。参考 Things 3（今天的安静）、Linear（一行一个对象、状态小而清楚）、YouTube Studio（和平时比）。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄 #ffd84a 只表示"等你处理"，红 #c4321c 只表示"出了问题"，绿 #0f7a4a 只表示"比平时好/正常"。系统字体，表格数字等宽对齐。不用装饰性隐喻、卡片墙、跨平台相加的大数字。
FORM：左 208px 侧栏四项（今天、作品、数据、系统）+ 右侧单列内容；只按桌面宽度设计，窄屏不坏即可。手机上只有飞书。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v2/.
FIRST VIEWPORT：返回链接、标题、入库时间、状态；成片面板 + 右侧成片列表与经过。
SIGNATURE：经过用一句人话一行，失败的一行是红字。
