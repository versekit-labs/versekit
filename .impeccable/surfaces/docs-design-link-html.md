---
version: 1
slug: "docs-design-link-html"
primary_target: "docs/design/link.html"
related_targets: []
---

# 允许一台设备接入

**模式**：Operate。
**为谁**：刚在另一台电脑上装了发布机、或在 Claude 里第一次用 Hifabu 的用户；浏览器是那台设备自己打开的。
**解决什么**：确认「是我要接的这台」，一下点完。
**怎么做**：一句话说清是谁、要干什么：「『书房的 Mac』想接入你的 Hifabu，作为发布机」。下面三行事实：设备（名字、系统）、它能做什么（发布机：登录你的平台账号、按你确认的时间发布、回传数据；Claude：把做好的作品送进来、看你的作品和数据）、它不能做什么（不经你确认发布 / 发布或登录平台账号）。墨色按钮「允许」，文字链接「不是我」。
**成功长什么样**：点完显示「接上了，可以关掉这一页」，那台设备自己继续。
**状态**：没登录 → 先去登录页，登录后回来；码过期 → 「这次接入过期了，回到那台电脑上重新开始」；点了「不是我」→ 「已拒绝。如果你没有在装 Hifabu，建议改一下密码」。
**明确不做**：让人输入配对码（码在地址里，只显示出来供核对）；在这里选账号组或绑定账号。
**数据从哪来**：`device.link.show / approve / deny`（ADR-0005 §6）。
**页面上不出现命令。**

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个。参考 Things 3、Linear、YouTube Studio 的克制。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄只表示"等你处理"，红只表示"出了问题"，绿只表示"比平时好/正常"。系统字体。不用装饰性隐喻、卡片墙、插画。
FORM：没有侧栏的单列窄页（最宽 440px，居中偏上），一个面板、一个墨色主按钮。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v3/.
FIRST VIEWPORT：字标、一句话、三行事实、允许。
SIGNATURE：「它不能做什么」和「它能做什么」并排写出来。
