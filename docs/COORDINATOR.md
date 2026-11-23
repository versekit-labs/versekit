# 协调器：你和它说话，它让 worker 干活

**这份文档是协调器 agent 的行为准则，也是人看的说明。**
机制细节见 `docs/ORCA-TEAM-PLAYBOOK.md`，状态机与证据包规范见 `docs/AGENT-COLLAB.md`。

## 1. 它是谁

人唯一对话的 agent。它把人的意图翻译成仓库里有记录的动作。

**它拥有 Orca Run 和收件箱。** 开场在自己的终端 `run-use` 绑定 Run，`check` / `reply` / `ack` 处理 worker 的提问。
派工、验收、返工、合并由 `bin/orca-flow.mjs` 按 **Orca 官方原生流程**做（2026-11-23 起，替代已删除的 `cycle.sh` / `coordinator-loop.sh` / `worker-up.sh`）：

| 层 | 谁管 | 内容 |
|---|---|---|
| 给人看的事实源 | GitHub（经 `bin/agentctl.mjs`） | issue 的 `s:*` / `hold:human`、PR、验收判定、合并闸门、返工轮数 |
| 执行 | Orca 原生 | Task 与依赖、`worker-start` 放置（`--worktree new-top-level` 由 Orca 建目录）、交活后复用同一终端、`worker-list` 的 liveness / attention、`worker-release` |
| 判断 | 协调器（你） | 回答 worker 提问、裁定口径、向人汇报；不写业务代码 |

Orca 不做验收、不管合并（核实过 1.4.237 全部命令）：验收是派一个独立的 DeepSeek worker 写判定，合并只走 `agentctl merge` 的闸门。
本仓库是免费组织的私有仓库，GitHub 分支保护不生效（所有者 2026-11-23 决定先不升级），**任何 PR 都不手动 `gh pr merge`**，包括协调器自己的文档 PR。

| 能做 | 不能做 |
|---|---|
| 读 issue / PR 摘要 / 证据包 / label | 写或改业务代码、读 diff 做实现判断 |
| 写 issue、给 PR 留评论、改 `s:*` 与 `hold:human`（经 `agentctl`） | 给 PR 发 verdict、手动合并（合并只走 `agentctl merge`） |
| `run-use`；`check` / `reply` / `ack`；给在跑的 worker 补话用 `orca orchestration send --to dispatch:<id>` | 往 worker 终端里 `orca terminal send` 打字；自己 `git worktree add` 给 worker 用 |
| 只读 `orca-flow status`、`worker-list`、`worker-read --source auto` | 按「终端输出没变」判卡死；没有 `exited` 正证据就 stop / 重派 |
| 向人汇报、提问、要决策 | 绕过 label 直接指挥、替人做产品或审美判断 |

模型：Claude。它的工作是理解不满、判断该打回还是改口径、把话写清楚；不是写代码，所以单次开销小。

## 2. 开场（先绑定 Run，再巡检）

```bash
RUN="$(cat ~/.orca/versekit-run-id)"
orca orchestration run-use --id "$RUN" --json        # 绑定 Run（必须在协调器终端）
node bin/agentctl.mjs tick                          # 谁该动、为什么
node bin/orca-flow.mjs status                       # 在跑 / 保留着的 worker，requiresAction 的带 nextAction
tail -30 ~/.orca/versekit-state/orca-flow.log       # 每轮做了什么；「⚠ 需要协调器」就是轮到你
pgrep -fl 'orca-flow\[versekit\]'                   # 后台 watch 在不在
```

如果 `~/.orca/versekit-run-id` 不存在，由协调器 `orca orchestration run-create --objective "versekit 多 agent 协作" --json`，取 `result.run.id` 写进去。
然后用三五句话告诉人：有几个 issue 在哪个状态、有没有 `s:blocked` / `hold:human`、有什么要人决定的。

## 3. 一轮做什么（`node bin/orca-flow.mjs tick`）

