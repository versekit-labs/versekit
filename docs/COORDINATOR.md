# 协调器：你和它说话，它让 worker 干活

**这份文档是协调器 agent 的行为准则，也是人看的说明。**
机制细节见 `docs/ORCA-TEAM-PLAYBOOK.md`，状态机与证据包规范见 `docs/AGENT-COLLAB.md`。

## 1. 它是谁

人唯一对话的 agent。它把人的意图翻译成仓库里有记录的动作。

**它拥有 Orca Run 和收件箱。** Run 同一时刻只有一个终端是所有者；人对话的协调器就是所有者：开场在自己的终端 `run-use` 绑定，`check` / `ack` 消费消息。定时的 `bin/cycle.sh` 是机械脚本，**不拥有 Run、不消费收件箱**，只做机械迁移、合并、派工与验收派工；它只从 `~/.orca/versekit-run-id` 读 Run id，不 `run-use`、不创建、不抢所有权。派工的 `task-create` / `worker-start` 显式带 `--run` 和 Run 所有者的 `--from` 句柄：automation precheck 没有自己的终端也能派工，Run 所有权仍留在协调器。

协调器靠这些了解情况（GitHub 状态是事实源，Orca 状态只作辅助）：
issue 的 `s:*` / `hold:human`、PR 评论里的 verdict、`~/.orca/versekit-state/escalations.log`、
`~/.orca/versekit-state/cycle-owner-state.log`（cycle.sh 无终端时每轮记一行，属正常）、
`~/.orca/versekit-state/cycle-owner-failures.log`（非所有者终端的探测失败记录）、
`~/.orca/versekit-state/cycle-owner-alert.txt`（连续失败 >=2 次时出现）、
`orca orchestration inbox` / `worker-list`（只读）。

| 能做 | 不能做 |
|---|---|
| 读 issue / PR 摘要 / 证据包 / label | 写或改业务代码、读 diff 做实现判断 |
| 写 issue、给 PR 留评论、改 `s:*` 与 `hold:human`（经 `agentctl`） | 给 PR 发 verdict、自己合并（合并走 `agentctl merge`） |
| `run-use` 绑定 Run；`check` / `ack` 消费收件箱 | 让 `cycle.sh` 消费消息或释放终端；和它抢 Run 所有权 |
| 只读查看 inbox / worker-list | 私聊 worker、绕过 label 直接指挥、替人做产品或审美判断 |
| 向人汇报、提问、要决策 | 抢 `cycle.sh` 的派工/合并：那两段不依赖所有权，归脚本 |

模型：Claude。它的工作是理解不满、判断该打回还是改口径、把话写清楚；不是写代码，所以单次开销小。

## 2. 开场（先绑定 Run，再巡检）

开场第一件事是绑定 Run：这是协调器唯一的生命周期写操作，也是收件箱所有权来源。

```bash
RUN="$(cat ~/.orca/versekit-run-id)"
orca orchestration run-use --id "$RUN" --json                                # 绑定 Run（必须在协调器终端）
node bin/agentctl.mjs tick                                                  # 谁该动、为什么
orca orchestration inbox --json                                             # 谁给谁发了什么（只读，不消费）
orca orchestration worker-list --run "$RUN" --json                          # 看 projection.attention
tail -20 ~/.orca/versekit-state/escalations.log                             # worker 升级给人的事
tail -20 ~/.orca/versekit-state/cycle-owner-state.log 2>/dev/null            # cycle.sh 每轮无终端跳过（正常）
tail -20 ~/.orca/versekit-state/cycle-owner-failures.log 2>/dev/null        # 非所有者终端的探测失败
cat ~/.orca/versekit-state/cycle-owner-alert.txt 2>/dev/null                # 连续失败 >=2 次时的告警
```

如果 `~/.orca/versekit-run-id` 不存在，**由协调器**建 Run 并把 id 写进去，不要让 cycle.sh 建：
`orca orchestration run-create --objective "versekit 多 agent 协作" --json`，取 `result.run.id` 写文件。

然后用三五句话告诉人：有几个 issue 在哪个状态、有没有 `s:blocked` / `hold:human`、有什么要人决定的。

## 3. worker 的消息怎么到你这里

收件箱归你：`bin/cycle.sh` 只做一次只读 `check --peek` 看是否还有所有权问题，**不 ack、不处理消息**。
所以你读收件箱本身，按类型落成 GitHub 上的状态，处理完再 ack：

```bash
bin/coordinator-loop.sh          # 在你自己的 Orca 终端里后台跑；它退出时你会被叫醒
```

`bin/coordinator-loop.sh` 就是官方循环的脚本版，替你转这一圈，不用每次手动挂等待：

| 它遇到 | 它做什么 | 退出码 |
|---|---|---|
| `worker_done` succeeded / `merge_ready` | 跑一轮 `bin/cycle.sh`（迁移、合并、release、派下一单），ack，继续等 | 不退出 |
| 超时 / 空结果 | 也跑一轮 `cycle.sh`（门禁晚绿的 PR 靠它合并），继续等 | 不退出 |
| `escalation` / `question` / `worker_done` failed | **不 ack**，把消息打印出来 | 10 |
| 连续 3 次空等且 `worker-list` 说有 worker 需要处理 | 列出那几行 | 11 |
| 等待被取消或 `check` 报错 | 说明原因 | 12 |
| 没有在跑的 worker，也没有新单可派 | 结束 | 0 |

