# 顶层蓝图（Blueprint）

**版本** v1.0　**日期** 2026-10-27　**状态** 已定稿，进入实施
**原则**：此文件是 versekit 的**唯一架构权威**。与之前任何文档冲突时，以此为准。修改须走 ADR。

---

## 第一部分：产品目标与定位

### 1.1 一句话

**一个人（或一个 agent）在本地管住自己所有平台的发布与数据；电脑干活，手机拍板。**

### 1.2 用户

- **P1（主力）**：1 人管 3–10 个平台、2–10 个账号的 AI 内容创作者。不在电脑前的时间远多于在电脑前。技术能力中等（能装 docker，不会配 tunnel）。
- **P2**：3–8 人小工作室，需要一个人拍板，其余人看数据。
- **P3**：把 versekit 当 skill/MCP 接入自己 agent 流的开发者。

### 1.3 三个 JTBD（按痛感排序）

| 痛点 | 现状 | versekit |
|---|---|---|
| **发不动** | 一条内容发 6 个平台，逐个改标题/话题/封面，40 分钟 | 一次编排，多平台差异化发布，< 2 分钟 |
| **看不见** | 发完不知道效果，各平台后台分别登录、没法横向比 | 自动回收播放/点赞/收藏，统一看板 |
| **不敢走开** | 登录态天天过期，哪个号多久没发、哪个号掉线全靠脑子记 | 账号健康主动发现，手机上收卡片、点按钮处理 |

### 1.4 差异化：为什么是"本地执行 + 远程控制"

| 象限 | 已有产品 | 缺什么 |
|---|---|---|
| 凭证在云端 + 手机可决策 | Buffer/Hootsuite/Later/Metricool/蚁小二 | 凭证要交出去，不做国内+海外双栈 |
| 凭证在本地 + 无手机控制面 | Mixpost/Postiz 自托管/social-auto-upload | 没有移动端，人不在电脑前就卡住 |
| **凭证在本地 + 手机可决策** | **（空）= versekit** | |

### 1.5 不做

公开内容采集 / 内容生产 / 托管 SaaS / 团队协作 / 评论 Inbox / 逆向签名。

### 1.6 成功指标

- **北极星**：每周成功完成的 publish 数
- **G1**：首次价值 < 30 分钟（安装 → 第一条发布）
- **G2**：一条内容发 5 平台 < 2 分钟（含差异编排）
- **G3**：账号失效永远由系统先发现
- **反指标**：静默失败 = 0

---

## 第二部分：产品架构

### 2.1 三层分离

```
┌────────────────── 界面层 ──────────────────┐
│  CLI vk    本地 Web    飞书卡片    MCP      │
│  agent      人        人         agent     │
└──────────────┬─────────────────────────────┘
               │ 命令总线
┌──────────────▼─────────────────────────────┐
│              内核（单进程常驻）              │
│  命令注册表 · 任务队列 · 状态机 · 事件总线    │
│  SQLite（唯一事实来源）                     │
└──────────────┬─────────────────────────────┘
               │ 适配器接口
┌──────────────▼─────────────────────────────┐
│  适配器层                                    │
│  YouTube · B站 · 抖音 · 小红书 · TikTok     │
│  浏览器自动化 / 官方 API / CLI              │
└─────────────────────────────────────────────┘
```

**铁律**（进 CI 验收）：

1. **CLI 完整律**：关闭 Web 和飞书后，`vk` 能力集合不减少。
2. **三端一致律**：同一命令在三端产生相同的 command_id、幂等键、审计、状态迁移。
3. **零后门律**：Web 与飞书不得直接读写 SQLite / 凭证目录。

### 2.2 命令注册表（唯一真源）

每个命令只定义一次（`core/commands.mjs`），CLI / HTTP / 卡片按钮全部派生。CI 校验三者一致。

```ts
defineCommand({
  name: "publish.retry",
  args: { publishId: "string" },
  permission: "operator",
  idempotent: (a) => `retry:${a.publishId}`,
  ttlMs: 24 * 3600e3,
  cli: { aliases: ["retry"], json: true },
  http: { method: "POST", path: "/api/publishes/:publishId/retry" },
  card: { label: "重试", style: "primary" },
  audit: "always",
});
```

### 2.3 领域模型

