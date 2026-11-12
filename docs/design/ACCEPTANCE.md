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
| ACC-harness-model-05 | `bash -n bin/cycle.sh bin/worker-up.sh bin/dsh-model.sh`；`bin/cycle.sh --dry-run --no-consume` | 语法检查无输出；dry-run 退出码 0，且不改任何 issue 状态 |
| ACC-harness-coord-01 | 读 `docs/COORDINATOR.md` | 含"开场""worker 的消息怎么到你这里""不满意→动作""四块 issue"四部分；明确协调器不写业务代码、不私聊 worker、不手改 `s:*`、**不拥有 Run、不 `run-use`** |
| ACC-harness-run-01 | 读 `bin/cycle.sh`；`bash -n`；`bin/cycle.sh --dry-run --no-consume` | `run-use` 出现在任何 `task-create` / `worker-start` 之前；绑定失败时输出错误码并退出非 0，不静默继续；dry-run 不触发绑定、退出码 0 |
| ACC-harness-ci-01 | `npm run ci` | 五道门禁全绿，不新增 skip |
