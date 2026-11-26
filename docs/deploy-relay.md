# 部署中转到 volc1（ACC-relay-05）

中转（`hifabu relay serve`，见 ADR-0003 与 `packages/relay`）只存成片文件和投递清单，不连任何平台。
部署文件都在 `deploy/volc1/`：

| 文件 | 作用 |
|---|---|
| `deploy.sh` | 在制作机/Mac mini 上运行：rsync 代码到 volc1 的 `/opt/hifabu`，再调用 `install-remote.sh`。可重复执行，升级也用它 |
| `install-remote.sh` | 在 volc1 上以 root 运行：建 `versekit` 系统用户、数据目录、systemd 服务、Caddy 站点块 |
| `hifabu-relay.service` | systemd 单元，`versekit` 用户运行，只监听 `127.0.0.1:8790` |
| `configure-hifabu.mjs` | 在 volc1 合并 Hifabu 验签配置，保留固定令牌和已有字段 |
| `Caddyfile.hifabu.snippet` | `vk.fangyouxi.cn` 的 Caddy 站点块（反代 8790，HTTPS 由 Caddy 自动签） |
| `e2e.sh` | 端到端：制作机 push → volc1 → 发布机拉取入库，测完自动清理 |

## 部署前提

- DNS：`vk.fangyouxi.cn` A 记录 → `14.103.40.240`（`dig +short vk.fangyouxi.cn` 能看到）。没解析就别部署，Caddy 签不下证书。
- `ssh volc1` 可用（root），volc1 上有 Node ≥ 22.13（`/usr/local/bin/node`）、Caddy 2、curl 和 util-linux 的 `flock`。

## 部署

已有旧版中转先按下文执行 R7 切换。新装或已完成切换的中转使用以下命令。

```bash
deploy/volc1/deploy.sh          # 默认 ssh 别名 volc1
```

它只**新增**以下东西，不碰 radar 或任何已有服务：

- 用户 `versekit`（nologin），代码 `/opt/hifabu`，数据与配置 `/var/lib/hifabu-relay`（`HIFABU_HOME`，目录权限 700）
- 服务 `hifabu-relay.service`（`systemctl status hifabu-relay`）
- `/etc/caddy/Caddyfile` 末尾追加一个带标记的站点块。追加前备份为 `Caddyfile.bak-hifabu-<时间>`，`caddy validate` 通过才 `reload`；不通过就还原并报错。块已存在时跳过，所以重复执行安全

## R7 服务器改名

协调器在部署窗口执行。volc1 改名中转，seoul-vps 的账号服务、部署目录和 nginx 站点已经使用 Hifabu 名称，切换前后只做只读检查。开发机从工作树执行两条离线预览：

```bash
deploy/cutover-rename --dry-run
deploy/rollback-rename --dry-run
```

从服务器上独立的 R7 checkout 执行以下步骤。该 checkout 放在与中转代码目录无关的路径，供切换和回滚共用。

1. 在 seoul-vps 运行 `deploy/hifabu/check-rename.sh`，记录账号服务和 nginx 状态、登录页 HTTP 200、中转探针 HTTP 401 和 assurelane 首页 HTTP 200。中转探针使用现有 HTTPS 地址；HTTP 401 表示成功到达中转的鉴权入口。
2. 暂停制作机投递、发布机拉取和管理端清理，等传输结束。在 volc1 确认现有单元、配置及中转数据已备份，Caddyfile 的中转块有原托管标记。有即将到期的文件时，安排在旧服务完成保留期清理后再记录基线。以 root 运行 `deploy/cutover-rename`。
3. 记录脚本打印的「切换前」「切换后」「启动后」，再用 `deploy/cutover-rename --counts` 复核。恢复流量前逐项核对下表。数量相异时先保留现场，核对是否为保留期清理或外部写入。
4. 在 seoul-vps 重跑第 1 步。用 0.1.0 插件和旧版发布机验证原 HTTPS 地址上的认证和拉取。固定令牌的开关、现有令牌、公钥和机器令牌协议沿用原设置。验证同机其他服务后恢复流量。

