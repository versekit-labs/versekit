---
name: versekit
description: 安静的工作台：把 Claude 做完的内容确认、发出去、看懂数据；黄色只叫你处理，红色只报出了问题，绿色只说比平时好。
colors:
  ground: "#fafaf8"
  paper: "#fffffe"
  sidebar: "#f1f1ee"
  hover: "#f3f3f0"
  nav-hover: "#e8e8e4"
  nav-current: "#e3e3df"
  line: "#e5e6e3"
  line-soft: "#eeefec"
  control-line: "#d3d5d1"
  ink: "#1a1c1f"
  ink-hover: "#0b0c0e"
  ink-secondary: "#5f656c"
  ink-faint: "#8d9399"
  on-ink: "#fffffe"
  track: "#e7e8e5"
  track-fill: "#a9aeb3"
  attention: "#ffd84a"
  attention-bg: "#fff8dc"
  attention-line: "#e6c84f"
  attention-edge: "#b99700"
  attention-ink: "#6b5d1c"
  problem: "#c4321c"
  problem-bg: "#fdf3f0"
  problem-line: "#edc3b9"
  better: "#0f7a4a"
  better-bg: "#edf7f1"
  better-line: "#bfdccb"
  video-ground: "#111214"
  chat-ground: "#eff0f2"
  chat-line: "#dcdee2"
  chat-head-neutral: "#e4e6ea"
  placeholder-ground: "#dcdcd8"
  placeholder-glyph: "#9a9a95"
  pf-xhs: "#e0213b"
  pf-douyin: "#161823"
  pf-shipinhao: "#9c5800"
  pf-bilibili: "#0079a8"
  pf-tiktok: "#25292e"
  pf-youtube: "#d21a12"
  pf-web: "#55606b"
  pf-mp: "#04823f"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  panel-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  brand:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "13px"
    fontWeight: 600
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
  table-head:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
  badge:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif"
    fontSize: "11px"
    fontWeight: 700
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "3px"
  sm: "4px"
  pf: "5px"
  md: "6px"
  control: "7px"
  seg: "8px"
  step: "9px"
  panel-inner: "10px"
  table: "12px"
  panel: "14px"
  full: "50%"
spacing:
  x1: "4px"
  x2: "8px"
  x3: "12px"
  x4: "16px"
  x5: "20px"
  x6: "28px"
  x7: "40px"
  gap-tight: "6px"
  gap-row: "10px"
  gap-card: "14px"
  pad-panel: "22px"
  gap-col: "28px"
