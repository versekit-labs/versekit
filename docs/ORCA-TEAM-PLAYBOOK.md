# Orca Agent 团队编排：机制与实践手册

**版本** 2026-11-09　**适用** Orca 1.4.x + 本仓库 harness
**读法** 想搞懂机制读 §1–§4；想照着干活读 §5–§8；想知道我们差在哪读 §9。

> 这份文档回答四个问题：人干什么、agent 干什么、人和 agent 怎么沟通、agent 之间怎么沟通。
> 机制部分来自 Orca 自带技能 `orca skills get orchestration`（含 `references/`）；
> 现状部分来自 2026-11-09 对本机 daemon、`orchestration.db`、automation 配置的实测。

---

## 0. 一句话

**Orca 不管理“聪明”，它管理所有权和生命周期。**

一个 **Run** 是命名空间 + 协调器收件箱；一个 **Task** 是一件工作；一个 **Dispatch** 是一次权威尝试。
消息只负责把“谁该知道什么”放进收件箱。**状态和证据永远留在 GitHub**——因为 Orca 的编排状态是本地的，重启就没了。

---

## 1. 四个原语

| 原语 | 是什么 | 不是什么 |
|---|---|---|
| **Worktree / Terminal** | 执行位置。folder workspace 也可以，不强制 Git | 不是身份，不是所有权 |
| **Run** | 持久命名空间 + 协调器邮箱；用 `run-create` 建 | **不调度、不放置 worker** |
| **Task** | 工作单元：`pending/ready/dispatched/completed/failed/blocked`，可带 `deps` 形成 DAG | 不是状态机本身；状态机在工单 label |
| **Dispatch** | 一次权威尝试，绑定一个 Task + 一个终端 | 终端标题、旧数据库行、可见 pane 都不是权威 |

**两种模式，先分清再动手**：

| 模式 | 特征 | 用什么 |
|---|---|---|
| **托管（supervised）** | 有 Run/Task/Dispatch，协调器等待、验收、回收 | `orca orchestration` |
| **交接（handoff）** | 把活交给另一个 agent/worktree，不管完成 | `orca-cli worktree create --agent`、`agent launch`；**不建 Run/Task/Dispatch** |

**模型选择不等于托管**：给 handoff 加 `--model` 不会让它变成 supervised。

---

## 2. 角色分工

| 角色 | 是谁 | 干什么 | 不干什么 |
|---|---|---|---|
| **人** | 你 | 定“什么算完成”、写 issue 口径、处理 `s:blocked`、回答 decision gate、抽检 | 不逐行看代码、不手改 `s:*` 状态 |
| **协调器** | LLM + 确定性脚本 | 绑 Run、发 spec、`check --wait`、收 `worker_done`、resolve gate、release/reuse 终端、汇总报告 | 不写业务代码、不做审美判断、不凭 absence 判死 |
| **实现 worker** | engineer worktree 里的 agent | 只做当前 Task：改代码、跑门禁、开 PR、响应打回 | 不给自己 approve、不改状态、不 push 别人分支 |
| **验收 worker** | 另一个 worktree 的 agent | 拿证据包逐条比对 ACC、给 PASS/FAIL | 不改实现代码、不凭“看起来不错”通过 |
| **Orca runtime** | daemon | 起进程、隔离 worktree、持久消息、给出生命周期的正证据 | 不做产品判断 |
| **GitHub** | issue/PR/labels | 状态机（`s:*`）、证据包、CI 门禁、审计 | 不执行任务 |

**最重要的一条**：验收必须是**另一个上下文**。实现方自己说“做完了”不算数——这是整套体系唯一真正重要的约束。

---

## 3. 沟通矩阵

### 3.1 人 ↔ 协调器

| 方向 | 通道 | 说明 |
|---|---|---|
| 人 → 协调器 | chat prompt / automation 的 `prompt` | 一次任务书；要自包含 |
| 人 → 协调器（持久） | GitHub issue | 口径、涉及文件、不可动边界、完成定义 |
| 协调器 → 人 | `worker_done` 摘要、`escalation`、decision gate、最终报告 | 报告必须逐 Task 写：结果、证据、未解决阻塞 |
| 人的干预 | `hold:human` | **不要直接改 label**；直接改会被下一 tick 覆盖，且丢了“谁改的、为什么” |
| 人回答决策 | `gate-resolve` | gate 只用于协调器拥有的 Task-DAG 决策 |

### 3.2 协调器 ↔ worker

