# 部署 Hifabu 账号服务

部署日由协调器和所有者在 seoul-vps、volc1 及两台自用机器上执行。开发机只跑下面的离线预览和测试。

```bash
repo="$PWD"
preview="$(mktemp -d)"
(cd "$preview" && "$repo/deploy/hifabu/deploy.sh" --dry-run)
rmdir "$preview"
node --test packages/core/test/hifabu-deploy.test.mjs
npm run ci
```

## 1. seoul-vps 上部署账号服务

部署前确认 `/usr/local/bin/node` ≥ 22.13，并准备 Git、OpenSSL（支持 Ed25519）、curl、nginx 和 systemd。Google OAuth 客户端的授权回调填 `https://hifabu.com/login/google/callback`。在 seoul-vps 上以 root 准备已审阅提交的 Git checkout，记录当前版本和已启用的 nginx 配置。

从 seoul-vps 的 root 终端运行 `deploy/hifabu/deploy.sh`。首次输入 Google OAuth 客户端密钥，输入不回显。环境文件 `/etc/hifabu-cloud/cloud.env` 为 root 持有，权限 600。部署日可在服务器上编辑其它字段，例如把 `HIFABU_OWNER_EMAIL` 设置为所有者的已验证邮箱、填写可选的 `HIFABU_MAC_DOWNLOAD_URL`，再重跑脚本。原密钥继续使用。端口 8791、公开来源、密钥路径及数据目录与部署材料对应。

签名私钥首次在服务器生成，放在 `/etc/hifabu-cloud/machine-signing-key.pem`，由服务用户持有，权限 600。备份私钥与独立状态目录 `/var/lib/hifabu-cloud`，按私密数据保管。恢复时沿用同一把私钥，因为 volc1 已安装对应公钥。

systemd 以 `hifabu-cloud` 用户运行 `packages/cloud`，在 `127.0.0.1:8791` 监听。脚本只在现有的 `/etc/nginx/conf.d/hifabu.conf` 的 server 块内写带标记的账号路由。该块继续只监听 `127.0.0.1:8081`，cloudflared 继续转到这个入口，其余路径继续由 `/var/www/hifabu` 提供静态页。脚本预检既有监听和静态根目录。遇到不匹配的配置，协调器先核对这个站点实际使用的 server 块再续跑。

脚本先检查 `nginx -t`，再检查 assurelane.ai 与 hifabu.com 首页均为 200、公开公钥与服务器私钥对应，以及 `/login` 的表单请求返回 303 到 `https://accounts.google.com`，其 `redirect_uri` 为已注册的回调。检查只读取 OAuth 跳转地址。所有者另用浏览器登录一次，并确认回到「我的 Hifabu」，再从「管理」为相同账号开通传片。

**回退。** 脚本失败会尝试还原原来的 nginx 文件和服务。首次部署后需要回退时，从脚本输出的 `hifabu.conf.pre-hifabu.*` 备份还原原站点配置，跑 `nginx -t && systemctl reload nginx`，再执行 `systemctl disable --now hifabu-cloud.service`。升级后回退时，优先用原 Git 提交重新执行部署脚本，或将 `/opt/hifabu-cloud/current` 原子切回原发布目录并重启服务。回退后复核两个首页都返回 200。保留数据目录、环境文件和签名私钥。

### R7 部署窗口