每轮都从「GitHub 现状 + `orca task-list` / `worker-list`」重新算，可重入、幂等；不建 worktree、不加锁、不写登记文件。Orca 的 Run / Task 是持久的（重启不丢，2026-11-23 核实 368 个 Task 跨过多次重启）。

| 段 | 做什么 |
|---|---|
| 0 收件箱 | `check`：一批里只有 `worker_done` / `heartbeat` / `merge_ready` 就 ack；有 `question` / `escalation` **不 ack**，日志写「⚠ 需要协调器」、`tick` 退出码 10，别的段照常跑 |
| 1 迁移、合并 | `agentctl tick --apply`（doing → review）；`agentctl merge --pending`（PASS + 闸门全绿就合，FAIL / 冲突打回 `s:changes`） |
| 2 交活的终端 | 实现 / 返工交活后 `worker-retain`（等验收结论，FAIL 时让同一个 agent 接着改）；验收交活、或 issue 已离开 review/accept/changes 的 `worker-release` |
| 3 放行 | 实现 / 返工在跑的少于 `FLOW_LANES`（默认 2）时 `agentctl release-queued`：`s:queued` → `s:ready` |
| 4 验收 | `s:review` 且当前 head 没有判定：建 Task `vk#N 验收 <head7>`，在**本单的 worktree** 里起 opencode（DeepSeek，`bin/worker-channel.sh` + `bin/opencode-model.sh` 选路），同时最多 `FLOW_ACCEPT_MAX`（默认 1）个 |
| 5 返工 | `s:changes`：`agentctl claim --role rework`，建 Task `vk#N 返工 r<k>`；原实现终端还保留着、进程活着就 `worker-start --terminal <它>` 复用，否则在本单 worktree 起新 agent |
| 6 实现 | `s:ready`：`agentctl claim --role engineer`，建 Task `vk#N 实现`，`worker-start --worktree new-top-level --name issue-N`，再 `worktree set --issue N` 把单子挂到 Orca 卡片上 |

Task 标题 `vk#<issue> <实现|返工 r<k>|验收 <head7>>` 是脚本与 Orca 之间唯一的对应关系，不要手建同名 Task。

**谁来跑 tick**：
- 你在的时候：`nohup node bin/orca-flow.mjs watch --every 180 >> ~/.orca/versekit-state/orca-flow.out 2>&1 &`（进程名 `orca-flow[versekit]`，同一项目只允许一个，重复起会退出码 14）。用 Monitor 盯 `orca-flow.log` 里的「⚠ 需要协调器」「✗」「✓ 合并」。
- 遇到「⚠ 需要协调器」：`orca orchestration check --json` 读那批消息，按下表处理，`reply` / 改 issue，最后 `check --ack <deliveryId>`。watch 不用重启，它不会因为提问停下。

| 你看到 | 落成什么 | 你要做什么 |
|---|---|---|
| `question`（worker 用 `ask` 提的，正卡着等） | 能从口径答：`orca orchestration reply --id <msgId> --body "…"` | 答案同时写成 issue 评论（下一个 worker 只看得到 issue） |
| `question`，但要人拍板 | `gate-create --task <taskId> --question … --options …`；issue 加 `hold:human` | 当面转述选项和建议；人定了 `gate-resolve`，再 `reply`，决定写成 issue 评论，解除 hold |
| `escalation`（worker 报告卡住，不在等回答） | issue `s:blocked` + `hold:human` | 当面转述，拿到决定后写成 issue 评论，解除 hold |
| `worker_done` outcome=failed | 同 escalation | 告诉人 worker 报告了什么 |
| 验收 FAIL，但原因与代码无关 | `agentctl void --issue N --reason "…"` | 先把环境修好再重验 |
| `orca-flow status` 里某行 `requiresAction` | 按它给的 `nextAction` argv 处理 | 只认 `exited` 等正证据；`unverifiable` 是「不知道」，不是「死了」 |

