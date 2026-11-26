# 失败和警告

从 `error.code`、`errorCode`、预览的 `rejected`、`warnings` 或投递回报读取原因。说明哪一步、哪一期和下一步，保留已有投递号。对外用 Hifabu、发布机和投递号描述内部服务。

| 信号 | 处理 |
| --- | --- |
| `runtime_required`、`cloud_login_required`、`relay_disabled` | 读 [setup.md](setup.md)。未开通时告诉用户开通后接着交，保留本次选择。 |
| `schema_unsupported` | 暂停交付。请用户到发布机更新 Hifabu，下载地址为 hifabu.com。 |
| `group_not_found` | 停在预览或现有失败投递。按原样说组名并列可用组。 |
| `disk_low`、`quota_exceeded` | 说明可用空间和需要保留的空间（有则给出），请清理后预览。 |
| `unreachable`、断网 | 已登记的任务由后台自动续传。给出当前进度和投递号。预览只有网络警告、素材校验仍通过时，可以登记，然后说明在排队。 |
| 发布机超过 6 小时没取 | 请用户到发布机那台电脑打开 Hifabu，官网 hifabu.com。 |
| `hash_mismatch`、`source_unavailable`、`local_path_in_manifest`、`invalid_manifest` | 核对本次暂存文件、哈希和清单，修复后再预览。 |
| 文案被拒绝 | 带上具体平台和字段，按 [copy.md](copy.md) 改短并先给用户看。 |

预览估计时间较长时一并报告文件大小和 ETA。遇到其他错误时用已返回的人话原因和下一步。
