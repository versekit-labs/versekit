# 设计验收

设计方（本分支）只做两件事：**定稿**与**验收**。实现由另一个 session 在 `packages/` 里做。
这份文件是验收口径，验收人只认这里写的东西。

## 一、验收怎么跑

```bash
# 1. 起真实服务（实现方负责）
npm run serve                      # http://127.0.0.1:8787

# 2. 机械验收（一条命令）
npm run design:accept -- --url http://127.0.0.1:8787

# 3. 全量门禁（实现方合并前必须自己跑过）
npm run ci
```

> 页面路径映射写在 `scripts/design-accept.mjs` 的 `PAGES` 表里（`/accounts`、`/plan`…）。
> 实现方若改路由，必须同步改这张表并在 PR 说明——验收脚本以它为准。

`design:accept` 会依次检查并给出通过/打回：

| 检查 | 判定 |
|---|---|
| 九个页面在真实服务上返回 200 | 缺一个就红 |
| 页面**不再引用** `store.js`（原型假数据） | 引用了就是没接真实数据 |
| 页面引用了 `api.js` 或含 `fetch('/api` | 没有就是硬编码 |
| `design-check --url` 通过（任务书/导航/死链/检测器/触控/溢出/hidden） | 任一失败即打回 |
| 每页的任务书存在 | 缺一页即打回 |
| [ACC-gate-01] 每页、每个视口加载后无未捕获脚本错误（`Runtime.exceptionThrown` / error 级控制台消息） | 任一页出现即打回，并输出页面名与错误文本 |

## 二、逐页验收项

每页都要过三件事：**数据来自 `/api`**、**每个动作有对应命令**、**空/错/权限三态真实**。

> **条目 id 是给机器看的。** PR 里的证据包必须逐条引用 `ACC-*` id 并给 pass/fail；
> 引用不到的 PASS 无效（见 `docs/AGENT-COLLAB.md` §4）。改条目文案时不要改 id——
> id 是跨 PR 的稳定引用，文案可以演进而 id 不能。

### 账号页 `account-wall.html`
- [ACC-account-01] 只显示**当前账号组**的五个平台槽位；未接入的显示缺口与添加入口。
- [ACC-account-02] 点账号行，详情在组内就位；主动作指向具体账号。
- [ACC-account-03] 空组：五个缺口 + 一句引导，不能白屏。
- [ACC-account-04] 状态文案与接口一致：`/api/accounts` 返回 `state=ok` 时页面显示「正常」，不得显示「即将过期」；同一平台只渲染一个槽位。
- [ACC-account-05] 在账号页点「重新登录」并在弹出的窗口里完成登录后，不用刷新、不用再点别的：页面自己检查登录态，成功才把该账号显示为「正常」；没登录成功时不得显示成功，也不得保持「已失效」不变（小红书、B站都要）。数据库里的 `account.state` 与页面一致。
- 实现提示 命令：`vk account list --group <g>`、`vk account reauth <id>`、`vk account remove <id>`

### 选择账号组 `groups.html`
- [ACC-groups-01] 首次进入无当前组时落到这里；选组后所有页面跟着变。
- [ACC-groups-02] 新建组后进入空组，不报错。
- 实现提示 命令：`vk group list`、`vk group add`、`vk group use`

### 矩阵总览 `matrix.html`
- [ACC-matrix-01] 跨组只读；点格子进入对应组。
- [ACC-matrix-02] 页面明确写"只读"，不能在这里改数据。

### 发布台 `publish.html`
- [ACC-publish-01] 只列**当前组**账号；已失效的账号不可选并说明原因。
- [ACC-publish-02] 平台差异字段只出现在真正不同的地方；预演列出将发生什么。
- [ACC-publish-03] 发布后生成 work + 多条 publish，状态可查。
- [ACC-publish-04] 素材类型与平台能力不匹配时在**创建前**拒绝并说人话：小红书适配器目前只支持视频，选了图片素材发小红书，发布台直接提示「这个平台目前只能发视频」并不创建 publish；不得把图片当视频硬传。
- [ACC-publish-05] `auto_running` 有总时限（默认 5 分钟，可配置）：超时后转 `failed`，写 `error_code=timeout` 与人话原因（停在哪一步），关闭为它开的浏览器；发布台与 `vk publish list` 都能看到失败原因和「重试」入口。任何发布不得无限停在 `auto_running` 而没有错误。
- 实现提示 命令：`vk publish <asset> --group <g> --to ... --schedule ... --dry-run`

