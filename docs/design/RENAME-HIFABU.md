# 全面改名为 Hifabu：范围、做法与拆单（2026-11-26）

所有者 2026-11-26 定：「把本项目之前遗留的所有 versekit、vk 之类的命令都改成 hifabu 这个体系，产品名已经确定改成 Hifabu。」

同日所有者确认的边界：
- **本机数据目录这次不搬**：`~/.versekit`、`~/.config/versekit`、`~/.local/state/versekit/vk.db` 和飞书 profile `versekit` 照旧，等发布机新安装器上线时再迁（§3）。
- **GitHub 仓库这次不改**：仍是 `versekit-labs/versekit`，以后单独迁。
- **Orca 协作流程这次不动**：`orca-flow[versekit]`、`/orca/workspaces/versekit`、协调器 worktree 照旧。

相关：插件重新设计 [plugin/DESIGN.md](plugin/DESIGN.md)。§C.4 的命名表以本文为准。

---

## 1. 现状（origin/main @ db69ea1 实测）

- 2218 个文件里，有 143 个出现 `versekit`，共约 1050 处；`vk` 作为独立词约 1170 处（其中 `VK_HOME` 179 处，多在测试里）。
- 主要集中在 `packages/core`（72 个文件）、`docs/design`（24）、`packages/cli`（21）、`packages/web`（9）、`packages/cloud`（8）。

| 类别 | 例子 | 改了会不会坏东西 |
|---|---|---|
| 用户看得见的字 | Web 页面标题和侧栏「versekit」、中转提示「打开那台电脑上的 versekit」、飞书卡片、官网 | 不会 |
| 命令 | `vk`（`packages/cli/src/vk.mjs`）、`commands.mjs` 里每条 `cli.usage`、文档和技能里的 `vk …` | 会：用户脚本、技能、0.1.0 插件都在调 `vk` |
| 环境变量 | `VERSEKIT_PREFIX` `VERSEKIT_SERVICE_LABEL` `VERSEKIT_OFFLINE` `VK_HOME` `VK_LARK_BIN` `VK_CHROME_BIN` `VK_FEISHU_PROFILE` 等 | 会：后台服务的 plist 里写着这些 |
| 本机路径 | `~/.versekit`（程序、私有 Node、biliup、lark-cli）、`~/.config/versekit`（配置、平台凭据）、`~/.local/state/versekit/vk.db`（数据库） | **会，风险最高**：所有者真机上的平台登录和作品库都在这里 |
| 后台服务 | launchd `com.versekit.daemon` | 会：改名后旧服务还在跑，就会有两个后台服务 |
| 飞书组件 | lark-cli 的 profile 名 `versekit` | 会：飞书连接要重新配，或者迁移 profile |
| 线上协议常量 | 机器令牌 audience `versekit-relay`、中转签名串 `versekit relay account control v1` | **会**：云端、中转、发布机只要有一边没同步升级，令牌就互相不认 |
| 服务器 | volc1 / seoul 上的 `versekit-relay.service`、`/var/lib/versekit-relay`、`/opt/versekit`、Caddy 片段 | 会：要停机切换 |
| 内部名字 | 根包名 `versekit`、`@versekit-app/*` 11 个包、`.claude/skills/versekit-ingest`、`docs/brand/versekit-icon-1024.png` | 不会坏，只是改动面大，容易和正在做的单冲突 |
| 历史记录 | 带 commit sha 的 GitHub 永久链接、ADR、`docs/research/`、带日期的交接和审计文档 | 不改：它们记录的是当时的事实 |

## 2. 改成什么

