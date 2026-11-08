---
name: versekit
description: 本地优先的多平台发布控制面；每页只完成一个任务，状态永远带证据与下一步。
colors:
  departure-navy: "#16324f"
  hangar-navy: "#0f2438"
  apron-ground: "#f4f4f2"
  paper: "#ffffff"
  paper-hover: "#ececeb"
  paper-subtle: "#fafaf9"
  ink: "#17191c"
  slate: "#5f666d"
  slate-faint: "#646b73"
  hairline: "#d9dcdf"
  hairline-soft: "#e8eaec"
  changed-amber: "#a85c06"
  changed-amber-bg: "#fff7e9"
  changed-amber-line: "#e4c28e"
  changed-amber-bright: "#ffc46b"
  healthy-green: "#1f6b52"
  healthy-green-bg: "#eef7f2"
  healthy-green-line: "#b8d5c7"
  expired-red: "#a32b20"
  expired-red-bg: "#fff2f0"
  expired-red-line: "#e5b7b1"
  nav-text: "#c9d7e3"
  nav-muted: "#a9bccc"
  nav-hover: "#1d3d5c"
  nav-line: "#2a4a68"
  nav-paper-hover: "#eaf0f5"
  local-green: "#7fd1b0"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "25px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  brand:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "21px"
    fontWeight: 650
    letterSpacing: "-0.02em"
  brand-compact:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "19px"
    fontWeight: 650
    letterSpacing: "-0.02em"
  brand-small:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "18px"
    fontWeight: 650
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "-0.01em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  x1: "4px"
  x2: "8px"
  x3: "12px"
  x4: "16px"
  x5: "20px"
  x6: "24px"
  x8: "32px"
components:
  button-publish:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.departure-navy}"
    rounded: "{rounded.md}"
    height: "42px"
    padding: "0 14px"
  button-primary:
    backgroundColor: "{colors.departure-navy}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 13px"
  button-primary-hover:
    backgroundColor: "{colors.hangar-navy}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 13px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-hover}"
    textColor: "{colors.ink}"
  status-ok:
    backgroundColor: "{colors.healthy-green-bg}"
    textColor: "{colors.healthy-green}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  status-warning:
    backgroundColor: "{colors.changed-amber-bg}"
    textColor: "{colors.changed-amber}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  status-expired:
    backgroundColor: "{colors.expired-red-bg}"
    textColor: "{colors.expired-red}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  matrix-cell:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "12px 13px"
  matrix-cell-selected:
    backgroundColor: "{colors.apron-ground}"
    textColor: "{colors.ink}"
    padding: "12px 13px"
  account-detail:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "18px 20px"
---

# Design System: versekit

## Overview

**Creative North Star: 「出港牌」 The Departure Board**

保留这个已确认的命名，但只保留它的一条产品原则：**时间、目的地、状态和下一步要一瞥可读。** 不把机票、航班、登机口、PNR 或翻牌造型带进界面。用户不应该先学习品牌隐喻，才能管理自己的账号。

versekit 是操作型产品，不是展示型官网。信息架构先于视觉：账号墙只回答“我的号都还好吗”，发布台只负责发布，作品详情只解释一条作品，任务与日志只呈现队列和失败现场。任何页面出现第二类对象前，先问它是否属于另一页。

已确认的视觉拒绝：Postiz 的紫色强调 + 近黑底、玻璃拟态与霓虹渐变、游戏化动效、监控大屏、海报式巨字排版。可以学习 Postiz 的清晰分工，不能复制它的外观。

**Key Characteristics:**
- 一页一个主任务；全局只有“发布内容”一个主动作。
- 首页以账号组为行、平台为列，直接呈现二维矩阵。
- 冷灰白场地、深蓝导航、白色工作区，零阴影。
- 异常在矩阵中直接可见；正常态退为灰绿文字，异常才有彩色签。
- 每个详情只有一个主动作，且指向具体对象（重登/续期/放行/详情）。
- 手机展示同一批数据，不通过隐藏正常账号换取简短。

## Colors