| 核对项 | 切换前 | 移动后、启动前 | 启动后、恢复流量前 |
|---|---|---|---|
| 全部投递清单 `deliveries/*.json` | 记录 | 相同 | 相同 |
| 全部完整 blob（以 SHA-256 命名） | 记录 | 相同 | 相同 |
| 固定令牌根目录的投递数、blob 数 | 记录两项 | 分别相同 | 分别相同 |
| 每个账号目录的投递数、blob 数 | 逐账号记录两项 | 分别相同 | 分别相同 |

两棵目录在同一文件系统内原子改名，沿用原服务 UID 和文件权限。数据目录内部仍按现有程序的布局读取。旧数据路径 `/var/lib/versekit-relay` 链接到 `/var/lib/hifabu-relay`。协调器在切换满一周后核实旧路径仍为该链接，再用 `unlink /var/lib/versekit-relay` 清理。旧托管单元备份和切换记录位于 `/etc/systemd/system/`，供回滚使用。

**R7 回滚。** 暂停读写后，在 volc1 用同一独立 checkout 以 root 运行 `deploy/rollback-rename`。它停止新单元，把当前数据和代码移回旧路径，复核数量，再恢复旧单元和原 Caddy 托管标记。切换后收到的投递随当前目录移回。回滚后重跑 seoul-vps 的只读检查和旧客户端拉取验证。常规部署在 R7 验证完成后再继续。

## Hifabu 机器令牌与迁移

账号服务用 Ed25519 私钥签发有效期一小时的机器令牌。中转启动时从本地文件读取公钥，每个请求离线验签。账号开通状态和容量来自签好的令牌，开通、关停或调整容量会在续签后生效。制作机和发布机会在令牌到期前自动续签。

账号投递存放在中转数据目录的 `<账号 id>/deliveries`，成片、封面和断点分别在同目录下的 `blobs` 和 `partial`。容量按账号计算，计入完整成片、半截文件和正在上传的预留空间。同账号下内容相同的文件只占用一份，入库后的保留期是七天。中转还会清理七天未续传的半截文件和七天未被投递引用的上传文件。云端磁盘仍须至少保留 2GB。

部署日顺序和每步回退见 [Hifabu 部署手册](deploy-cloud.md)。账号服务还用同一把 Ed25519 私钥为用量查询与账号清理签发 30 秒的控制端凭据。凭据绑定 HTTP 方法和账号，通过 `Authorization: Bearer` 发往 `/v1/control/accounts/<账号 id>`。中转用同一个 `machine_public_key_file` 验签，volc1 只安装公钥。保持两台服务器时钟同步，避免有效凭据被拒。

1. 从 seoul-vps 的 `/.well-known/hifabu-machine-key.pem` 取得已自检的公钥，核对来源后放到 volc1 的 `/var/lib/hifabu-relay/hifabu-machine-key.pem`，设为 `versekit:versekit` 持有、644。账号服务的 `HIFABU_RELAY_URL` 应为公开的 HTTPS 中转地址。
2. 部署支持 Hifabu 验签的中转版本。已有中转启动后，在 volc1 的 root 终端备份配置，把公钥合并进去，再重启服务。

   ```bash
   config=/var/lib/hifabu-relay/.config/versekit/config.json
   key=/var/lib/hifabu-relay/hifabu-machine-key.pem
   backup="$(mktemp "$config.pre-hifabu.XXXXXX")"
   cp -p "$config" "$backup"
   chmod 600 "$backup"
   printf '中转配置备份：%s\n' "$backup"
   runuser -u versekit -- /usr/local/bin/node /opt/hifabu/deploy/volc1/configure-hifabu.mjs "$config" "$key"
   systemctl restart hifabu-relay
   systemctl is-active hifabu-relay
   ```

   首次从旧固定令牌模式迁移时写入以下字段，原有推送和拉取令牌仍可用。已有显式设置时沿用原开关。切换前先确认开关为 `true`。

   ```json
   {
     "relay": {
       "machine_public_key_file": "/var/lib/hifabu-relay/hifabu-machine-key.pem",
       "allow_legacy_tokens": true
     }
   }
   ```

   回退时用 `cp -p "$backup" "$config"` 恢复原配置，再运行 `systemctl restart hifabu-relay`。
