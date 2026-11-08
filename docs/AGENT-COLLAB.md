# 多 Agent 协作规范（工单驱动）

**版本** v0.1 草案　**日期** 2026-11-08　**状态** 待评审
**适用**：`fangyouxi/versekit` 的两个（及以后更多）Orca worktree：`engineer`（实现）与 `product-design`（设计与验收）

> 这份文档不是"怎么让 agent 更聪明"，是"怎么让两个 agent 在不互相踩脚的前提下，把一件已经写清楚的事做完，并且留下证据"。
> 它属于 harness：约束靠脚本和状态机，不靠提示词里的请求。

---

## 0. 一句话结论

**别让协作靠 agent 的自觉，让协作靠工单状态 + 确定性脚本。**

- **政策层**：`PRD.md` / `BLUEPRINT.md` / `docs/design/ACCEPTANCE.md` / `AGENTS.md` —— 仓库里已有，是事实源，不改。
- **控制层**：GitHub Issue 的 label 即状态；**只有协调器脚本能改状态**，agent 只能开 PR、写评论、建 issue。
- **执行层**：Orca worktree + `orca orchestration`（派工、等待、门禁、回收）。Orca 的 Run 是短生命周期的工作区，**不是审计记录**；审计记录永远落在工单上。

三层分工的理由：Orca 的编排状态是本地、临时的，重启就没了；工单是持久、可链接、人和 agent 都能读的。**能用 `git log` 和 issue 复盘的，不要放进 agent 的上下文里。**

---

## 1. 三种协作模型，先选对再谈细节

