---
version: 1
slug: "docs-design-feishu-html"
primary_target: "docs/design/feishu.html"
related_targets: []
---

# 飞书卡片（示意）

**模式**：Operate。只按桌面宽度设计，窄屏不坏即可。
**为谁**：作者自己（一人公司，用 Claude 做内容，发到自己的多个平台账号）。以后给同类创作者：从"一条视频、一种语言、两三个平台"到"多支成片、多语言、七八个平台"都是同一个结构。
**解决什么**：定下手机上每个时刻收到什么卡片、能点什么。手机上只有飞书。
**怎么做**：三列会话示意：新作品到确认（入库卡片、视频消息、确认卡片及其表单态和完成态、小红书单独卡片）；发出去了与出问题（含重新登录）；结果与周报。确认卡片可以点。
**成功长什么样**：实现的人照着这页和 feishu-cards/ 下的 JSON 就能做；所有者能判断手机上的流程顺不顺。
**明确不做**：飞书之外的手机界面、真实发送测试（要所有者同意）。
**数据从哪来**：通道层把 core 事件渲染成卡片；按钮回调对应 vk 命令。
**依据**：`docs/PRD.md` v0.2、`docs/design/FLOW-v2.md`。硬规则：没有人确认，一条都不会发。

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个；数字永远和这个账号自己的平时比。参考 Things 3（今天的安静）、Linear（一行一个对象、状态小而清楚）、YouTube Studio（和平时比）。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄 #ffd84a 只表示"等你处理"，红 #c4321c 只表示"出了问题"，绿 #0f7a4a 只表示"比平时好/正常"。系统字体，表格数字等宽对齐。不用装饰性隐喻、卡片墙、跨平台相加的大数字。
FORM：左 208px 侧栏四项（今天、作品、数据、系统）+ 右侧单列内容；只按桌面宽度设计，窄屏不坏即可。手机上只有飞书。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v2/.
FIRST VIEWPORT：标题 + 三列会话。
SIGNATURE：卡片点完原地变成结果，按钮消失。
