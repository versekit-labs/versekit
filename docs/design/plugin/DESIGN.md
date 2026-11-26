# Hifabu 插件重新设计（2026-11-26，设计师）

输入：[INPUT-2026-11-26.md](INPUT-2026-11-26.md)。状态：**所有者 2026-11-26 已答复全部 7 处**（见「所有者的决定」），可以写口径、拆单。

文中「实测」指本机 Claude Code 2.1.332 在临时 HOME 里跑过；「文档」指 code.claude.com 官方文档，链接在 §B 末尾。没标的是设计判断。

## 一页结论

1. **插件 = 一个技能 + 一个小命令行程序 `hifabu`**。`hifabu` 只有制作机要的 8 条命令（登录、状态、登出、看发布机的账号组、预览、交付、查列表、查单个），由 `commands.mjs` 里标了 `maker` 的条目**构建生成**，和 `vk` 同名同参，CI 校验两边一致。这样 CLI 完整律和三端一致律都守得住，又不用装 VerseKit。没有 hooks、没有 MCP、不注册后台服务。
2. **不写死项目**：约定从插件挪到用户项目里的 `.hifabu/project.json`。第一次用时 Claude 扫目录、猜一份约定，和用户确认后写下；之后这个项目一句话交完。用 git 仓库根定位项目，worktree、改目录名都不影响。
3. **交付接口 v1** 单独成文、带版本号。用 `work.key`（项目 id/期）代替本机路径：同一期再交就是更新。发布机读不了新版本时，制作机**不上传**，直接说清原因。
4. **关掉 Claude 也接着传**：前台命令起一个分离的上传进程，传完自己退出。实测 `claude -p` 退出后它还活着。电脑重启后，下次任何一次 `hifabu` 调用都会接着传。
5. **没有 Node**：Claude Code 原生安装不带 Node（文档）。缺 Node 时，经用户同意后下载锁定版本的官方 Node，用 sha256 校验，只放在插件数据目录里。
6. **一句话安装**：主推终端一行 `claude plugin install hifabu --marketplace https://hifabu.com/plugin/marketplace.json`（实测 7.6 秒）。「写给 AI 助手」那段改成说明：先给用户看命令和它装了什么，用户同意后再执行。
7. **发布机**和插件彻底分开：在 hifabu.com/download 下载锁定版本的安装包，页面显示 sha256；biliup、飞书组件用到才装；安装第一页写明会注册哪个后台服务。

### 所有者的决定（2026-11-26）

| # | 问题 | 决定 |
|---|---|---|
| ① | 形态：小程序还是 MCP | **小程序，不做 MCP**（按推荐；通用做法见 §A.2.2） |
| ② | 账号组 | **制作机必须知道账号组**，「不然用户体验很差」。改成：发布机把自己的账号组报上来，制作机能列出、能选、能记住（§A.4.5）。新增一条制作机命令 `group.list` |
| ③ | 开会话自动续传（hook） | **先不要** |
| ④ | 约定文件放哪 | **放项目里**（`.hifabu/project.json`） |
| ⑤ | 自动更新 | **默认打开**（§B.5） |
| ⑥ | 两种安装方式哪个放第一 | **在 Claude Code 里说一句放第一**，「对用户更友好」（§B.6） |
| ⑦ | 提交官方插件目录 | **稳定后再说** |

---

## 0. 任务书

| 问题 | 回答 |
|---|---|
| 为谁 | 在 Claude Code 里做视频的人。做完一期，在同一个会话里交出去。项目叫什么、目录怎么摆，每个人都不一样（vibe-video 和 tcm-video 就完全不同，assurelane-videos 又是另一种）。 |
| 解决什么 | 在**任意项目**里说「交给发布机」，Claude 就把这一期该交的东西（成片、封面、文案）按交付接口传到中转，由发布机去取。插件只做这一件事。 |
| 成功长什么样 | ① 装插件一句话，10 秒内装好，不装 Node 以外的任何东西，不注册后台服务。② 第一次在一个新项目里交，最多问 2 个问题（「是这几个文件吗」「文案用这段吗」），之后同一个项目一句话交完不再问。③ 说完 1 秒内拿到投递号，会话不被占住；关掉 Claude，上传还在继续。④ 内行打开插件包，30 秒内看明白它会碰什么：一个技能、一个命令行小程序、零 hooks、零 MCP、零后台服务。 |
| 明确不做 | 不装、不引导装发布机（VerseKit 全套、biliup、lark-cli、后台服务）。不发布，也不在制作机上排期。不碰平台账号。不写死任何项目名、目录名、文件名。插件里不带任何个人数据。不做 MCP（理由见 §A.2）。 |
| 数据从哪来 | 用户项目里的文件；项目根目录下的 `.hifabu/project.json`（第一次交时和用户一起定）；hifabu.com 账号（设备登录）；中转的投递状态和发布机回报。 |

**所有者定下、本设计不动的三条**：插件只给制作机上的 Claude 用；发布机在 hifabu.com 单独下载，插件不碰；不写死项目、一句话装好、发布前必须人确认、对外只叫 Hifabu。

### 0.1 两个产品，一条接口

```
制作机（任意电脑，装了 Claude Code）          hifabu.com                     发布机（官网下载的 Hifabu）
┌──────────────────────────────┐        ┌──────────────────┐        ┌──────────────────────────┐
│ Claude Code                   │        │ 账号 / 设备登录   │        │ Hifabu 程序 + 后台服务     │
│  └ Hifabu 插件                 │ HTTPS  │ 中转（按账号分）   │ HTTPS  │  每 5 分钟取一次            │
│     ├ 技能 handoff            │───────▶│  blob 按 sha256    │◀───────│  校验 → 入库 → 待确认      │
│     └ hifabu 小程序（单文件）  │ 交付   │  投递 + 状态       │ 回报   │  人在「今天」页/飞书确认    │
└──────────────────────────────┘ 接口v1 └──────────────────┘        └──────────────────────────┘
```

两边**只通过交付接口 v1**（§A.4）和账号相连。插件版本和发布机版本各自升级，靠接口版本号保证兼容。

---

## A. 研发架构

### A.1 制作机这一侧最少要什么能力

| 能力 | 对应现有命令（`packages/core/src/commands.mjs`） | 说明 |
|---|---|---|
| 登录 / 状态 / 登出 | `cloud.login` `cloud.status` `cloud.logout` | 设备登录流程已在 hifabu.com 上线（`/api/devices/link`、`/poll`、`/refresh`），机器令牌 1 小时有效，靠刷新凭据续。 |
| 预览 | `work.push --dry-run` | 校验清单、算大小、估时间、文案超限，一个字节不传。 |
| 交付（登记 + 后台上传） | `work.push` | 登记后立刻返回投递号；上传按 sha256 分块续传（中转已有 `PUT /v1/blobs/:sha?offset=`）。 |
| 查进度 | `delivery.list` `delivery.show` | 读中转 `GET /v1/deliveries?view=maker` 与 `/:id`。 |
| 看发布机的账号组（新增） | `group.list`（制作机版本：读中转上发布机报的快照，不读本地库） | 所有者 11-26 定：制作机必须知道账号组。见 §A.4.5。 |