components:
  nav:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.ink-secondary}"
    width: "208px"
    padding: "18px 10px"
  nav-item:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 10px"
  nav-item-hover:
    backgroundColor: "{colors.nav-hover}"
    textColor: "{colors.ink}"
  nav-item-current:
    backgroundColor: "{colors.nav-current}"
    textColor: "{colors.ink}"
  nav-count:
    backgroundColor: "{colors.attention}"
    textColor: "{colors.ink}"
    rounded: "9px"
    height: "18px"
    typography: "{typography.badge}"
  panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "22px"
  table-wrap:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.table}"
  table-head-cell:
    textColor: "{colors.ink-secondary}"
    typography: "{typography.table-head}"
    padding: "10px 14px"
  table-cell:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "10px 14px"
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 12px"
    typography: "{typography.body-small}"
  button-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
    textColor: "{colors.on-ink}"
  button-primary-large:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.control}"
    height: "42px"
    padding: "0 18px"
    typography: "{typography.body-strong}"
  link:
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body-small}"
    height: "32px"
  segmented:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.seg}"
    padding: "2px"
  segmented-item:
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  segmented-item-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 9px"
  state-wait:
    textColor: "{colors.ink}"
    typography: "{typography.body-small}"
  state-done:
    textColor: "{colors.better}"
    typography: "{typography.body-small}"
  state-bad:
    textColor: "{colors.problem}"
    typography: "{typography.body-small}"
  platform-badge:
    textColor: "{colors.on-ink}"
    rounded: "{rounded.pf}"
    size: "20px"
    typography: "{typography.badge}"
  confirm-video:
    backgroundColor: "{colors.video-ground}"
    rounded: "{rounded.panel-inner}"
    height: "300px"
  platform-rows:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.panel-inner}"
  platform-row:
    textColor: "{colors.ink}"
    height: "44px"
    padding: "5px 12px"
  platform-row-problem:
    backgroundColor: "{colors.problem-bg}"
    textColor: "{colors.ink}"
  solo-block:
    backgroundColor: "{colors.attention-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel-inner}"
    padding: "12px"
  confirm-footer:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-secondary}"
    padding: "12px 0"
  done-note:
    backgroundColor: "{colors.better-bg}"
    textColor: "{colors.better}"
    rounded: "{rounded.panel-inner}"
    padding: "12px 14px"
  cut-step:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.step}"
    padding: "8px"
  cut-step-current:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  cut-thumb:
    backgroundColor: "{colors.nav-current}"
    rounded: "{rounded.md}"
    size: "44px"
  typical-bar:
    backgroundColor: "{colors.track}"
    rounded: "{rounded.xs}"
    height: "6px"
    width: "120px"
  typical-bar-fill:
    backgroundColor: "{colors.track-fill}"
    rounded: "{rounded.xs}"
  typical-bar-marker:
    backgroundColor: "{colors.ink}"
    width: "2px"
  strip-dot:
    backgroundColor: "{colors.ink-faint}"
    rounded: "{rounded.full}"
    size: "11px"
  note:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel-inner}"
    padding: "12px 14px"
  note-problem:
    backgroundColor: "{colors.problem-bg}"
    textColor: "{colors.ink}"
  other-item:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.table}"
    padding: "12px 14px"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.step}"
    padding: "10px 16px"
  code-chip:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    typography: "{typography.code}"
    padding: "1px 5px"
  chat-pane:
    backgroundColor: "{colors.chat-ground}"
    rounded: "{rounded.panel}"
    padding: "14px 12px 18px"
  chat-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel-inner}"
  chat-head-wait:
    backgroundColor: "{colors.attention}"
    textColor: "{colors.ink}"
  chat-head-problem:
    backgroundColor: "{colors.problem}"
    textColor: "{colors.on-ink}"
  chat-head-neutral:
    backgroundColor: "{colors.chat-head-neutral}"
    textColor: "{colors.ink}"
  chat-head-good:
    backgroundColor: "{colors.better}"
    textColor: "{colors.on-ink}"
  video-card:
    backgroundColor: "{colors.video-ground}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.panel-inner}"
    width: "210px"
  video-placeholder:
    backgroundColor: "{colors.placeholder-ground}"
    textColor: "{colors.placeholder-glyph}"
---

# Design System: versekit

## Overview

**Creative North Star: 「安静的工作台」 The Quiet Workbench**

versekit 是作者一个人每天打开的工具：Claude 做完内容，入库，这里确认、发出去、看懂数据。界面的全部工作是把「现在轮到你做什么」放在第一眼，其余一律退后。没有品牌色，没有插画，没有隐喻造型；亮色只出现在需要人看一眼的地方，所以它们才有意义。

参考的是三个同类工具的克制，而不是它们的外观：**Things 3** 的「今天」只放一件要紧事，做完才露出下一件；**Linear** 的密度与表格节奏，状态是一个小点加一个词，而不是彩色徽章墙；**YouTube Studio** 的作品为中心、数字总是对照这个频道自己的常态。三者共同点是：它们都相信用户是来办事的，不是来看界面的。

已确认的视觉拒绝：旧版「出港牌」深蓝导航与航班隐喻（业主已否决）、监控大屏、卡片墙、渐变与玻璃、装饰性比喻。

**Key Characteristics:**
- 暖灰白底（#fafaf8）+ 近白纸面（#fffffe）+ 墨色（#1a1c1f）；零阴影，层次只靠 1px 线与底色差。
- 一页一个任务；「今天」页一次只展开一条等你确认的作品。
- 三种信号色各管一件事：黄 = 等你处理，红 = 出了问题，绿 = 比平时好 / 正常。
- 主按钮只有一种颜色：墨色。
- 数字永远与同一账号的平时对照，从不跨平台求和。
- 只为桌面设计；窄屏只保证不坏。

## Colors