### Primary
- **离港深蓝 Departure Navy** (#16324f)：导航、主按钮。它是稳定的壳，不是信息状态。
- **机库深蓝 Hangar Navy** (#0f2438)：主按钮 hover。

### Secondary
- **改口琥珀 Changed Amber** (#a85c06)：需要留意但尚未失败的状态，如“71 小时后失效”“待放行”。
- **改口亮琥珀 Changed Amber Bright** (#ffc46b)：深色导航中的焦点环与文字选中底。
- 状态底色使用 #fff7e9，边线使用 #e4c28e；不大面积铺琥珀。

### Tertiary
- **健康绿 Healthy Green** (#1f6b52)：仅用于“登录正常”的文字与小圆点，**不做填充徽章**；正常是默认态，不抢占注意力。
- **失效红 Expired Red** (#a32b20)：已失效、明确失败；浅底 #fff2f0，边线 #e5b7b1。

### Neutral
- **场地灰 Apron Ground** (#f4f4f2)：页面场。
- **纸白 Paper** (#ffffff)：工作区与按钮。
- **油墨 Ink** (#17191c)：正文。
- **石板 Slate** (#5f666d)：次级说明。
- **浅石板 Slate Faint** (#646b73)：字段名与辅助事实。
- **发丝线 Hairline** (#d9dcdf) / **柔发丝线 Hairline Soft** (#e8eaec)：分隔。
- 异常行只允许极浅底色：失效 #fffafa、将失效 #fffdf8；不使用粗色条。


### Named Rules
**The One-Ambient-Color Rule.** 深蓝是唯一大面积彩色区域；状态色只出现在小签、短句和极浅行底中。

**The No-Purple-No-Glow Rule.** 不使用紫色强调、近黑页面、霓虹渐变、玻璃或发光边缘。

## Typography

**Display / Body:** 系统无衬线（-apple-system / PingFang SC / Noto Sans SC）
**Data:** 系统等宽（SF Mono / Menlo）

**Character:** 名字和动作说人话；只有时间、编号和需要对齐的数据使用等宽。中文界面不夹 BOARDING PASS、GATE 等装饰性英文。

### Hierarchy
- **Display** (650, 28px)：桌面页面标题。
- **Title** (650, 25px)：手机页面标题。
- **Brand** (650, 21px；紧凑 19px；手机 18px)：产品名。
- **Body** (400, 14px)：账号名与导航。
- **Body Small** (400, 13px)：按钮、摘要、筛选。
- **Meta** (400, 12px)：证据、来源、字段名。
- **Data** (400, 12px, tabular-nums)：时间与编号。

### Named Rules
**The Twelve-Pixel Floor Rule.** 所有功能文字至少 12px；正文默认 14px，不用微缩字制造密度。

**The Chinese-First Rule.** 状态与动作先写中文，等宽字体不承担句子。

## Layout

- **桌面**：224px 深蓝侧栏 + 弹性主区；主区最大 1240px，1440 下留 32px 边距。
- **账号矩阵**：行是账号组，列是平台；每组每平台最多一个账号，因此一格唯一对应一个平台账号。
- **矩阵不是表格，是瓷贴阵**：内容仍是二维矩阵，但呈现方式是灰底上间距 6px 对齐的白瓷贴，不画连续网格线、不加整块外框。行列坐标由对齐和排版承担，不靠边框。
- **单元格自证身份**：每格首行是平台标识 + 账号名（handle）。宽屏下不能只靠列头猜平台——用户不该为了确认“这是哪个平台的哪个号”再抬头找表头。平台名文字不再重复进格，由平台标识和列头共同承担。
- **单元格**：首行身份，第二行登录状态，第三、四行是最近发布与最近采集，时间必须绑定结果（“失败 · 10-31”而非裸时间）。
- **详情跟随账号组**：选中某格后，详情在该账号组那一行下方原位展开（桌面跨列一行，手机在该组段内），不沉到整张矩阵末尾；一次只展开一个详情。
- **未接入**：保留空格，显示“未接入”和预填了组与平台的添加入口，不计入异常。
- **断点**：≤1240 侧栏收窄到 200px；**≤1180 改为顶部导航**——侧栏与五列同时存在会把账号名挤到省略号，宁可让出侧栏宽度。
- **手机**：≤900 每个账号组变成一段，平台逐行排列；保留相同字段，不强行压缩五列，不隐藏正常账号。
- **节奏**：标题、待处理条、矩阵、组内详情；不叠加 KPI 卡、作品卡或队列表。

## Elevation & Depth

**零阴影。** 层级由场地灰、白瓷贴、深蓝导航和 1px 发丝线承担。矩阵的二维关系靠间距与对齐表达，不靠连续网格线或外框——一旦画出整块表格框，页面就从“控制台”退回“电子表格”。边框与底色只在同一层级使用一次，不叠加“边框 + 大投影”的幽灵卡片。

## Shapes

- 4px：状态签。
- 6px：按钮、导航项。
- 8px：矩阵瓷贴、账号详情、手机分组卡。
- 不做胶囊按钮、撕口、票根、假条码或装饰性缺口。

## Components

### Workspace（账号组）
- 账号组是工作区，不是筛选标签：进入先选组，之后所有日常页面只服务这一组。
- 侧栏切换器常驻：一个原生 `<select>`，含「全部账号组 · 矩阵总览」与「全部账号组 · 数据汇总」两个只读入口，下面是「管理账号组」文字链接。
- 切换立即生效并记住（localStorage）；回访直接回到上次的组。
- 跨组视图必须显式标注「只读」，不能让人误以为在里面能改数据。

### Shared Shell（页面共用）
- 五页共用 `docs/design/app.css`：token、外壳、按钮、状态、面板、列表、字段、命令块。
- 页面只写自己独有的样式；不复制 token，不另起一套色板。
- 侧栏在长页面上 sticky（发布台、总览、任务日志都要滚），短页面同样适用。

### Buttons
- **全局发布按钮**：深蓝侧栏里的白底按钮，高 42px；它是页面唯一持续存在的主动作。
- **详情主按钮**：深蓝底白字，高 36px；只给当前最需要处理的账号。
- **次按钮**：白底墨字、1px 发丝边；详情、续期等。
- **焦点**：浅底 #a85c06，深底 #ffc46b，2px 外环。

### Todo Strip（待处理条）
- 标题下一行紧凑文字链：按严重度列出当前待办（如“小红书重登 · 抖音续期 · TikTok 放行”）。
- 点击直达对应格：选中、展开组内详情、滚动到可见。
- 按所需动作去重：同一登录失效引发的发布、采集失败不重复计数。

### Matrix Cell（瓷贴）
- 形态：8px 圆角、1px 发丝边、白底，贴在灰底上，彼此留 8px 间距；不参与连续网格线。选中时是这块瓷贴自身被描边，不是整格被填色。
- **身份自证**：首行 = 18px 平台标识 + 账号名（12px/650，超长省略）。平台标识是自绘 SVG（品牌色圆角方块 + 白色标记），不是外部图片，也不依赖网络。
- 账号组名不重复进格（由行头承担）；平台名文字不重复进格（由标识 + 列头承担）。
- 平台标识同时通过 `aria-label`（“平台 · handle · 登录状态”）提供给读屏。
- 首行登录状态：正常态只用绿点 + 灰绿文字，**无底色无边框**；只有异常（将过期 / 已失效）才用琥珀或红的浅底小签。
- 第二行登录状态（正常态仅绿点 + 灰绿字，无填充）。
- 第三、四行固定为“发 结果 · 时间”“采 结果 · 时间”，用单字标签节省宽度；所有瓷贴顶对齐、共用基线；标签用无衬线，时间与数字用等宽。
- 选中态只有一种信号：2px 深蓝内框（贴在内边）；同时对应账号组名下方出现短墨线、平台表头加重，帮助定位，不给整行整列铺色。
- 异常瓷贴整体换浅底（失效 #fff2f0、将失效 #fff7e9）+ 对应色边，让异常在灰底上整块跳出，而不是靠一枚小签硬撑。
- 未接入格是虚线幽灵贴：无填充、1px 虚线边，只写“未接入”和安静的文字型“添加”；它表达矩阵缺口，不伪装成账号。
- 手机上瓷贴退回到组卡内的一行行条目：去掉每格的边与圆角，只留行分隔线，避免卡中卡。

### Account Detail
- 以 handle 为主标题，“账号组 · 平台”降为上方定位小字；右侧只有一个下一步动作。
- 标题下一句话说清异常结论、影响与最近成功时间；正常账号写事实（“登录正常 · 发布与采集运行中”），不写“没有需要处理的事项”这类空话。
- 下方两列证据：最近发布、最近采集（含来源与失败原因）；不重复矩阵里已有的状态签。
- 主按钮进入具体对象：失效→该账号重新登录；将到期→续期；待放行→该条发布；正常→账号详情。链接各不相同，不只换文案。

### Panel（工作面板）
- 白底、1px 发丝边、8px 圆角；标题行 14px/650，右侧 hint 12px。
- 面板内用 `.row` 列表：12px/16px 内边距、柔发丝线分隔，不用表格框。
- 面板是「一块工作区」，不是卡片墙；一页最多三到四块。

### Plan（发布计划）
- 发布台有两种模式：**写一条**（组合内容与账号）与**发布计划**（排期）。同一页切换，URL 记住模式（`?view=plan`）。
- **单位不能两义**：摘要写「N 个作品 · M 条平台发布」，不写含糊的「N 条」。
- **平台状态必须逐平台记录**：`platforms: [{id, state}]`，卡片聚合状态取其中最差的一个；一张卡写「仅自见」而其中某平台其实已发布，是错的。
- **一天 = 一个作品的卡片，不是一个平台一条。** 一个作品发四个平台仍是一张卡，卡上并排四个平台标识；把工作拆成四块是错的。
- 卡片信息固定四件：时间、状态、标题（最多两行）、平台标识。标题必须是内容，不能只显示时间。
- 三种视图，各司其职：
  - **周**（默认，桌面）：7 列，每列真实卡片，能直接看出这周发什么。
  - **月**：只做导航，格子里是状态点与条数，点一天切到那一周；month 里不放卡片，塞不下也读不懂。
  - **列表**：按天分组的议程，手机默认用它。
- 顶部摘要回答排期真正的问题：本周几条、几个空白天、几处同平台撞车；撞车项可点，点了跳到那一周。
- **改期要快、要有反馈、要不设防**：卡片展开先给「明天 / 下周同日」快捷项，一步完成；保存后 toast 并给「撤销」；过去时间要拦，撞车要在保存前提示；空值不能静默。
- **撞车必须落在卡片上，不能只在摘要里报数。** 同组同平台、时间相差 ≤30 分钟即算撞车；相关卡片加红边与「撞车」签，否则用户知道有问题却找不到在哪。
- 列表视图把空白日也画出来：连续空白折叠成一行「11/13 – 11/16 · 4 天没有安排 + 排一条」，保证摘要里的空白天数与眼睛看到的一致。
- 月视图只统计本月的条目与撞车，不把相邻月份的格子算进"本月"。
- 卡片默认收起动作，点一下才展开「改期 / 取消 / 看作品」；改期就地展开时间选择器，不弹窗。
- 空白日有「+ 排一条」，点它带着日期回到写作模式并把定时填好。
- 手机：七列会压成字，所以默认列表；周视图改成纵向堆叠也仍可用。
- 命令区随账号组与月份变化：`vk schedule list --group <组> --from <月首> --to <月末>`。

### Stats（总览数字）
- 数字用等宽、25px、tabular-nums；标签 12px 灰；变化量用绿/红文字，不用箭头图标。
- 关键规则：数字必须带口径（覆盖几个平台、与上周比、几个账号数据过期）。孤立的大数字不算结论。

### Chart（趋势）
- 真实坐标轴与刻度，不用装饰性 sparkline。
- 数据缺口画成浅红区间并在曲线上打点标记，配一句“这一段是插值，不是真实数据”。
- 图例区分「数据」与「缺口」，两者颜色不同。

### Command Block（命令对照）
- 深灰底（--ground）、1px 柔边、6px 圆角、等宽 12px，行首一个小号说明词。
- 每个主页面至少一处：它把「CLI 完整律」变成看得见的东西——界面上能做的，CLI 里有同一条。
- 命令允许换行，不允许横向被裁掉。

### Tabs（分段选择）
- 36px 高的分段控件，选中项深蓝底白字；用真实 radio + label，不用假按钮。
- 用于时间范围（7/30/90 天）与任务状态筛选。

### Scene（失败现场）
- 浅红底、上方红边，直接展开在失败条目下方，不弹窗。
- 左列结构化现场：错误码、HTTP、平台原文、尝试次数、任务号。
- 右列人话：发生了什么、下一步做什么。
- 底部一排动作（转手动、重试、去重登）+ 等价命令。

### Local Status
- 侧栏底部只写“本地运行中”“凭证与数据只在这台电脑”“最近检查时间”。
- 它是信任承诺，不放版本号、营销语或多余设置入口。

## Do's and Don'ts

### Do:
- **Do** 让每页只回答一个问题。
- **Do** 把待办放在首屏顶部，点击直达对应格；矩阵继续承担全局定位。
- **Do** 让每个时间绑定结果：发布成功/失败、采集成功/失败，不让用户点进去才知道。
- **Do** 区分口径：登录状态、发布事项、采集新鲜度分开命名，汇总与详情一致。
- **Do** 详情跟随账号组原位展开，切换时让标题和主按钮进入视口。
- **Do** 手机保留同一批账号与字段。
- **Do** 时间使用等宽 + tabular-nums。
- **Do** 定时发布必须能在日历上看见，并支持改期与取消；只有时间输入框不算排期。
- **Do** 让每个主页面露出对应的 `vk` 命令：CLI 完整律要看得见，不只写在文档里。
- **Do** 数字必须带口径：覆盖几个平台、与什么比、几个账号数据过期。

### Don't:
- **Don't** 用航班、登机口、乘客等隐喻替代产品术语。
- **Don't** 在账号墙里塞作品详情、发布队列或数据看板。
- **Don't** 给正常账号做彩色填充徽章——正常是默认态，异常才有视觉优先权。
- **Don't** 在详情里重播矩阵已有的状态签，或写“没有需要处理的事项”这类空话。
- **Don't** 用弹窗装失败现场：现场要留在任务旁边，跟着队列一起读。
- **Don't** 画没有坐标轴的装饰性 sparkline。
- **Don't** 用阴影、玻璃、渐变或大圆角卡片制造层次。
- **Don't** 为了手机简短而隐藏正常账号。
- **Don't** 抄 Postiz 的紫色、近黑底或视觉识别。
