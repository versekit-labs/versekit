# versekit 架构设计

**版本** v0.1　**日期** 2026-10-27　**配套** `docs/PRD.md`（产品定义）、`docs/platforms.md`（平台能力）、`docs/adapter-contract.md`（适配器规约）

**设计前提**（来自 PRD，不可动摇）
1. 凭证与素材留在本机 → 单机常驻进程，不做云。
2. 一个内核、三个界面（CLI / 本地 Web / 飞书）→ 业务逻辑只有一份。
3. 默认自动化、零资质；`auto → draft → notify` 降级；**永不静默失败**。
4. 数据是可解释的：每条指标都带 `source` 与 `status`。

---

## 1. 运行时形态

```
┌───────────────────────── 单机 ─────────────────────────┐
│                                                        │
│  vk (CLI)  ──unix socket──┐                            │
│                           ├──►  versekitd  ──► SQLite  │
│  browser(localhost:8787) ─┘     ├ 命令总线              │
│                                 ├ 队列/调度             │
│  飞书长连接（出网）─────────────┤ 事件总线  │            │
│                                 └ 适配器 ───┴─► 平台    │
│                                        └─► Chrome(CDP):9333 │
└────────────────────────────────────────────────────────┘
```

| 决策 | 选择 | 理由 |
|---|---|---|
| 进程数 | **1 个守护进程 + N 个 CLI 客户端** | 发布/采集必须串行化在同一个内存与文件锁下 |
| CLI ↔ 内核 | **本地 HTTP（unix socket）**，CLI 不直接写库 | 否则 Web/飞书/CLI 三条写路径必然分叉（违反 §5.3 零后门律） |
| 守护进程未启动 | CLI **自动拉起**（`vk serve --detach`），2s 内就绪 | 用户不该学"先启服务" |
| Web | 由守护进程同端口提供静态页 + `/api/*` | 免去第二套部署 |
| 浏览器 | **共享一个持久 Chrome（CDP 9333）** | 登录态复用；三个平台共用一套 driver |

> CLI 直连库只允许一种情况：`--offline` 的**只读**查询（daemon 挂了也能 `vk doctor`）。写入永远走 socket。

---

## 2. 仓库结构

```
packages/
  core/                 内核：db · queue · events · commands · states · doctor
  driver-browser/       Chrome CDP 驱动（移植自 factory/browser.mjs）
  adapter-youtube/      API 后端
  adapter-bilibili/     biliup 后端
  adapter-tiktok/       Web 后端（TikTok Studio）+ collectors
  adapter-xiaohongshu/  Web 后端（创作服务平台）
  adapter-douyin/       Web 后端（创作者中心，Wave 2）
  channel-feishu/       飞书长连接 + 卡片
  cli/                  vk
  web/                  本地控制台（构建产物内嵌进 core）
docs/
```

**边界规则**：适配器只能调 `core` 暴露的接口，不能 import 彼此；`core` 不能 import 任何适配器（靠注册表注入）。这条规则用 eslint `no-restricted-imports` 钉死。

---

## 3. 数据模型（SQLite）

