# 多 Agent 协作 · 人话版操作手册

**这份文档给「你」看**，不是给 agent 看。
给 agent 的规则在 `docs/AGENT-COLLAB.md`（那份是规范，有状态机、有字段格式、有反模式清单）。
Orca 编排层怎么运转、消息怎么走，见 `docs/ORCA-TEAM-PLAYBOOK.md`。
这份回答的是：**明天早上打开电脑，我该干什么？**

---

## 一、这套东西在干什么（一句话）

> 你写一份"要什么"，两个 agent 接力做到"能验收"，全程用 GitHub issue 当交接单。

打个比方：**你是甲方，issue 是施工单，PR 是验收单，CI 是质检机。**

- 你只在两个时刻出现：**开工前**（写清楚要什么）和**卡住时**（做决策）。
- 中间的"改代码 → 提 PR → 逐条验收 → 打回重改 → 通过合并"，agent 自己转。

---

## 二、三个角色

| 角色 | 是谁 | 干什么 | 不干什么 |
|---|---|---|---|
| **你** | 人 | 写需求、定验收标准、处理卡住的事 | 不逐行看代码，不手工改状态 |
| **实现 agent** | `engineer` worktree 里的那个 | 读 issue → 改代码 → 跑测试 → 开 PR | 不给自己发通行证 |
| **验收 agent** | `product-design` worktree 里的那个 | 拿证据 → 逐条比对 → 判 PASS/FAIL | 不改实现代码，不凭感觉通过 |
| **协调器** | `bin/agentctl.mjs` | 读工单 → 算"该谁动" | **不写业务代码，不做审美判断** |

关键点：**验收 agent 和实现 agent 是两个不同的上下文**。实现方自己说"我做完了"不算数——这是整套体系唯一真正重要的约束。

---

## 三、一个 issue 的一生

```
你写 issue（带验收条目 id）
        │
        ▼
   s:triage ──你补完口径──► s:ready
                              │
                    agentctl 说「该派工」
                              ▼
                          s:doing ──► agent 改代码
                              │
                          开 PR（带证据包）
                              ▼
                          s:review
                              │
                   agentctl 说「该验收」
                              ▼
                    验收 agent 逐条比对
                       ╱          ╲
                    FAIL          PASS
                      │             │
                s:changes      s:accept
                      │             │
               agent 继续改     双门禁校验
                （同一分支）         │
                      │          合并 PR
                      └──► s:doing    │
                                      ▼
                                   s:done
                              （issue 自动关闭）
```

**三个数字要记住**：

- **3 轮**：同一个 issue 被打回超过 3 次，自动停到 `s:blocked`，必须你做决定。不是怕花钱，是说明**需求本身没说清**。
- **90 分钟**：`s:doing` 超过 90 分钟没动静，标成停滞，等人看。
- **2 个请求**：agentctl 一次只发 2 个 API 请求。因为配额可能只有 60/h，烧光就静默停摆。

---

## 四、你不用派工，agent 自己会来抢

**这是这套流程最重要的性质**：没有任何一步需要你说「去做 #12」。

**实际只有一个** Orca 定时任务在转（`orca automations list` 可查）：`coordinator`，每 10 分钟一次，
prompt 里只跑 `bin/cycle.sh`。三段动作由脚本内部完成，不是三个独立任务：

| 脚本阶段 | 频率（随 coordinator） | 干什么 |
|---|---|---|
| 机械迁移 | 每 10 分钟 | `agentctl tick --apply`：`doing` 有 PR 了 → 推到 `review` |
| 派工 | 每 10 分钟 | `claim` 抢一个 `s:ready` 的 issue，起 worker，做到底并开 PR |
| 验收派工 | 每 10 分钟 | 取队列里第一个待验收 PR，逐条比对 ACC，给 PASS/FAIL |

它们互不知情、也不需要知道彼此——全靠 label 这个原子状态交接（抢单机制：先删 `s:ready`，删成功者赢）。

> 注意：`coordinator` 的 `reuseSession` 是 `false`，所以每轮都会新起一个 session；
> 验收侧不抢单，同一个 PR 可能被重复派。这两点是现在内存和重复任务的来源，详见
> `docs/ORCA-TEAM-PLAYBOOK.md` §9。

### 你每天只需要做两件事

#### 1. 看一眼有没有 `human` 的活

```bash
npm run agentctl -- tick
```

```
 #11  s:ready    engineer     派工实现
       └ 口径齐，且没有进行中的 PR
 #14  s:review   acceptance   派工验收
       └ PR 已开，等逐条比对验收条目（PR #15 · 9f3c1ab）
 #16  s:blocked  human        需要人
       └ 3 轮打回后仍未通过
────────────────────────────────────────────────────────────────
  engineer 1 · acceptance 1 · human 1   |   配额 4917/5000
```