**就这 8 条。**不需要 SQLite、不需要平台适配器、不需要账号组管理、不需要本地 Web。现在这些能力只长在 `vk` 里，而 `vk` 绑着整个发布机——这是 0.1.0 必须先装 VerseKit 全套的根因。

还缺三条服务端能力，本设计新增（见 §D 第 1、2 单）：
- 发布机每次来取时上报账号组快照，中转按账号存最新一份（§A.4.5）。
- `device.revoke.self`：设备用自己的凭据注销自己（现在 `device.revoke` 要网页会话，登出时无法在服务端作废）。
- 中转 `ping` 回报支持的交付接口版本（§A.4.4）。

### A.2 用什么实现：四个方案

| | ① 插件自带小客户端（推荐） | ② 插件带 MCP server | ③ Claude 直接调 HTTP | ④ 原生二进制（Go 等） |
|---|---|---|---|---|
| 形态 | `bin/hifabu` 启动脚本 + `lib/hifabu.mjs` 单文件，由 `commands.mjs` 里标了 `maker` 的 8 条命令**构建生成** | stdio MCP 进程，8 个工具，同样由命令表派生 | 技能里写 curl 步骤，Claude 自己拼请求 | 另写一个跨平台二进制 |
| 守 CLI 完整律 | ✅ 这 8 条在 `vk` 里照旧存在；`hifabu` 是命令表的又一个投影，和 HTTP、卡片同级 | ✅ 同左 | ❌ 能力只存在于提示词里 | ⚠️ 要另做代码生成才能和命令表对齐 |
| 守三端一致律 | ✅ 加一条 parity 测试：`hifabu` 的命令集合 = 命令表里 `roles` 含 `maker` 的集合 | ✅ 同左 | ❌ | ⚠️ |
| 关掉 Claude 后上传继续 | ✅ 分离子进程（§A.5） | ❌ MCP 进程随会话结束；要继续还得再起一个独立进程，等于又做一遍 ① | ❌ | ✅ |
| 断点续传、sha256 | ✅ 直接复用 `packages/relay/src/client.mjs` | ✅ 复用 | ❌ Claude 拼不可靠，令牌会出现在命令行和会话记录里 | ✅ 重写 |
| 需要 Node | 要（≥ 22.13）——见 §A.3 | 要 | 不要 | 不要 |
| 上下文成本 | 一个技能：常驻约 30 token（实测 0.1.0：`claude plugin details` 报常驻 ~27 tok，触发时 ~880） | MCP 工具定义常驻每个会话（7 个工具的 schema） | 技能变长 | 同 ① |
| 每次调用的权限确认 | `allowed-tools` 预先放行 `Bash(hifabu *)`，不再逐条弹 | 每个工具第一次用要批准一次 | 每条 curl 都弹 | 同 ① |
| 内行审计 | 一个可读的 .mjs，源码在公开仓库同一个 tag | 同左，多一层协议 | 读提示词 | 二进制，要信任构建 |
| 代价 | 要把 `work.push` 的校验从 `store` 里抽成不碰库的纯函数；要写构建脚本 | ① 的全部 + MCP 封装 + 进程生命周期 | 最省事，但不安全、不可靠 | 两套语言、两套测试 |

**推荐 ①。**MCP 留给 SaaS（ADR-0005 §9 的「plugin 带本机 MCP」那条线），到时候由同一张命令表多派生一个投影即可，不推翻 ①。③ 直接否掉：令牌出现在 Bash 命令里会被写进会话记录，断点续传让 Claude 拼也不可靠。

> **定（所有者 11-26）：①，小客户端，不做 MCP。**所有者 11-24 选过「方案 A：技能调用 `vk`」，① 是它的延续：仍是技能调用一个命令行程序，只是程序从「VerseKit 全套」缩成「只有制作机那 8 条」。

#### A.2.1 MCP 的优劣（所有者 11-26 要求说明）

**MCP 好在哪**
- **结构化**：工具有参数表，Claude 填参数，不用拼命令行，引号、路径、中文文件名这类出错的机会少。
- **能给别的客户端用**：同一个 MCP 服务，Claude Desktop、Cursor 等支持 MCP 的工具也能接。小程序方案只服务 Claude Code。
- **和以后的 SaaS 形状一致**：ADR-0005 §9 设想的是「插件带本机 MCP」。
- **权限按工具批**：每个工具第一次用时批一次，比 Bash 命令更好懂。

**MCP 差在哪**
- **扛不住「关掉 Claude 接着传」**：MCP 进程跟着会话走，会话一关它就停。要后台续传，还得另起一个独立的上传进程，也就是小程序方案里那部分一样要做。MCP 是**多加一层**，不是替代。
- **每个会话都会启动**：文档写明，插件一启用，MCP 服务就自动启动。用户在任何项目里开 Claude，它都会起一个 Node 进程，哪怕这一次根本不交东西。小程序只在调用时运行。
- **安全形象**：文档（security）把 MCP 进程和 hooks 归在一类：在沙箱外运行，不受权限规则约束。0.1.0 被评审夸的正是「没有 hooks、没有 MCP」。
- **同样要 Node**：用户没有 Node 时，两个方案都要下载运行时，MCP 没有省掉这一步。
- **调试和排查更难**：出了问题，小程序可以让 Claude 或用户直接在终端跑一遍看输出；MCP 要看客户端日志。

**结论**：现在只有 Claude Code 这一个客户端，「关掉 Claude 接着传」又是硬要求，所以小程序方案**少一层、风险更小**。将来要支持 Claude Desktop 或别的客户端时，再从同一张命令表派生一个 MCP 外壳：工具直接调小程序，上传仍交给小程序起的后台进程。不用推翻任何东西。

#### A.2.2 现在的通用做法（2026-11-26 查）

- **Anthropic 官方**（claude.com/docs/connectors/building/what-to-build）：「If you already have a public API or CLI that Claude can use directly, the plugin can leave the connector out.」插件里的技能教 Claude 去用这个 API 或命令行。需要 Claude「read from or act in your product or data」时才加 MCP 连接器。本机 MCP 只在 Claude Code 和桌面版的 Cowork 里能跑，聊天里不行，所以「most plugins reference remote servers」。
- **社区经验**：本机工具多用「技能 + 命令行」：技能只常驻几十 token，命令行不调用时零成本。需要团队分发、托管登录（OAuth、令牌刷新），或者要在所有 Claude 客户端上都能用时，才上 MCP。Arize 做过一次评测：最难的一档任务里，MCP 的成本是技能 + 命令行的 6 倍多，耗时是 5 倍。这是单次评测，只作参考。
- **对 Hifabu 的含义**：交付要读本机文件、起本机上传进程，正好是「技能 + 命令行」的典型场景，和本设计一致。将来可选的一步是在 **hifabu.com 上做一个远程 MCP**，只做「查投递、看账号组」这类不碰本机文件的事。这样在 claude.ai 网页版、手机上也能问「到了吗」。这件事不进这次拆单。

#### 「从 commands.mjs 派生」具体是什么

```js
// commands.mjs 里给这 8 条加一个字段
{ name: "work.push", roles: ["maker"], ... }
```