墨色为主，三种信号色各有专责，其余都是中性灰。信号色一旦被用作装饰，整套系统就失效。

### Primary
- **墨 Ink** (#1a1c1f)：正文、主按钮底、选中的分段控件、toast 底、当前步骤描边、平时刻度线。它是唯一的主按钮颜色。
- **墨 hover Ink Hover** (#0b0c0e)：主按钮 hover。
- **纸上白 On Ink** (#fffffe)：墨色、平台色、红 / 绿卡片头上的文字；也是纸面本身（`paper`）。

### Signal
- **等你处理黄 Attention** (#ffd84a)：只表示「等你处理」。导航里的待办数、`.st.wait` 的点、飞书待确认卡片头、`::selection`。配套：淡黄底 (#fff8dc)、黄线 (#e6c84f)、黄点描边 (#b99700)、黄底上的次要字 (#6b5d1c)。
- **出了问题红 Problem** (#c4321c)：只表示「出了问题」。`.st.bad`、失败行底 (#fdf3f0)、线 (#edc3b9)、`.x.dn`（比平时差）、健康点异常。
- **比平时好绿 Better** (#0f7a4a)：只表示「比平时好」或「正常」。`.st.done`、`.x.up`、健康点、完成提示。配套：底 (#edf7f1)、线 (#bfdccb)。

### Neutral
- **底 Ground** (#fafaf8)：页面底色。
- **纸 Paper** (#fffffe)：面板、表格、控件底。
- **侧栏 Sidebar** (#f1f1ee)：导航底、行内 `code` 底。
- **hover 灰** (#f3f3f0)：按钮、步骤行 hover。导航项 hover 为 (#e8e8e4)，当前项与封面占位底为 (#e3e3df)。
- **线 Line** (#e5e6e3)：面板、表格外框、导航分隔。**软线** (#eeefec)：行与行之间。**控件线** (#d3d5d1)：按钮、输入框、分段控件边框。
- **次要字 Ink Secondary** (#5f656c)：说明、表头、导航默认字。**弱字 Ink Faint** (#8d9399)：未选中的圆点描边、关闭态、示意图的点。
- **常态刻度** 轨道 (#e7e8e5)、填充 (#a9aeb3)：`.typ` 对比条的灰。

### Platform badges
`.pf` 是 20px 方块，一个字：小红书 (#e0213b)、抖音 (#161823)、视频号 (#9c5800)、B站 (#0079a8)、TikTok (#25292e)、YouTube (#d21a12)、官网 (#55606b)、公众号 (#04823f)。这是平台自己的识别色，仅用于这个徽章；不得借用于其他元素，也不表示状态。

### Surfaces for media
- **视频底 Video Ground** (#111214)：视频播放框与飞书视频缩略图的黑底。
- **占位 Placeholder** (#dcdcd8 底、#9a9a95 播放三角)：`app.js` 内联 SVG 的空封面。
- **飞书会话** 底 (#eff0f2)、卡片线 (#dcdee2)、中性卡片头 (#e4e6ea)。

### Named Rules
**The One Meaning Rule.** 黄只说「等你处理」，红只说「出了问题」，绿只说「比平时好 / 正常」。一个颜色不得承担第二种意思；需要强调但不属于这三类时用墨色加粗。

**The Ink Button Rule.** 主按钮只有墨色这一种。一屏至多一个主按钮；它的文字说明点下去会发生什么。

**The Quiet Normal Rule.** 正常、已发布、已核对都退为灰或墨，不上彩色底。异常才配得上颜色。

## Typography

**Font:** 系统无衬线栈 -apple-system、BlinkMacSystemFont、"PingFang SC"、"Noto Sans SC"，不加载网络字体。数字一律 `tabular-nums`。**Mono:** ui-monospace，只用于行内命令与路径。

**Character:** 中文为主、数字对齐、层级靠字重与灰度而不是字号跳跃。

### Hierarchy
- **Display** (700, 24px, 1.3, -0.02em)：页面 `h1`、飞书卡片里的大数字 `.x.big`。
- **Panel title** (700, 18px, -0.01em)：「今天」展开区的作品名。
- **Title** (700, 17px, 1.35)：`h3`，空状态与面板标题。
- **Brand** (700, 15px)：导航里的 versekit 字标。
- **Body** (400 / 600, 14px, 1.5)：正文、表格、输入框、飞书卡片正文。
- **Section / Body small** (600 / 400, 13px)：`h2` 分区标题（次要字色）、按钮、状态词、次要说明。
- **Meta** (400 / 600, 12px)：表头、图例、提示、示意标注。
- **Badge** (700, 11px)：平台徽章字、导航计数用 12px/700。
- 字重只用 400、600、700。

### Named Rules
**The Number Is Bold Rule.** 比较结果（如 `.x` 的「×1.8」）用 700 且带色，其余数字与正文同重。

## Layout

桌面优先：`.app` 为两栏网格，左侧 208px 粘性导航，右侧 `main`（内边距 28px 40px，最大宽 1240px；飞书页 1320px 居中）。页面内部用 14px 的间距排列面板，双栏页（今天、作品详情）用「主区 + 300px 侧栏」，间隙 28px，面板内边距 22px。表格行高由 10px 纵向内边距撑起，行内最小触控高度 32px。

**窄屏不专门设计，只保证不坏。** 860px 以下导航变成顶部横排、`main` 内边距收为 20px 16px、平台行折为三列；1040px 以下双栏页堆叠为单栏。不做手机版的二次构图，不隐藏数据换取简短。`npm run design:check` 在窄屏检查横向溢出与触控目标。

## Elevation & Depth

扁平。没有 `box-shadow`。层次由底色（ground → paper）、1px 线、与墨色选中态承担。唯一浮起的元素是 toast（固定于底部，墨底白字，`opacity` 0.2s `cubic-bezier(.16,1,.3,1)` 渐显）。确认面板的底栏用 `position: sticky` 贴在面板底，靠上边线分隔而非阴影。焦点环：2px 墨色实线，偏移 2px。

### Named Rules
**The Flat Rule.** 不加阴影、不加渐变、不加毛玻璃。需要分层时加一条线。

## Shapes

圆角随元素大小递进，没有胶囊：徽章与小方块 3–5px，按钮与输入框 7px，分段控件 8px（内项 6px），内嵌面板与提示 10px，表格 12px，大面板与飞书会话窗 14px，圆点 50%。边框一律 1px，虚线只用于二维码占位。所有圆角已在 frontmatter 的 `rounded` 中列出，新增圆角先加到那里。

## Components

### Shell nav
208px 粘性侧栏，字标 + 4 项（今天、作品、数据、系统）。项高 34px，圆角 7px；默认次要字，hover (#e8e8e4)，当前页 (#e3e3df) 加 600 字重。「今天」旁的黄色计数是唯一的彩色。底部 `.health` 用 6px 小点：绿 = 正常，红 = 有问题。

### Panel / Table
`.panel` 纸底 + 1px 线 + 14px 圆角；表格包在 `.tblwrap`（12px）内，表头 12px/600 次要字，行间软线，数字列右对齐。作品行点进详情，整行 `.wcell` 是链接。

### Segmented control `.seg`
筛选与版本切换。纸底、控件线、8px 圆角；选中项墨底白字 600。用 `aria-pressed` 表达状态。

### Buttons and links
`.btn` 34px 高、7px 圆角、控件线边框、hover 变 (#f3f3f0)。`.btn.pri` 墨底白字；`.btn.lg` 42px 用于「确认」这一个动作。`.link` 为无框下划线次要字，用于「先不发」「晚点」类次要选择。禁用态 45% 不透明度。

### Confirm panel `.cp`
一支成片 = 视频（#111214 底，300px 高，竖版 360px）+ 版本切换 + 每个平台一行 + 小红书单独一块 + 一个确认按钮。
- **`.prow`**：平台徽章、名称、标题、时间、动作；44px 最小高；失败行淡红底；被关闭的行标题与时间划线并转弱字。
- **`.solo`**：淡黄底黄线，专给必须单独处理的平台（小红书），因为它需要人工点击；里面有自己的标题与动作。
- **`.cfoot`**：粘底操作栏，左侧小字提示，右侧唯一的大墨色按钮。
- 确认完成后换为 `.done-note`（淡绿底绿字 600）。

### Cut steps `.step`
右栏的成片列表：44px 缩略图 + 标题，9px 圆角；当前项墨色描边 + 纸底。`.sidebox` 用上线分块，`.nx` 为「接下来」三列行。

### Typical bar `.typ`
120px × 6px 的对比条：轨道灰，填充为本条的值，2px 墨色竖线标记「这个账号的平时」（40% 处）。高于平时填充为绿，低于为红，接近为灰；旁边总有 `.x` 倍数。

### Strip plot（数据页）
每个平台一行：96px 平台名 + 横向一维点图 + 150px 说明。细线为轴，墨色竖线为平时 (50%)，浅竖线为刻度，11px 圆点是每支作品，绿 / 红 / 灰按相对平时好 / 差 / 持平。点图只比较同一账号，行与行之间不共用刻度含义。

### State vocabulary `.st`
8px 圆点 + 13px 词。点与词合起来才是状态，颜色只是附加：
- **wait 等你确认**：黄点（描边 #b99700），墨字。
- **sched 已确认，等时间**：空心墨圈，墨字。
- **pub 已发布**：灰实点，次要字。
- **done 已发布，已核对 / 正常**：绿点绿字。
- **bad 出了问题**：红点红字 600。
- 未命名的空心灰圈是「未编排 / 先不发」。

### Note `.note`
10px 圆角的说明块，纸底；`.note.bad` 为淡红底红线，写清「怎么了、影响什么、你现在能做什么」，下方动作按钮。失败现场的截图框 `.shot` 同用红线。

### Toast
墨底白字，9px 圆角，居中固定于底部 28px，点击动作后的一句确认，如「已确认 6 条，按时间发」。

### Feishu card mock
三列手机会话示意（#eff0f2 底，14px 圆角）：头像是墨色圆里一个黄点；卡片 10px 圆角，线 (#dcdee2)。卡片头颜色与主系统同义：黄 = 待确认，红 = 出了问题，灰 (#e4e6ea) = 通知，绿 = 已完成。卡片带 210px 视频缩略图（#111214 底，白色播放三角）、`.ln` 行列表、整行平分的按钮、76px 虚线二维码占位。卡片上能点的动作与 Web 完全一致，复杂编辑留给 Web。

## Do's and Don'ts

### Do:
- **Do** 让按钮说清点下去会发生什么：「确认这 6 条，按时间发」，而不是「确认」「提交」。
- **Do** 每个数字都带同一账号的平时：用 `.x` 倍数与 `.typ` 对比条，title 里给出绝对值与基线。
- **Do** 把所有新颜色、字号、圆角先加进本文件 frontmatter，再写进样式。
- **Do** 状态永远是「点 + 词」，色盲用户靠词也读得懂。
- **Do** 一页只有一个主任务和至多一个墨色主按钮。
- **Do** 窄屏只做「不溢出、触控目标 ≥ 32px」。

### Don't:
- **Don't** 用装饰性隐喻（航班、仪表、船舶、游戏化）；界面不需要先学一个比喻。
- **Don't** 做卡片墙：同级内容用表格或行列表，面板不套面板。
- **Don't** 跨平台求和或排名。播放、点赞在不同平台含义不同，只与自己的平时比。
- **Don't** 加 eyebrow 小标签、大写字距小标题；分区标题就是 13px/600 的 `h2`。
- **Don't** 给黄、红、绿第二种用途，也不要把平台品牌色拿去做状态或装饰。
- **Don't** 加阴影、渐变、毛玻璃、图标字形；平台徽章用单字，不用 emoji 或字形图标。
- **Don't** 把正常状态做成彩色徽章。
- **Don't** 为手机重新构图；手机上拍板走飞书卡片。

### 账号组切换（`.grp`）

侧栏顶部、品牌名下面的一个 `<details>`：收起时显示当前账号组的名字和一行说明；展开是组列表（当前组标"当前"，别的组有待办时带黄色数字）和"新建账号组"按钮。只用已有的颜色和圆角（8px 外框、10px 菜单、6px 菜单项），没有阴影。每一页的副标题带上当前组的名字；飞书卡片标题前用一个描边小标签写组名。