**下行**：

```bash
# 一次建 Task + Dispatch，并注入 live preamble（推荐）
orca orchestration worker-start --spec "<task spec>" --worktree <wt> --agent <provider>

# 针对某次尝试的跟进：地址用 dispatch id，不用终端 handle
orca orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<guidance>"

# 等结果：FIFO delivery，未 ack 会重放
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000
```

**上行**：

| 消息 | 谁发 | 语义 | 硬规矩 |
|---|---|---|---|
| `heartbeat` | worker | 只证明活着 | 不等于完成；按 preamble 节奏发 |
| `worker_done` | worker | 结算一次尝试 | **只发一次**；带 `taskId` + `dispatchId` + 三句总结 + `--outcome succeeded/failed` |
| `escalation` | worker | 做不下去，缺什么 | 不要用 prose 藏失败 |
| `ask` | worker | 阻塞问题 | 超时保留一个 pending，按 message id 续问；协调器用 `reply` 回答 |
| `question` | worker | 需要协调器决策 | 必须被 reply，不能装没看见 |

**worker 的四个动作**（来自官方 worker 契约）：
1. 只做当前 Task；阻塞用 `ask`，不开本地问答
2. 按 preamble 节奏发心跳
3. 每个自然检查点读协调器跟进（`check --terminal <handle>`），`worker_done` 前再读一次
4. `worker_done` 后立刻结束本轮、idle；不轮询、不接新活

### 3.3 Worker ↔ Worker

**默认不直接聊。** 真要沟通：

- 同 Run 的 live dispatches：`send --to @all/@claude/@codex/@worktree:<id>`
- 子 Run 的 worker 发到 `run:<id>`
- 向协调器报阻塞：发 `run:<run_id>`
- **生命周期消息（`worker_done`/`heartbeat`）永远不发组地址**，只发 `run:<id>` 或 `dispatch:<id>`

跨 worktree 的协作，优先由协调器转发或落工单，不要让两个 worker 私聊——私聊不留审计。

### 3.4 Agent ↔ 仓库（持久层）

| 层 | 放什么 | 为什么 |
|---|---|---|
| GitHub issue label | `s:triage … s:done` + `hold:human` | 持久、可链接、人可读；**唯一事实源** |
| PR | 证据包 YAML、ACC 条目逐条 pass/fail、CI 结果 | 验收和审计的锚点 |
| Orca Run/Task/Dispatch | 当前所有权、尝试、消息 | **临时执行态**；重启即失，不做审计 |

### 3.5 消息类型速查

`status`（进度）/ `dispatch`（派工）/ `worker_done`（完成）/ `merge_ready`（可合并）/
`escalation`（阻塞）/ `handoff`（交接）/ `decision_gate`（决策门）/ `question`（提问）/ `heartbeat`（心跳）。

### 3.6 四条投递语义（最容易搞错）

1. **`send` 成功 = 入队成功**，不证明对方读了、开始了、接受了转向。
2. **`check` 是最早的 FIFO delivery，最多 50 条，未 ack 会重放**。必须处理完每一条 + 对每个已结算终端做出“复用/保留/释放”决定，才能 ack。
3. **空等或超时是 checkpoint，不是失败**。连续三次空等后再用 `worker-list` 枚举，不要盲目等。
4. **幂等**：同一请求先 `request-show` 查是否已生效；完成回执必须同时带 `taskId` + `dispatchId`，否则重试会把别的派发误标完成。

---

## 4. 生命周期铁律（官方 safety floor）

1. **权威来自 live preamble 里的 Dispatch**，不重建、不翻译、不扩大参数。
2. **只有正证据能 stop/abandon/retry**：`exited`、worker 自己观察到进程退出、或最终 turn 没发 `worker_done`。**absence 不算**。
3. **`silence is not failure`**：超时是静默预算，硬超时是它的 4 倍。一小时没声音的 review 可能还活着。
4. **`worker_done` 自动结算 Task 和 Dispatch**；不要再 `task-update --status completed`。
5. **只有被接受的结算才能 `release`**；release 是事后清理，不是取消。
6. **不 release 就必须 retain**，且 retain 要有用户明确要求；不能既不留也不清。
7. **`worker-start` 失败不要 relaunch**：读 receipt 的 `failedStage` / `residualResources`。
8. **liveness 分层**：`worker-list` 的 `projection.liveness` 是机队结论；`worker-show` 的 `observation.status` 只是 PTY。活着的终端也可能挂着死掉的 agent。
9. **`unverifiable` 是 absence**，包括 `agentWait: null`；不能据此判死。
10. **协调器 turn 结束前**，`worker-list --terminal-state reclaimable` 必须为空。