- `scripts/build-maker-client.mjs`：用 esbuild 一类的打包器（只在构建时用，不进运行时依赖）把「命令表里 `roles` 含 `maker` 的条目 + 它们的 handler + relay 客户端 + 设备登录客户端」打成一个 ESM 文件 `plugins/hifabu/lib/hifabu.mjs`，文件头写源码 tag 和 sha256。
- 命令名、参数、`--json` 输出与 `vk` **逐字相同**：`hifabu work push <清单> --dry-run --json` ≡ `vk work push ...`。技能里只写 `hifabu`。
- CI 加两条：parity（`hifabu --help` 列出的命令 = 命令表 maker 子集）；可复现（重跑构建，产物 sha256 不变）。
- handler 要能在没有 SQLite 的地方跑：`work.push` 现在调 `store.checkWorkPlan`、`store.COPY_LIMITS`、`store.copyViolations`，要抽到 `packages/core/src/plan-rules.mjs`（纯函数，`vk` 和 `hifabu` 共用）。上传队列和失败记录从 `store.patchRelayState` 改成一个小接口，`vk` 用库实现，`hifabu` 用数据目录里的 JSON 文件实现（§A.5）。

### A.3 用户没有 Node 怎么办

文档（setup）：原生安装器**不需要** Node，系统要求里只有操作系统、内存和 Shell；只有 npm 安装方式才要 Node 22+。所以要假设用户没有 Node。客户端是 .mjs，需要 Node ≥ 22.13。

| 选项 | 做法 | 代价 |
|---|---|---|
| a. 系统 Node，没有就下载官方 Node（推荐） | `bin/hifabu` 先找 `node`（≥ 22.13）；没有时 `hifabu` 不运行，技能告诉用户「需要 Node.js 运行时（约 45MB，官方版本，只放在插件的数据目录里，不改系统、不进 PATH）」，**同意后**执行 `hifabu-runtime install`：从 nodejs.org 下载锁定版本，用插件里写死的 sha256 校验，解压到数据目录。 | 首次多一步、多 45MB。nodejs.org 在国内可能慢，可以在 hifabu.com 镜像同一个文件，sha256 不变。 |
| b. 每个平台预编译单文件可执行（Node SEA / bun compile） | 构建出 darwin-arm64、darwin-x64、linux-x64、win-x64 四个可执行文件放 hifabu.com，首次按平台下载并校验 | 每个 50–90MB；要我们自己构建、以后还要签名；构建链变长 |
| c. 只支持有 Node 的人 | 找不到就让用户自己装 | 违背「一句话装好」 |

推荐 a：下载的是 Node 官方发行包，内行一看就懂，sha256 可以和 nodejs.org 的 SHASUMS256 对上。插件包本身仍然只有文本文件。

### A.4 交付接口 v1

这是插件和发布机之间唯一的约定，单独成文：`docs/delivery-interface.md`，配 JSON Schema `schemas/delivery-v1.json`，hifabu.com 上同步一份 `https://hifabu.com/schema/delivery-v1.json`。

#### A.4.1 清单

```json
{
  "schema": "hifabu.delivery/1",
  "work": {
    "key": "p_7Q3M9X2K/17",
    "title": "AI 算法简史",
    "language": "zh"
  },
  "cuts": [
    {
      "video": { "name": "17_AI算法简史_v3.mp4", "sha256": "…", "size": 104857600 },
      "cover": { "name": "17_AI算法简史_封面.png", "sha256": "…", "size": 812345 },
      "copy": {
        "default": { "title": "…", "body": "…", "tags": ["AI", "算法"] },
        "xiaohongshu": { "title": "…" }
      }
    }
  ],
  "target": { "group": "南竹" },
  "from": { "client": "hifabu-plugin/0.2.0", "device": "01J…" }
}
```

- 和现有 `work.add` / `work.push` 的 `cuts` 结构一致（字段改名只在接口层做映射：`video` ↔ `versions[].asset`），发布机入库逻辑不重写。
- `copy.default` 是通用文案，平台键只写和通用不同的字段。平台键取发布机认识的名字（`xiaohongshu`、`douyin`、`bilibili`、`shipinhao`、`youtube`、`tiktok`）。
- 不放任何本机路径。现在的 `source` 是制作机上的路径（`/Users/.../vibe-video/成片/...`），换电脑、换 worktree、改目录名都会变，所以换成 `work.key`。

#### A.4.2 文件身份

- 文件 = sha256 + size。中转按 sha256 存一份，重复内容不重传（已有）。
- `name` 只用来显示和猜扩展名，不参与身份。

#### A.4.3 同一期再交 = 更新

- `work.key` = `<项目 id>/<期标识>`。项目 id 第一次配置时随机生成，写进项目里的 `.hifabu/project.json`（§A.6），跟着项目走：改目录名、开 worktree、换电脑 clone，都不变。期标识由项目约定给出（编号、slug，或用户确认的名字）。
- 发布机按 `work.key` 找作品：有就更新成片、封面、文案；还没发出去的平台稿按新内容更新；已发出的不动，并在回报里写明（沿用 ACC-deliver-01，只是把 `source` 换成 `work.key`）。
- 旧投递（0.1.0，`source` 是路径）照旧按路径匹配，不迁移。

#### A.4.4 版本兼容

- `schema` 只有主版本：`hifabu.delivery/1`。只做**加字段**的改动不升主版本，读的一方忽略不认识的字段。
- 中转 `ping` 回报发布机最近一次声明能读的版本（发布机每次来取时带上 `accepts: ["hifabu.delivery/1"]`）。客户端上传前先比对：发布机不认识时**不上传**，直接说「发布机上的 Hifabu 版本太旧，先在那台电脑上更新」。
- 发布机遇到不认识的主版本：不入库，回报 `failed`，`errorCode: schema_unsupported`，原因和下一步回到制作机。

#### A.4.5 账号组：制作机看得到、能选、记得住

所有者 11-26 定：制作机必须知道账号组，不然用户体验很差。0.1.0 的问题是制作机**只能盲填**组名，填错了要等文件传完、发布机入库时才报「没有这个组」。

**发布机上报快照**：发布机每次来取（每 5 分钟）时，顺带把账号组快照报给中转，中转按账号存最新一份：

```json
{
  "device": { "id": "01J…", "name": "客厅的 Mac mini" },
  "reportedAt": 1795680000000,
  "groups": [
    { "name": "南竹", "default": true,
      "accounts": [ { "platform": "xiaohongshu", "name": "南竹笔记" }, { "platform": "douyin", "name": "南竹笔记" }, { "platform": "bilibili", "name": "南竹" } ] },
    { "name": "中医", "accounts": [ { "platform": "xiaohongshu", "name": "中医小课" }, { "platform": "shipinhao", "name": "中医小课" } ] }
  ]
}
```

- 只有组名、平台、账号显示名，**没有**凭据、cookie、账号 id。隐私政策要补一句「发布机会把账号组名和账号显示名同步到你的 Hifabu 账号，用于在 Claude 里选择交到哪个组」。
- 制作机 `hifabu group list --json` 读这份快照，带上 `reportedAt`。

