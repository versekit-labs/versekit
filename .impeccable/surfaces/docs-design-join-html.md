---
version: 1
slug: "docs-design-join-html"
primary_target: "docs/design/join.html"
related_targets: []
---

# 接受邀请与第一次设置

**模式**：Operate。
**为谁**：被邀请来的新用户。她用 Claude 做内容，不懂命令行；手边有一台常开、和手机同网的电脑。
**解决什么**：从一条邀请链接走到「能发第一条」，中间不碰命令行，也不需要问人。
**怎么做**：一页，四步，一次只展开当前这一步，做完的收成一行、带绿点：
1. 设密码（邮箱来自邀请，已填好，不能改）。
2. 接一台发布机：打开官网的安装页照着装（不做签名安装包，所有者 2026-11-18 定）；装完它自己打开浏览器让你点「允许」；这一页等着，接上后显示它的名字和出口位置。
3. 登录第一个平台账号：选平台 → 二维码就在这里。可以「先跳过」。
4. 接上 Claude：一句可以复制的话。可以「先跳过」。
做完进「今天」。中途关掉，下次登录回到没做完的那一步；第 3、4 步跳过后在系统页补。
**要对她说清楚的**（第 1 步下面，普通文字，不是小字）：平台的登录只存在你自己的发布机上，这个服务拿不到；你的作品、文案和成片存在这个服务上。
**状态**：邀请过期或用过 → 整页换成一句话和「请发邀请的人再发一次」；发布机 3 分钟没接上 → 「还没接上」+ 三条可能的原因（没装完、那台电脑没联网、浏览器里没点允许）。
**明确不做**：产品介绍轮播、填资料问卷、选套餐。
**数据从哪来**：`invite.accept`、`device.link.*`、`account.add`、`account.login.*`。
**页面上不出现命令。**

## Direction contract

THESIS：安静的工作台。一屏只回答一个问题，主操作只有一个。参考 Things 3、Linear、YouTube Studio 的克制。
OWN-WORLD：暖白场地 #fafaf8、白色面板、发丝线；墨色 #1a1c1f 是唯一的主按钮色；黄只表示"等你处理"，红只表示"出了问题"，绿只表示"比平时好/正常"。系统字体。不用装饰性隐喻、卡片墙、插画。
FORM：没有侧栏的单列窄页（最宽 440px，居中偏上），一个面板、一个墨色主按钮。
FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the baseline screenshots in docs/design/screenshots/v3/.
FORM：没有侧栏的单列页（最宽 560px），四步竖排，当前步是一个面板，其余是一行。
FIRST VIEWPORT：字标、「你好，林夏」、四步里的当前一步。
SIGNATURE：做完的步骤收成一行并写出结果（「书房的 Mac · 美国 洛杉矶」），不是一个勾。