| 实体 | 关键点 |
|---|---|
| account | 平台 + 昵称 + 凭证状态机（ok/expiring/expired/banned/manual）+ 凭证存储位置 |
| work | 一条内容（与平台无关的主素材） |
| publish | work × account 一行，携带平台差异字段（标题/话题/封面/定时/可见性） |
| snapshot | (publish, 抓取时间) + 宽松 KV 指标集 + source(api/intercept/csv) + status(ok/partial/failed) |
| followup | 发布后还需要做的事（合集/AI 声明/字幕/可见性），可核实可关闭 |
| run | 任务队列一行：publish/collect/check/reauth，含心跳、重试、失败原因 |
| event | 通知目录落地，dedupe_key 保证幂等 |

### 2.4 发布模式

默认 `auto`，降级链 `auto → draft → notify → manual`：

| 模式 | 语义 | 人的动作 |
|---|---|---|
| auto | 全自动发出去 | 无 |
| draft | 自动上传+填文案，投草稿箱 | 打开 App → 点发布 |
| notify | 上传也做不了，推通知 | 自己传+发 |
| manual | 只提醒不跟踪 | 自行处理 |

**永不静默失败**：每次发布必须终结在 published / published_limited / draft_pending / notify_pending / failed(带原因) 之一。

### 2.5 可见性策略

| visibility | 行为 |
|---|---|
| public | 发布即公开 |
| private | 仅自己可见，不提醒 |
| private_then_public | 先发私密 → 推卡片 → 用户点"放行" → 系统自动改公开并核实 |

### 2.6 后置动作（followup）

处理"平台强制的不完整"：YouTube 未审核 → 强制私享、B站 → 合集要归入。
`publish.state = published_limited` + `followup{kind, verify}` → 系统负责核实。

### 2.7 账号状态机

```
ok → expiring → expired → ok
  → banned → manual → ok
```

信号源三条：定时探测（6h）· 被动信号（发布/采集遇 auth 错）· 到期预测（提前 72h）。

### 2.8 采集模型

- 节奏：发布后 +1h, +6h, +24h, +3d, +7d, 之后每天（上限 30 天）
- 每条快照记录：source(api/intercept/csv) + status(ok/partial/failed) + metrics(KV)
- 三条路径按能力分级，同一张表

### 2.9 事件目录

8 类事件（6 类必推 + 2 类可配）：

| 事件 | 级别 | 卡片按钮 |
|---|---|---|
| account.expiring/expired | 必推 | 重新授权 / 转手动 |
| publish.failed | 必推 | 重试 / 转 notify / 看现场 |
| publish.needs_human | 必推 | 打开 App / 我已发布 |
| publish.needs_followup | 必推 | 我已处理（→ 系统核实） |
| approval.requested | 必推 | 发布 / 打回 |
| collect.degraded | 必推 | 重试 / 转手动 |
| digest.daily | 可配 | 打开看板 |
| system.dead | 必推 | 重启 / 看日志 |

### 2.10 多账号与 lane 隔离

- **单实例 ≠ 单用户**：一台电脑一个 versekit 进程，管所有账号所有平台。
- **lane = account_id**：同账号同时只跑一个任务（发布/采集/登录检查都算）。
- **不同账号之间真并行**，但浏览器池有上限（默认 4）。
- **每账号一个 Chrome profile**：`~/.local/state/versekit/browser/<account_id>/`，CDP 端口按账号分配。

---

## 第三部分：研发架构

### 3.1 技术选型（D1/D2 已定）

| 层 | 选择 | 理由 |
|---|---|---|
| 运行时 | **Node ≥ 22.13**（`node:sqlite` 内置，`.get()` 无命中返回 `undefined`） | 零外部依赖 |
| 浏览器 | **自写 CDP**（不换 Playwright） | 零依赖、小、已在工厂验证 |
| 数据库 | **SQLite WAL** | 单机足够，无需额外服务 |
| 进程模型 | **单守护进程 + CLI 客户端**（unix socket） | 写路径唯一，三端不分叉 |
| Web | 守护进程同端口静态页 + `/api/*` | 免去第二套部署 |
| 浏览器池 | 每账号一个 Chrome profile + 池上限 4 | 矩阵运营不串号 |