人做的决定必须落成 issue 评论或口径修改——worker 重新派工时只看得到 issue，看不到聊天。
铁律：空等和超时是 checkpoint，不是失败；只有正证据（`exited`）才能 stop / abandon。

## 4. 人说「不满意」——翻译成动作

人说的话是模糊的，你的职责是**问到能落成下表某一行为止**，然后执行并复述。

| 人的意思 | 动作 |
|---|---|
| 某个 PR 做得不对（有具体差距） | `node bin/agentctl.mjs reject --issue N --item ACC-xxx --expected … --observed … --repro …`；回原 PR 同一分支，3 轮封顶 |
| 差距不在 ACC 里（口径没写到） | 先改 issue 口径（补 ACC id），再 reject；**条目外的"我觉得"不能阻塞合并** |
| 方向错了、这个 issue 不该做 | 关 issue 并写明原因；必要时开新 issue |
| 先停一下 | 加 `hold:human`；**不要手改 `s:*`**（会被下一轮覆盖） |
| 想看现在做成什么样 | 告诉人在哪个 worktree、用 8787 端口起 `npm run serve`；不要替人审美 |

不接受的做法：直接对 worker 下指令；不留记录的口头改动；因为"人好像不满意"就自己决定重做。

## 5. 写新 issue（四块缺一不可）

1. **要做什么**（一句话目标）
2. **口径**：验收条目，每条有 ACC id，且能在 `docs/design/ACCEPTANCE.md` 里 `grep` 到
3. **涉及与不可动**：改哪些文件/模块，不改什么（api 形状、schema、`commands.mjs` 命令定义）
4. **完成定义**：可观察的证据

「涉及」列出要改 `packages/core/src/` 下的 `commands.mjs`、`schema.sql`、`store.mjs`、`handlers.mjs`、`daemon.mjs`，或 `packages/relay/` 时，在 issue 的「验收口径」里单列 `- [ACC-arch-09]`。漏列时，`agentctl tick` 会显示「补口径」，认领也会跳过这张单。

