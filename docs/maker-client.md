# Hifabu 制作机命令

`plugins/hifabu/bin/hifabu` 优先使用 PATH 中的 Node.js 22.13 或更高版本，其次使用插件数据目录下的 `runtime/bin/node`。两处都没有时，启动器会返回 `runtime_required`，列出下载大小、安装目录和需要用户同意的安装命令。

制作机的数据默认放在 `~/.local/state/hifabu/maker`。插件用 `--data <目录>` 传入 `${CLAUDE_PLUGIN_DATA}`，安装私有运行时和执行制作机命令时应传同一个目录。`queue/` 保存等待上传的投递和最近的失败记录。

## 安装私有运行时

在 macOS 和 Linux 的 x64 或 ARM64 机器上，运行与 `hifabu` 同目录的 `hifabu-runtime install --data <目录>`，输入 `yes` 同意。自动化调用在用户同意后可传 `--yes`。安装器从 `nodejs.org` 下载锁定的 v22.23.5 官方压缩包，按插件内置的 SHA-256 校验，然后将 Node 放进插件数据目录。它只安装插件所需的 `node` 可执行文件，系统安装和 PATH 保持原样。可以通过 `HIFABU_RUNTIME_URL` 指定同一压缩包的镜像完整地址，校验值随插件版本固定。 [Node.js v22.23.5 发布记录](https://nodejs.org/en/blog/release/v22.23.5/)

## 凭据位置和清理

运行 `hifabu --data <目录> cloud status --human` 查看当前存储位置，JSON 输出的对应字段为 `credentialStorage`。

- macOS 使用钥匙串，服务名为 `hifabu`，账户名为设备 ID。
- Linux 使用由 `secret-tool` 提供的 Secret Service，条目标签为 `Hifabu`，属性为 `service=hifabu` 和 `device=<设备 ID>`。
- 系统工具缺失时，刷新凭据保存在权限为 `0600` 的 `<数据目录>/device.json`。有系统工具但无法写入时，登录会报错并提示检查系统凭据服务。已有的文件凭据可以继续用，退出并重新登录后会按当前机器选择存储位置。

使用系统存储时，权限为 `0600` 的 `device.json` 只保存设备和连接资料。有效期一小时的机器令牌保存在运行进程的内存中。

卸载前运行 `hifabu --data <目录> cloud logout`，让 Hifabu 作废设备并删除本地凭据。若退出时无法联网，可在「我的 Hifabu」移除该设备。插件卸载通常删除数据目录，包括私有 Node 和未完成的投递，除非卸载时选择保留数据。钥匙串和 Secret Service 条目由系统保管，可能在插件卸载后保留。若已卸载，可以在 macOS「钥匙串访问」中按服务 `hifabu` 和设备 ID 找到并删除该条目。Linux 可在系统密码管理器中删除对应的 `Hifabu` 条目，或运行 `secret-tool clear service hifabu device <设备 ID>`。保留了插件数据时，文件凭据仍在 `device.json`，可在退出 Hifabu 后删除该文件。

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

文件头的 `Source version` 取自仓库根目录 `package.json` 的 `version`。`SHA-256 (inputs)` 对按仓库相对路径排序的 `[路径, 文件 SHA-256]` 数组的 JSON 编码计算，覆盖制作机模块、构建脚本和两个启动脚本。`SHA-256 (body)` 校验文件头后空行之后的 ESM 正文。相同的源码版本和构建输入在完整克隆、浅克隆和 squash 合并后会生成逐字相同的文件。