### 3.2 仓库结构

```
packages/
  core/              schema.sql · db · 状态机 · 事件 · 队列 · 命令注册表 · test/
  driver-browser/    Chrome CDP 驱动（持久 profile · 真实鼠标 · shadow DOM · 响应拦截）
  adapter-youtube/   官方 Data API v3
  adapter-bilibili/  biliup CLI + 创作中心接口
  adapter-tiktok/    TikTok Studio web 自动化
  adapter-xiaohongshu/ 创作服务平台 web 自动化
  adapter-douyin/    创作者中心 web 自动化
  channel-feishu/    飞书长连接 + 交互卡片
  cli/               vk
  web/               本地控制台
docs/
```

### 3.3 适配器契约

```ts
interface PlatformAdapter {
  platform: string;
  capabilities: {
    publish: "api" | "web" | "cli" | "none";
    collect: "api" | "web" | "cli" | "none";
    visibility: Array<"public" | "private" | "friends">;  // [] = 不支持
    draft: boolean;
    requiresQualification: boolean;
    minScheduleLeadMs?: number;
  };
  ready(): string | null;
  login?(ctx): Promise<void>;
  check?(ctx): Promise<AccountHealth>;
  publish(input): Promise<PublishResult>;
  collect?(input): Promise<Metrics>;
}
```

**14 条硬规则**（详见 `docs/adapter-contract.md` §3）：
持久 profile / 禁用节流 / 真实鼠标 / scrollIntoView instant / 中英双匹配 / 每步回读 / 清空断言 / 话题等 700ms / 超时按真实耗时 / 发布靠结果状态 / 发布后回读核实 / 失败留截图 / dry-run 必须存在 / 每适配器可独立运行。

### 3.4 队列与调度

- 乐观锁领取（UPDATE ... WHERE state='queued'）
- 租约 5min（上传 30min）+ 30s 心跳
- 中断 ≠ 失败：租约过期立即重排，计入 attempts
- 退避 1m → 5m → 30m，3 次转 failed 并发事件
- lane 串行（lane = account_id）
- 缺处理器直接 failed（配置错误，重试无意义）

### 3.5 错误码表

| code | 含义 | 处置 |
|---|---|---|
| auth | 凭证失效 | blocked + 推卡片 |
| platform_reject | 平台拒稿 | 转 notify，不自动重试 |
| quota | 配额/频率限制 | 延后重试（不计数） |
| flaky_ui | 页面改版 | 退避重试 → draft/notify |
| asset_invalid | 素材不合法 | 直接 failed，不重试 |
| timeout | 总时限内没有结果 | 直接 failed（带停在哪一步），人可重试 |
| unknown | 其他 | 退避重试 |

适配器只负责抛/返回错误码；人话与按钮由核心生成。`auto_running` 有总时限（默认 5 分钟）：
到点 abort 适配器关浏览器、转 `failed`，不允许无声停在 running。

### 3.6 事件与通道

- 事件先落库（dedupe_key 唯一），再异步投递（delivery 表）
- at-least-once + 去重 = 等效 exactly-once
- 卡片发送后保存 external_msg_id，后续更新原消息
- 合并投递：一条消息 ≤ 3 个事件
- 飞书走长连接（WebSocket），不开公网端口
- 配对：本机 6 位码 → 飞书输入
- 脱敏：卡片不含路径/凭证/内部 id

### 3.7 时区与日界线

存 UTC，展示按用户时区；日界线按账号平台主要时区（国内 Asia/Shanghai，海外 UTC）。

### 3.8 安全

- 凭证文件 0600，目录 0700，DB 只存 credential_ref
- 远程命令白名单 + exp + 幂等键 + 全量审计
- 卡片不含路径/凭证/内部 id
- 只出网，不监听公网端口；Web 仅 127.0.0.1
- 遥测默认关闭

### 3.9 CI 门禁（D5 已定）

| 门禁 | 断言 |
|---|---|
| test | 全部单测通过 |
| commands-parity | `vk commands --json` == HTTP 路由 == 卡片按钮 |
| adapter-contract | 每个适配器满足接口形状 + ready() 语义 + dry-run 无对外动作 |
| no-backdoor | channel-* 与 web 不得 import core/db |

---

## 第四部分：产品设计

