# 通道：飞书

**状态**：发卡片可用；按钮回执代码就绪，需要在飞书开发者后台订阅一次事件。

---

## 1. 为什么走 lark-cli

飞书的交互卡片需要「长连接收事件」才能拿到按钮点击。蓝图明确不开公网回调，而官方长连接
协议要自己实现一大套鉴权与帧格式。

这台机器上已经有 `lark-cli`（trustbridge 在用）：它持有 app secret（系统钥匙串）、负责
token 刷新与事件总线。versekit 只调用它：

| 动作 | 命令 |
|---|---|
| 发卡片 | `lark-cli im +messages-send --msg-type interactive ...` |
| 收按钮 | `lark-cli event consume card.action.trigger --as bot`（NDJSON 流） |
| 原地更新卡片 | `lark-cli api POST /open-apis/interactive/v1/card/update` |

好处：凭证不进 versekit 的库、不写文件；零依赖；token 刷新不用我们管。
代价：飞书通道依赖本机装了 `lark-cli` 并已登录（`lark-cli auth status` 有 user identity）。

---

## 2. 三步接上

```bash
lark-cli auth login                 # 如果还没登录
npm run vk -- init                  # 只需一次
npm run serve                       # 守护进程（会自动拉起）
npm run vk -- channel bind feishu   # 配对 + 发一张测试卡
```

`channel bind` 会：

1. 用 `lark-cli auth status` 取当前登录人的 `open_id`（不用手抄 `ou_...`）
2. 写一条 `channel_binding`（配对关系，重新执行只会刷新时间）
3. 发一张测试卡到你飞书

## 3. 最后一步：订阅按钮事件

没订阅时卡片能收到，但**按钮点击收不到**。日志会明确写出来，并给一个链接：

```
[feishu] 开发者后台还没订阅 card.action.trigger（卡片按钮收不到点击）。
[feishu] 打开这个链接完成订阅：https://open.feishu.cn/page/launcher?clientID=...&addons=...
[feishu] 订阅后无需重启，5 分钟内会自动重连。
```

在飞书后台 → 该应用 → **事件与回调** 里订阅 `card.action.trigger` 即可。订阅完成后
通道会自动重连，不需要重启守护进程。

---

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
