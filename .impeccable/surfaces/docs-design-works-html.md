---
version: 1
slug: "docs-design-works-html"
primary_target: "docs/design/works.html"
related_targets: []
---

# 作品（档案）

**模式**：Operate。只按桌面宽度设计，窄屏不坏即可。
**为谁**：作者自己（一人公司，用 Claude 做内容，发到自己的多个平台账号）。以后给同类创作者：从"一条视频、一种语言、两三个平台"到"多支成片、多语言、七八个平台"都是同一个结构。
**解决什么**：找到任何一个作品，一行看清它走到哪一步。
**怎么做**：一行一个作品：封面、标题、现在的状态（只取最要紧的一个）、各平台实心/空心/红色、最好的一条、入库时间；按状态筛选，按标题搜。
**成功长什么样**：3 秒内找到"有问题"或"等我确认"的作品并点进去。
**明确不做**：在列表里直接确认或改稿（进详情做）、批量操作、账号组切换。
**数据从哪来**：`vk work list`。
**依据**：`docs/PRD.md` v0.2、`docs/design/FLOW-v2.md`。硬规则：没有人确认，一条都不会发。

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个；数字永远和这个账号自己的平时比。参考 Things 3（今天的安静）、Linear（一行一个对象、状态小而清楚）、YouTube Studio（和平时比）。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄 #ffd84a 只表示"等你处理"，红 #c4321c 只表示"出了问题"，绿 #0f7a4a 只表示"比平时好/正常"。系统字体，表格数字等宽对齐。不用装饰性隐喻、卡片墙、跨平台相加的大数字。
FORM：左 208px 侧栏四项（今天、作品、数据、系统）+ 右侧单列内容；只按桌面宽度设计，窄屏不坏即可。手机上只有飞书。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v2/.
FIRST VIEWPORT：标题 + 作品数；状态分段筛选 + 搜索；作品表。
SIGNATURE：平台图标三态——实心已发、空心未发、红色出问题。