```sql
PRAGMA journal_mode=WAL;

CREATE TABLE account (
  id            TEXT PRIMARY KEY,              -- acc_xxx
  platform      TEXT NOT NULL,                 -- youtube|bilibili|douyin|xiaohongshu|tiktok
  handle        TEXT NOT NULL,
  display_name  TEXT,
  credential_ref TEXT,                         -- 指向凭证文件；库内不存 token
  state         TEXT NOT NULL DEFAULT 'ok',    -- ok|expiring|expired|banned|manual
  is_manual     INTEGER NOT NULL DEFAULT 0,    -- 该号是否只手动发
  expires_at    INTEGER,                       -- 登录态到期（可空）
  last_ok_at    INTEGER,                       -- 最近一次 check 成功
  created_at    INTEGER NOT NULL,
  UNIQUE (platform, handle)
);

CREATE TABLE work (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  asset_path  TEXT NOT NULL,
  asset_sha   TEXT,
  meta_json   TEXT,                            -- 标题/描述/话题的母版
  created_at  INTEGER NOT NULL
);

CREATE TABLE publish (
  id            TEXT PRIMARY KEY,
  work_id       TEXT NOT NULL REFERENCES work(id),
  account_id    TEXT NOT NULL REFERENCES account(id),
  mode          TEXT NOT NULL DEFAULT 'auto',      -- auto|draft|notify|manual
  visibility    TEXT NOT NULL DEFAULT 'public',    -- public|private|private_then_public|friends
  state         TEXT NOT NULL DEFAULT 'queued',    -- 见 §4
  scheduled_at  INTEGER,
  overrides_json TEXT,                             -- 平台差异字段（标题/话题/封面/分区…）
  external_id   TEXT,
  external_url  TEXT,
  fallback_reason TEXT,                            -- flaky_automation|risk_control|no_upload_path|app_only_feature
  error_code    TEXT,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (work_id, account_id)
);
CREATE INDEX idx_publish_state ON publish(state, scheduled_at);

CREATE TABLE snapshot (
  id          TEXT PRIMARY KEY,
  publish_id  TEXT NOT NULL REFERENCES publish(id),
  captured_at INTEGER NOT NULL,
  source      TEXT NOT NULL,        -- api|intercept|csv
  status      TEXT NOT NULL,        -- ok|partial|failed
  metrics_json TEXT NOT NULL,       -- {"play":123,"like":4,"fav":1}
  UNIQUE (publish_id, captured_at)
);
CREATE INDEX idx_snapshot_pub ON snapshot(publish_id, captured_at DESC);

CREATE TABLE followup (
  id          TEXT PRIMARY KEY,
  publish_id  TEXT NOT NULL REFERENCES publish(id),
  kind        TEXT NOT NULL,        -- set_visibility_public|add_to_collection|resubmit_topic
  state       TEXT NOT NULL DEFAULT 'open',   -- open|done|waived
  verify_hint TEXT,
  done_at     INTEGER
);

CREATE TABLE run (                  -- 队列
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,        -- publish|collect|check|reauth
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|canceled
  priority    INTEGER NOT NULL DEFAULT 100,
  run_after   INTEGER,              -- 定时/退避
  lease_until INTEGER,              -- 租约；过期视为中断
  heartbeat_at INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_run_ready ON run(state, run_after, priority);

CREATE TABLE event (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL,        -- info|warn|critical
  publish_id  TEXT,
  payload_json TEXT,
  dedupe_key  TEXT UNIQUE,          -- 幂等投递
  created_at  INTEGER NOT NULL
);

CREATE TABLE delivery (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES event(id),
  channel      TEXT NOT NULL,       -- feishu
  state        TEXT NOT NULL,       -- pending|sent|failed|read
  external_msg_id TEXT,
  attempted    INTEGER NOT NULL DEFAULT 0,
  sent_at      INTEGER
);

CREATE TABLE command_audit (        -- 所有远程命令
  id          TEXT PRIMARY KEY,     -- = command_id
  name        TEXT NOT NULL,
  actor       TEXT NOT NULL,        -- feishu:ou_xxx
  origin      TEXT NOT NULL,        -- cli|web|feishu
  args_json   TEXT,
  result      TEXT,                 -- ok|rejected|error
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE channel_binding (
  id               TEXT PRIMARY KEY,
  channel          TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  paired_at        INTEGER,
  UNIQUE (channel, external_user_id)
);
```

**为什么指标用 JSON 而不用列**：平台字段天然不同（TikTok 无收藏、B站有投币、小红书有收藏），宽表会崩。查询层再收敛出"标准三指标"：

```sql
SELECT json_extract(metrics_json,'$.play') AS play FROM snapshot WHERE publish_id=?
```

超过 50 万行后按 `captured_at` 月度归档到 `snapshot_archive`。

---

## 4. 状态机

