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

## 2. volc1 接入中转

按 [中转部署和 Hifabu 迁移](deploy-relay.md#hifabu-机器令牌与迁移) 更新中转与验签配置。核对服务器时钟同步，且 `relay.allow_legacy_tokens` 为 `true`。在所有者账号的「我的 Hifabu」核对传片用量可读，确认已登录的所有者可以在「管理」看到该账号的开通状态和用量。验证管理查询即可。

**回退。** 暂停账号令牌投递后，还原更新前的中转配置备份并重启 `versekit-relay`。需要回退中转代码时，使用上一个已知正常的提交重跑中转部署。不清理原固定令牌队列或新增的按账号目录。

## 3. 制作机、发布机在系统页登录

先暂停用固定令牌新建投递，传完并拉取旧队列，确认没有已下载待入库的投递。两台机器升级后在各自的「系统」页登录同一个 Hifabu 账号。制作机选择「制作机」，发布机选择「发布机」。浏览器中核对六位确认码并允许接入。回到系统页核对邮箱、机器角色与传片开通状态。CLI 可用 `vk cloud status` 复核。切换完成前妥善保管两台机器原来的固定令牌及中转地址。

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
