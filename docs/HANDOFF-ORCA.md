# Orca 协作流程 · 交接说明

**写给在 `main` worktree 接手的你/agent。**
写这份文档时，代码在 `main`（commit ≥ `3fe1099`），但**闭环最后一环没打通**：`worker-start` 报错，具体原因还没看到。

---

## 一、架构（已定，不要改）

```
main (projects/versekit)
  └─ coordinator automation（每 10 分钟，claude）
       跑 bin/cycle.sh，只调度，不写代码

engineer / engineer-2 / engineer-3
  └─ 实现 worker（并发 3）

product-design
  └─ 验收 worker
```

**为什么这样分**：Orca 官方 `placement-and-remote.md` 明确「新 worker 是新终端，不是新 worktree」，默认用现有 workspace。之前用 `new-per-run` 每次建 worktree 是错的，已改掉。

---

## 二、已完成

| 组件 | 位置 | 状态 |
|---|---|---|
| 状态机 | GitHub label `s:*` | ✅ 9 个 label 已建 |
| 分支保护 | ruleset `main-protection` | ✅ 4 项 required checks 生效 |
| `agentctl` | `bin/agentctl.mjs` | ✅ `tick` / `claim` / `set` 都跑通 |
| 一轮协调 | `bin/cycle.sh` | ⚠️ 前三段能用，第 3 段最后一步失败 |
| dsh worker 准备 | `bin/worker-up.sh` | ✅ 实测能起可派工的 dsh 终端 |
| coordinator automation | id `d43265fa-498e-4fc1-a965-aab828e89b82` | ✅ 每 10 分钟 |
| engineer worktree | engineer / engineer-2 / engineer-3 | ✅ 已建 |

**已真实验证跑通的**（不是纸面）：
- `#12` 由验收 agent 判 PASS → `s:accept` → 合并 → issue 自动关闭
- `#11` 判 FAIL → `s:changes` → 返工 worker 提交新 commit（PR #15）
- dsh worker 能收 preamble、执行命令、发 `worker_done`（带 taskId + dispatchId）

---

## 三、卡在哪

```
== 3/3 验收派工 ==
  → 验收 #11（PR #15）
    ✗ worker-start 失败：{"id":"...","ok":false, ...}
```

**错误被截断了**。我已经把错误输出改成只提取 `error.message`，但还没跑一次看结果。

**下一步就一件事**：在 `main` worktree 跑

```bash
bin/cycle.sh
```

看 `worker-start 失败：<message>` 里到底说什么。

### 最可能的三个原因

1. **`task_not_startable`** —— 这个 Task 已经被派过。`cycle.sh` 每轮 `task-create` 新 task，理论上不会；但如果 worker-up 复用了同一个终端，Orca 可能认为该终端已有活跃 dispatch。
2. **终端已被占用** —— `worker-up.sh` 起的终端如果之前的 worker 还没释放，`--terminal` 会冲突。
3. **`--run` 没传对** —— 已验证传了，但 `RUN_ID` 来自 `~/.orca/versekit-run-id`（当前是 `run_bb1ce736a2de`），如果那个 Run 状态异常也会失败。

---

## 四、关键的环境差异（这是我没调通的主因）

| 环境 | Run 绑定 | 结果 |
|---|---|---|
| 我在 engineer worktree 的终端 | 早前 `run-create` 过，**自带绑定** | `task-create` 不传 `--run` 也能成功 |
| automation 起的 main 新终端 | **没有绑定** | 必须显式 `--run`，否则失败且错误信息含糊 |

**教训**：`bin/cycle.sh` 里所有 orchestration 调用都必须显式带 `--run "$RUN_ID"`。已经全加了，但如果哪天又失败，先查这条。

---

## 五、命令速查

```bash
# 看板（只读）
node bin/agentctl.mjs tick

# 一轮协调（会派工、会合并）
ENGINEER_WTS="path:.../engineer,path:.../engineer-2,path:.../engineer-3" \
ACCEPTANCE_WT="path:.../product-design" \
bin/cycle.sh

# 只演练不执行
... bin/cycle.sh --dry-run

# 手动触发 automation
orca automations run d43265fa-498e-4fc1-a965-aab828e89b82

# 看 automation 跑出了什么
orca automations runs --id d43265fa-498e-4fc1-a965-aab828e89b82 --limit 3
orca terminal list | grep -A1 "coordinator run"   # 取最后一个，不是第一个！

# 看 worker 队列
orca orchestration worker-list --run run_bb1ce736a2de --json
```

---

## 六、已知问题（不影响打通，但要知道）

1. **CI 的 `test` job 会挂住 10 分钟**，占并发，导致后续 PR 的 required checks 排队。治本是给 `ci.yml` 加 `timeout-minutes: 10`，还没做。
2. **验收会被重复派**：`acceptance` 队列没有认领锁，同一个 PR 在多轮里会被多个 worker 看。不致命（验收可重入），但浪费。
3. **`agentctl` 的网络重试刚加**，还没在真实失败场景下验证过。

---

## 七、不要做的事

- ❌ 不要用 `--workspace-mode new-per-run` 建 worker worktree（官方说默认用现有）
- ❌ 不要用 `--agent dsh` 派工（会起未配置 profile，停在引导页）
- ❌ 不要让实现 agent 自己改 `s:review`（自证）
- ❌ 不要在 `2>/dev/null` 里跑 orchestration 命令（错误会被吞，今天为此浪费了两小时）

---

## 八、当前的 board

跑 `node bin/agentctl.mjs tick` 看最新。写这份文档时：

```
#11  s:review   acceptance   PR #15 待验收（返工已提交）
```

`#12` 已合并关闭。