### 发布计划 `calendar.html`
- [ACC-calendar-01] 一条排期 = 一个作品一张卡，卡上带该作品要去的平台；**不要拆成平台碎片**。
- [ACC-calendar-02] 周/月/列表三视图；手机默认列表。
- [ACC-calendar-03] 改期 1 步可达（快捷项），保存有 toast + 撤销；过去时间拦截；撞车在保存前提示。
- [ACC-calendar-04] 撞车必须在卡片上有标记，不能只在摘要里报数。
- [ACC-calendar-05] 空档行可逐日选择。
- 实现提示 命令：`vk schedule list --group <g> --from --to`、`vk schedule move`、`vk schedule cancel`

### 作品详情 `work.html`
- [ACC-work-01] 每个数字旁边有来源与时间；采集缺口要画出来。
- [ACC-work-02] 平台级状态逐平台显示，不用一个状态盖住全部。

### 总览 `overview.html`
- [ACC-overview-01] 数字带口径（作品数 vs 平台发布数分开）；跨组汇总只读。
- [ACC-overview-02] 数据新鲜度面板与账号页一致。

### 任务与日志 `runs.html`
- [ACC-runs-01] 失败条目就地展开现场：错误码、平台原文、尝试次数、任务号。
- [ACC-runs-02] 重试有上限；不静默放弃。
- 实现提示 命令：`vk run list`、`vk publish retry`

### 添加账号 `add.html`
- [ACC-add-01] 组已锁定；已接入平台灰掉并说明被谁占用。
- [ACC-add-02] 完成回到账号页能看到新账号。
- [ACC-add-03] 添加 B站账号后，用户在页面上点一次即可完成登录，全程不需要打开终端、不需要复制命令；账号页 B站失效后的「重新登录」同样是点一次开扫码窗，不开终端。`biliup … login` 命令最多作为「高级/手动」折叠项保留，不得是必经步骤。
- [ACC-add-04] 登录完成后页面自己检查并给出结果（成功 / 失败原因），不依赖用户回来点「我已登录，检查」；失败有可读原因与重试入口，不静默。没有真的完成登录时不得出现「重新登录完成」「已登录」等成功文案——只有 `login.status` / `check` 确认 `state=ok` 才算成功。
- 实现提示 命令：`vk account add --group <g> <platform>`

## 三、数字一致性（最容易糊弄的地方）

同一组、同一时间范围，三处必须相等：

```
页面显示  ==  CLI --json  ==  /api 返回
```

抽查三条：
```bash
vk schedule list --group ai --from 2026-11-01 --to 2026-11-30 --json | jq '.works | length'
curl -s 'http://127.0.0.1:8787/api/schedule?group=ai&from=2026-11-01&to=2026-11-30' | jq '.works | length'
# 与计划页摘要里的「N 个作品」对照
```

## 四、判定

| 结论 | 含义 |
|---|---|
| **通过** | `design:accept` 全绿 + 逐页项全过 + 数字一致 |
| **打回** | 任一机械项失败，或逐页项缺失，或数字对不上 |
| **有条件通过** | 只欠非阻塞项（如 hover 预览、拖拽改期），需在 PR 里列出并登记 |

打回时验收意见写到 PR 评论，格式：`[打回] 页面 / 验收项 / 实测 / 期望`，一条一行，实现方逐条回复。

## 五、不在验收范围

视觉风格的主观偏好、动效手感、文案润色——这些在设计阶段定稿，验收只查"是否照做"。
要改设计，先改 `DESIGN.md` 与对应 surface brief，再改实现；反向操作一律打回。

## 九、Harness 验收口径：dsh 模型通道与协调器准则

不是界面验收，但流程要求每个 issue 的口径都能在这里 `grep` 到 ACC id，所以和界面条目放在同一份文件。
验收人**不得打印、复制或引用 `~/.dsh/.credentials.yaml` 的内容**。