```
账号   ok ──► expiring ──► expired ──► ok
        └──► banned ──► manual ──► ok

发布   queued ──► auto_running ──► published
                    │                 └──► published_limited（平台强制不完整 → followup）
                    ├──► draft_running ──► draft_pending ──► published
                    ├──► notify_pending ──► published
                    ├──► failed ──► queued（重试）
                    └──► blocked（登录失效）──► queued（reauth 后）

followup  open ──► done | waived
```

**迁移表**（每个迁移必须有 `event` 与 `audit`，无例外）

| from → to | 触发 | 副作用 |
|---|---|---|
| queued → auto_running | worker 取到 run（租约） | heartbeat 每 30s |
| auto_running → published | 适配器返回 + 回读核实 | 建首条 snapshot 任务；发 `publish.published` |
| auto_running → draft_running | 检测到平台只给草稿/风控 | 记 `fallback_reason` |
| * → notify_pending | 自动上传失败 ≥2 次或 `no_upload_path` | 发 `publish.needs_human` |
| auto_running → published_limited | 核实发现可见性/合集不符 | 建 followup；发 `publish.needs_followup` |
| * → blocked | 适配器报 `auth_error` | 账号置 expired；暂停该账号所有任务 |
| failed → queued | 用户点重试 或 自动退避（1m/5m/30m） | attempts+1，超 3 次转 notify |

### 4.1 健康检查（`check` 任务）

账号失效不能只靠“发布失败了才发现”——那是用户 G3 承诺的反面。三条信号源，按顺序：

| 信号 | 频率 | 实现 |
|---|---|---|
| 定时探测 | 每 6h/账号 | `run{kind:'check'}` → `adapter.check()`（没实现就跳过） |
| 被动信号 | 实时 | 发布/采集报 auth 错 → 立即置 `expired`，不等下一轮 |
| 到期预测 | 实时 | 凭证自带 `expiresAt` 时提前 72h 置 `expiring` |

无 `adapter.check()` 的适配器必须显式缺失（不是默默跳过）：`vk doctor` 里列为“只能被动发现失效”，并计入风险页。

### 4.2 followup 核实器

PRD 说 “系统自己核实”，所以 `followup.verify` 是一个**可执行的东西**，不是一句注释：

| verify | 怎么核实 | 失败时 |
|---|---|---|
| `visibility` | 调适配器的可见性读接口（TikTok `video.list` / YouTube `videos.list`） | 保持 open + 卡片重试 |
| `collection` | 读作品所属合集列表，包含目标合集则 done | 提示“可能需手动加入” |
| `captions` | 读字幕列表非空 | 保持 open |

核实器由 `run{kind:'check'}` 顺带跑（不单开任务类型），每次核实都写 `snapshot` 级别的证据日志。

### 4.3 错误码表（唯一枚举）

`publish.error_code` 只能取下列值；映射到人话与可执行动作：

| code | 含义 | 人话 | 处置 |
|---|---|---|---|
| `auth` | 凭证失效/被限 | 登录过期了，扫一下码 | `blocked` + 推卡片 |
| `platform_reject` | 平台拒稿/审核不通过 | 平台拒绝了这条 | 转 `notify`，不自动重试 |
| `quota` | 配额/频率限制 | 今天发得太频了 | 延后重试（不计数） |
| `flaky_ui` | 页面改版/元素找不到 | 自动化没跑通 | 退避重试 → `draft`/`notify` |
| `asset_invalid` | 素材不合法（尺寸/时长/大小） | 这个文件平台不收 | 直接 failed，不重试 |
| `timeout` | 总时限内没有结果（页面停在某一步） | 发布卡住了，已超时中止 | 直接 failed，带「停在哪一步」，人可重试 |
| `unknown` | 其他 | 出错了（附截图） | 退避重试 |

`auto_running` 有总时限（默认 5 分钟，可用 `VK_PUBLISH_TIMEOUT_MS` 或 `config.json` 的
`publish.timeout_ms` 调整）：到点先 abort 适配器（它负责关闭为这次发布打开的浏览器），再转
`failed`；没有活 run 的残留行由守护进程定期扫描收掉。任何发布都不允许无限停在 `auto_running`。

