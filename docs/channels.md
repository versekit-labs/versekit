# 通道：飞书

**状态**：卡片 + 按钮回执已验证；**应用由用户在产品里配置**，versekit 不复用机器上已有的任何飞书应用。

---

## 1. 前提

- 本机有 `lark-cli`（令牌刷新与长连接由它负责；versekit 保持零依赖）
- 你自己的飞书**企业自建应用**（在飞书开放平台创建）

## 2. 两次扫码，其余自动

都在「接入」页，**不用手抄 key，也不用点「我已完成」**：

1. **扫码创建应用**
   点「扫码创建应用」→ 出现二维码 → 手机扫码（或点「在浏览器打开」）→ 在飞书里确认创建。
   官方流程会把 app_id / secret 直接写进 `versekit` 独立 profile（钥匙串）。
   完成后页面**自动**进入下一步。
2. **扫码授权**
   授权二维码自动出现 → 扫码并在飞书里点确认。
   后台轮询到授权完成，**自动**配对并发送测试卡。

**已有应用？** 创建区下面有「我已有应用，手动填写」；Secret 只经 stdin 一次性交给钥匙串。

## 3. 应用需要的能力

| 项 | 值 |
|---|---|
| 机器人 | 开启 |
| 发消息权限 | `im:message:send_as_bot` |
| 读事件权限 | `im:message:readonly` |
| 事件订阅 | `card.action.trigger`（开发者后台 → 事件与回调） |
| 可用范围 | 包含你自己 |

没订阅事件时卡片能收到、按钮收不到；「诊断」会直接给出后台订阅链接，订阅后 5 分钟内自动重连。

## 3.1 隔离与不回落

- versekit 只使用名为 `versekit` 的 lark-cli profile，所有调用都带 `--profile versekit`
- 没有配置自己的应用时，通道明确报「飞书应用未配置」，**不会回落到机器上的全局默认应用**
- 想换应用：在「接入」页重新填 App ID / Secret，或先移除 `versekit` profile

## 4. 哪些事会发卡片

| 事件 | 卡片 | 按钮 |
|---|---|---|
| `publish.failed` | 发布失败 + 原因 | 重试 |
| `publish.needs_human` | 自动发布没走通 | 我已发布 / 重试 |
| `publish.needs_followup` | 上线了但平台还要补一步 | （说明去哪做） |
| `account.expiring` / `expired` | 登录要过期 / 已失效 | 重新授权 / 转手动 |
| `collect.degraded` | 数据没抓到 + 原因 | 立即重抓 |
| `digest.daily` | 昨日数据摘要 | — |
| `system.dead` | 守护进程停了 | — |

内部 trace（`publish.state_changed`、`run.interrupted`、`system.alive`）**不发卡片**：
半夜被「状态变了」吵醒一次，人就会把通知关掉。

## 5. 两条幂等保证

- **投递**：`delivery(event_id, channel)` 忙位 + 飞书侧 `idempotency-key`，同一事件不会发两次。
- **动作**：按钮 `value` 里带 `key`，写进 `command_audit.idempotency_key`（唯一索引）；同一张卡
  点两次只执行一次。按钮 `exp` 为 24 小时，过期后拒绝并提示去控制台。

## 6. 安全

- 卡片只放业务字段：平台、标题、原因、时间；**不放路径、凭证、内部 id**。
- 按钮动作只接受命令表里 `remote: true` 的命令；`init`、`publish.create` 这类本地命令一律拒绝。
- 只接受已配对的 `open_id` 点击；换了人点会被拒绝并记审计。
