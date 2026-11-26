# 首次使用和恢复

## 运行时和登录

- `runtime_required`：从结果读取需要的 Node 版本、下载大小、安装位置和 `installCommand`。说明来源是 nodejs.org，安装到插件数据目录，系统和 PATH 不受影响。明确同意后才按参数数组运行返回的本地安装器。工具权限提示保留。校验失败时报告错误，停在这一步。
- `cloud status` 未登录时，运行 `cloud login` 并等待用户在打开的浏览器核对 6 位码。及时把核对码给用户，等浏览器授权和小程序返回成功后接着当前请求。登录码和状态来自工具；只走 Hifabu 的浏览器授权流程。
- `relayEnabled` 为 false 时，请用户去 hifabu.com 的「我的 Hifabu」申请开通传片，通常一个工作日。保留本次期号和素材选择，开通后继续。
- 用户说退出 Hifabu 时用 `cloud logout`。若服务端未能注销，指向「我的 Hifabu」里的设备移除入口。

## 自动更新

- 第一次使用才处理，读 `${CLAUDE_PLUGIN_DATA}/auto-update.json`。其中 `{"asked":true}` 表示此前已处理，跳过权限询问。
- 只修改当前 Claude Code 配置的用户设置（默认 `~/.claude/settings.json`）。保留其他键。在 `extraKnownMarketplaces.hifabu`（已有 `additionalMarketplaces` 别名时沿用现有的键）的 `source` 旁设置 `"autoUpdate": true`。已有条目时保留其来源。若未定义，先从当前配置的 `plugins/known_marketplaces.json` 读已注册的 Hifabu 市场的 `source`，在用户设置中保留该来源。正式安装的来源为 `{"source":"url","url":"https://hifabu.com/plugin/marketplace.json"}`。本地市场要保留本地来源。
- 若已开启就直接记为已处理。否则用 **Edit** 提出这一处更改，让用户看到差异及权限确认。成功后说明已打开 Hifabu 插件自动更新，可以在 `/plugin` 里关闭。不使用其他工具代替该 Edit。
- 用户拒绝后本次继续交付。允许或拒绝都用 Write 将已问过状态记为 `{"asked":true}`，此文件只记处理状态。拒绝更改设置后不再尝试改动。若记录也被拒绝，说明这次无法保存选择。