适配器只负责抛/返回错误码；**人话与按钮由核心根据这张表生成**，不允许适配器自己拼文案。

### 4.4 时区与日界线

存 UTC，展示按用户时区；**日界线按账号所属平台的主要时区**（国内 `Asia/Shanghai`，海外 `UTC`）。受影响的是：

- `digest.daily` 的 9:00（用户的本地时间，不是服务器时间）
- 按天聚合的曲线点
- “今天已发布 N 条”类计数（风控预算依赖它）

---

## 5. 命令注册表

**唯一真源** `core/commands.ts`；CLI help、HTTP 路由、飞书卡片按钮全部由它生成，CI 校验三者一致（PRD §5.4）。

```ts
defineCommand({
  name: "publish.retry",
  summary: "重试一次发布",
  args: { publishId: "string" },
  permission: "operator",                  // 允许远程触发的等级
  idempotent: (a, ctx) => `retry:${a.publishId}:${ctx.attempt}`,
  ttlMs: 24 * 3600e3,                      // 卡片按钮有效期
  undoable: false,
  cli:  { aliases: ["retry"], json: true, human: true },
  http: { method: "POST", path: "/api/publishes/:publishId/retry" },
  card: { label: "重试", style: "primary", confirm: false },
  audit: "always",
  handle: async (a, ctx) => ctx.queue.push({ kind: "publish", targetId: a.publishId }),
});
```

### CLI 命令表（v0.1）

| 命令 | 说明 | 远程可用 |
|---|---|---|
| `vk init` | 建库、生成配置、启动守护进程 | 否 |
| `vk serve [--port]` | 前台/后台运行守护进程 | 否 |
| `vk now [--human]` | 一屏状态：账号健康 / 队列 / 通道 / 下次采集 | 是 |
| `vk account add <platform> --name` | 加账号，输出扫码页链接（自动开 Web） | 否 |
| `vk account list / check / reauth / rm` | 账号生命周期 | `reauth` 可远程发起，但扫码必须在电脑前完成 |
| `vk account mode <id> auto\|manual` | 该号是否自动 | 是 |
| `vk publish <asset> --to a,b --schedule --visibility --dry-run` | 创建发布 | 否（本地） |
| `vk publish list` / `retry <id>` / `release <id>` / `confirm <id>` | 列表与队列操作 | 是 |
| `vk platforms` | 已安装适配器与可用状态（Web 发布台的数据源） | 否 |
| `vk publish approve <work>` / `reject <work> --reason` | 审批门禁（可选） | 是 |
| `vk collect [--now] [--platform]` | 立即采集 / 查看下次计划 | `--now` 是 |
| `vk stats works [--range]` / `series <id>` | 数据查询（最新值 / 全部快照） | 否 |
| `vk runs [--state]` / `events [--since]` | 队列与事件排障 | 是 |
| `vk channel bind feishu` / `test` | 配对 + 探活 | 否 |
| `vk commands [--json]` | 导出注册表（CI 用） | 否 |
| `vk doctor [--json]` | 32 项自检 | 否 |
| `vk event list [--since]` / `replay <id>` | 事件排查 | 是 |

`--json` 是默认，`--human` 才给人看；`--dry-run` 对 `publish` 与 `collect` 都必须可用。

**传输端点（不属于命令表）**：Web 有两个只能由浏览器用的端点，它们不是新能力，所以不占命令位：

| 端点 | 用途 | 为什么不是命令 |
|---|---|---|
| `POST /api/assets` | 浏览器把文件传成素材，返回本机路径 | CLI 直接用文件路径，能力等价 |
| `GET /api/stream` | SSE 实时状态（2s 一帧），控制台靠它自动刷新 | 纯推送，没有任何写操作 |

---

## 6. 事件与通道