**制作机怎么用**：
1. **第一次在一个项目里交**：只有一个组就直接用，并说一句「交到南竹组（小红书、抖音、B 站）」。有多个组时问一次，问题里带上每个组有哪些平台，例如「交到哪个组？南竹（小红书、抖音、B 站）／中医（小红书、视频号）」。
2. **记住**：选择存在插件数据目录里，按项目 id 存（`<数据目录>/projects/<项目id>.json`）。不写进 `.hifabu/project.json`，因为那份会随项目提交，协作者可能交到不同的组。之后同一项目不再问，每次交完的那句话里带上组名。
3. **临时换组**：用户说「这期交到中医组」，只这一次用中医组，不改记住的选择。用户说「以后都交到中医组」，才更新记住的选择。
4. **预览更准**：`work.push --dry-run` 只按这个组里有的平台检查文案限制，不再按全部平台报一堆用不上的拒绝。
5. **上传前就拦住**：组不在快照里时不上传，直接说「发布机上没有『南竹』组，现在有：中医」。

**边界情况**：
- 发布机从没报过（离线，或者是旧版本）：用记住的组名照常交，并说明「发布机还没同步账号组，没法确认这个组在不在」。
- 快照超过 24 小时：照常用，回复里带上「账号组是 X 小时前同步的」。
- 一个账号下有多台发布机：按机器分开列出；清单的 `target` 里加 `device`，只让那台机器来取。第一版可以只支持一台，多台时提示「先在 Hifabu 里只保留一台发布机」。

清单里 `target.group` 因此是**必填**（上面例子里的 `null` 改成组名）。

#### A.4.6 发布机怎么拿到

不变：发布机后台服务每 5 分钟从中转取一次（同一账号的发布机才取得到），下载、核对 sha256、按清单入库，平台稿一律「等你确认」，再回报中转。

### A.5 上传不占着会话，关掉 Claude 也继续（不注册系统服务）

```
hifabu work push 清单.json --json
  ├─ 校验 + 算 sha256（前台，大文件 1–2 秒/100MB）
  ├─ 写入队列：<数据目录>/queue/<投递号>.json
  ├─ 若没有上传进程在跑：spawn(detached, stdio 忽略) 起一个 `hifabu _uploader`，写 pid 文件
  └─ 立刻返回 { id, state: "pending" }      ← Claude 这时就能回话
```

- **上传进程**：`detached: true` + `unref()`，脱离 Claude Code 的进程组。
  - 文档（interactive-mode）：Claude Code 退出时会清理**后台任务**（`run_in_background`），连从任务 shell 里 `setsid` 出去的进程也一起停。所以**不能**用后台任务来跑上传，必须由一条**前台**命令起分离子进程、然后立刻返回。
  - 实测（2026-11-26，`claude -p` 用 Bash 工具前台执行一个起分离子进程的命令）：`claude -p` 退出 5 秒后子进程仍在写心跳。文档没有承诺这一点，所以第 3 单的验收必须包含「交互式会话里交付后直接退出 Claude Code、关终端窗口，上传照样完成」的真机测试；万一以后版本会连带清理，退路是待定 3 的 hook 方案或发布机式的用户级 launchd。它按队列逐个上传（复用 `pushBlob` 的续传和重试），每 2 秒把进度写回队列文件，队列空了就**自己退出**。不常驻，不注册 launchd/systemd。
- **单例**：用 `<数据目录>/uploader.lock`（`O_EXCL` 建文件 + pid + 心跳时间）。pid 不在或心跳超过 60 秒视为死掉，下一次启动接管。
- **防睡眠**（macOS）：上传期间用 `caffeinate -i -w <上传进程 pid>` 防止空闲睡眠，传完自动解除。Linux 不做。
- **重启电脑以后**：上传进程没了，但队列文件还在。**任何一次**调用 `hifabu`（问「到了吗」、交下一期、`hifabu status`）都会先检查队列，有没传完的就把上传进程拉起来。所以「关电脑 → 开电脑 → 问一句到了吗」就会接着传。
- **不加 SessionStart hook 自动续传**：hook 会在用户的**每一个**会话、每一个项目里自动运行，这正是评审夸 0.1.0「没有 hooks」的地方。代价是：重启后如果用户一直不提 Hifabu，就不会续传。

> **定（所有者 11-26）：先不要 hook。**以后如果发现重启后常常忘了续传，再考虑加一个只做「队列非空就拉起上传进程」的 SessionStart hook。

- **状态从哪来**：`delivery.show` 先看本地队列（正在传：已传多少、还要多久），传完以后看中转（等发布机来取、发布机在下载、等你确认、没交成）。这一段沿用 ACC-deliver-04。

### A.6 项目约定：放在项目里，不放在插件里

0.1.0 的根因：约定文件在插件里、按目录 basename 选。改成：

- **位置**：`<项目根>/.hifabu/project.json`。项目根 = git 仓库根（`git rev-parse --show-toplevel`），不是 git 仓库就用 Claude 的工作目录。随项目提交，所以 worktree、换电脑、多人协作都一样。
- **内容**：只有「在哪找、怎么认」，不含个人账号和令牌。

```json
{
  "id": "p_7Q3M9X2K",
  "name": "vibe-video",
  "language": "zh",
  "episodes": {
    "video": "成片/{episode}_{topic}*.mp4",
    "pick": "highest-version",
    "cover": ["成片/封面/{episode}_{topic}_封面.png"],
    "copy": { "file": "成片/文案/发布文案.md", "section": "## {episode} {topic}" },
    "notCopy": ["成片/文案/*_文案.txt"]
  },
  "notes": "17 期的「革命练习曲版」用原版文案"
}
```

- **第一次用**：没有这个文件时，`hifabu scan <项目根> --json` 列出项目里的视频、图片、文案类文件（按扩展名和修改时间，不读内容，跳过 `node_modules`、`.git` 等），Claude 据此**猜一份**约定，用两三句话给用户看（「成片在 `成片/`，按 `_v2/_v3` 取最新；封面在 `成片/封面/`；文案取 `发布文案.md` 里对应的一节。对吗？」），用户确认后写入。之后同一项目不再问。
- **没有规律的项目**（只有一两个视频）：不强行写模板，`episodes` 留空，每次由 Claude 列候选、用户点名。
- **期标识**：有 `{episode}` 就用编号；没有就用用户确认的名字，写进 `.hifabu/project.json` 的 `works` 映射，保证下次同一期 key 不变。
- 个人化的特例（0.1.0 里的 `"17_AI算法简史": "革命练习曲版"`）写在项目自己的约定里（`notes`），不再进插件包。

> **定（所有者 11-26）：放项目里。**项目内 `.hifabu/project.json`（会随项目提交）。备选：放插件数据目录、按 git 远端地址索引（不污染项目，但 worktree 和换电脑时要重新确认，也不能和协作者共享）。

### A.7 凭据放在哪，怎么登出

- **数据目录**：`${CLAUDE_PLUGIN_DATA}`。文档（plugins-reference）：路径是 `~/.claude/plugins/data/<id>/`，第一次引用时创建，**跨升级保留**，从最后一个 scope 卸载时**删除**（`--keep-data` 可保留）。这个变量**不在 Bash 工具的环境里**，只在技能正文里被替换成实际路径，所以技能每次调用都显式传：`hifabu --data "${CLAUDE_PLUGIN_DATA}" …`（仍以 `hifabu` 开头，`allowed-tools` 能匹配）。上传进程启动时继承这个参数。里面：`device.json`（设备 id、机器名）、`queue/`、`uploader.lock`、`runtime/`（§A.3 下载的 Node）。
- **刷新凭据**（长期有效的那一个）：macOS 放钥匙串（`security add-generic-password -s hifabu -a <设备id>`）；Linux 有 `secret-tool` 就放 Secret Service；都没有时放 `device.json`，权限 600，并在 `hifabu cloud status` 里说明存在哪。机器令牌（1 小时）只在内存里。
- **登出**：`hifabu cloud logout` 先调 `device.revoke.self` 让服务端作废这台设备，再删本地凭据；断网时先删本地，下次联网补作废，并提示「也可以在『我的 Hifabu』里把这台机器移除」。
- **卸载插件**：数据目录随卸载删除（文档），没传完的队列也一起没了；凭据在钥匙串里会残留。所以技能和 README 都写明：卸载前先说「退出 Hifabu」，或卸载后到「我的 Hifabu」移除这台机器。