---

## 5. 工具表

| 工具 | 谁用 | 用途 |
|---|---|---|
| `orca orchestration run-create/run-use/run-current/run-list` | 协调器 | 建/绑/看 Run |
| `worker-start --spec` | 协调器 | 一次建 Task+Dispatch+注入 preamble（首选） |
| `task-create` + `worker-start --task` | 协调器 | 带依赖的计划性 fan-out / 重试已知 Task |
| `check --wait` / `check --ack` | 协调器 | 收信、处理、确认 |
| `send` / `ask` / `reply` / `inbox` | 双方 | 互发、阻塞提问、回答、总览 |
| `gate-create/resolve/list` | 协调器（+人决策） | Task-DAG 决策门 |
| `worker-list/show/read/stop/abandon/release/retain` | 协调器 | 观测、止血、回收 |
| `orca automations` | 人 | 定时唤醒（**不是状态判定**） |
| `orca worktree` / `orca terminal` | 双方 | 隔离位置与终端 |
| `bin/agentctl.mjs` | 脚本 | 工单状态机：tick / claim / set / report |
| `bin/cycle.sh` | 协调器 prompt | 一轮：机械迁移 → 派工 → 验收派工 |
| `bin/worker-up.sh` | cycle.sh | 起一个可对话的 dsh 终端（18s + Esc 绕过引导页） |

---

## 6. 一条完整接力（时序）

```
人写 issue（四块：要做什么 / 口径 ACC id / 涉及与不可动 / 完成定义）
        │  s:triage → s:ready
        ▼
automation（每 10 分钟）拉起协调器，跑 bin/cycle.sh
        │  1) agentctl tick --apply：doing 有 PR → review
        │  2) claim：DELETE s:ready（404 = 被抢，原子锁）→ POST s:doing
        │  3) worker-up.sh：起 dsh 终端，等首帧，Esc 跳过 landing
        │  4) task-create + worker-start：建 Task/Dispatch，注入 spec
        ▼
实现 worker：改代码 → 跑 npm run ci → 开 PR（带 Closes #N + 证据包）
        │  心跳 → worker_done(taskId, dispatchId, outcome)
        ▼
协调器：check --wait 收 worker_done → 校验 dispatch → ack
        │  新上下文起验收 worker：拉 diff + 证据包 + ACC 条目
        ▼
验收 worker：逐条 pass/fail → FAIL: s:changes（回原 PR，同分支改）
        │                    → PASS: s:accept
        ▼
协调器：双门禁（CI + verdict 引用全部 ACC id）→ merge → Closes → s:done
        │  gate（仅 Task-DAG 决策需要）
        ▼
结算：复用（同终端下一个 Dispatch）/ retain（用户要求）/ release（清理）
        │  worker-list --terminal-state reclaimable 必须为空
        ▼
里程碑：open_issues + unmerged_prs == 0 且出门条件有 s:done → 交人确认
```

**数字**：并发 2（实现 1 + 验收 1）；同一 issue 最多 3 轮打回；`doing` 90 分钟无 commit 且无心跳 → `s:blocked`；派工幂等 10 分钟；`changes → doing` 冷却 2 分钟；worktree TTL 48h。

---

## 7. 参数化：谁决定什么

| 决定 | 由谁 | 落在哪 |
|---|---|---|
| 做什么、什么算完成 | 人 | issue 正文 + `ACCEPTANCE.md` |
| 现在派谁 | 确定性脚本（claim） | label `s:doing` |
| 这次尝试的 prompt | 协调器（模板） | Dispatch spec |
| 通过还是不通过 | 验收 worker（新上下文） | PR verdict + `s:accept` |
| 能不能合并 | 脚本（双门禁） | merge + `s:done` |
| 什么时候唤醒 | Orca automation | 定时，只负责“开始”，不判定状态 |
| 卡住时怎么办 | 人 | `s:blocked` / `hold:human` / gate |

---

## 8. 本仓库的现状（2026-11-09 实测，11-10 晚复核）

