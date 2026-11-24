# Hifabu 账号服务

使用 Node 22.13 或更新版本。服务监听本机回环地址，由 HTTPS 入口转发。启动方式为 `npm run start --workspace @versekit-app/cloud`，也可运行 `node packages/cloud/src/cli.mjs serve`。

| 配置 | 含义 |
|---|---|
| `HIFABU_ORIGIN` | 浏览器访问的 HTTPS 来源，不带路径。回环测试可用 HTTP。Google OAuth 的回调地址是该来源的 `/login/google/callback`。 |
| `HIFABU_DATA_DIR` | 服务专用目录，包含 `control.db` 和 `logs/`。 |
| `HIFABU_PORT` | 本机监听端口，默认 8791。 |
| `HIFABU_GOOGLE_CLIENT_ID`、`HIFABU_GOOGLE_CLIENT_SECRET` | Google OAuth 客户端凭据，由进程环境注入。 |
| `HIFABU_LOG_RETENTION_DAYS` | 日志按 UTC 日轮转，默认 30 天，范围 0–30 天。0 会删除服务日志并停止记录。 |

账号服务的日志只记录时间、固定事件、错误码和说明。HTTPS 入口也需关闭原始请求日志，或过滤查询字符串、请求头和请求体，并采用同样的保留期。回调查询字符串含一次性授权码。网站的 `/privacy/` 由 HTTPS 入口路由到静态站点，隐私政策在账号服务上线时更新。

运行 `node packages/cloud/src/cli.mjs --help` 可看云端命令。创建会话会给出浏览器登录地址，Google 授权在浏览器内完成。读取和撤销已有会话可通过 `HIFABU_SESSION_TOKEN` 传入该会话的凭据。

机器接入服务可以为 `createCloudServer` 提供 `resolveLink(code)`，只对仍有效的核对码返回机器名。接入页可将用户引导至 `/login?code=...`，登录成功后会回到对应的 `/link?code=...`。

本地测试运行 `node --test packages/cloud/test/*.test.mjs`，Google 授权、换令牌和验签密钥均来自本地假服务。
