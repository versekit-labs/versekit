# Hifabu 账号服务

使用 Node 22.13 或更新版本。服务监听本机回环地址，由 HTTPS 入口转发。启动方式为 `npm run start --workspace @versekit-app/cloud`，也可运行 `node packages/cloud/src/cli.mjs serve`。

| 配置 | 含义 |
|---|---|
| `HIFABU_ORIGIN` | 浏览器访问的 HTTPS 来源，不带路径。回环测试可用 HTTP。Google OAuth 的回调地址是该来源的 `/login/google/callback`。 |
| `HIFABU_DATA_DIR` | 服务专用目录，包含 `control.db` 和 `logs/`。 |
| `HIFABU_PORT` | 本机监听端口，默认 8791。 |
| `HIFABU_GOOGLE_CLIENT_ID`、`HIFABU_GOOGLE_CLIENT_SECRET` | Google OAuth 客户端凭据，由进程环境注入。 |
| `HIFABU_LOG_RETENTION_DAYS` | 日志按 UTC 日轮转，默认 30 天，范围 0–30 天。0 会删除服务日志并停止记录。 |
| `HIFABU_SIGNING_KEY_FILE` | 机器接入使用的 Ed25519 PEM 私钥文件，权限必须为 600。没有配置时，Google 登录仍可用。 |
| `HIFABU_RELAY_URL` | 随机器登录和刷新返回的传片服务 HTTPS 来源。回环测试可用 HTTP。 |
| `HIFABU_OWNER_EMAIL` | 可以访问 `/admin` 和管理命令的所有者邮箱。邮箱必须与已验证的 Hifabu 账号匹配。留空时所有人均无管理权限。 |
| `HIFABU_MAC_DOWNLOAD_URL` | 公开的 Mac 发布机安装包 HTTPS 地址。留空时 `/account` 显示 Mac 版暂未提供。回环测试可用 HTTP。 |

账号服务的日志只记录时间、固定事件、错误码和说明。HTTPS 入口也需关闭原始请求日志，或过滤查询字符串、请求头和请求体，并采用同样的保留期。回调查询字符串含一次性授权码。网站的 `/privacy/` 由 HTTPS 入口路由到静态站点，隐私政策在账号服务上线时更新。

运行 `node packages/cloud/src/cli.mjs --help` 可看云端命令。创建会话会给出浏览器登录地址，Google 授权在浏览器内完成。读取和撤销已有会话可通过 `HIFABU_SESSION_TOKEN` 传入该会话的凭据。

本机运行 `hifabu cloud login --role maker` 接入制作机，发布机使用 `hifabu cloud login --role executor`。浏览器会打开接入页，核对六位数字后点「允许」，本机会自动继续。`hifabu cloud status` 查看当前 Hifabu 账号、机器角色和传片状态。`hifabu cloud logout` 清除本机登录。测试可通过 `HIFABU_ORIGIN` 指向本地假服务。

已登录的用户可以在「我的 Hifabu」查看自己接入的机器，并点「退出这台」。CLI 对应 `vk-cloud device list` 和 `vk-cloud device revoke <机器 id>`，会话通过 `HIFABU_SESSION_TOKEN` 提供。退出后，机器刷新会被拒绝，已签发令牌在一小时内到期。

`vk-cloud relay grant status` 查看当前账号传片状态，`vk-cloud relay grant request` 提交开通申请。申请显示在管理页。所有者用 `vk-cloud user list` 查看账号 ID 和用量，用 `vk-cloud relay grant set <账号 id> on` 或 `off` 开关传片。关闭后，账号页显示「传片已被关闭」，用户可再次申请。新账号容量默认为 10 GB。指定 `keep <容量 GB>` 可单独修改容量。机器在下次刷新时取得新设置。

所有者在管理页点「删除账号」后输入待删除账号的完整邮箱。CLI 对应 `vk-cloud user delete <账号 id> <完整邮箱>`。账号服务先等中转确认删除目录，再删除控制库里的账号及关联行。若中转暂不可用或仍有请求正在处理，页面显示失败并可重试。中转的用量及删除接口以既有 Ed25519 公钥验证短期控制凭据，每个凭据绑定一个账号和一种操作。删除后，中转保留一小时的散列撤销记录，阻止已签发的机器令牌重建目录。

签名公钥通过 `GET /.well-known/hifabu-machine-key.pem` 公开，`src/machine-token.mjs` 提供 Ed25519 离线验签。短期接入申请在账号服务进程中保存 10 分钟，服务重启后需重发申请。控制库只保存刷新凭证的哈希。本机登录使用权限为 600 的凭据文件。

本地测试运行 `node --test packages/cloud/test/*.test.mjs`，Google 授权、换令牌和验签密钥均来自本地假服务。