| 设计 | 实际 |
|---|---|
| 文档说 3 个 automation：engineer-claim / acceptance-claim / agentctl-tick | **只有 1 个 `coordinator`**（id `d43265fa`，`*/10 * * * *`，`reuseSession:false`，provider dsh；当前状态 **disabled**），prompt 里跑 `bin/cycle.sh`，由脚本内部做三段 |
| 派工：claim 原子锁 | `bin/agentctl.mjs`：`DELETE s:ready`，404 = 被抢；再 `POST s:doing` |
| 验收也抢单 | **不抢，但有去重锁**：`cycle.sh` 用 `mkdir` 原子锁 `accept-<issue>.lock`（TTL 45 分钟），同 issue 同时只派一个验收；不是按 head_sha 去重（见 §9.1） |
| 协调器消费消息 | **已实现**：每轮 `check` → 逐条处理（merge_ready / escalation / question）→ `--ack <delivery>` → `--peek` 预看下一批 |
| 合并 | **已实现**：`agentctl merge --pending`，verdict PASS + head_sha 对齐 + ACC 逐条覆盖 + 五门禁全绿才 squash 合并 |
| 验收打回 | **已实现**：`agentctl reject`，回原 PR 同一分支，3 轮上限转 `blocked`；不新建 issue |
| 决策门 | `gate-list` = 0；唯一的 `question` 停在库里（`question_threads` = 1） |
| 终端回收 | `retained=10`，`reclaimable=1`，从不 `worker-release` |
| 派发巡检 | 两个 engineer Dispatch 卡在 `starting` **11 小时**，直到 daemon 重启才被判 `abandoned`（`terminal_missing`） |
| 验收上下文 | 起了新 session，但 cycle.sh 用的是同一个 dsh profile；不是同一 session，这点符合“换上下文” |

**结论（11-12 更新）**：check/ack、release 巡检、脚本合并已经补上，`cycle.sh` 现在是官方 loop 的六段结构。
仍未用的只有 decision gate 与 `worker-read` 深读——这两项在“脚本做协调器”的形态下不是必需。

---

## 9. 已知坑（都是实测，11-10 晚复核了修复状态）

1. **验收重复派工（已修，但锁有边界）**：`dispatch_acceptance` 原先每 10 分钟可能再起一个。
   11-10 的 `cycle.sh` 已加 `mkdir` 原子锁（`~/.orca/versekit-locks/accept-<issue>.lock`，TTL 45 分钟）。
   两个边界要知道：锁按 **issue 号**、不按 `head_sha`，所以 FAIL 打回后同一 issue 在 45 分钟内再派会被跳过；
   锁在派工成功后**不删除**，靠 TTL 过期。打回后想立刻复验，先 `rm -rf` 对应锁。
2. **每 10 分钟一个新 session**：automation 的 `reuseSession:false`。这是 6 个/小时的稳定开销，也是昨晚 session 数暴涨的来源之一。当前 `coordinator` 已 disabled，重开时优先考虑复用 session。
3. **retained 终端不释放**：结算后没有 release，资源记账一直是 `retained`。协调器结束前必须清 `reclaimable`。
4. **静默失败（部分已修）**：`worker-start` 曾卡在 `starting` 11 小时没人知道。现在 `worker-up` 用 `orca terminal wait --for tui-idle` 有超时，失败会清终端、把 issue 退回 `s:ready`（117c199）；但**派发之后的巡检仍缺**——没有周期性 `worker-list` 看 `attention`，长跑 dispatch 依旧可能静默。
5. **Esc 跳 landing 仍是 hack（已不那么脆）**：不再固定等 18 秒，改成 `tui-idle` 等待（默认 60 秒就绪 + 15 秒 settle）。但 Esc 本身仍是绕过 dsh 启动页的 hack，TUI 交互一变就会破；根治是让 `worker-start --agent` 指向已初始化 profile，或走原生 `--spec` 路径。
6. **协调器不看信箱**：`worker_done` 不消费，等于“干完了但没人记账”。必须先修好 check/ack，再谈自动合并。

---

## 10. 本周练习：把 #21 走完一个完整生命周期

**目标**：不是把代码合进去，是把**每种通信都用一遍**。

| 步骤 | 动作 | 观察 |
|---|---|---|
| 1 | 人（你）确认 #21 口径，`#35` 保持 `hold:human` | label 时间线 |
| 2 | 先手工救 #21：worktree 提交 + 开 PR + 本地 `npm run ci` | 证据包 |
| 3 | 派一个实现 worker（一次只放 1 个） | `worker-start` receipt、心跳 |
| 4 | 派一个验收 worker（**新上下文**，不看实现 agent 的思考） | verdict 引用 ACC id |
| 5 | 制造一次 FAIL，观察 `s:changes` → 回同分支 → 再 PASS | 打回轮次 |
| 6 | 结算：release 或 retain，`worker-list` 清空 reclaimable | 终端记账 |

