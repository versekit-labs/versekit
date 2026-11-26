# Hifabu 制作机命令

`plugins/hifabu/bin/hifabu` 需要 Node 22.13 或更高版本。运行 `hifabu --help` 查看命令。

制作机的数据默认放在 `~/.local/state/hifabu/maker`。用 `--data <目录>` 可以指定其他位置，例如插件传入的 `${CLAUDE_PLUGIN_DATA}`。`device.json` 保存刷新凭据，权限为 600。短期机器令牌只在运行时保存在内存中。`queue/` 保存等待上传的投递和最近的失败记录。

项目选择放在同一数据目录的 `projects/<项目 id>.json`，格式为 `{"group":"账号组名"}`。旧清单未指定 `--group` 时会按项目选择使用该组。v1 清单通过 `target.group` 指定本次投递的组。

`hifabu group list --json` 的数据字段共有 `reportedAt` 和 `groups`。组有 `name`、可选的布尔字段 `default` 和 `accounts`，账号只列 `platform` 和 `name`。完整版用读取时间填 `reportedAt`，另外保留 `current` 和组的 `id`、`created_at`、`account_count`。制作机显示最近同步的时间和发布机 `device`。发布机从未同步时，制作机返回空数组和 `reportedAt: null`。

`hifabu work push <清单> --dry-run --json` 只检查清单和中转状态。交付时，制作机先登记投递，再在当前命令中上传。遇到可重试的失败，下次交付时会尝试续传队列中的投递。

在仓库根目录运行 `node scripts/build-maker-client.mjs` 构建 `plugins/hifabu/bin/hifabu` 和 `plugins/hifabu/lib/hifabu.mjs`。构建会打印两个文件的大小和 SHA-256。`--out-dir <目录>` 可以把产物写到另一个目录。