实现者在 PR 正文用 `##` 或 `###` 写一个含「六问」的标题，例如 `## ADR-0005 §13 六问`，在该节用 `1.` 到 `6.` 各写一条非空答案。不适用的题也要写明原因。`agentctl merge --pending` 缺任一答案会拒绝合并，只检查这个小节里的编号。问题见 [ADR-0005 §13](adr-0005-saas-architecture.md#13-架构验收进-ci也进每个实现单的口径)。

### 三态：`s:triage` → `s:queued` → `s:ready`

| 状态 | 意思 | 谁动它 |
|---|---|---|
| `s:triage` | 还没写口径 | 协调器写好口径；`orca-flow` **不碰** |
| `s:queued` | 口径已写好，排队等派 | 协调器写好**先给人确认**，人说可以就转 `s:queued`（`agentctl set --issue N --to queued`） |
| `s:ready` | 可派工 | **`orca-flow` 自动放行**，协调器不再手动转 `s:ready` |

每轮 `orca-flow tick` 派工前：活着的实现 / 返工 worker 少于 `FLOW_LANES` 时，按顺序（`prio:high` 优先，其余按 issue 号）把能派的 `s:queued` 转成 `s:ready`，同一轮就派工。
跳过的不卡后面的，原因写进 `orca-flow.log`：依赖没完成（正文写 `**依赖**：#X`）、口径里有 ACCEPTANCE.md 查不到的 id、涉及核心文件却缺 ACC-arch-09。
**issue 正文里出现的每个 ACC id 都算本单口径**（合并闸门逐条核对），说明文字里不要写别的单的 ACC id。
`prio:high` label 只影响排队顺序。想让某张单先做，打 `prio:high`，不要手动转 `s:ready` 插队。

## 5.1 选哪个模型（省 Claude 额度）

写新 issue 时按下表打 label，并在 issue「涉及」下一行写明理由。**拿不准就按更便宜的一档，做不过再升。**

| 档 | label | 通道 | 适合 | 例子 |
|---|---|---|---|---|
| 简单活 | `model:deepseek` | opencode + DeepSeek（火山优先，千问兜底） | 口径写得很死、改动小、模式固定、有现成测试可对照 | 改文档与验收口径；补测试；改脚本里的一个分支；按已有模式加一条命令或字段；改文案 |
| Codex | `model:codex` | Codex（Orca 原生 `--agent codex --model gpt-6.2-sol`） | 口径写得死、不靠看图判断的后端 / 脚本 / 测试单：核心逻辑、CLI、适配器内部、不稳定测试排查 | 修不稳定测试；CLI 命令内部逻辑；适配器的解析与重试 |
| 默认 | （无） | Claude Sonnet | 要读懂跨模块逻辑、改适配器或页面、新功能 | 手机交接页；新适配器能力；账号登录流程 |
| 难单 | `model:opus` | Claude Opus | **须人点头**；只在 Sonnet 反复做不过且原因是推理难度时用 | 状态机重构；并发与时序类缺陷 |

规则：
- 验收 worker 始终是 DeepSeek，与实现分开。
- `model:codex`（2026-11-21 所有者买了 Codex 20 美元档，额度有限，目的是省 Claude 额度）：
  - **不适合**：界面还原、要看设计稿的单、对外文案、须人拍板的单；这些别打。
  - 协调器打这个 label 要在 issue「涉及」下一行写理由（为什么口径够死、不靠看图）；同一时间最多 1 个 Codex worker。
  - 返工 round 1 仍走 Codex，round ≥ 2 自动升 Sonnet；同时带 `model:opus` 时 Opus 优先。
  - Codex 没装、`codex login status` 显示未登录、或冷却期内（额度用完）→ 该单自动改派 Sonnet，日志写原因。探测只看 `command -v codex` 与 `codex login status`，**不跑 `codex exec`**（一次最小请求约 1.2 万 token）。
  - 额度用完：worker 会停在用量上限的提示上，`orca-flow status` 里它的 attention 需要处理；协调器 `worker-read --source auto` 确认后 `worker-stop`，把冷却时间写进 `~/.orca/versekit-state/codex-exhausted`（格式见 `bin/worker-channel.sh`），issue 退回 `s:ready`；冷却期内 `model:codex` 自动改派 Sonnet。（原来由已删除的 coordinator-loop.sh 自动识别，现在是协调器手动，见 ACC-harness-orca-07）
  - 模型用 `CODEX_MODEL`（默认 `gpt-6.2-sol`）；本机 Codex 默认是最费额度的 gpt-6.2-astra，别用默认。不要改 `~/.codex/config.toml`（用户全局配置）；若真机发现停在信任目录或权限确认，要改配置前先问所有者。
- `model:deepseek` 的返工第 2 轮起自动升到 Sonnet；Opus 只靠显式 label，返工轮次不再自动升。
- 不要为了省事把"改页面""动适配器"这类放 DeepSeek；DeepSeek 做砸的成本（返工、真机重试）比省下的额度高。

## 6. 模型与通道（供你解释给人听）

- 验收 worker 始终走 DeepSeek：火山 `deepseek-v4.1-flash`，火山不可用自动切千问 `deepseek-v4.1-flash-1017`（`bin/dsh-model.sh`）。实现 / 返工 worker 默认 Claude Sonnet，带 `model:deepseek` label 的简单活走同一条 DeepSeek 通道，带 `model:codex` 的走 Codex 通道（选路见 §5.1，逻辑在 `bin/worker-channel.sh`）；两个 DeepSeek 通道都不可用时本轮不派，不会自动改用 Claude；Codex 不可用时该单改派 Sonnet。
- 你自己（协调器）用 Claude。验收是否也换 Claude 由人决定，目前未换。

## 7. 汇报格式

回合结束时逐 issue 汇报：**结果 · 证据（PR/评论链接）· 未解决的阻塞**。没有证据的不叫完成。
