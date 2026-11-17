---
version: 1
slug: "docs-design-system-html"
primary_target: "docs/design/system.html"
related_targets: []
---

# 系统

**模式**：Operate。只按桌面宽度设计，窄屏不坏即可。
**为谁**：作者自己（一人公司，用 Claude 做内容，发到自己的多个平台账号）。以后给同类创作者：从"一条视频、一种语言、两三个平台"到"多支成片、多语言、七八个平台"都是同一个结构。
**解决什么**：出了问题或想改规则时来这里；平时不用看。
**怎么做**：账号（登录状态、今天还能发几条）、发布方案（哪种成片发哪些平台、什么节奏，可改）、发布机与队列、平台规则（不能关）、最近出的问题；每块下面写对应的 vk 命令。
**成功长什么样**：能回答"为什么这条没发""今天还能发几条""我的发布习惯在哪改"。
**接入账号（#208 补）**：账号表下方一行——选平台（只列已安装的适配器）→ 填账号名 → 墨色主按钮「接入账号」，当场就地登录（B站/小红书/抖音扫码或登录窗口，TikTok 官方接口走授权链接），成功后出现在表里、归当前账号组。TikTok 官方接口没有应用凭证时，在那一行下面就地填 client key / secret 保存。设计稿里没有这个入口，按现有样式补，不另起一页；旧 `/accounts/add`、`/groups` 跳到本页对应位置。
**明确不做**：账号组矩阵、日志全文、云端运维。
**数据从哪来**：`vk group list`、`vk account list`（含今天还能发）、`vk platforms`、`vk account credentials`；发布方案 `vk plan show` / `vk plan set`（#209，存在 meta 表，按账号组各一份）、发布机 `vk machine`（心跳 + 与「今天」同源的排队数）、平台规则（`plan.show` 里的生效规则，默认值标「默认值」）、最近出的问题 `vk runs --failed`（最近 7 天、能「再试一次」的）。
**依据**：`docs/PRD.md` v0.2、`docs/design/FLOW-v2.md`。硬规则：没有人确认，一条都不会发。

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个；数字永远和这个账号自己的平时比。参考 Things 3（今天的安静）、Linear（一行一个对象、状态小而清楚）、YouTube Studio（和平时比）。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄 #ffd84a 只表示"等你处理"，红 #c4321c 只表示"出了问题"，绿 #0f7a4a 只表示"比平时好/正常"。系统字体，表格数字等宽对齐。不用装饰性隐喻、卡片墙、跨平台相加的大数字。
FORM：左 208px 侧栏四项（今天、作品、数据、系统）+ 右侧单列内容；只按桌面宽度设计，窄屏不坏即可。手机上只有飞书。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v2/.
FIRST VIEWPORT：标题 + "一切正常 / 有 N 件事要处理"；账号表；发布方案表。
SIGNATURE：每块下方一行等宽字的对应命令（CLI 完整律看得见）。