### A.8 发布机下载页和安装器（hifabu.com/download）

插件**不提**怎么装发布机，只在「发布机没来取」时说一句「在那台电脑上打开 Hifabu」，并给官网链接。

| 项 | 设计 |
|---|---|
| 入口 | `hifabu.com/download`（「我的 Hifabu」里也有）。按系统给安装包：macOS `.pkg`（先做），Windows 以后。界面上不出现命令行（发布机这一侧的红线）。 |
| 锁定版本 | 每个版本一个固定地址 `hifabu.com/download/<版本>/Hifabu-<版本>.pkg`，同目录 `SHA256SUMS`。页面显示版本号、发布日期、sha256、源码 tag 链接。不再有 `curl …/main/install.sh`。 |
| 校验 | 安装器自己下载的组件（私有 Node、可选组件）全部按安装包里写死的 sha256 校验，不符就停，说明是哪个文件。 |
| 可选组件按需装 | 核心：Hifabu 程序 + 私有 Node。**B 站上传工具（biliup）**：第一次添加 B 站账号时才装。**飞书组件（lark-cli）**：第一次在系统页接飞书时才装。都在发布机的界面里点按钮完成，并说清装什么、多大。 |
| 写清后台服务 | 安装第一页就列出：会注册 1 个后台服务 `com.hifabu.publisher`（开机自启，负责每 5 分钟取一次作品、到点发布），数据放在哪个目录，怎么卸载（系统页一个按钮，或安装包附带的卸载脚本）。 |
| 签名 | 测试期不签名（11-22 定），页面上写明「测试版未签名，首次打开要在『系统设置 → 隐私与安全性』里点『仍要打开』」，配截图。正式版再做 Developer ID 签名和公证。 |

> 发布机安装器是一张独立的大单，和插件可以并行，本设计只定原则，细节另出任务书。

---

## B. Claude Code 插件开发

以下 Claude Code 插件机制都以官方文档（2026-11-26 抓取）为准，加上本机 2.1.332 在临时 HOME 里实测。来源见 §B.9。

### B.1 插件里放什么