| 模型 | 形态 | 代表实现 | 适合 |
|---|---|---|---|
| **A 单流水线** | 一个 run 内 DAG：规划 → 架构 → 设计 ∥ → 编码 → 审阅 ∥ 安全 → 测试 → 文档；失败 `onFailGoto` 回到编码，有 `maxRetries` | [orca-sdlc-kit](https://github.com/vankhangfet/orca-sdlc-kit)（JSON 配置 + `.orca/artifacts/` + 状态页） | 一个目标、一次交付、人就在旁边 |
| **B 事件驱动** | 长驻守护进程轮询工单，每个合格 issue 起一个隔离 workspace 跑 agent，状态回写工单 | [OpenAI Symphony](https://github.com/openai/symphony)（`WORKFLOW.md` + `active_states`/`terminal_states` + 每 issue 一个 workspace） | 多个 issue 并行、人不在电脑前 |
| **C 混合（推荐）** | **issue = 交付单元**；issue 内跑 A 的流水线；issue 之间用 B 的事件驱动接力 | 本文件 | 你现在的情况：2 个 worktree、目标已写好、想长期跑 |

为什么推荐 C：A 的每一步都确定性可复现，调试成本低；B 的价值只在"排队 + 隔离 + 回写"，不该把流水线本身也变成事件。**把 B 限制在边缘（谁该开始、谁该验收），中间仍是一条可重跑的流水线。**

---

## 2. 角色与权限边界（硬规则）

| 角色 | 在哪 | 能做什么 | **不能做什么** |
|---|---|---|---|
| **协调器**（确定性脚本，非 agent） | 本机 daemon | 改 `s:*` 标签、派工、建 worktree、合并（双门禁通过后）、算里程碑 | 写业务代码；判断"好不好看" |
| **实现 agent** | `engineer` worktree | 读 issue/验收条目 → 改代码 → 跑 `npm run ci` → 开 PR → 回应打回 | 给自己 PR approve；改 `s:*`；push 到别人的分支；force push 到 `main` |
| **验收 agent** | `product-design` worktree | 跑 `design:accept`、看截图/录屏、逐条比对验收条目、给 verdict、建打回 issue | push 到实现分支；改实现代码；凭"看起来不错"通过 |
| **人** | 任意 | 处理 `s:blocked`、产品判断、合并冲突、抽检 | —— |

**为什么"改状态"必须收归脚本**：状态一旦可由 agent 写，就会出现"实现 agent 自己标 review、自己标 accept"的自证循环。GitHub 的 label 权限没法细粒度到"只准改状态不准 approve"，所以用**约定 + 审计**：任何 `s:*` 变更都必须在 issue 时间线上有对应的脚本事件（`bin/agentctl` 写入的评论），人工抽检能一眼看出越权。

现状（2026-11-08 已处理）：`main` 已加 ruleset `main-protection`，连 admin 都不可绕过（`current_user_can_bypass: never`）。但**required status checks 至今不能设**——实测发现这个仓库的 Actions 从未触发过任何 workflow run（PR #36 推送后 `check-runs` 恒为 0），此时若填 required checks，所有 PR 会永久卡在 "Expected — waiting for status to be reported"。详见 §10.1。

**一个必须知道的约束**：这个仓库所有操作都用同一个 GitHub 账号 `creator-omnikit`，而 **GitHub 不允许 approve 自己开的 PR**。所以分支保护**不能**用 `required_approving_review_count >= 1`，那样会让所有 PR 永久卡死。正确做法是 ruleset 里 `required_approving_review_count: 0` + 只开 `required_review_thread_resolution`——**"必须走 PR"由规则强制，"通过与否"由 `agentctl` 判**，不假装有个人在点 approve。

---

## 3. 状态机（label 即状态）

前缀 `s:` 避免和平台/类型标签混在一起。**同一时刻一个 issue 只允许一个 `s:*`**（脚本强制，多则取最靠后的并告警）。

| 状态 | 含义 | 进入条件（谁） | 离开动作 |
|---|---|---|---|
| `s:triage` | 想法，口径未定 | 人 / 产品随手记 | 口径齐 → `s:ready` |
| `s:ready` | 可派工 | 验收条目、涉及文件、不可动边界都写清（人） | 协调器派工 → `s:doing` |
| `s:doing` | 有且仅有一个 agent 在跑 | 协调器（派工成功那一刻） | 开 PR → `s:review` |
| `s:review` | 等验收 | 协调器（收到 `pull_request.opened`） | 见下 |
| `s:changes` | 打回，等改 | 验收 agent 提交 `verdict: FAIL` | 协调器重新派工 → `s:doing` |
| `s:accept` | 通过，等合并 | 验收 agent 提交 `verdict: PASS` **且** CI 全绿 | 协调器合并 → `s:done` |
| `s:blocked` | 卡住，等人 | 任一方 + 原因（必须写"缺什么"） | 人处理后回到原状态 |
| `s:done` | 合并关闭 | 协调器（PR merged） | —— |

**合法迁移表**（其余一律拒绝并留事件）：

```
triage → ready
ready → doing → review
review → changes → doing        (循环，最多 3 轮)
review → accept → done
any → blocked → (回到进入前的状态)
```

**正交原则（从 Symphony SPEC 抄的，这条最值钱）**：`s:*` 只表达"这个 issue 对人来说处于哪个阶段"；`claimed / running / retry_queued / released` 这类**运行态只存在于调度器内存里，绝不写进 label**。两者正交，才不会出现"标签说在 review，其实 agent 早就崩了"或者"agent 还在跑，标签被手改回 ready 导致重复派工"。任何需要知道"现在谁在跑"的人，去问 `agentctl status`，不要看标签。

**一轮完整接力长这样**：

```
人/产品            agentctl                实现 agent        验收 agent
  │                   │                       │                │
  ├ 写 issue ────────►│                       │                │
  │  (带验收条目 id)   ├ 校验口径 → s:doing ───►│                │
  │                   ├ 起 worktree ─────────►│                │
  │                   │                       ├ 改代码 + ci    │
  │                   │◄── PR opened ─────────┤                │
  │                   │    s:review            │                │
  │                   ├─ 证据包 + 新 session ────────────────►│
  │                   │                       │   逐条比对 / 跑门禁
  │                   │◄── verdict ───────────────────────────┤
  │                   │                       │                │
  │        FAIL ◄─────┤ s:changes → 回 PR ───►│ (同分支改)      │
  │                   │ 轮次+1；>3 → blocked  │                │
  │        PASS ◄─────┤ 双门禁 → merge        │                │
  │                   └ Closes #N → s:done    │                │
```

**守卫**：
- `review → accept` 需要三个条件同时成立：CI **五门禁**全绿（`test` / `parity` / `adapter-contract` / `no-backdoor` / `design`）、验收 verdict=PASS、verdict 里引用了**全部**验收条目 id。缺一个就 `verdict` 无效。
- **人工干预用 `hold:human`，不直接改状态**。直接改会被下一 tick 的 reconcile 覆盖回去，而且丢了"谁改的、为什么"。`hold:human` 是唯一的冻结开关，撤掉后状态机自己恢复。
- 同一 issue 的第 3 轮 `changes → doing` 之后仍 FAIL → 强制 `s:blocked`，不再自动重试。**不设上限的重试是烧钱机器。**
- `doing` 超过 90 分钟没有新 commit 且无心跳 → 协调器标 `s:blocked`（`reason: stale`），不自动重启（重启会掩盖真问题）。

---

## 4. 验收证据包（Evidence Pack）

验收 agent 拿到的不能是"实现 agent 说它做完了"，而是一份**可机器校验的证据**。OpenAI 对 Symphony 的描述是 "proof of work: CI status, PR review feedback, complexity analysis, and walkthrough videos" —— 这个方向是对的，但本项目已经有更强的机械门禁，直接用。

PR 描述里必须有一块 YAML（脚本解析，缺字段 = 直接打回，不进人工判断）：

```yaml
issue: 42
base_sha: 125ada0
head_sha: 9f3c1ab
gates:
  test: pass            # npm test
  parity: pass
  adapter_contract: pass
  no_backdoor: pass
  design_check: pass
  design_accept: pass   # npm run design:accept -- --url http://127.0.0.1:8787
evidence:
  screenshots: [docs/design/screenshots/calendar-conflict.png]
  walkthrough: null     # 有就用录屏，没有写 null，不许编
acceptance:
  - id: ACC-calendar-03      # 必须能在 ACCEPTANCE.md 里 grep 到
    status: pass
    note: 撞车在保存前提示，截图见 evidence
  - id: ACC-calendar-04
    status: pass
```

**三条硬规则**：
1. **引用不到条目 id = 不通过**。id 用 `grep` 在 `docs/design/ACCEPTANCE.md` 里查，查不到就是编的。
2. **`design_accept` 必须是真跑过的输出**（脚本页脚带时间戳与 URL），不接受"我本地跑过了"。
3. **截图/录屏必须来自真实服务**（`npm run serve` 起的 8787），不是原型 `store.js` 的假数据。`design:accept` 已经在检查页面是否还引用 `store.js`，这条是它的语义延伸。

---

## 5. 打回协议（结构化，不是聊天）

验收失败时，验收 agent **只做两件事**：写一条结构化评论 + （可选）建一个打回 issue。

```yaml
verdict: FAIL
round: 2
failed:
  - item: ACC-calendar-03
    expected: 撞车在保存前提示
    observed: 保存成功后才弹 toast
    repro: ["选 10:00 已有排期的作品", "再选 10:00", "保存"]
    evidence: [docs/design/screenshots/calendar-conflict.png]
  - item: ACC-work-02
    expected: 每个数字旁有来源与时间
    observed: 播放数没有采集时间
must_not_change: [api 形状, 数据库 schema]   # 防止"顺手重构"
```

- **默认回 PR，不新建 issue**：`request changes` + 一条带 `<!-- agent-handback -->` 标记的机器可解析评论，状态 `s:changes`，同一分支继续改。**新建 issue 只用于"范围外发现"**（要新接口、要改 schema、需求本身矛盾），标 `origin:acceptance` + `blocks: #<PR>`，原 PR 停在 `s:changes`。
  理由：一 FAIL 就开新 issue，分支越开越多，同一件事的证据散在两处，最后没人知道该看哪个。实测调研里 Vibe Kanban / Conductor / Sculptor 全都把"反馈"留在原 PR 上，只有范围外的才另开一个。
- **打回次数上限 2–3 轮**，到顶强制 `s:blocked` + `hold:human` + @人。注意别把两个上限搞混：Orca 的 `max_turns` / Symphony 的 20 turns 是**单次会话内的轮数**，不是打回次数。
- **禁止**把打回写成"这里不太对，再看看"。**没有 `expected` / `observed` / `repro` 三件套的 FAIL 无效**，脚本会拒收并回帖要求补全。
- 打回理由必须来自 `ACCEPTANCE.md` 的条目；条目之外的"我觉得"只能开新 issue（`kind:polish`），不能阻塞 PR。**否则验收 agent 会变成审美暴君。**

---

## 6. 触发与幂等

现状约束（实测，2026-11-08）：本仓库机器人 token `core` 配额 60/h、`graphql` 配额 **0**（`gh issue list` 直接失败），`main` 无保护。这意味着：

- **不要用 GitHub Actions 跑 agent 主循环**：public repo 的 fork PR 拿不到 secrets；agent 又需要本地 `npm run serve` + 浏览器，runner 环境不匹配。
- **不要 30 秒轮询**：60/h 会在 10 分钟内打满，然后整条流水线静默停摆（静默失败 = P0，你们自己的规范）。
- **推荐**：本地 `bin/agentctl daemon`，**5 分钟一次** REST 拉取（`ETag`/`If-None-Match`，未变更返回 304 不计数），单次 2–3 个请求 → 实测 < 40 请求/h。突发事件用 `gh api` 单点查（PR opened 后 1 次）。

**GitHub Actions 不是不能用，是不能当主循环**。真要用（比如跑纯 CI 校验、发通知），这几条是硬的：

| 坑 | 事实 | 对策 |
|---|---|---|
| fork PR 拿不到 secrets | 来自 fork 的 PR 工作流无 secrets、`GITHUB_TOKEN` 只读 | 同仓分支开工（你们本来就是 team 内部 workflow），不接外部 PR 的自动化 |
| `pull_request_target` 是 pwn request | 它带 secrets + 写权限，checkout v7 起默认拒绝 checkout fork head | 别用；必须用时不允许 checkout PR 代码 |
| agent 评论自触发 | bot 发的评论会再次触发 `issue_comment` | 事件入口白名单 actor，或给 bot 自己的评论打 `skip` 标记 |
| 并发重入 | 同一 PR 连推 5 次 → 5 个 review run | `concurrency.group` 按 PR 号；review 用 `cancel-in-progress: false`（别杀掉正在写的结论） |
| 6 小时上限 | 单个 job 最长 6h | agent 任务本来就不该跑在 Actions 里，这正是要用本地 daemon 的原因 |

**Orca 这边的对应关系**（版本 1.4.237 实测）：`orca orchestration` 提供 Run / Task / Dispatch / decision gate / `worker_done` / `escalation` / `ask-reply`；`orca automations` 提供定时任务（`create` / `run` / `runs`）——**定时唤醒用 Orca automations，状态判定用 `agentctl`，两者别重叠**。

一条来自 Orca 官方文档的硬规矩：完成回执必须同时带 `taskId` 和 `dispatchId`。原因很实在——重试产生的旧消息如果不带 dispatch 身份，会把别的派发误标成完成。我们自己的脚本同理：**任何状态迁移事件都要带 `(issue, round, head_sha)` 三元组**，否则重放时会错杀。

**幂等键**：`<issue>#<state>@<head_sha>`。同一个键在 10 分钟内只派一次工。多实例/重入时，第二个实例直接跳过并写一条 `skip: duplicate` 事件，不报错。

**冷却**：`changes → doing` 同一 issue 至少间隔 2 分钟，避免"改一行 → 打回 → 再改一行"的高频抖动。

---

## 7. 里程碑与收口

- 里程碑的**出门条件**已经在 `docs/PLAN.md` §3 写成可验证句（例如 v0.1 的"TikTok + B站 `auto` 发出各 ≥1 条"）。这些条件是**验收条目**，不是"感觉差不多"。
- issue 关闭只走 `Closes #N`（PR 合并时自动），**不要手点**。手点会绕过验收。
- 里程碑进度由脚本算：`open_issues + unmerged_prs == 0` 且所有出门条件有对应 `s:done` issue → 提议关闭里程碑，交人确认。
- 周报不是 agent 写作文，是脚本输出：`agentctl report --week` 打印 完成/打回轮次/平均周期/被 block 的原因分布。人在复盘会上看这张表。

---

## 8. 反橡皮图章（这套体系最容易烂的地方）

自评是 agent 协作的第一死因。四条结构性约束，不靠"请认真评审"：

1. **评审必须换上下文**。验收 agent 起新 session，只给：issue 原文 + `ACCEPTANCE.md` 相关条目 + PR diff + 证据包。**不给实现 agent 的思考过程**（那会变成说服而不是评审）。
2. **verdict 必须引用条目**（见 §5）。没有引用的 PASS 视为无效，PR 停在 `s:review`。
3. **禁止同一 session 既写又批**。实现 agent 交出 PR 后，该 session 结束；打回时由协调器起新 dispatch（哪怕还是同一个模型）。
4. **抽检 + 棘轮**。每周人抽 5 个已 accept 的 PR 复核；发现一个橡皮图章，就往 `agentctl` 里加一条结构性规则（例如"该条目必须附截图"），并把这次的漏检写进 `docs/AGENT-COLLAB.md` 的"事故"小节。**只收紧，不放松**（[harness engineering](https://futureagi.com/blog/harness-engineering/) 的 ratchet 原则）。

---

## 9. 成本、并发与现场清理

| 项 | 默认值 | 理由 |
|---|---|---|
| 并发 dispatch | 2（实现 1 + 验收 1） | 再多就互相抢 worktree 和本地端口 |
| 单 issue 轮次 | 3 | 超过说明需求本身没说清，该找人 |
| 单 issue token 预算 | 软上限，超了记事件 | 预算爆掉通常是"打回理由含糊"导致反复试 |
| worktree TTL | 48h | 合并/放弃后 `orca worktree rm`；孤儿由 `agentctl gc` 清 |
| 分支命名 | `issue-<n>-<slug>` | 一眼能从分支回到 issue |
| 日志 | `.orca/artifacts/<issue>/<round>/` | 每个 dispatch 一个目录，含 prompt、输出、diff、证据 |

**端口冲突**：两个 worktree 同时 `npm run serve` 会抢 8787。约定：实现方用 8787，验收方用 8788（`--port`），证据包里写清 URL。

---

## 10. 落地顺序（一周能跑起来的最小版本）

| 步骤 | 产出 | 验收 |
|---|---|---|
| 1 ✅ | **已完成**：9 个 label（8 个 `s:*` + `hold:human`）+ ruleset `main-protection`（禁删、禁 force push、必须走 PR、线性历史、只允许 squash、评论必须 resolve） | `gh api repos/fangyouxi/versekit/rules/branches/main` 能查到 4 条规则；直推会报 `protected branch` |
| 1.5 | **阻塞中**：required status checks —— 原因见 §10.1，Actions 根本没在工作 | 故意让 CI 红，PR 显示 "Required" 且无法 merge |
| 2 | `bin/agentctl` 只读模式：`tick --dry-run` 打印"该派谁、为什么" | 连跑 10 轮不产生任何写操作 |
| 3 | `agentctl dispatch`：issue → `orca worktree create` → 注入 spec → 等 PR | 一个真 issue 走完 ready→review |
| 4 | 验收侧：`agentctl review <pr>` 组装证据包 + 调验收 agent | FAIL 能产出结构化评论与 `s:changes` |
| 5 | 合并：双门禁通过 → 协调器 merge → `Closes` 关闭 → 里程碑重算 | 一个 issue 走完 done |
| 6 | 抽检与棘轮 | 每周 5 个，记录在案 |

**先只读，再写状态，最后才允许自动合并。** 顺序反了，你会得到一台自动制造未验收代码的机器。

### 10.1 实测：CI 从未跑过（2026-11-08）

第一阶段的验证发现了一个比"没设 required checks"严重得多的问题。

| 检查 | 结果 |
|---|---|
| `GET /actions/runs`（全仓库） | `total_count: 0` —— 仓库 2026-10-28 建好至今，**一次都没跑过** |
| PR #36 推分支后 `GET /commits/<sha>/check-runs` | `0` |
| 同上 `check-suites` | `0` |
| repo 级 `actions/permissions` | `{enabled: true, allowed_actions: "all"}` |
| workflow `ci` 的 state | `active` |
| 是否 fork / archived | 都不是 |

也就是说：**看起来一切正常，但 Actions 就是不启动。** 唯一没查到的是 org 级策略——token 缺 `admin:org`，`GET /orgs/fangyouxi/actions/permissions` 返回 403。

**排查顺序**（需要有 org 权限的人做）：

1. GitHub UI → Settings → Actions → General，确认没有 "Disable actions"。
2. Organization settings → Actions → General，看是否限制了 `fangyouxi` 下的仓库。
3. Actions 页面首次可能要手动点一次 "I understand my workflows, go ahead and enable them"（导入型仓库常见）。
4. 幂等验证：随便推一个 commit，`GET /actions/runs` 应出现 `push` 事件。**这一步没通过之前，不要往下做自动化。**

**在那之前，required status checks 一律不能设**——填了就会让每个 PR 永久卡在 `Expected — waiting for status to be reported`，而且因为 `bypass_actors: 0`，连 admin 都解不开，只能改 ruleset。

**这段空窗期怎么办**：CI 名义上存在、实际不跑，等于**所有 PR 都是裸奔**。所以 `agentctl merge` 必须在本地跑 `npm run ci`，把真实输出（含时间戳与 commit SHA）写进证据包——这是唯一可信的门禁。等 Actions 恢复后，再把 required checks 补上，本地跑退化为"提前发现问题"而不是"唯一防线"。

---

## 11. 反模式（照着踩过的人写的）

1. **让实现 agent 自己 approve / 自己改状态** —— 自证循环，等于没有验收。
2. **验收 agent 只看 diff 不看证据** —— diff 说明"改了什么"，不说明"能不能用"。
3. **PR 太大**（>800 行或跨 3 个模块）—— 验收退化为"看起来没问题"。按 issue 切，一个 issue 一个 PR。
4. **状态存在三个地方**（label + Linear + 文档表格）—— 必然漂移。**只留 label**，其它都是投影。
5. **无上限重试** —— 打回-重试循环烧钱且掩盖需求缺陷。3 轮必停。
6. **worktree 复用给不同 issue** —— 残留改动污染下一个任务，且 diff 无从归因。
7. **验收标准写在聊天里** —— 下次没人记得。写进 `ACCEPTANCE.md`，用 id 引用。
8. **用 GraphQL 轮询** —— 本仓库当前 GraphQL 配额是 0，直接静默失败。（见 §6）
9. **agent 直接推 main** —— 没有保护 = 没有门禁。先开保护再谈自动化。
10. **让 agent 写周报** —— 会得到一份好看且不可信的叙事。要数据，让脚本出。

---

## 12. 工单系统选型：要不要学 Orca 上 Linear

**结论：这个项目不需要 Linear。你缺的不是看板，是状态机和调度器——而这两样都不由工单系统提供。**

### 12.1 Orca 为什么有 Linear 集成

因为 Orca 的用户画像就是那批用 Linear 的创业公司。Orca 同时支持 GitHub、GitLab、Jira、Linear（`orca worktree create --linear-issue <url>` / `--pr` / `--gitlab-issue`），这恰恰说明它是在**适配你已有的工单系统**，不是推销某一家。而且这些关联至今是"显式动作"——`orca linear save-issue`、`comment add` 要人（或协调器）下命令，没有"任务完成自动回写"的后台同步。这说明连 Orca 自己都没打算让工单系统当执行引擎。

### 12.2 四个候选的实测对比

| 维度 | GitHub Issues + label | Linear | Plane（自托管） | 禅道 / Gitee |
|---|---|---|---|---|
| API | REST（`core` 60/h） | GraphQL，质量最好 | REST + 官方 MCP | 禅道 REST v2.0（token）；Gitee OpenAPI v5 |
| Webhook | 有 | 有（AgentSession 必须 5s 内 ack，否则标 unresponsive） | 有（HMAC 签名） | 禅道 9.6+ 内置；Gitee 有 |
| MCP | 无官方 | 有 | 有（含 Agent Run 生命周期） | Gitee 有社区 mcp-gitee |
| 自托管 | ✗ | ✗ | ✓ 但要 10 个服务 | 禅道 ✓；Gitee 企业版 ✓ |
| 国内可达 | 差（你们已经遇到配额问题） | 无节点，webhook 回本地要公网 | 自建可控 | 最好 |
| 成本 | 0 | Free：无限成员 / 2 teams / **250 issues**；Basic $10/席/月 | 服务器 + 运维人力 | 开源版 0；企业版按需 |
| 对 agent 友好度 | **最高**（PR 就在同一个系统里） | 高，但 PR 在外 | 中，要自己接 | 低，字段模型重 |

来源：[Linear 定价](https://www.getpricepulse.com/blog/linear-pricing-2026-complete-guide.html)、[Plane MCP](https://developers.plane.so/dev-tools/mcp-server)、[Plane 自托管架构](https://dev.to/syed_anzar/plane-the-open-source-jiralinear-alternative-what-actually-happens-when-you-self-host-a-2158)、[禅道 API/Webhook](https://lib.zentao.net/test-management-tool-integration-api-webhook-plugin)、[Gitee + MCP 实践](https://segmentfault.com/a/1190000048084524)

### 12.3 为什么 Linear 对你是过度设计

1. **双事实源是自杀**。你的 PR、CI、验收脚本、证据截图全在 GitHub；状态放 Linear 就要写双向同步。Linear 官方 GitHub 同步只到"open / closed"这种粗粒度，细粒度同步得自己写——那就是"三处状态不同步"反模式的官方入口。
2. **它的强项你正好用不上**。Linear 的 Agent / Coding Sessions 是在**它的云沙箱**里跑代码然后开 PR；而你的 agent 跑在 Orca worktree 里，需要本地 `npm run serve`、真浏览器、扫码登录这些"必须在你自己机器上"的东西。这是架构错位，不是能力差距。
3. **250 issue 的墙**。开源项目一接社区 issue 就会撞。撞墙时你会被迫升级，而升级解决的是一个你本来不需要的问题。
4. **国内可达性**。webhook 要回你本机得内网穿透——这跟你产品定位里写的"用户不会配 tunnel"是同一个坑，你自己不该先踩。

### 12.4 什么情况下才值得上

满足任意两条再考虑：

- 团队 > 5 人，且有**非工程角色**（产品/运营）要天天看板，不愿意开 GitHub；
- 需要 cycle / roadmap / 项目依赖图这类"规划视图"，而不只是"这周做什么"；
- 多个仓库共用一个 intake（现在只有一个 `fangyouxi/versekit`）。

**真上了也必须单向**：脚本把 GitHub 投影到 Linear，**绝不反向写**。反向同步是状态漂移的头号来源。

### 12.5 现在该用什么

**GitHub Issues + label 状态机 + 本地 `agentctl`**，理由只有一个但足够：**PR 是最强证据源，而 PR 和 issue 天生在同一个系统里。** 任何把两者拆开的方案，都要额外造一层同步来还原它们本来就在一起的关系。

需要看板可视化时，加 **GitHub Projects**（免费、原生、和 issue 实时同步）就够；不要为了"好看的看板"引入一个新服务。国内团队如果 GitHub 访问实在不稳，退路是 **Gitee 镜像 + 同一套 label 约定**（Gitee 有 OpenAPI v5 和 webhook，状态机逻辑可以复用），但仍然保持"代码在哪、工单就在哪"。

---

## 13. 外部实践（这套东西的来源）

- [OpenAI Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md)：工单 → 隔离 workspace → agent run → 回写工单；`WORKFLOW.md` 把提示词和运行时策略**放进仓库**；`active_states`/`terminal_states` 决定谁可派工；一次成功的 run 可以停在 `Human Review` 而不是 `Done`。**"完成"由人定义，不由 agent 定义。**
- [orca-sdlc-kit](https://github.com/vankhangfet/orca-sdlc-kit)：一条 JSON 流水线，产物落盘，`onFailGoto` + `maxRetries` 让失败回到编码，`autoRun:false` 做人审门禁。**它的价值是"失败会自己回去"，不是"agent 很聪明"。**
- [Harness engineering](https://futureagi.com/blog/harness-engineering/)：仓库是事实源；约束用 linter 而不是提示词；每次事故变成一条结构性规则（ratchet）；自主权分级给。
- Orca 自身：`orca skills get orchestration`（Run/Task/Dispatch、`gate-create`/`gate-resolve`、`worker_done`/`escalation`、worker 回收）。**Orca 负责执行与隔离，工单负责政策与审计。** 两条实测细节值得抄：完成回执必须同带 `taskId` + `dispatchId`（防重试串号）；超时是"静默预算"不是失败判定（`silence is not failure`），硬超时是静默预算的 4 倍——一小时没声音的 review 可能还活着，按静默判死会误杀。
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) / [Conductor](https://www.conductor.build/) / [Terragon](https://www.terragonlabs.com/)：共同骨架是"任务 → 隔离 worktree → agent → diff/PR → **人 review → 人 merge**"，没有任何一家把合并权交给 agent。三者的现状很有说服力——Vibe Kanban 2026-04 关停公司转纯本地，Terragon 2026-02 关停，Conductor 被 Meta 收编。**这个赛道做产品很难，但做一套自己的脚本很便宜**：这也是本文主张"用 100 行的 `agentctl` 而不是引入一个 SaaS"的现实理由。
- [Anthropic 长任务 harness](https://www.anthropic.com/engineering) 与 [harness engineering 综述](https://futureagi.com/blog/harness-engineering/)：Repository as source of truth；约束用 linter 不用提示词；每次失败变成一条结构性规则（ratchet，只收紧）；自主权分级授予；**失败要读成 harness 的缺口，不是模型的缺口**。

---

## 附录 A：最小 issue 模板

```markdown
## 要做什么
（一句话）

## 口径（来自 docs/design/ACCEPTANCE.md）
- [ ] ACC-xxx-01 …
- [ ] ACC-xxx-02 …

## 涉及
- 文件/模块：…
- **不可动**：api 形状、数据库 schema、AGENTS.md 三条架构约束

## 完成定义
- `npm run ci` 全绿
- 上述条目全部 pass，并附证据
```

## 附录 B：`bin/agentctl` 命令面（草案）

```
agentctl tick [--dry-run]         # 一轮：读工单 → 算该派谁 → （非 dry-run 才写状态）
agentctl dispatch <issue>        # 起 worktree + 注入 spec
agentctl review <pr>             # 组装证据包，调用验收 agent
agentctl merge <pr>              # 双门禁校验后合并
agentctl report --week           # 周期/打回/阻塞统计
agentctl gc                      # 清孤儿 worktree 与过期 artifacts
```

---

**待定**（需要拍板）：
1. 验收 agent 的"独立上下文"标准——换模型，还是换 session 就够？调研结论倾向后者（Orca 的 dispatch 天然是新 session），但换模型能再少一层同源偏差。
2. 是否把 `agentctl` 写进 `packages/` 还是独立 `bin/`——倾向 `bin/`，它是 harness 不是产品能力，不该受"CLI 完整律"约束（但它调用的 `vk` 命令必须合规）。
3. 验收截图/录屏要不要进 git——进则仓库膨胀，不进则证据会丢。倾向：只进 `docs/design/screenshots/` 下的小图，录屏放 `.orca/artifacts/` 并在 PR 里留路径 + 摘要。