**只看 `human` 那几行。** 其余两行是 agent 自己会去抢的，你不用管——事实上你也不该管，你插手反而会和它抢。

#### 2. 处理 `human` 的活

| 看到什么 | 你要做什么 |
|---|---|
| `s:triage` | 写清验收条目（能 grep 到 ACC id 的那种），然后打 `s:ready` |
| `s:blocked` | 看打回理由：改需求 / 砍范围 / 自己动手，然后改回 `s:ready` |
| `修状态` / `查停滞` | 标签和实际对不上，判断真实情况再改 |

#### 干预：用 `hold:human`

**别直接改 label。** 打 `hold:human` 上去，调度器就绕开它；撤掉就恢复。

直接改状态会和 `agentctl-tick` 打架，而且丢了「谁改的、为什么」。

### 如果你想手动推一把

不用等定时任务，直接触发一次：

```bash
orca automations run 5f5bc1e6-4538-4081-a9fc-fb7885254e07   # engineer 立刻抢一次
orca automations run 8b04610a-2a81-4701-b782-4970b04004a8   # 验收立刻跑一次
```

或者自己看看队列里有什么（不改任何状态）：

```bash
npm run agentctl -- claim --role acceptance   # 只是列出来，不认领
```

---

## 五、写 issue 的正确姿势

issue 是施工单，写得含糊，agent 就只能猜。**四块内容缺一不可**：

```markdown
## 要做什么
一句话。

## 口径（来自 docs/design/ACCEPTANCE.md）
- [ ] ACC-calendar-03
- [ ] ACC-calendar-04

## 涉及
- 文件/模块：packages/web/public/calendar.html
- **不可动**：api 形状、数据库 schema、AGENTS.md 三条架构约束

## 完成定义
- `npm run ci` 全绿
- 上述条目全部 pass，并附证据
```

**最重要的一行是"口径"**：验收 agent 判 PASS 时必须逐条引用这些 id。引用不到的 PASS 是无效的——这是防"橡皮图章"的机械保障。

id 从哪来？`docs/design/ACCEPTANCE.md` 里本来就有。写完 grep 一下确认能搜到。

---

## 六、命令速查

```bash
# 看今天该干什么（不动任何东西）
npm run agentctl -- tick

# 看详情（带 label 和链接）
npm run agentctl -- tick --verbose

# 机器可读
npm run agentctl -- tick --json

# 本地跑全部门禁（CI 挂了时的替代）
npm run ci

# 以仓库绑定账号操作 GitHub
bin/ghx issue list
```

---

## 七、现在能用什么 / 还不能用什么

**已经能用**：

- ✅ 状态机（9 个 label：`s:triage` … `s:done` + `hold:human`）
- ✅ 分支保护（走 PR、只允许 squash、评论必须 resolve、4 项 required checks）
- ✅ CI 真跑（迁移到 `versekit-labs` 之后）
- ✅ `agentctl tick` 算"该谁动"

**还不能用**（按顺序做）：

- ⬜ `agentctl dispatch`：自动开 worktree + 注入任务（**先要 tick 连续跑稳**）
- ⬜ `agentctl review`：自动组装证据包 + 调验收 agent
- ⬜ `agentctl merge`：双门禁通过后自动合并
- ⬜ 轮次统计（要拉 PR 评论，会突破 2 请求上限，得先做缓存）
- ⚠️ `test / npm test` 在 CI 上会挂住（本地 214 项全绿 16 秒），暂时没设成 required

**为什么不能一口气全做**：自动化写操作的前提，是判断逻辑已经稳定。顺序反了，你会得到一台自动制造未验收代码的机器。

---

## 八、出问题时的排查顺序

1. **`agentctl` 报错** → 看 stderr 第一行，它会说清是认证、仓库还是 API
2. **配额告警** → `tick` 会打印剩余量，低于 10 会警告；降低频率
3. **label 和实际对不上** → `tick` 会把异常标成 `human / 修状态`，不会自己猜
4. **CI 红但本地绿** → 先看是不是 `test` 那个已知问题（见第七节）
5. **完全不知道怎么回事** → `docs/AGENT-COLLAB.md` §10.1 有这次踩坑的完整记录

---

## 九、一句话总结

**你负责说清"什么算做完了"，别的都交给流程。**

流程不信任任何 agent 的自述——它只信三样东西：GitHub 上的状态、CI 的结论、验收条目上的逐条勾选。