3. 按部署手册排空旧队列，让所有者的两台机器通过系统页接入并验证传片。固定令牌访问原数据目录，账号令牌访问自己的账号目录。跨切换仍需投递的作品可以从制作机重新发送。
4. 所有者择日把 `relay.allow_legacy_tokens` 改为 `false` 并重启，分别验证旧令牌 401 和新连接正常。回退时将开关改回 `true` 并重启。确认切换稳定后再清理旧令牌，按需备份原数据目录下的 `blobs`、`partial`、`deliveries` 和 `activity.json`。

配置公钥后默认关闭固定令牌。尚未配置公钥的旧部署默认维持固定令牌模式，显式关闭前须先配置公钥。

## 旧固定令牌

启用固定令牌时，服务在首次启动时生成缺少的推送、拉取令牌，写进
`/var/lib/hifabu-relay/.config/versekit/config.json`（权限 600）。token 不进仓库、不进日志、不进 PR。取法：

```bash
# 制作机用（推送）
ssh volc1 'runuser -u versekit -- env HIFABU_HOME=/var/lib/hifabu-relay node /opt/hifabu/packages/cli/src/vk.mjs relay token push'
# 发布机用（拉取）
ssh volc1 'runuser -u versekit -- env HIFABU_HOME=/var/lib/hifabu-relay node /opt/hifabu/packages/cli/src/vk.mjs relay token pull'
```

然后在对应机器上：

```bash
hifabu relay connect https://vk.fangyouxi.cn --token <推送 token> --push   # 制作机
hifabu relay connect https://vk.fangyouxi.cn --token <拉取 token>          # 发布机
```

换 token：删掉 volc1 上 `config.json` 里对应字段，`systemctl restart hifabu-relay` 会重新生成，再重新 connect。

## 真机验证（待人工）

以下检查由所有者执行。固定令牌兼容模式可用 `e2e.sh` 验证。迁移后用已接入同一账号的制作机和发布机验证，并在发布机记录成片大小、下载耗时和平均速度。

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://vk.fangyouxi.cn/v1/ping   # 无 token → 401
deploy/volc1/e2e.sh
```

`e2e.sh` 用 ffmpeg 生成 2 秒测试视频；制作机、发布机各用一个临时 `HIFABU_HOME`，发布机带 `HIFABU_OFFLINE=1`，
不配任何平台账号凭证（只建没有凭证的占位账号），所以碰不到平台。步骤：发布机建组 → 连中转 → 制作机 `hifabu work push` →
发布机 `hifabu relay pull` → 核对作品入库、平台稿「等确认」。结束（包括失败）时清掉本机临时目录、两个守护进程，
以及 volc1 上这次测试的投递文件和成片。

**注意**：发布机不能用 `hifabu serve --offline`。离线模式不加载适配器，入库时 `plan.apply` 一条平台稿也生成不了，
投递会落成「没入库：一条平台稿都没生成」。这里的「离线」靠 `HIFABU_OFFLINE=1` 标记 + 没有任何账号凭证来保证；
拉取入库只生成待确认稿，不发布、不采集。

## 日常运维

```bash
ssh volc1 systemctl status hifabu-relay
ssh volc1 journalctl -u hifabu-relay -n 50 --no-pager
ssh volc1 df -h /                    # 剩余不足 2GB 中转会拒收
```

首次安装回退：`systemctl disable --now hifabu-relay`，用 `/etc/caddy/Caddyfile.bak-hifabu-*` 还原 Caddyfile 后 `systemctl reload caddy`。