```ts
type EventType =
  | "account.expiring" | "account.expired" | "account.banned"
  | "publish.published" | "publish.failed" | "publish.degraded"
  | "publish.needs_human" | "publish.needs_followup"
  | "approval.requested"
  | "collect.degraded" | "collect.recovered"
  | "digest.daily" | "metric.milestone"
  | "system.alive" | "system.dead";
```

**投递语义**：事件先落库（`event` 表，`dedupe_key` 唯一），再由通道异步投递（`delivery`）。at-least-once + 去重键 = 等效 exactly-once；卡片发送后保存 `external_msg_id`，后续状态变化**更新原消息**而不是新发一条。

### 飞书通道实现要点

| 事项 | 做法 |
|---|---|
| 接入方式 | **长连接（WebSocket）**，不是公网回调 → 不需要域名/内网穿透（与视频工厂"轮询不依赖公网"同一思路） |
| 卡片 | 交互卡片 v2；`actions` 里每个按钮带 `command_id` + `idempotency_key` + `exp`（24h） |
| 回执 | 收到 `card.action.trigger` 事件 → 校验 `exp` / 白名单 / 幂等键 → 执行 → **原地更新卡片**为结果态 |
| 配对 | `vk channel bind feishu`：用 lark-cli 已登录身份取 open_id → 落 `channel_binding` → 发测试卡（不需要 6 位码，也不需要公网回调） |
| 脱敏 | 卡片只放业务字段；路径、凭证、内部 id 一律不出 |
| 降级 | 长连接断开 → 事件积压在 `delivery(pending)`，恢复后按 `created_at` 补投并按类型合并 |

---

## 7. 队列与调度

```ts
// 取任务的唯一入口（乐观锁，天然防并发）
UPDATE run SET state='running', lease_until=now+lease, heartbeat_at=now
WHERE id = (SELECT id FROM run
            WHERE state='queued' AND (run_after IS NULL OR run_after<=now)
            ORDER BY priority, created_at LIMIT 1)
  AND state='queued';
```

- **并发**：全局 2，`per-account` 1（同一账号并发发布极易触发风控）。
- **租约**：普通任务 5 分钟，上传类 30 分钟；主循环每 10s 扫描 `lease_until < now` 的 running → 判为中断，`attempts+1` 并回到 `queued`。
- **退避**：1m → 5m → 30m，3 次后转 `notify`（把最后一公里交给人，而不是无限重试）。
- **守护进程自身心跳**：写 `meta.last_beat`；若外部看门狗（launchd/systemd）发现 90s 无心跳 → 重启并保留队列。
- **采集预算**：每账号每日采集次数上限（前密后疏曲线总次数固定），超限静默延期而不是失败。

---

## 8. 适配器

接口、14 条硬规则、反模式见 `docs/adapter-contract.md`。这里只补两条架构级决定：

1. **`driver-browser` 是共享基础设施**：抖音/小红书/TikTok 共用一个 Chrome（CDP 9333）和同一套 `tab` 工具。禁止每个适配器自己起浏览器。
2. **每个适配器是独立包**，可单独版本化；契约测试（`contract.test.ts`）对每个包跑同一组形状断言 + 一次 `--dry-run`。

---

## 9. 采集器设计（含 TikTok 走创作者后台拦截）

### 9.1 采集节奏

```
发布后：+1h · +6h · +24h · +3d · +7d · 之后每天（上限 30 天）
由 `core/collect-plan.mjs` 的纯函数排下一个点（依据 `publish.published_at`），
每次采集成功后自动排下一次；重启不影响，手动补抓也不会打乱节奏。
每条快照：{ captured_at, source, status, metrics_json }
```

### 9.2 三条采集路径（按能力分级，同一张表）

| source | 实现 | 适用 |
|---|---|---|
| `api` | 官方分析接口（YouTube Analytics） | 有 API 的平台 |
| `intercept` | 登录态页面 + **拦截页面自己发出的请求** | 抖音/小红书/TikTok/B站(创作中心) |
| `csv` | 用户手工导入 | 兜底、历史补齐 |