### 4.1 界面分工

| | CLI vk | 本地 Web | 飞书卡片 |
|---|---|---|---|
| 用户 | agent、脚本、CI | 坐在电脑前的人 | 不在电脑前的人 |
| 干什么 | 全能力（JSON 优先） | 扫码、编排、图表、排障 | 通知、审批、重试、看摘要 |
| 能力占比 | 100%（基准） | 80% | 20% |
| 可否关闭 | — | 关掉不影响功能 | 关掉不影响功能 |

### 4.2 Web 五页

1. **账号墙**（首页）：登录态色标 + 最近发布 + 最近采集 + 一键重授权
2. **发布台**：拖入素材 → 勾平台 → 每平台差异字段 → 一键发/定时
3. **作品详情**：三指标趋势 + 采集来源与时间戳 + 跨平台并排
4. **总览看板**：跨账号/平台/时间聚合
5. **任务与日志**：队列、失败重试、抓取失败现场

### 4.3 飞书卡片原则

- 一句话结论 + ≤ 3 个按钮
- 放决策所需最小上下文（影响几条、上次成功什么时候）
- 不放日志、不放路径、不放凭证
- 点完就地更新原消息，不刷屏
- 按钮 24h 过期

### 4.4 CLI 原则

- 默认 JSON（agent 消费是主路径），--human 才给人看
- --dry-run 对 publish 和 collect 必须可用
- 错误信息包含"下一步该做什么"

---

## 第五部分：测试方案

### 5.1 测试金字塔

| 层 | 内容 | 占比 |
|---|---|---|
| 单元测试 | 状态机、队列、事件去重、命令注册表、适配器契约 | 60% |
| 集成测试 | 假 biliup/假 Chrome 跑通发布+采集闭环 | 30% |
| 端到端测试 | 真实账号发一条（私享/仅自己可见）→ 快照对齐 | 10% |

### 5.2 每个适配器必须通过的契约测试

1. 形状断言：platform/ready/publish/collect/capabilities 存在且类型正确
2. ready() 返回 string 或 null
3. dry-run 不产生任何对外动作
4. 发布结果包含 id/url/visibility/state
5. 采集结果包含 source/status/metrics
6. 失败时抛出带 error_code 的异常

### 5.3 状态机测试

- 所有迁移在白名单表内
- 每个迁移产生 event + audit
- published 是终态
- published_limited 只能经 release 回到 published

### 5.4 队列测试

- 领取幂等（两个 runner 不会同时抢到）
- 租约过期恢复
- lane 串行（同账号并发数恒为 1）
- 退避单调递增
- 未知 kind 直接 failed

### 5.5 三端一致性测试

- `vk commands --json` 的命令集合 == HTTP 路由表 == 卡片按钮集合
- 不一致 CI 直接失败

---

## 第六部分：里程碑

### v0.1 内核闭环

**目标**：一条内容能真的发出去、数据能回到本地。

**出门条件**：
1. TikTok + B站 两平台 auto 发出各 ≥1 条
2. 失败能降级且 fallback_reason 正确
3. 快照落库且 source/status 正确
4. check 能主动发现失效
5. CI 跑通 test + commands-parity

**范围**：core（runner/schema/commands）+ driver-browser + adapter-tiktok + adapter-bilibili + cli（init/doctor/now/serve/account/publish/collect/stats）

### v0.2 控制面

**目标**：手机上能拍板。

**出门条件**：
1. 飞书长连接配对成功
2. 6 类必推事件可投递
3. 卡片按钮幂等 + 24h 过期
4. 账号墙能扫码登录
5. 失效能推卡片并被处理

**范围**：channel-feishu + web（账号墙/发布台/作品详情/总览/日志）+ 事件投递器 + digest 调度

### v0.3 平台扩展

**目标**：五个平台齐 + 可交付。

**出门条件**：
1. 小红书/抖音/YouTube 接入
2. CSV 兜底
3. 看板可用
4. 英文 README
5. 外部用户盲测通过 G1/G2

**范围**：adapter-xiaohongshu + adapter-douyin + adapter-youtube + CSV 导入 + 看板 + 文档

### v0.4 agent 化

**目标**：能被 agent 组装。

**出门条件**：
1. Skill + MCP 双形态
2. 飞书多维表格适配器
3. Telegram 通道