| ACC id | 怎么验 | 通过标准 |
|---|---|---|
| ACC-harness-model-01 | `dsh --profile dsh-tui --patch bin/dsh/volc-flash.patch.yml --dump-config`，再对 `qwen-flash.patch.yml` 重复一次，看最后一个 `agent-default-model` | 火山为 `arkcli-coding-plan` / `deepseek-v4.1-flash`；千问为 `qwen-token-plan-cn` / `deepseek-v4.1-flash-1017` |
| ACC-harness-model-02 | `STATE_DIR=$(mktemp -d) bin/dsh-model.sh --force` | 火山可用时 stdout 只有 `volc`，退出码 0 |
| ACC-harness-model-03 | `ARKCLI_CODING_PLAN_API_KEY=bad STATE_DIR=$(mktemp -d) bin/dsh-model.sh --force` | stderr 说明火山不可用，stdout 只有 `qwen`，退出码 0 |
| ACC-harness-model-04 | `HOME=$(mktemp -d) ARKCLI_CODING_PLAN_API_KEY= QWEN_TOKEN_PLAN_CN_API_KEY= STATE_DIR=$(mktemp -d) bin/dsh-model.sh --force` | stdout 为空，stderr 说"本轮不派工"，退出码 1 |
| ACC-harness-model-05 | `bash -n bin/cycle.sh bin/worker-up.sh bin/dsh-model.sh`；`grep -nP '\$[A-Za-z_]\w*[^\x00-\x7F]' bin/*.sh`；`bin/cycle.sh --dry-run --no-consume` | 语法检查无输出；grep 无输出（变量名后紧跟全角标点会在 `set -u` 下报未绑定，`bash -n` 查不出）；dry-run 退出码 0，且不改任何 issue 状态 |
| ACC-harness-model-06 | 用 `bin/worker-up.sh` 在选定通道为 volc 时起一个 worker 终端，发一条最小请求后读终端底部模型名，并看该 dsh 进程的实际出站连接 | 模型名是火山的 `deepseek-v4.1-flash`（不是千问的 `-1017`）；出站连接指向 `ark.cn-beijing.volces.com`（不是千问 token-plan 的地址）；`--dump-config` 对、运行时不对也算失败。通道为 qwen 时同理反向验证 |
| ACC-harness-coord-01 | 读 `docs/COORDINATOR.md` | 含"开场""worker 的消息怎么到你这里""不满意→动作""四块 issue"四部分；明确协调器不写业务代码、不私聊 worker、不手改 `s:*`；**协调器拥有 Run 与收件箱，开场 `run-use` 并 `check` / `ack`**；`cycle.sh` 不拥有 Run、不消费收件箱、不释放终端 |
| ACC-harness-run-01 | 读 `bin/cycle.sh`；`bash -n`；`env -u ORCA_TERMINAL_HANDLE bin/cycle.sh --dry-run --no-consume` | 可执行的 `run-use` / `run-create` / `ack` / `worker-release` 调用为 0；`task-create` / `worker-start` 显式带 `--run` + Run 所有者 `--from`；消费段只有只读 `check --peek`，失败写 `cycle-owner-failures.log`、连续 >=2 次写 `cycle-owner-alert.txt`，且不阻断派工/合并；无终端 dry-run 退出码 0 |
| ACC-harness-cycle-01 | 在无终端环境（如 `env -i` 或 Orca automation precheck）下运行 `bin/cycle.sh --max 1` | 不再因 `no_active_sender_terminal` 退出；`task-create` / `worker-start` 用 Run 所有者的 `--from` 完成派工，`s:ready` 的 issue 能被派工（派工失败只影响该 issue，不回滚整轮） |
| ACC-harness-cycle-02 | 让 Run 所有权探测失败一次以上（如 `ORCA_TERMINAL_HANDLE` 指向非所有者终端）；无终端 automation 跑两轮 | 非所有者：日志写明错误码/原因，每次写 `cycle-owner-failures.log`，连续 >=2 次写 `cycle-owner-alert.txt` 供协调器开场读取；无终端：正常跳过并写 `cycle-owner-state.log`；两者都不阻断派工、都不 ack |
| ACC-harness-cycle-03 | 对照 `docs/COORDINATOR.md` 与 `bin/cycle.sh` 注释 | 分工一致、不互相抢占：Run 与收件箱归协调器；脚本不依赖终端句柄也能完成派工与合并；无所有权时跳过消费/结算并留痕，不 ack |
| ACC-harness-cycle-04 | 用假 `orca` 包装脚本让 `worker-start` 首次失败、第二次成功，跑 `bin/cycle.sh --max 1` | 同一 task 在短退避后自动重试至多 2 次，重试前不新建 task；日志含失败回执的 stderr 与 `failedStage`/`residualResources`；成功后只有 1 个 task、1 个 Dispatch |
| ACC-harness-cycle-05 | 让 `worker-start` 连续失败（假 `orca`），跑一轮后 `orca orchestration task-list --ready` | issue 退回 `s:ready`，该 task 被标记为已放弃，`ready` 列表里没有无 Dispatch 的孤儿；下一轮同一 issue 不会因此重复新建 task |
| ACC-harness-cycle-06 | 在 `env -i HOME=$HOME bin/dsh-model.sh --force`（无 shell 环境变量，模拟 automation precheck）与普通终端下各跑一次，密钥来源只用 `~/.zshrc` 的 `export` 行 | 两种环境选出同一通道；读取只在内存，不打印、不写文件、不改 `~/.zshrc`；读不到才降级到千问并说明原因 |
| ACC-harness-cycle-07 | 准备一个 `s:changes` 的 issue（有验收 FAIL 评论与原 PR 分支），跑 `bin/cycle.sh --max 1` | 自动派返工 worker，任务书引用最近一条验收评论并要求在原分支继续；派出后 issue 变 `s:doing`；3 轮封顶后不再派，转 `s:blocked` + `hold:human` |
| ACC-harness-cycle-08 | 准备两个互不相关的 `s:ready` issue（涉及文件不相交），`bin/cycle.sh --max 2` | 每个 issue 各得到**独立 worktree、独立终端、独立 Dispatch**，不会把两个 issue 塞进同一 worktree；`dispatch-<id>.json` 各记各的 issue |
| ACC-harness-cycle-09 | 准备两个 `s:ready` issue，「涉及」里列了同一个文件 | 只派其中一个，另一个保持 `s:ready` 并在日志写明「与 #N 涉及同一文件，串行」；工单没写「涉及」的文件时按串行处理 |
| ACC-harness-cycle-10 | `git ls-files bin`；对同一 PR 在验收未结束时连续跑两轮 `bin/cycle.sh` | 仓库里不存在 `bin/cycle.sh-E`；同一 PR 同一 head 不会被重复派验收（沿用验收锁）；并行 lane 数有上限（默认 3，可配置）；旧 lane 的 worktree 空闲后可复用，不无限新建 |
| ACC-harness-leak-01 | 假 `orca` 包装脚本：让一个 worker 完成并被 `cycle.sh` 处理（ack）后，查看 `terminal close` 调用 | 该 worker 的终端被自动关闭；验收 worker 同理；仍在运行的 worker 终端不被关；关闭失败只写日志，不阻断整轮 |
| ACC-harness-leak-02 | 假 `orca` 与假 `dsh-model.sh`：`$role.channel` 记录 volc，本轮选 qwen，跑 `ensure_terminal` | 先关闭旧终端、再新建；日志含「通道切换，已关旧终端」；不出现两个终端同时留存 |
| ACC-harness-leak-03 | 假 `orca` 返回超过「lane 数 + 2」个已完成未关的 worker 终端，跑 `bin/cycle.sh --max 1` | 派工前先清理已完成终端；清完仍超上限则不再开新终端并写 `cycle-owner-alert.txt`；上限可配置 |
| ACC-harness-leak-04 | 读 `bin/cycle.sh` 验收任务书模板，并实际跑一次验收 | 任务书要求收尾关闭自己起的 Chrome 与测试服务，且只关自己启动的（按 pid/端口），不碰 `~/.local/state/versekit/browser/` 下的登录窗口；验收结束后 `ps` 中无该验收遗留的测试 Chrome |
| ACC-harness-claude-01 | 选定通道为 claude 时用 `bin/worker-up.sh` 起一个实现 worker 终端，发一条最小请求，读终端底部模型名与进程命令行 | 终端里跑的是 Claude Code（`claude`，不是 dsh），模型为 Sonnet（`claude-sonnet-5-5` 或别名 `sonnet`）；以跳过权限确认的模式启动，无人值守时不会停在权限确认框；起终端后能被 `worker-start --terminal` 正常派工并收到 `worker_done` |
| ACC-harness-claude-02 | `bin/cycle.sh --dry-run --no-consume`（或假 `orca`）各准备一个 `s:ready` 与一个 `s:review` 的 issue，看日志里每次派工选的通道 | 实现 worker（含返工）默认走 claude 通道；验收 worker **始终**走 DeepSeek 通道（volc 优先、qwen 兜底），不会选 claude；日志每次派工写明「角色 → 通道 → 模型」 |
| ACC-harness-claude-03 | 给 issue 打 `model:opus` label 后派实现；另造一个第 3 轮返工（round ≥ 3）派工 | 两种情况都用 Opus（`claude-opus-5-5` 或别名 `opus`）；其余实现单子用 Sonnet；日志写明升级原因（label / 返工轮次） |
| ACC-harness-claude-04 | 让 claude 通道不可用（`PATH` 里没有 `claude`，或用假 `claude` 模拟额度用完/限流报错），跑一轮实现派工 | 自动降级到 DeepSeek 通道照常派工，stderr/日志写明降级原因；不会因 claude 不可用整轮停派；通道变化时按 ACC-harness-leak-02 先关旧终端；探测不打印任何凭据 |
| ACC-harness-claude-05 | 读 claude 通道实现 worker 的任务书；`bash -n bin/*.sh`；`grep -nP '\$[A-Za-z_]\w*[^\x00-\x7F]' bin/*.sh` | 任务书明确「只改本 worktree 内、工单涉及的文件，不碰 worktree 以外的路径、不改用户全局配置」；语法检查与 grep 均无输出 |
| ACC-harness-ci-01 | `npm run ci` | 五道门禁全绿，不新增 skip |