**为什么不直接 curl 平台接口**：国内平台与 TikTok web 都需要签名参数（`X-Bogus`/`msToken`/`a1`）。逆向签名是合规红线且天天变——我们只读**页面自己发出的、已签好名的响应**。

### 9.3 TikTok 采集（本次选定：创作者后台拦截）

```
1. 复用同一 Chrome profile（已登录 @handle）
2. 打开 https://www.tiktok.com/tiktokstudio/content  （作品管理，私密视频也可见）
3. CDP: Network.enable，监听 Network.responseReceived
   过滤：mime == application/json 且 url 命中 /item_list|posts|video\/list/
4. Network.getResponseBody → JSON
5. 启发式定位：深度递归找含 stats 的对象，用 publish.external_id 匹配作品
6. 归一化：play_count←stats.playCount, like_count←stats.diggCount,
           comment_count←stats.commentCount, share_count←stats.shareCount
           （收藏：TikTok 无此指标 → 不写入，而不是写 0）
7. 落库：source='intercept', status='ok'；某个字段取不到 → status='partial'
8. 页面被重定向到 /login → 抛 auth_error → account.state='expired' → 事件
```

**判定失败的三种情况**（必须区分，否则排障无门）：
- 登录失效（跳 login）
- 页面改版（等不到 item_list 响应）→ `collect.degraded`，提示"平台可能改版"
- 作品找不到（id 不匹配）→ 说明发布时拿到的 id 不可靠，回写 `external_id` 并告警

### 9.4 真实案例：B站公开接口不可用

视频工厂的记录：**B站公开接口对本机海外 IP 返回 412**，于是改用创作中心的稿件列表（复用 biliup 登录）。这正是 `source` 分级的现实意义——同一个平台，按**网络位置**和**登录态**选择不同路径，并把选择结果写进 `source`。

---

## 10. 安全

| 面 | 措施 |
|---|---|
| 凭证 | 文件 0600 + 目录 0700；DB 只存 `credential_ref`；macOS 可选写 Keychain |
| 远程命令 | 白名单 + `exp` + 幂等键 + 全量审计（`command_audit`） |
| 卡片 | 不含路径/凭证/内部 id；危险操作卡片上二次确认 |
| 网络面 | 只出网（飞书长连接、平台 API），**不监听公网端口**；Web 仅 `127.0.0.1` |
| 遥测 | 默认关闭；开启也只发聚合计数 |

---

## 11. 可观测

`vk doctor` 的 32 项自检分四组：**能跑吗**（daemon/DB/socket）· **能发吗**（账号健康/浏览器/凭证）· **能看到吗**（采集最近成功时间/平台降级率）· **能收到吗**（飞书长连接/最近投递）。任意一组红灯都输出"下一步该做什么"的一句话。

日志单文件 JSONL（`~/.local/state/versekit/vk.log`），关键字段 `event_id`/`run_id`/`publish_id` 与库对齐，便于 grep 串联。

---

## 12. CI 契约测试

| 测试 | 断言 |
|---|---|
| `commands-parity` | `vk commands --json` 的命令集合 == HTTP 路由表 == 卡片按钮集合 |
| `adapter-contract` | 每个适配器包满足 §2 接口形状；`ready()` 返回 string 或 null |
| `state-machine` | 所有迁移都在白名单表里；每个迁移都产生 event + audit |
| `no-backdoor` | eslint：`channel-*` 与 `web` 不得 import `core/db` |
| `collect-shape` | 快照必含 `source`/`status`；指标键在平台白名单内 |

---

## 13. 与 PRD 里程碑的映射

| 版本 | 架构交付物 |
|---|---|
| v0.1 | §3 表结构 + §5 注册表 + §7 队列 + driver-browser + 三个适配器（YouTube/B站/TikTok）+ `auto→draft→notify` |
| v0.2 | §6 事件与飞书通道 + `followup` + reauth 闭环 + Web 5 页 |
| v0.3 | §9 CSV 路径 + 看板查询 + §12 全部 CI 测试 |
| v0.4 | 适配器包化发布 + Skill/MCP 薄壳 + 飞书多维表格适配器 |