| 现在 | 改成 | 过渡期怎么兼容 |
|---|---|---|
| VerseKit / versekit（产品名） | **Hifabu** | 无 |
| `vk` 命令 | **`hifabu`** | 安装时 `vk` 作为别名保留两个小版本：能用，但每次在 stderr 提示一句「vk 已改名为 hifabu」。之后删除 |
| `vk work push …` 等全部子命令 | `hifabu work push …`，子命令和参数**不变** | 同上 |
| `VERSEKIT_*`、`VK_*` 环境变量 | `HIFABU_*`（如 `HIFABU_HOME`、`HIFABU_PREFIX`、`HIFABU_OFFLINE`） | 新名优先，旧名作后备并提示一次；删除时间跟 `vk` 别名一起 |
| `~/.versekit` | 以后改为 `~/.hifabu`，**这次不改** | 迁移步骤见 §3，留到发布机新安装器上线时做 |
| `~/.config/versekit`、`~/.local/state/versekit` | 以后改为 `~/.config/hifabu`、`~/.local/state/hifabu`，**这次不改** | 同上 |
| `vk.db` | 以后改为 `hifabu.db`，**这次不改** | 同上 |
| launchd `com.versekit.daemon`、systemd user `com.versekit.daemon.service` | launchd `com.hifabu.daemon`、systemd user `com.hifabu.daemon.service` | R5 停止旧进程并保留旧定义，启动新服务并确认 `/api/now` 和 `/today` 都返回 200，再移除旧定义。失败时恢复旧程序和旧服务。 |
| lark-cli profile `versekit` | 以后改为 `hifabu`，**这次不改** | 跟本机路径一起迁 |
| `versekit-relay.service`、`/var/lib/versekit-relay`、`/opt/versekit` | `hifabu-relay.service`、`/var/lib/hifabu-relay`、`/opt/hifabu` | 协调器在部署窗口切换，数据目录 `mv` 后保留旧路径链接一周 |
| 根包 `versekit`、`@versekit-app/*` | `hifabu`、`@hifabu/*` | 包都是私有的、不发 npm，包之间只有 1 处按包名引用，直接改 |
| `.claude/skills/versekit-ingest` | `.claude/skills/hifabu-ingest` | 无 |
| `npm run vk -- …` | `npm run hifabu -- …` | `vk` 脚本保留到别名删除为止 |

**刻意不改的**（写进 `check:brand` 的白名单，见 §4）：
1. **线上协议常量**：`versekit-relay` audience、中转签名串。用户看不见，改了要求三端同时升级，收益是零。以后协议升 v2 时顺带改。
2. **GitHub 地址** `versekit-labs/versekit`（所有者定，这次不改）。
3. **Orca 流程**里的项目名和路径（所有者定，这次不动）。
4. **历史记录**：带 sha 的永久链接、ADR、`docs/research/`、带日期的交接和审计文档。
5. **迁移代码和别名代码本身**：它们必须认识旧名。
6. **本机数据路径和飞书 profile 名**（所有者 11-26 定：先不搬）：白名单写明「暂不迁移，待发布机新安装器」，到时删掉这一条。

### 2.1 和插件小程序同名的问题

插件设计里，制作机上的小程序也叫 `hifabu`（只有 8 条命令）。单机用户两样都装时，Claude Code 把插件的 `bin/` 放在用户 PATH **之后**（官方文档），所以 Bash 里的 `hifabu` 解析到完整版。要求：
- 完整版 `hifabu` 接受插件的调用方式，包括 `--data <目录>` 参数（完整版忽略它，用自己的数据目录），8 条命令输出逐字相同（`group.list` 完整版读本机库、插件版读中转快照，输出格式要一致）。插件设计 §A.2 的 parity 测试已经覆盖这一点，第 R3 单再加一条「完整版接受 `--data`」。

## 3. 本机数据迁移（风险最高的一步）

> **定（所有者 11-26）：先不搬。**本机路径这次不改，下面的迁移步骤留到发布机新安装器上线时再用。改名里只有这一步真正有风险，其余都是机械替换。
> - **简化做法**：本机路径（`~/.versekit`、`~/.config/versekit`、`~/.local/state/versekit`、`vk.db`）这次**不改**，只改用户看得见的字、命令、环境变量和服务名。这样不碰真机数据，R5 缩成「只换服务名」的一张小单。代价是：内行在磁盘上还能看到 `versekit` 目录，官网下载页写「数据放在哪」时也会露出旧名。
> - **完整做法**：按下面的步骤迁移。
> - 推荐：先用简化做法把改名落地，等发布机安装器（插件设计 §A.8）上线时，借新安装器顺手做路径迁移。


**触发**：新版本第一次启动（后台服务或任何 `hifabu` 命令），发现 `~/.hifabu` 不存在、`~/.versekit` 存在。

**步骤**（每步写进迁移日志 `~/.hifabu/migrate.log`）：
1. 停掉旧服务 `com.versekit.daemon`，确认进程退出；账号浏览器（Chrome）也全部关掉。
2. 检查三处旧目录在同一个磁盘分区；不在就停下，报告原因，什么都不动。
3. 先对 `vk.db` 做一次 SQLite 在线备份，放到 `~/.local/state/versekit/vk.db.pre-hifabu`。
4. 三处目录各 `rename` 到新路径（同一分区内是原子操作），`vk.db` 改名为 `hifabu.db`。
5. 在旧路径各留一个符号链接指向新路径，保证旧脚本和旧 plist 还能找到。
6. 复制 lark-cli profile `versekit` 为 `hifabu`（不删旧的）。
7. 注册新服务 `com.hifabu.daemon`，卸载旧 plist。
8. 自检：新服务起来了、`hifabu doctor` 通过、账号数和作品数与迁移前一致、每个平台账号的登录状态与迁移前一致。

