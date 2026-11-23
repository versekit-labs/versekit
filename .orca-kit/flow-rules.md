# versekit 的任务书专属约束（bin/orca-flow.mjs 读，ACC-harness-orca-08）

只有 `## 实现`、`## 验收` 两节里以 `- ` 开头的行会原样拼进任务书的「约束」。

## 实现

- 真机红线（docs/design/ACCEPTANCE.md 开头）：本机是开发机，不访问任何平台的真实站点；起 vk 服务只能用 VK_HOME=$(mktemp -d) vk serve --offline
- 界面单（口径里有 ACC-v3-fid-08）的证据包三件事缺一不可：① 截图 1360 宽、用 `vk demo seed` 的演示数据截（不要用测试替身数据），放 `docs/design/screenshots/impl/<页面>.png`；② PR 描述里用相对链接把它和 `docs/design/screenshots/v3/` 里同一页的图并排；③ 贴出 ACC-v3-fid-01 的实测值（页面底色 #fafaf8、导航项高 34px、body 的 -webkit-font-smoothing:antialiased 与 tabular-nums、焦点环 2px 墨色偏移 2px、选中色 #ffd84a）

## 验收

- 需要看界面时用 8788 端口，避开实现方可能占用的 8787
- 真机红线（docs/design/ACCEPTANCE.md 开头）：本机是开发机，不得让任何平台的真实站点被访问；起 vk 服务只能用 VK_HOME=$(mktemp -d) vk serve --offline；需要真实平台的口径在 PR 评论里列为「待人工」，不计 pass 也不计 fail
- 收尾关闭自己起的 Chrome 与测试服务（只按自己的 pid / 端口关），不碰 ~/.local/state/versekit/browser/ 下的登录窗口
