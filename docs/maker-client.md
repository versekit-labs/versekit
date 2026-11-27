# Hifabu 制作机命令

`plugins/hifabu/bin/hifabu` 优先使用 PATH 中的 Node.js 22.13 或更高版本，其次使用插件数据目录下的 `runtime/bin/node`。两处都没有时，启动器会返回 `runtime_required`，列出下载大小、安装目录和需要用户同意的安装命令。

制作机的数据默认放在 `~/.local/state/hifabu/maker`。插件用 `--data <目录>` 传入 `${CLAUDE_PLUGIN_DATA}`，安装私有运行时和执行制作机命令时应传同一个目录。`queue/` 保存等待上传的投递和最近的失败记录。

## 安装私有运行时

在 macOS 和 Linux 的 x64 或 ARM64 机器上，运行与 `hifabu` 同目录的 `hifabu-runtime install --data <目录>`，输入 `yes` 同意。自动化调用在用户同意后可传 `--yes`。安装器从 `nodejs.org` 下载锁定的 v22.23.5 官方压缩包，按插件内置的 SHA-256 校验，然后将 Node 放进插件数据目录。它只安装插件所需的 `node` 可执行文件，系统安装和 PATH 保持原样。可以通过 `HIFABU_RUNTIME_URL` 指定同一压缩包的镜像完整地址，校验值随插件版本固定。 [Node.js v22.23.5 发布记录](https://nodejs.org/en/blog/release/v22.23.5/)

## 凭据位置和清理

运行 `hifabu --data <目录> cloud status --human` 查看当前存储位置，JSON 输出的对应字段为 `credentialStorage`。

- macOS 使用钥匙串，服务名为 `hifabu`，账户名为设备 ID。
- Linux 使用由 `secret-tool` 提供的 Secret Service，条目标签为 `Hifabu`，属性为 `service=hifabu` 和 `device=<设备 ID>`。
- 打开浏览器前，小程序会试写并清理一条临时的系统凭据。钥匙串锁着、无桌面会话或系统工具无法写入时，刷新凭据保存在权限为 `0600` 的 `<数据目录>/device.json`。授权后遇到系统写入失败也会改存到该文件，本次授权继续有效。登录结果和状态都显示文件位置。

使用系统存储时，权限为 `0600` 的 `device.json` 只保存设备和连接资料。有效期一小时的机器令牌保存在运行进程的内存中。

卸载前运行 `hifabu --data <目录> cloud logout`，让 Hifabu 作废设备，并清理系统存储和本地文件。若退出时无法联网，可在「我的 Hifabu」移除该设备。插件卸载通常删除数据目录，包括私有 Node 和未完成的投递，除非卸载时选择保留数据。钥匙串和 Secret Service 条目由系统保管，可能在插件卸载后保留。若已卸载，可以在 macOS「钥匙串访问」中按服务 `hifabu` 和设备 ID 找到并删除该条目。Linux 可在系统密码管理器中删除对应的 `Hifabu` 条目，或运行 `secret-tool clear service hifabu device <设备 ID>`。保留了插件数据时，文件凭据仍在 `device.json`，可在退出 Hifabu 后删除该文件。

常驻机器和脚本可以通过进程环境中的 `HIFABU_DEVICE_TOKEN` 提供设备刷新凭据。设置后，制作机只用环境变量换取机器令牌，跳过浏览器授权和本地凭据的读写。状态显示环境变量名称，JSON 的 `credentialStorage` 为 `env`。此时 `cloud logout` 返回非零退出码和 `cloud_logout_env_token`，提示从环境移除该变量，原有本地凭据和服务端设备保持原状。要让环境变量中的凭据彻底失效，到「我的 Hifabu」移除对应设备。

## 制作机命令

项目选择放在同一数据目录的 `projects/<项目 id>.json`，格式为 `{"group":"账号组名"}`。旧清单未指定 `--group` 时会按项目选择使用该组。v1 清单通过 `target.group` 指定本次投递的组。

`hifabu group list --json` 的数据字段共有 `reportedAt` 和 `groups`。组有 `name`、可选的布尔字段 `default` 和 `accounts`，账号只列 `platform` 和 `name`。完整版用读取时间填 `reportedAt`，另外保留 `current` 和组的 `id`、`created_at`、`account_count`。制作机显示最近同步的时间和发布机 `device`。发布机从未同步时，制作机返回空数组和 `reportedAt: null`。

`hifabu work push <清单> --dry-run --json` 只检查清单和中转状态。交付时，制作机先登记投递，再在当前命令中上传。遇到可重试的失败，下次交付时会尝试续传队列中的投递。

## 重建与校验

在要核对的源码版本上，从仓库根目录运行以下命令。构建会把 `lib/hifabu.mjs` 和两个启动脚本写入临时目录，打印三个文件的大小和 SHA-256。最后一条命令输出的两份完整文件 SHA-256 应一致。

```sh
out=$(mktemp -d)
node scripts/build-maker-client.mjs --out-dir "$out"
shasum -a 256 plugins/hifabu/lib/hifabu.mjs "$out/lib/hifabu.mjs"
```

文件头包含构建脚本路径和两项 SHA-256。`SHA-256 (inputs)` 对按仓库相对路径排序的 `[路径, 内容 SHA-256]` 数组的 JSON 编码计算，覆盖实际打包的模块、构建脚本和两个启动脚本。模块源码去掉末尾空白后再计算。命令注册表只使用打包时生成的内容，包含以固定格式序列化的 `MAKER_COMMANDS`（含本地 `scan`）、制作机调用的云端命令，以及共用的参数校验源码。只改根 `package.json` 的发布机版本号，或新增或修改完整版专用命令时，制作机产物逐字相同。插件版本记录在 `plugins/hifabu/.claude-plugin/plugin.json` 的 `version` 中。

`SHA-256 (body)` 校验文件头后空行之后的 ESM 正文。相同的构建输入在完整克隆、浅克隆和 squash 合并后会生成逐字相同的文件。CI 报制作机产物过期时，在仓库根目录运行 `node scripts/build-maker-client.mjs`，再提交重新生成的产物。