seoul-vps 的 `hifabu-cloud.service`、`/opt/hifabu-cloud`、`/var/lib/hifabu-cloud` 与 nginx 的 Hifabu 站点沿用现有部署。协调器在 volc1 切换之前和之后，从 seoul-vps 上的 R7 checkout 运行 `deploy/hifabu/check-rename.sh`。命令只检查本机服务和登录页、公开 HTTPS 登录页、中转鉴权入口及 assurelane 首页。切换步骤、投递和 blob 数量核对表见[中转运维手册](deploy-relay.md#r7-服务器改名)。

服务器管理命令的新名称为 `hifabu-cloud`，从仓库可运行 `node packages/cloud/src/cli.mjs --help`。已安装 workspace bin 时，`vk-cloud` 在两个小版本内仍可调用，并在 stderr 提示改名。

## 2. volc1 接入中转

按 [中转部署和 Hifabu 迁移](deploy-relay.md#hifabu-机器令牌与迁移) 更新中转与验签配置。核对服务器时钟同步，且 `relay.allow_legacy_tokens` 为 `true`。在所有者账号的「我的 Hifabu」核对传片用量可读，确认已登录的所有者可以在「管理」看到该账号的开通状态和用量。验证管理查询即可。

**回退。** 暂停账号令牌投递后，还原更新前的中转配置备份并重启 `hifabu-relay`。需要回退中转代码时，使用上一个已知正常的提交重跑中转部署。不清理原固定令牌队列或新增的按账号目录。

## 3. 制作机、发布机在系统页登录

先暂停用固定令牌新建投递，传完并拉取旧队列，确认没有已下载待入库的投递。两台机器升级后在各自的「系统」页登录同一个 Hifabu 账号。制作机选择「制作机」，发布机选择「发布机」。浏览器中核对六位确认码并允许接入。回到系统页核对邮箱、机器角色与传片开通状态。CLI 可用 `hifabu cloud status` 复核。切换完成前妥善保管两台机器原来的固定令牌及中转地址。

**回退。** 在两台机器的系统页退出 Hifabu，再按 [旧固定令牌](deploy-relay.md#旧固定令牌) 恢复原中转连接。曾启用账号令牌的设备也可在「我的 Hifabu」中撤销。

## 4. 核对一次传片

选一份所有者确认用于测试的作品。从制作机交付到默认账号组，核对制作机的投递状态、发布机拉取和文件校验、作品入库及平台稿进入「等确认」，最后核对制作机收到入库回报。记录成片大小、下载耗时和平均速度。

**回退。** 暂停新投递，保留投递号和错误信息，查清失败处在哪个阶段。确实需要走旧通道时，先按第 3 步恢复固定令牌连接，再从制作机重新交付未入库的作品。用发布机的已入库记录核对哪些作品已经收到。

## 5. 由所有者决定何时关闭旧令牌

确认两台机器和传片均稳定后，由所有者择日把 `relay.allow_legacy_tokens` 改为 `false` 并重启中转。复核旧固定令牌请求返回 401、账号令牌仍能传片。确认迁移结束后再清理两端留存的旧令牌和原中转目录。

**回退。** 把 `relay.allow_legacy_tokens` 改回 `true` 并重启。旧令牌或其队列如已清理，从安全备份恢复；令牌无法恢复时按旧令牌流程生成并重新连接。

## 6. 发布插件

插件源目录为 `plugins/hifabu`。插件内容变更后，先提升 `plugins/hifabu/.claude-plugin/plugin.json` 的语义化版本号，再运行 `node plugins/hifabu/test/version.test.mjs --print-hash`，把新版本和哈希追加到 `plugins/hifabu/version-lock.json`。发布脚本会对暂存的插件内容执行版本校验。

从仓库检出目录运行以下命令进行离线预览。需要 Node.js 22.13 或更高版本及 `zip`。省略 `--output-dir` 时，脚本打印三个文件的名称和 SHA-256，随后清理暂存文件。

```bash
preview="$(mktemp -d)"
node deploy/hifabu/publish-plugin.mjs --dry-run --output-dir "$preview"
```

协调器发布时传入有写权限的 SSH 主机别名。服务器的 nginx 静态根目录为 `/var/www/hifabu`。

```bash
node deploy/hifabu/publish-plugin.mjs --host seoul-vps
```

脚本将文件上传到 `/var/www/hifabu/plugin/` 下的暂存目录，先公开 `hifabu-<version>.zip` 和 AI 助手安装说明 `install.txt`，最后切换 `marketplace.json`。旧版 zip 继续可用。同一版本重复发布时，只有服务器上的 zip 与本地构建字节一致才更新清单。

发布后用一个新的 Claude Code 用户环境实测安装。安装成功后，在现有会话运行 `/reload-plugins` 或重开会话。

```bash
claude plugin marketplace add https://hifabu.com/plugin/marketplace.json && claude plugin install hifabu@hifabu
claude plugin list
```

已有用户升级时先刷新市场清单，再更新插件。Claude Code 2.1.332 的插件更新命令会使用已缓存的市场清单。

```bash
claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu
```

## 7. 发版

协调器在一批改动合并并验收后发版。首发时先就位并验证正式版，再切换 main 上的旧安装入口与后台更新。发版使用含本版 `package.json` 的 `app-v<版本>` tag，由协调器检出干净的 tag。版本日期取 tag 日期（UTC）。程序包直接读取 Git 中的字节，固定归档元数据，保留可执行位，并限制在 5 MB 内。包内文件包括各工作区的运行代码和包元数据、Web 静态文件、`bin/`、演示数据入口及许可文件。

准备本版发版说明，并通过 `--installer-template` 指定仓库内的安装模板。发布脚本把清单直接嵌入生成的 Bash 安装器，并执行 `bash -n`。说明格式见[发版说明骨架](../CHANGELOG.md)。模板见 [deploy/hifabu/install-template.sh](../deploy/hifabu/install-template.sh)。

### 准备上游文件与离线预览

在协调器的发版环境，从同一 tag 运行两次下载命令，分别使用两个不同的网络出口。两个参数都指向尚不存在的目录。

```bash
node deploy/hifabu/publish-release.mjs --fetch-deps /path/to/upstream-a
node deploy/hifabu/publish-release.mjs --fetch-biliup /path/to/upstream-b
```

清单覆盖 macOS 和 Linux 的 arm64、x64 包。Node 对照上游 `SHASUMS256.txt`，lark-cli 对照上游 `checksums.txt`。biliup-rs `v0.2.4` 要求两个网络下载的压缩包 SHA-256 相同，并与该 tag 的 GitHub 发布资产摘要一致。正式发布会重新获取上游校验数据，任一校验失败或无法获取数据时退出。lark-cli `v1.0.97` 的原包含 MIT 许可。biliup-rs 同样采用 MIT，发布时将带原版权声明的完整许可作为 `deps/` 同版文件公开，清单的 `licenseUrl` 指向它。两项镜像均保留原包字节。 [biliup-rs 许可](https://github.com/biliup/biliup-rs/blob/v0.2.4/LICENSE) · [lark-cli 许可](https://github.com/larksuite/cli/blob/v1.0.97/LICENSE) · [lark-cli 打包配置](https://github.com/larksuite/cli/blob/v1.0.97/.goreleaser.yml)

下面的命令从本地输入生成预览，输出待发布的相对路径和 SHA-256。可选的 `--output-dir` 指向尚不存在的目录，省略时仅打印校验和。历史列表的预览默认只列候选版本。可以通过 `--publish-dir` 读入本机已有的版本目录。正式激活时，历史列表从目标机上的版本目录生成。开发机可运行 `node --test packages/core/test/publish-release.test.mjs`，用临时 Git 仓库和本地上游替身复现。

```bash
release_inputs=(
  --deps-dir /path/to/upstream-a
  --biliup-second-dir /path/to/upstream-b
  --installer-template deploy/hifabu/install-template.sh
  --changelog /path/to/release-notes.md
)
preview="$(mktemp -d)"
node deploy/hifabu/publish-release.mjs --dry-run "${release_inputs[@]}" --output-dir "$preview/download"
```

### 就位、验证与切换

协调器从本机的干净 tag 检出目录运行。SSH 别名须指向具备 `/var/www/hifabu/download` 写权限且已安装 Node.js 22.13 或更高版本的 seoul-vps 账号。首次运行先校验上游数据，再通过 SSH/SCP 将候选版本和依赖上传到目标机的暂存目录。目标机重新计算每个文件的 SHA-256，校验通过后将版本目录一次改名就位。同名文件仅接受完全相同的字节。`SHA256SUMS` 记录版本目录内其余每个文件的哈希。

```bash
node deploy/hifabu/publish-release.mjs "${release_inputs[@]}" --host seoul-vps
```

使用候选版本固定地址 `/download/<版本>/install.sh`，在临时 HOME 中各演练一次全新安装和从上个正式版升级。两次通过后，以相同输入再运行一次并加 `--activate`。目标机核对已就位的文件，刷新 `versions/index.html`，最后原子替换 `latest.json`。

```bash
node deploy/hifabu/publish-release.mjs "${release_inputs[@]}" --host seoul-vps --activate
```

同机部署时，把 `--host seoul-vps` 换成 `--publish-dir /var/www/hifabu/download`。

### 发布机安装

使用固定版本的安装地址，例如 `https://hifabu.com/download/0.3.0/install.sh`。系统需有 Bash、curl、tar、Perl（含 JSON::PP）与 shasum 或 sha256sum。首次安装只下载锁定的程序和私有 Node。升级沿用 `~/.versekit` 和原数据目录，同时用清单版本更新已装在 `~/.versekit/bin` 的 biliup 和 lark-cli。安装器先校验本次下载的每个文件，再替换程序文件。它在注册前显示服务名称、用途和日志路径。

旧 GitHub 安装地址通过 HTTPS 读取 `latest.json`，下载指定版本的 `SHA256SUMS` 和 `manifest.json`。先确认 `SHA256SUMS` 中登记的清单哈希等于 `latest.json`，再校验 `manifest.json` 和 `install.sh` 的实际哈希，通过后才运行安装脚本。仅在离线测试中，可同时设 `HIFABU_INSTALL_TEST=1` 和 `HIFABU_DOWNLOAD_URL`，改用回环 HTTP 地址或本地文件目录。

仍在运行的旧更新程序可以继续提交 `file://` 本地源码包用于升级，保留 `app.prev` 供原有自检和回滚处理。

### 撤回和清理

在下载目录所在的服务器上，用干净的 tag 检出执行维护。历史版本目录一直保留。附 `--publish-dir /var/www/hifabu/download --withdraw <版本> --reason '<原因>'` 可在历史列表标注撤回原因。撤回当前版本并且有可用旧版本时，附上 `--replacement <已验证旧版本>`，脚本最后原子切换 `latest.json`。

用 `--publish-dir /var/www/hifabu/download --prune` 预览超过 90 天且没有任何保留版本引用的镜像文件。协调器核对列表后，按命令输出附上 `--confirm-prune <清单哈希>` 重新执行。
