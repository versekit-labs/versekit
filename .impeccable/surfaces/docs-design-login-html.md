---
version: 1
slug: "docs-design-login-html"
primary_target: "docs/design/login.html"
related_targets: []
---

# 登录

**模式**：Operate。
**为谁**：已经有账号的用户，回到这个服务。
**解决什么**：进到自己的工作台。
**怎么做**：邮箱、密码、一个墨色按钮「登录」。下面两个文字链接：「忘了密码」「我有邀请码」。
**成功长什么样**：10 秒内进到「今天」。
**状态**：密码不对 → 字段下面一句「邮箱或密码不对」（不说是哪个不对）；试太多次 → 「试的次数太多了，15 分钟后再试」；从设备配对页被带过来时，上面多一句「登录后继续接入『书房的 Mac』」。
**明确不做**：第三方登录、飞书登录、公开注册入口、营销内容。
**数据从哪来**：`session.create`（ADR-0005 §5）。
**页面上不出现命令。**

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个。参考 Things 3、Linear、YouTube Studio 的克制。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄只表示"等你处理"，红只表示"出了问题"，绿只表示"比平时好/正常"。系统字体。不用装饰性隐喻、卡片墙、插画。
FORM：没有侧栏的单列窄页（最宽 440px，居中偏上），一个面板、一个墨色主按钮。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v3/.
FIRST VIEWPORT：字标、邮箱、密码、登录。
SIGNATURE：除了要填的两项，什么都没有。