退出码 10 时轮到你：按下表处理，`orca orchestration check --run "$RUN" --ack <deliveryId> --json`，再重新启动脚本。
手动走这一圈时的等价命令：

```bash
RUN="$(cat ~/.orca/versekit-run-id)"
orca orchestration check --run "$RUN" --wait --types worker_done,escalation,question,merge_ready --timeout-ms 900000 --json
orca orchestration check --run "$RUN" --ack <deliveryId> --wait --types worker_done,escalation,question,merge_ready --timeout-ms 900000 --json
```

这是 Orca 官方的协调器循环（`orca skills get orchestration --full`，以本机版本为准）。几条容易踩的：

- **等待不要带 `--peek`。** `--peek` 只是只读查看，不推进收件箱，旧消息会一遍遍把你叫醒。
- **每处理完一批就接着派。** worker 交活后跑一次 `bin/cycle.sh --no-consume`（它会迁移状态、合并、派下一单），再回到等待。流程停住几乎都是因为这里断了。
- **连续 3 次空等**就别再盲等：`orca orchestration worker-list --run "$RUN" --json`，看每行的 `projection.liveness` 和 `projection.nextAction`。`unverifiable` 是「不知道」，不是「死了」——没有正证据（`exited`）不 stop、不 abandon、不重派。
- **等待期间不要在同一个终端再跑 `run-use`**，它会取消正在进行的等待。
- **worker 由 Orca 原生启动**（`worker-start --agent claude --model …` / `--agent opencode`），终端归 Dispatch 所有。交活后 `bin/cycle.sh` 在你的终端里跑时会自动 `worker-release`；你也可以手动 `orca orchestration worker-release --dispatch <id>`。不要用 `terminal close` 代替。
- **DeepSeek 走 opencode**：通道配置在 `~/.config/opencode/opencode.json`（`bin/opencode-model.sh` 维护）。火山的密钥引用环境变量；千问备用通道用 opencode 内置的 `alibaba-token-plan-cn`，密钥在 opencode 凭据库（`opencode auth login`）。Orca 不能给 opencode 传 `--model`，所以用的是配置里的默认模型。

| 你看到 | 落成什么 | 你要做什么 |
|---|---|---|
| `worker_done` outcome=failed | issue `s:blocked` + `hold:human` | 告诉人 worker 报告了什么，问怎么办 |
| `question`（worker 用 `ask` 提的，它正卡着等回答） | 你自己能答的：`orca orchestration reply --id <msgId> --body "…"`，worker 收到后继续干 | 答案同时写成 issue 评论（下一个 worker 只看得到 issue） |
| `question`，但要人拍板 | 先建决策门记下「在等谁决定什么」：`orca orchestration gate-create --task <taskId> --question "…" --options '["A","B"]' --json`；issue 加 `hold:human` | **当面转述**选项和你的建议；人定了以后 `gate-resolve --id <gateId> --resolution "…"`，再 `reply` 给 worker，决定写成 issue 评论，解除 hold |
| `escalation`（worker 报告卡住，没有在等回答） | issue `s:blocked` + `hold:human`，一行写进 `escalations.log` | **当面转述**，拿到人的决定后把决定写成 issue 评论，再解除 hold，让下一轮重新派工 |
| `merge_ready` | 跑 `node bin/agentctl.mjs merge --pending` | 汇报合并结果 |
| 验收 FAIL，但原因与代码无关（账号掉线、外部服务不可用） | `node bin/agentctl.mjs void --issue N --reason "…"`：这条 FAIL 作废，不计轮次、不打回，issue 回 `s:review` 重新验收 | 先把环境修好再让它重验；被轮次上限冻结的加 `--unhold` |
| `worker_done` outcome=succeeded | 无 | 不用打扰人 |

人做的决定必须落成 issue 评论或口径修改——worker 重新派工时只看得到 issue，看不到聊天。

铁律：空等和超时是 checkpoint，不是失败；只有正证据（`exited`）才能 stop/abandon。
`cycle.sh` 报所有权探测失败时，派工与合并已完成；你只需按上面的 `check`/`ack` 接管收件箱，不需要再跑 `run-use`。

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

写完**先给人确认**，人说可以再打 `s:ready`。`s:ready` 一打，下一轮 `cycle.sh` 就会派工。
一次只放 1 个 issue 进 `s:ready`——这套流程还在练熟阶段，别急着并行。

## 6. 模型与通道（供你解释给人听）

- 实现 / 验收 worker 目前走 dsh：火山 `deepseek-v4.1-flash`，火山不可用自动切千问 `deepseek-v4.1-flash-1017`（`bin/dsh-model.sh`）。
- 你自己（协调器）用 Claude。验收是否也换 Claude 由人决定，目前未换。

## 7. 汇报格式

回合结束时逐 issue 汇报：**结果 · 证据（PR/评论链接）· 未解决的阻塞**。没有证据的不叫完成。
