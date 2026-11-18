# 部署中转到 volc1（ACC-relay-05）

中转（`vk relay serve`，见 ADR-0003 与 `packages/relay`）只存成片文件和投递清单，不连任何平台。
部署文件都在 `deploy/volc1/`：

| 文件 | 作用 |
|---|---|
| `deploy.sh` | 在制作机/Mac mini 上运行：rsync 代码到 volc1 的 `/opt/versekit`，再调用 `install-remote.sh`。可重复执行，升级也用它 |
| `install-remote.sh` | 在 volc1 上以 root 运行：建 `versekit` 系统用户、数据目录、systemd 服务、Caddy 站点块 |
| `versekit-relay.service` | systemd 单元，`versekit` 用户运行，只监听 `127.0.0.1:8790` |
| `Caddyfile.vk.snippet` | `vk.fangyouxi.cn` 的 Caddy 站点块（反代 8790，HTTPS 由 Caddy 自动签） |
| `e2e.sh` | 端到端：制作机 push → volc1 → 发布机拉取入库，测完自动清理 |

## 部署前提

- DNS：`vk.fangyouxi.cn` A 记录 → `14.103.40.240`（`dig +short vk.fangyouxi.cn` 能看到）。没解析就别部署，Caddy 签不下证书。
- `ssh volc1` 可用（root），volc1 上有 Node ≥ 22.13（`/usr/local/bin/node`）、Caddy 2。

## 部署

```bash
deploy/volc1/deploy.sh          # 默认 ssh 别名 volc1
```

它只**新增**以下东西，不碰 radar 或任何已有服务：

- 用户 `versekit`（nologin），代码 `/opt/versekit`，数据与配置 `/var/lib/versekit-relay`（`VK_HOME`，目录权限 700）
- 服务 `versekit-relay.service`（`systemctl status versekit-relay`）
- `/etc/caddy/Caddyfile` 末尾追加一个带标记的站点块。追加前备份为 `Caddyfile.bak-versekit-<时间>`，`caddy validate` 通过才 `reload`；不通过就还原并报错。块已存在时跳过，所以重复执行安全

## token

首次启动时服务自己在 volc1 生成推送、拉取两个 token，写进
`/var/lib/versekit-relay/.config/versekit/config.json`（权限 600）。token 不进仓库、不进日志、不进 PR。取法：

```bash
# 制作机用（推送）
ssh volc1 'runuser -u versekit -- env VK_HOME=/var/lib/versekit-relay node /opt/versekit/packages/cli/src/vk.mjs relay token push'
# 发布机用（拉取）
ssh volc1 'runuser -u versekit -- env VK_HOME=/var/lib/versekit-relay node /opt/versekit/packages/cli/src/vk.mjs relay token pull'
```

然后在对应机器上：

```bash
vk relay connect https://vk.fangyouxi.cn --token <推送 token> --push   # 制作机
vk relay connect https://vk.fangyouxi.cn --token <拉取 token>          # 发布机
```

换 token：删掉 volc1 上 `config.json` 里对应字段，`systemctl restart versekit-relay` 会重新生成，再重新 connect。

## 验证与端到端

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://vk.fangyouxi.cn/v1/ping   # 无 token → 401
deploy/volc1/e2e.sh
```

`e2e.sh` 用 ffmpeg 生成 2 秒测试视频；制作机、发布机各用一个临时 `VK_HOME`，发布机带 `VERSEKIT_OFFLINE=1`，
不配任何平台账号凭证（只建没有凭证的占位账号），所以碰不到平台。步骤：发布机建组 → 连中转 → 制作机 `vk work push` →
发布机 `vk relay pull` → 核对作品入库、平台稿「等确认」。结束（包括失败）时清掉本机临时目录、两个守护进程，
以及 volc1 上这次测试的投递文件和成片。

**注意**：发布机不能用 `vk serve --offline`。离线模式不加载适配器，入库时 `plan.apply` 一条平台稿也生成不了，
投递会落成「没入库：一条平台稿都没生成」。这里的「离线」靠 `VERSEKIT_OFFLINE=1` 标记 + 没有任何账号凭证来保证；
拉取入库只生成待确认稿，不发布、不采集。

## 日常运维

```bash
ssh volc1 systemctl status versekit-relay
ssh volc1 journalctl -u versekit-relay -n 50 --no-pager
ssh volc1 df -h /                    # 剩余不足 2GB 中转会拒收
```

回滚：`systemctl disable --now versekit-relay`，用 `/etc/caddy/Caddyfile.bak-versekit-*` 还原 Caddyfile 后 `systemctl reload caddy`。