**通过标准**：一个 issue 从 `s:ready` 到 `s:done`；`heartbeat`、`worker_done`、`question`/`reply`、`verdict` 至少各出现一次；PR 证据包能被脚本解析；没有重复 dispatch、没有僵尸终端。

---

## 11. 和现有文档的关系

- `docs/AGENT-COLLAB.md`：政策层规范（状态机、证据包、打回协议）。**机制细节看本文。**
- `docs/AGENT-WORKFLOW.md`：人话版操作手册（你每天该干什么）。
- 本文：Orca 编排层怎么运转、消息怎么走、我们差在哪。

**一条最重要的实践建议**：先别急着扩并发。把这套“一个 issue 走完”练熟，再谈多个 agent 并行——昨晚的教训是并发和重复派工一起爆的。

---

## 12. 实测记录（2026-11-09 ~ 11-10）

第一次完整跑通的记录，留作以后对照。

### 第一轮：#21 → PR #36

| 步骤 | 实际发生 |
|---|---|
| 状态重置 | #21 卡在 `s:doing` 11 小时，dispatch `ctx_600e38d8` 直到 daemon 重启才被 `abandoned`；按 stale 规则回到 `s:ready` 并留审计评论 |
| 派工 | `task_ede8e6de` / `ctx_12c894`，dsh worker，spec 自包含 |
| 交付 | PR #36，head `5f7a367`，本地 240 tests 全绿 |
| 消息 | 第一次 `check` 重放了 **12 条**昨天未 ack 的历史消息；处理完才 ack，再拿到新回执 |
| 验收 | 新上下文 `ctx_b332ce`，verdict=PASS，ACC-add-01 / ACC-account-01 逐条 pass |
| 卡点 | GitHub `test` job 10m15s 被超时杀掉；本地绿、CI 红 → **不合并**，停在 `s:review` |

### 第二轮：#37 修 CI，然后连合两个 PR

| 步骤 | 实际发生 |
|---|---|
| 工单 | 新建 #37，写明日志证据、根因、口径、不可动边界 |
| 修复 | worktree 里已有 3 个测试文件的半成品：CI 跳过真浏览器用例、ui 用例 headless + `finally` 关 daemon |
| 派工 | `ctx_1b9177ae`，worker 只提交 3 个文件，push 更新 PR #32，head `c4bc6a7` |
| 结果 | `test` job 从 **10m15s 超时** 变成 **8s 通过**；五门禁全绿 |
| 合并 | #32 squash 合并（`2f0516b0`），#37 自动关闭 |
| 收尾 | #36 `update-branch` 到 `fa99129`，CI 8s 绿；squash 合并（`d3eda08`）；#21 → `s:done` |
| 回收 | 3 个 worker 终端全部 release + close；`worker-list` 无 reclaimable |

### 你下次照着走：人的四个检查点

1. **开工前**：写 issue，四块缺一不可（要做什么 / 口径 ACC id / 涉及与不可动 / 完成定义）。写完 `grep` 一下 ACC id 能不能搜到。
2. **每天扫一眼**：
   ```bash
   npm run agentctl -- tick     # 只读：今天该谁动
   orca orchestration inbox     # 谁给谁发了什么
   ```
   只看 `human` 那几行；agent 的活不要插手。
3. **卡住时**：看 `s:blocked` 的原因或 decision gate，做决定；冻结用 `hold:human`，不要手改 `s:*`。
4. **合并前**：看 PR body 的证据包 + 五门禁。PASS 但 CI 红，照样不能合。合并后确认 `Closes #N` 生效、milestone 计数更新。

### 这次暴露的待修项（11-10 晚复核后更新）

- ~~验收侧不抢单，同一 PR 可能被重复派~~ → 已加 `accept-<issue>.lock`（TTL 45 分钟）；待改进：锁按 issue 而非 `head_sha`，打回后 45 分钟内复验会被跳过
- `coordinator` automation 当前 **disabled**，provider 已改成 dsh；重开前先定 `reuseSession` 策略
- CI 的 test job 修复已进主干；`v0.1` 只剩 #35 的真机验收（需要人操作真实账号）
- 晚复核已合并：#42（#24 应用外壳，验收 PASS），以及本手册