| 组件 | 放不放 | 理由 |
|---|---|---|
| **skills** | ✅ 一个：`handoff` | 只有名字加描述常驻上下文，正文用到时才加载（文档 skills）。0.1.0 实测常驻约 27 token。 |
| **commands** | ❌ | 文档：commands 是旧格式，已并入 skills。`/hifabu:handoff` 由技能自己提供。 |
| **bin/** | ✅ `bin/hifabu`（启动脚本） | 文档：插件启用时 `bin/` 加进 Bash 工具的 PATH，排在用户 PATH 之后，不能顶替 `git` 这类命令。有了它，技能里写 `hifabu …`，`allowed-tools` 能写成 `Bash(hifabu *)`。**代价**：文档的平台支持表写明，带顶层 `bin/` 的插件在 claude.ai 网页版和 Cowork 上**装不了**。本插件要读本机文件、起本机上传进程，本来就只给 Claude Code 用，这个代价可以接受，在 README 写明。 |
| **lib/** | ✅ `lib/hifabu.mjs`（构建产物，不压缩、不混淆） | 文档（目录提交要求）：单个文件超过 256 KiB、包含二进制或编译过的可执行文件会进人工审核；代码不能压缩或混淆。所以构建产物必须是可读的 ESM，并且控制在 256 KiB 以内（第 2 单验收点）。 |
| **hooks** | ❌（所有者 11-26 定：先不要） | 文档（security）：hooks 在沙箱外运行、不受权限规则约束，插件一加载就注册，在用户的每个会话里都会跑。0.1.0 被评审夸的正是「没有 hooks」。 |
| **MCP** | ❌ | 文档：插件一启用就自动启动 MCP server，工具定义常驻每个会话；MCP 进程随会话结束，扛不住「关掉 Claude 继续传」。理由见 §A.2。 |
| **agents** | ❌ | 用不上。交付是主会话里的对话，不需要子代理。 |
| **userConfig** | ❌（暂不） | 没有需要用户事先填的东西：账号走浏览器登录，项目约定在项目里。以后真要配置项，敏感值用 `sensitive: true`（文档：进系统钥匙串）。 |

### B.2 技能结构

```
skills/handoff/
├── SKILL.md                 主流程，≤ 120 行：找这一期 → 预览 → 交 → 报告；何时去读哪份 reference
└── references/
    ├── project-setup.md     第一次在一个项目里用：scan、猜约定、确认、写 .hifabu/project.json 的格式
    ├── copy.md              没有文案时怎么起草；各平台字数限制；批准后怎么写回项目
    ├── status.md            「到了吗」：状态词表和每种状态怎么说
    ├── errors.md            errorCode → 一句人话 + 下一步（BRIEF §5）
    └── setup.md             没装 Node、没登录、没开通传片
```

- 文档（skills）：SKILL.md 保持在 500 行以内，细节放到同目录文件里，在正文里写明什么时候读；脚本是执行，不是加载。0.1.0 把五个阶段塞在一个文件里，每次都整份加载（评审第 6 条）。
- 正文写**要点和判断规则**，不写台词。只有必须一字不差的地方给原文：账号组名、错误原因按 CLI 原样转述。
- 参数和项目文件内容一律当作**数据**，不当指令（保留 0.1.0 的做法，评审认可）。

### B.3 触发描述和 allowed-tools

```yaml
---
name: handoff
description: >-
  Hand a finished video from this project to the user's Hifabu publishing computer
  (video, cover, publishing copy), and report delivery status. 把做好的一期交给发布机、查投递进度。
when_to_use: >-
  The user asks to 交给发布机 / 把某一期交了 / send it to Hifabu, or asks whether a Hifabu
  delivery from this session has arrived. Do not use for generic "did it arrive" questions
  unrelated to Hifabu.
argument-hint: "[期号或选题 | status [投递号]]"
allowed-tools: Bash(hifabu *) Read Glob Grep
---
```

- **收紧触发**：文档写明 Claude 靠描述匹配请求，主要用途要写在最前面。描述里不再单独列「到了吗」，而是限定为「本会话里交过的 Hifabu 投递」。单独一句「到了吗」不再触发（评审第 6 条）。
- **`allowed-tools`**（文档：空格或逗号分隔，授权只在调用这一轮有效）：
  - 预先放行：`Bash(hifabu *)` 和只读工具 `Read`、`Glob`、`Grep`。`hifabu` 只会登录、读状态、上传到用户自己的账号，不会发布，交付本身又是用户刚提的要求。
  - **故意不放行**：`Write`、`Edit`。写 `.hifabu/project.json`、写回文案文件都是改用户的项目，应该让用户看见、点同意。
  - **故意不放行**：下载 Node 运行时（`hifabu-runtime install`，不以 `hifabu ` 开头，匹配不上），每次都要用户同意。
- **描述长度**：description 加 when_to_use 超过 1,536 字符会被截断，所有技能共用上下文 1% 的预算（文档）。上面这段约 450 字符。

### B.4 安装包只放运行要用的

```
hifabu-0.2.0.zip
├── .claude-plugin/plugin.json
├── README.md          做什么、会运行什么、会把什么发到哪里（hifabu.com）、数据和凭据放在哪、怎么卸载
├── CHANGELOG.md
├── LICENSE
├── bin/hifabu         启动脚本：找 Node ≥ 22.13 → 运行 lib/hifabu.mjs；找不到就说明怎么装运行时
├── lib/hifabu.mjs     构建产物，文件头写源码 tag 和 sha256
└── skills/handoff/…   见 §B.2
```

- 打包脚本用**白名单**，不是「整个目录拷过去」。测试、构建脚本、示例项目都放在仓库的 `plugins/hifabu-src/` 或 `test/plugin/` 下，不进包。0.1.0 包里带着跑不起来的测试（评审第 3 条），就是因为整个目录被打进去了。
- 包里不出现：任何项目名、个人目录、邮箱、`.DS_Store`、`..` 路径（文档：这几项会直接挡住目录提交）。

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin.json",
  "name": "hifabu",
  "displayName": "Hifabu",
  "version": "0.2.0",
  "description": "Hand a finished video from Claude Code to your Hifabu publishing computer. Nothing is published until you confirm it there.",
  "author": { "name": "Hifabu", "url": "https://hifabu.com" },
  "homepage": "https://hifabu.com/plugin/",
  "repository": "https://github.com/versekit-labs/versekit",
  "license": "MIT",
  "keywords": ["video", "publishing", "handoff"],
  "engines": { "claude-code": ">=2.1.292" },
  "network": { "hosts": ["hifabu.com"] },
  "documentationUrl": "https://hifabu.com/plugin/",
  "supportUrl": "mailto:creator.omnikit@gmail.com",
  "privacyPolicyUrl": "https://hifabu.com/privacy/",
  "termsOfServiceUrl": "https://hifabu.com/terms/"
}
```

- `repository`：仓库现在是公开的（`gh repo view` 实测 PUBLIC），评审第 4 条「没有可审计的源码」可以直接解决。README 里给出这个版本对应的 tag 和 `lib/hifabu.mjs` 的构建命令，内行可以自己重建、比对 sha256。
- `network.hosts`：文档写明只做展示、不拦截，但它让「会连哪里」一目了然。
- `engines`：一步式安装 `claude plugin install … --marketplace …` 要求 2.1.292 以上（文档）。
- `version` 前面的 `$schema` 地址要在实现时核对，核不到就去掉。

### B.5 版本和更新

文档（plugin-marketplaces）：
- `version` 的取值顺序：先看 plugin.json，再看市场条目；都没写时，archive 来源取 zip 的 sha256。
- 写死了 `version`，不改它就收不到更新。
- `claude plugin marketplace update` 只刷新目录，`claude plugin update` 会刷新并在版本变了时装新版。
- 第三方市场默认**不**自动更新。

实测（协调器，0.1.0）：只跑 `claude plugin update` 拿不到新版本，要先 `marketplace update`。和文档的说法不一致，**以实测为准**，页面上继续写两步。

设计：
1. **版本号照旧写死，内容一改就升**（ACC-plugin-dist-01 已有，有测试钉着）。不改成「不写 version、靠 sha256」：写死的版本号对用户和 CHANGELOG 更清楚。
2. **旧 zip 保留，市场清单只指向最新版**（ACC-plugin-dist-05 已有）。
3. **客户端提醒**：`hifabu` 每天最多查一次 `https://hifabu.com/plugin/marketplace.json`，落后时在 JSON 输出里带 `update: {current, latest, command}`。技能在回复末尾提醒一次，不阻断交付。
4. **自动更新：默认打开**（所有者 11-26 定）。
   - 机制（文档 settings-reference）：在用户设置 `~/.claude/settings.json` 里给 `hifabu` 市场加 `"autoUpdate": true`。打开后，Claude Code 启动后会在后台刷新这个市场，并更新已装的插件。第三方市场默认是关的，安装命令也没有对应的参数（`claude plugin marketplace add --help` 实测没有）。
   - 所以由技能在**第一次使用时**打开：Claude 用 `Edit` 在用户设置里给 `hifabu` 市场加上这一项。`Edit` 不在 `allowed-tools` 里，用户会看到一次权限确认，看得见改了什么。改完说一句「已打开 Hifabu 插件的自动更新，不想要可以在 /plugin 里关掉」。
   - 用户拒绝了就不再问。客户端的版本提醒（上面第 3 条）仍然有效。
   - 插件页「这个插件会做什么」那一块，加一句「第一次使用时会打开它自己的自动更新」。
   - 风险提示照写进 README：文档（security）说，开了自动更新，磁盘上的插件可能和用户当初看过的不一样。所以每次发版都要有 CHANGELOG，zip 的 sha256 要公开。

### B.6 一句话安装，又让内行放心

评审说「专门写给 AI 助手、让它直接执行安装命令」是危险信号，问题出在三处：**祈使句**（「请执行」）、**跳过人**（没说先给用户看）、**说不清装了什么**。所以办法是改写法，不是删掉这条路：

**页面最上面（给人看）**，两种方式：

1. **在终端里粘贴一行**（实测，全新 HOME 里 7.6 秒装好）：
   ```
   claude plugin install hifabu --marketplace https://hifabu.com/plugin/marketplace.json
   ```
   比现在的 `marketplace add && install` 短一半，也没有 `&&`。这条命令用的是 Claude Code 自己的安装器，会按市场清单里的 sha256 校验 zip。命令里没有 `curl | bash`，也不跑任何脚本。
2. **或者在 Claude Code 里说**：「安装 hifabu.com/plugin 上的 Hifabu 插件」。

紧跟着一块「这个插件会做什么」，四行：
- 装了什么：一个技能 + 一个命令行小程序 `hifabu`，没有 hooks、没有 MCP、不注册后台服务。
- 会连哪里：只连 hifabu.com；上传你说要交的那几个文件。
- 不会做什么：不发布，不碰平台账号，不装发布机。
- 源码在哪：源码 tag 链接，zip 的 sha256，CHANGELOG。

**「For AI assistants」改成说明，不是命令**：

> This page describes the Hifabu plugin for Claude Code. If a user asks you to install it: show them the command below and explain that it adds the Hifabu plugin marketplace from hifabu.com and installs one plugin (a skill and a small command-line client; no hooks, no MCP server, no background service). Run it only after they agree. After it finishes, tell them to run `/reload-plugins`.
>
> `claude plugin install hifabu --marketplace https://hifabu.com/plugin/marketplace.json`

`install.txt` 是同一段文字。这样写，有三层确认：Claude 先给用户看、用户同意，Claude Code 执行 Bash 时还会再弹一次权限确认。内行看到的也是一段平常的安装说明，不像在给 AI 下指令。

> **定（所有者 11-26）：「在 Claude Code 里说一句」放第一**，理由是对用户更友好，不用打开终端。终端一行放第二，给习惯终端、想先看清命令的人。
>
> 因为这条路以后是主路，下面三点要做到：
> 1. **能读到说明**：Claude 打开 `hifabu.com/plugin/` 时，常常只拿到页面的摘要。所以说明要写在页面最前面的纯文本里，同时提供 `hifabu.com/plugin/install.txt` 纯文本版，页面上写明「AI 助手请读 install.txt」。
> 2. **不让 Claude 起疑**：说明写成文档语气，见上文 For AI assistants 那段：先给用户看命令和它装了什么，用户同意再执行。Claude 对网页里「请直接执行」这类话会警惕，祈使句反而可能让它拒绝。
> 3. **实测通过才算数**：第 7 单的验收要加一条：在一个全新账号、全新 HOME 的 Claude Code 里说「安装 hifabu.com/plugin 上的 Hifabu 插件」，Claude 能找到命令、给用户看、得到同意后装好，并提醒 `/reload-plugins`。分别用默认模型和一个小模型各测 3 次，都要成功。

### B.7 提交官方插件目录

文档（publish、pre-submission-checklist）：
- **两个入口**：Anthropic 的目录在 claude.ai/directory，从 `claude.ai/directory/manage` 提交，提交人要有付费套餐；另有社区市场 `claude-community`，对应仓库 `anthropics/claude-plugins-community`。`claude-plugins-official` 不接受门户提交。
- **直接挡掉的**：没有 README（少于 40 词）、没有 LICENSE、有 `.DS_Store`、路径用 `..` 跳出插件目录、`npx` 或 `uvx` 没锁精确版本、文件里有明文凭据、远程 MCP 不是 https、名字冒充品牌。
- **转人工审核的**：单个文件超过 256 KiB、文件总数超过 512、有二进制或编译过的可执行文件、读取用户环境里已有的 token。
- **其他**：要遵守 Anthropic Software Directory Policy，过安全扫描；README 写明会运行、发送、获取什么；代码不能压缩或混淆。

本设计已经按这些要求收口：白名单打包、可读的单文件构建产物、README 写清网络行为、凭据只在运行时进钥匙串。第 9 单只剩「准备提交材料 + 所有者决定提不提」。

> **定（所有者 11-26）：稳定后再说。**本设计照样按目录要求收口（这些要求本身就是让内行放心的做法），提交与否到时再定。

### B.8 安装范围

- 默认装在 **user** 范围（写进 `~/.claude/settings.json`），因为用户会在多个项目里用。
- 团队或多台电脑同步：文档提供项目 `.claude/settings.json` 的 `extraKnownMarketplaces` 加 `enabledPlugins` 写法，但每个协作者仍要自己装一次，而且要先接受文件夹信任对话框才生效。本设计不主动往用户项目里写 Claude 设置，只在 README 里说明这种写法。

### B.9 文档来源

`https://code.claude.com/docs/en/`：`plugins/manifest-reference`、`plugins/components`、`plugins/marketplace-reference`、`plugins/loading`、`plugins/cli-reference`、`plugins/install`、`plugins/security`、`plugins/publish`、`plugins/measure`、`skills`、`setup`、`interactive-mode`、`hooks`、`tools-reference`；`https://claude.com/docs/plugins/`：`pre-submission-checklist`、`platform-support`。抓取日期 2026-11-26。

---

## C. 用户体验

### C.1 原则

- **素材齐全就直接交，只在猜过的地方停下来问**（所有者 11-24 定，保留）。每次交完都把「交了什么」说清楚：哪个文件、多大、哪段文案。
- **技能里写要点，不写台词**。下面引号里的话是示例，不是让 Claude 逐字念。
- **一次只问一个问题**，问题里带上选项。
- **永远不说**：VerseKit、vk、中转 token、relay、blob。对用户只有：Hifabu、发布机、我的 Hifabu、投递号。

### C.2 对话流程

主流程（同一项目第二次起）：

```
用户：把 17 期交给发布机
Claude：（hifabu cloud status → 已登录、已开通）
        （按 .hifabu/project.json 找到 17 期：v3 成片、封面、发布文案.md 里的一节）
        （hifabu work push --dry-run → 无拒绝）
        （hifabu work push → dl_xxx）
        交了 17 期「AI 算法简史」：17_AI算法简史_v3.mp4（100MB）、封面、发布文案.md 里那一节。
        投递号 dl_xxx，后台在传，大约 15 分钟到发布机。关掉这个会话也会继续传。
        到了以后要在发布机的「今天」页或飞书上确认才会发。
```

| 情况 | 什么时候发现 | Claude 怎么做 | 不做 |
|---|---|---|---|
| **第一次用（这个项目没有约定）** | 找这一期时 | `hifabu scan`，猜约定，一句话给用户看，确认后写 `.hifabu/project.json`，接着交 | 不要求用户改目录或改文件名 |
| **没装 Node** | 第一次调 `hifabu` | 说明要下载官方 Node 运行时、多大、放哪、不改系统；同意后装，接着交 | 不顺手装别的 |
| **没登录** | `cloud status` | 「这台电脑还没登录 Hifabu。我打开浏览器，你核对 6 位码一致后点『允许』」。`hifabu cloud login` 后台等，期间把核对码告诉用户；成功后接着交，不用重说 | 不让人抄令牌 |
| **没开通传片** | `cloud status` 或上传被拒 | 说去「我的 Hifabu」点「申请开通」，人工开通，通常一个工作日。记住这一期，开通后说「交」就接着 | 不反复重试 |
| **还没选过账号组（这个项目第一次交）** | 交之前 | `hifabu group list`：只有一个组就直接用并说出来；多个组时问一次，选项里带上每组的平台；记住，之后不再问 | 不盲填组名 |
| **多个候选文件** | 找这一期时 | 同一期多个版本号：按约定取最新并**告诉**用户取了哪个。版本号以外的变体（如「灵动版」）：每次问，列出文件名让用户选 | 不默默选 |
| **没有封面** | 找这一期时 | 「这期没有封面，平台会用视频首帧」，继续交 | 不因此停下 |
| **没有文案** | 找这一期时 | 按选题起草标题、正文、话题（可参考字幕，但不拿字幕当正文），给用户看，同意后交；交完按约定写回文案文件（写回失败只报告，不重传） | 不拿字幕时间轴当正文；不没看就交 |
| **文案超限** | 预览 | 「小红书标题 24 字，限 20 字」，给一个改短的版本，同意后重新预览 | 不默默截断 |
| **上传中途断网** | 后台 | 上传进程自己重试、续传；用户问起时：「网断了，已传 60MB，网通了会接着传，不用再说一遍」 | 不让人重交；不重复投递 |
| **用户问「到了吗」** | 任意时候 | 先用本会话的投递号；没有就 `delivery list` 按期号、选题匹配，多个对不上时问是哪一个。按状态词表回答（正在传 / 等发布机来取 / 发布机在下载 / 等你确认 / 没交成） | 不在制作机上说「已发布」 |
| **发布机 6 小时没来取** | 查状态时 | 「已到 Hifabu，但发布机 6 小时没来取。打开那台电脑上的 Hifabu 就会自动下载」 | 不改派、不引导装发布机 |
| **发布机版本太旧** | 预览时（§A.4.4） | 「发布机上的 Hifabu 太旧，读不了这次的交付。先在那台电脑上更新」 | 不上传 |
| **记住的账号组在发布机上没了** | 预览时（读快照） | 「发布机上已经没有『南竹』组，现在有：中医。交到中医吗？」 | 不上传后再失败 |

**触发边界**：技能只在用户提到「发布机」「Hifabu」，或在本会话已经交过、接着问进度时生效。单独一句「到了吗」不在别的语境里触发（评审第 6 条）。

### C.3 在哪里确认发布

- 制作机这边**到「等你确认」为止**，没有「发」的动作，也不改排期。
- 确认在**发布机**上做：Hifabu 的「今天」页，或飞书卡片。入库后发布机推一条「新到 1 期：AI 算法简史，3 条等你确认」（ACC-deliver-04 已有）。
- 制作机问「到了吗」时，Claude 把这条也带上：「到了，3 条等你在发布机上确认：小红书 11-27 20:00、抖音 11-27 21:00、B 站 11-28 12:00」。

### C.4 对外命名

全项目改名（`vk` → `hifabu`、VerseKit → Hifabu）的范围、迁移和拆单见 [../RENAME-HIFABU.md](../RENAME-HIFABU.md)。

| 用户看到的 | 指什么 | 不再出现 |
|---|---|---|
| **Hifabu** | 整个产品 | VerseKit、versekit、Hi 发布（中文字标里保留「Hi 发布」作为读法） |
| **Hifabu 插件** | Claude Code 里的这个插件 | handoff 插件、vk 插件 |
| **发布机** | 装了 Hifabu 程序、负责发布的那台电脑 | executor、publisher（只在代码里） |
| **制作机** | 只在说明「两台电脑」时用；对话里尽量说「这台电脑」 | maker（只在代码里） |
| **我的 Hifabu** | hifabu.com/account | 账号后台、控制台 |
| **投递号** | `dl_…` | delivery id、任务号 |

命令行小程序叫 `hifabu`。用户基本不会直接敲它，但它会出现在 Claude 的工具调用里，名字和产品一致，避免「我到底装了几样东西」。

---

## D. 拆单建议

先后顺序：**1 → 2 → (3 ∥ 4) → 5 → 6 → 7**；8（发布机安装器）和 1–7 并行。涉及命令、鉴权、文件、设备的单（1、2、3、4、8）都要带 ACC-arch-09（ADR-0005 §13 六问）。

| # | 单 | 改哪里 | 可检查的验收点 |
|---|---|---|---|
| 1 | **交付接口 v1** | `docs/delivery-interface.md`、`schemas/delivery-v1.json`；中转接受新清单并原样存；发布机按 `work.key` 匹配更新；`ping` 回报 `accepts`；发布机来取时声明 `accepts`；发布机来取时上报账号组快照，中转按账号存 | ① schema 文件能校验文中示例；② 同一 `work.key` 连交两次只有一个作品，已发平台稿不动；③ 清单里出现绝对路径就拒收；④ 发布机遇到 `hifabu.delivery/2` 回报 `schema_unsupported`，原因回到制作机；⑤ 0.1.0 的旧清单（`source` 是路径）仍能入库；⑥ 快照里没有凭据、cookie 和账号 id，测试断言字段白名单；⑦ 隐私政策补上账号组同步那一句 |
| 2 | **制作机命令抽离 + `hifabu` 客户端构建** | `commands.mjs` 加 `roles`；校验抽成 `plan-rules.mjs`；`scripts/build-maker-client.mjs`；新增 `device.revoke.self`；`group.list` 的制作机版本读中转快照 | ① `hifabu --help` 的命令集合 = 命令表 maker 子集（CI）；② 同一清单 `vk work push --dry-run --json` 与 `hifabu work push --dry-run --json` 输出相同；③ 构建两次产物 sha256 相同；④ 产物不 import 任何 `node:sqlite`；⑤ `hifabu cloud logout` 后服务端该设备不可再刷新 |
| 3 | **后台上传进程** | `hifabu` 的队列、单例锁、分离子进程、macOS 防睡眠、调用时自动续传 | ① `work push` 1 秒内返回投递号；② 杀掉父进程（模拟关 Claude）后上传继续完成；③ 本地假中转中途断开再恢复，最终 sha256 一致、只有一个投递；④ 杀掉上传进程后，任意一次 `hifabu delivery list` 会把它拉起并续传，不重传已完成的分块；⑤ 队列空后进程退出，`ps` 里没有残留；⑥ 不写任何 launchd / systemd 文件 |
| 4 | **运行时与凭据** | `bin/hifabu` 启动脚本找 Node；`hifabu-runtime install` 下载锁定版本并校验；凭据进钥匙串 / Secret Service / 600 文件 | ① 没有 Node 的临时 HOME 里，同意前不下载任何东西；② 下载文件 sha256 不符时停下并说明；③ 凭据不出现在任何日志、会话输出、命令行参数里（测试抓 `ps` 和输出）；④ 卸载说明写明凭据位置 |
| 5 | **插件 0.2.0 重写** | `plugins/hifabu/`：技能主流程 + `references/`；`allowed-tools`；项目约定 `.hifabu/project.json` 的扫描与确认；README、CHANGELOG、`repository`；打包白名单 | ① `claude plugin validate --strict` 通过；② 包里只有运行要用的文件（白名单测试），没有 `test/`、没有个人数据、没有任何项目名；③ `claude plugin details` 常驻成本 ≤ 60 token；④ 用三个目录结构不同的假项目（仿 vibe-video、tcm-video、只有一个视频的项目）跑离线评测：第一次各问 ≤ 2 个问题，第二次 0 个；⑤ 在 worktree 里、改了目录名后仍能认出同一个项目；⑥ 「到了吗」在没交过东西的普通会话里不触发；⑦ 有两个账号组时第一次问一次、之后不问，说「这期交到中医组」只换这一次；⑧ 第一次使用时用 Edit 打开自动更新，用户拒绝后不再问 |
| 6 | **版本与更新** | 发布脚本、页面、技能里的版本提示 | ① 发布 0.2.1 后，按页面上的更新命令在临时 HOME 里能拿到 0.2.1；② `hifabu` 发现自己落后于 hifabu.com 上的最新版时，在回复末尾提醒一次，不阻断交付 |
| 7 | **插件页与安装说明重写** | `site/plugin/`、`install.txt` | ① 页面写清插件包含什么、不包含什么、源码链接、zip 的 sha256；② 「在 Claude Code 里说一句」放第一，「给 AI 助手」一段改成「先给用户看命令和它做什么，用户同意再执行」，并提供 install.txt（§B.6）；③ 全新环境里说那句话，默认模型和小模型各 3 次都装成功；④ 不出现 VerseKit、curl \| bash |
| 8 | **发布机下载页与安装器** | `hifabu.com/download`、`.pkg`、SHA256SUMS、可选组件按需装 | 另出任务书。验收要点：锁定版本地址、页面显示 sha256、安装第一页列出后台服务、biliup / lark-cli 只在用到时装 |
| 9 | **（可选）提交官方插件目录** | 见 §B.7 | 满足目录要求清单后由所有者决定是否提交 |

0.1.0 的处理：hifabu.com 上先不下架（协调器已定）。0.2.0 发布后，0.1.0 的 zip 保留（旧版本不覆盖），市场清单只列 0.2.0。