**失败就回滚**：任何一步失败，按日志逆序恢复（链接删掉、目录改回、旧服务重新加载），系统页「最近出的问题」写人话原因，旧版照常运行。

**幂等**：重复运行不出错；迁移到一半断电，下次启动按日志接着做或回滚。

**真机**：先在临时 HOME 里，用所有者真机数据的**副本**跑一遍（不登录任何平台，只比对数量和文件）。通过后，由所有者在**自己那台发布机上**点更新，协调器陪同检查。按真机红线（封号根因是异地 IP），开发机不碰真实平台账号。

## 4. 防回潮：`check:brand` 闸门

- 新增 `scripts/ci/check-brand.mjs`，接进 `npm run check`：在白名单之外，出现 `versekit` / `VerseKit` / `VERSEKIT_` / 独立的 `vk` 命令 / `VK_` 就失败，并打印文件和行号。
- 白名单是一个显式文件 `scripts/ci/brand-allowlist.txt`，每条写明**理由**（协议常量 / 仓库地址 / Orca 流程 / 历史文档 / 迁移代码）。
- 第 R1 单先上「只报告不拦截」，最后一单（R8）再切成「拦截」。这样中间各单合并时不会互相卡住。

## 5. 拆单

先后顺序：R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8。改名的单改动面大、都是机械替换，**一张一张串行做，做完立刻合**，减少和其他单的冲突。R3 要排在插件重新设计的第 2 单（`hifabu` 客户端构建）**之前**，这样制作机小程序生下来就叫 `hifabu`。

改了命令、环境变量、服务、设备的单（R3、R4、R5、R7）都要带 ACC-arch-09 六问。

| # | 单 | 范围 | 可检查的验收点 |
|---|---|---|---|
| R1 | `check:brand` 闸门（报告模式） | `scripts/ci/check-brand.mjs`、白名单 | ① 输出按类别统计的剩余数量；② 白名单每条都有理由；③ 先只报告，不让 CI 失败 |
| R2 | 用户看得见的字 | Web 页面、飞书卡片、中转和投递状态文案、错误信息、官网、`docs/design` 里的现行设计稿和 `.impeccable` 任务书 | ① 本地控制台每页标题和侧栏是「Hifabu」；② 「打开那台电脑上的 Hifabu」；③ 截图核对浅色和深色；④ `npm run design:check` 通过 |
| R3 | 命令 `hifabu` + `vk` 别名 | `packages/cli`、`commands.mjs` 的 `cli.usage`、`package.json` 的 bin 和 scripts、AGENTS.md §5、技能和文档里的命令示例、`install.sh` | ① `hifabu --help` 和旧 `vk --help` 命令集合相同；② `vk` 能用，且 stderr 提示改名；③ 完整版 `hifabu` 接受 `--data`（§2.1）；④ 三端一致测试仍通过 |
| R4 | 环境变量 | 所有 `VERSEKIT_*` → `HIFABU_*`，所有 `VK_*` → `HIFABU_*` | ① 只设旧名时照样生效，并提示一次；② 新旧都设时新名优先；③ 测试改用新名 |
| R5 | 后台服务改名（数据目录不动） | `packages/cli/src/service.mjs`、更新流程 | ① 更新后只保留 `com.hifabu.daemon` LaunchAgent 或 `com.hifabu.daemon.service` systemd user unit。② 更新前后账号数、作品数、平台登录状态一致。③ 更新中途失败时恢复旧服务并记录原因。④ 在临时 HOME 测，发布机真机升级见 P6。 |
| R6 | 内部名字 | 包名、`vk.mjs` 等文件名、`.claude/skills/versekit-ingest`、品牌图标文件名、代码注释 | ① `npm test` 全绿；② `check:brand` 报告里这一类归零 |
| R7 | 服务器 | volc1 / seoul 的 systemd 单元、数据目录、`/opt` 目录、Caddy 片段、`deploy/` 脚本和文档 | ① 切换前后，中转上的投递和 blob 数一致；② 0.1.0 插件和旧版发布机切换后仍能拉取（协议常量没改）；③ 不动同机的其他服务（assurelane 等） |
| R8 | 闸门切成拦截 | `check:brand` | ① 白名单外剩余为 0；② CI 拦截新增的 `versekit` / `vk` |

## 6. 不在这次范围里

- GitHub 组织和仓库改名（所有者定，以后单独迁）。
- Orca 项目名、worktree 路径、协调器脚本里的 `versekit`（所有者定，等产品改名落地后再迁）。
- 线上协议常量（§2 第 1 条）。
