# Hifabu Claude Code 插件

在 Claude Code 里说「把第 17 期交给发布机」，或运行 `/hifabu:handoff 17`。插件会找这一期的成片、封面和发布文案，先预览，再交到你选的 Hifabu 账号组。「到了吗」可查询本会话的投递。平台稿在发布机的「今天」页或飞书等待你确认。

仅支持 Claude Code ≥ 2.1.292。插件含本机 `bin/`，因此网页版和 Cowork 无法安装。使用前需有 Hifabu 账号和已开通的传片服务，并在另一台电脑准备好支持 v1 清单的 Hifabu 发布机。

在终端安装市场上的版本：

```sh
claude plugin install hifabu --marketplace https://hifabu.com/plugin/marketplace.json
```

安装后运行 `/reload-plugins` 或重开 Claude Code 会话。

## 会运行和发送什么

- `handoff` 运行随包附带的 `hifabu` 小程序，读取你指定的项目和账号组，在本机预览。第一次写项目约定、开启 Claude Code 的自动更新时会提示确认。打开自动更新后，Claude Code 会在启动后刷新 Hifabu 市场并更新插件，磁盘上的版本可能随之变化。可以在 `/plugin` 中关闭。
- 浏览器授权和投递使用 hifabu.com；实际上传使用 Hifabu 账号提供的传片地址。登记后，后台进程把选中的成片、封面和发布文案连同交付清单发往你的 Hifabu，直到发布机来取。它可在 Claude Code 退出后继续，上传完成后退出。不注册开机启动服务。项目约定、账号组偏好和本机素材路径留在本地。
- 启动器先找系统 Node.js ≥ 22.13，其次找插件数据目录的 Node。两处均不可用时，你同意后才调用 `hifabu-runtime` 从 nodejs.org 下载固定版本，校验 SHA-256 后安装在插件数据目录下。

## 本机数据与卸载

- 项目只保存一份 `.hifabu/project.json`，可提交并随工作树移动。约定只有素材定位规则和稳定标识。
- 插件数据默认在 `~/.claude/plugins/data/` 下本插件的目录，由 Claude Code 提供路径，跨升级保留。目录含设备记录、项目账号组选择、自动更新处理状态、上传队列、暂存素材和可能安装的 Node 运行时。
- 刷新凭据优先存在 macOS 钥匙串（服务名 `hifabu`）或 Linux Secret Service。系统存储锁着或写入失败时，登录自动改存插件数据目录内权限为 600 的 `device.json`。`cloud status` 显示凭据位置。机器令牌只在小程序内存中。
- 脚本可用环境变量 `HIFABU_DEVICE_TOKEN` 提供设备刷新凭据，跳过本地凭据读写。此时 `cloud logout` 返回错误并提示从环境移除变量，设备须在「我的 Hifabu」移除才能彻底作废。
- 卸载前在 Claude Code 里说「退出 Hifabu」，或用插件小程序的 `hifabu --data <插件数据目录> cloud logout`。这会清理本机凭据并请求 Hifabu 注销此设备。离线时可稍后到「我的 Hifabu」移除设备。
- 运行 `claude plugin uninstall hifabu@hifabu` 卸载。卸载最后一个范围时会删除插件数据和未完成的上传队列，`--keep-data` 可以保留它们。若已经卸载但未登出，可在钥匙串或 Secret Service 中删除 Hifabu 的此设备条目，并在「我的 Hifabu」移除设备。项目里的约定可在不再需要时自行删除。

## 源码与校验

此版本对应源码标签 [hifabu--v0.2.1](https://github.com/versekit-labs/versekit/tree/hifabu--v0.2.1)，发布时建立。检出该标签，在仓库根目录运行：

```sh
node scripts/build-maker-client.mjs --out-dir ./rebuild
shasum -a 256 ./rebuild/lib/hifabu.mjs ./plugins/hifabu/lib/hifabu.mjs
```

两行 SHA-256 应一致。ESM 文件头还记录了构建所用源码提交和正文 SHA-256。发布包的 SHA-256 随 Hifabu 市场清单提供。版本记录见 [CHANGELOG.md](CHANGELOG.md)。