**范围**：skill/mcp + channel-feishu-bitable + channel-telegram

---

## 第七部分：关键决策登记

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 适配器语言 | 统一 Node，不做 Python sidecar | 用户侧多一个运行时就是灾难 |
| D2 | 浏览器方案 | 保持自写 CDP，不换 Playwright | 零依赖、小、已验证 |
| D3 | 浏览器池 | 每账号一个 Chrome profile + 池上限 4 | 矩阵运营不能串号 |
| D4 | 发布确认机制 | 发布后回读核实，失败留截图 | 静默失败是 P0 缺陷 |
| D5 | CI 门禁 | test + commands-parity + adapter-contract + no-backdoor | 承重墙要有护栏 |
| D6 | 商用版边界 | 凭证永不出用户机器（红线） | 一旦破例，护城河就没了 |
| D7 | 复用策略 | 移植流程、重写契约（ADR-0001） | 踩坑知识复用 >80% |
| D8 | 多账号隔离 | lane = account_id，每账号一个 Chrome profile | 同账号串行、多账号并行 |

---

## 第八部分：agent 工作分解

按依赖关系切成 5 个工作流，可并行：

| 工作流 | 内容 | 依赖 | 负责 agent |
|---|---|---|---|
| **foundation** | core（runner/schema/commands/adapters）+ driver-browser + cli + test | 无 | Agent A |
| **adapters** | adapter-tiktok + adapter-bilibili + adapter-youtube + adapter-xiaohongshu + adapter-douyin | foundation | Agent B |
| **web** | 本地控制台 5 页 | foundation + adapters | Agent C |
| **channel** | channel-feishu（长连接 + 卡片 + 配对） | foundation | Agent D |
| **quality** | CI workflow + 契约测试模板 + 端到端测试 + 文档 | 全部 | Agent E |

**并行规则**：
- 每个 agent 只改自己工作流内的文件
- 跨工作流的接口变更必须先提 ADR，经评审后统一改
- 每个工作流有自己的测试套件，CI 分开跑

---

## 第九部分：风险与应对

| 风险 | 信号 | 应对 |
|---|---|---|
| 平台改版导致自动化失效 | 某平台 flaky_ui 一周内 > 3 次 | 适配器独立发版 + collect.degraded 事件 + 失败截图 |
| 登录态频繁失效 | account.expiring 日均 > 1 次 | 提前 72h 提醒 + 一键扫码 + 降低采集频率 |
| 通知噪音导致关闭通道 | 卡片 7 日点击率 < 10% | 合并投递 + 必推白名单 + 默认静音 |
| 三端漂移 | commands-parity CI 失败 | CI 是唯一防线 |
| 移植带进别人的假设 | review 出现 assurelane、固定 TID | ADR-0001 §6 剥离清单 |
| 产品做成自用高级脚本 | 只有作者在用 | G1 盲测：必须找外部创作者 |

---

## 附录：文档索引

| 文档 | 内容 | 何时读 |
|---|---|---|
| **BLUEPRINT.md**（本文） | 唯一架构权威 | 动手前必读 |
| PRD.md | 产品定义、范围、竞品位置、路线图 | 判断"该不该做这个功能" |
| ARCHITECTURE.md | 进程形态、schema、命令表、事件、采集器、CI 契约 | 改内核/表结构/命令/事件时 |
| platforms.md | 五平台能力矩阵（自动化/资质/降级率） | 需要知道某平台怎么发、怎么采 |
| adapter-contract.md | 适配器规约：接口 + 14 条硬规则 + 反模式 | 写/改任何平台适配器时 |
| adr-0001-reuse.md | 复用裁决：只借知识，少抄代码 | 想复用外部代码之前 |
| adr-0002-multi-account.md | 多账号浏览器池方案 | 改浏览器管理时 |
| PLAN.md | 规划与审阅（10 个问题 + 里程碑 + 风险） | 了解项目健康度 |
| REVIEW-2026-10-27.md | 顶级架构师/PM 联合审阅 | 了解设计取舍 |
| RELEASE-CRITERIA.md | 发布标准与商业化信号 | 决定"能不能发版" |
| wireframes.html | 7 屏设计稿 | 做 Web 界面时 |
