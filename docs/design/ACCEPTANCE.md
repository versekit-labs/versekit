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

> **真机红线（2026-11-14 起，11-15 扩大）**：`@测试` 小红书号被平台处罚，用户确认的根因是**开发机（Mac mini，英国）与手机（美国）同时使用同一个号，IP 来回跳**，当天短时间内又自动发了多篇测试笔记。
> 因此**开发机上的任何 agent（实现、验收、协调器）不得对任何平台的真实账号做登录、发布、体检或采集**，包括"仅自己可见"和草稿；只用 stub driver、fixture、录制页面或隔离的假账号。
> 需要真实账号的验证写进 PR 的「待人工」，由用户在**与手机同一网络的另一台电脑**上按试用说明执行，结果回填到 PR。

## 二、逐页验收项（v1，已作废，仅留档；v2 见第十节）

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
- [ACC-account-06] （真机部分**仅用户本人在自己电脑上执行**；开发机上的验收只用 stub driver / 录制的登录页，不打开真实平台页面）小红书扫码登录不弹窗口：在账号页对小红书账号点「重新登录」，页面里直接显示二维码（后台无头 Chrome 取自创作服务平台登录页），**屏幕上不出现新的浏览器窗口**；扫码确认后，页面无需刷新自己变为「正常」。开发机验收：用录制页面 / stub 模拟「出码 → 已扫 → 确认成功」，验证页面无窗口、自动变「正常」。真机核对（用 `@测试` 扫一次，关闭该账号 Chrome 后再做一次账号检查仍为 `ok`）写进 PR 的「待人工」，由用户在与手机同网的电脑上做。
- [ACC-account-07] 二维码过期（约 1–2 分钟）时页面自动换新二维码或给出「刷新」并能换新；已扫未确认时显示「请在手机上确认」；失败（被风控、页面结构变化）时用人话说明并给出备用入口：短信验证码登录、打开登录窗口。不得静默卡住。
- [ACC-account-08] CLI 同等可用：`vk account login <id> --qr` 输出二维码图片路径并等待到成功或过期；`vk account login <id> --phone <11 位手机号>` 与 `--code <验证码>` 能被正确解析（单元测试覆盖参数解析；不得在测试里真的发短信）。
- [ACC-account-09] 状态不冒充：账号行显示「上次检查时间」；超过 24 小时未检查的显示「待确认」而不是「正常」。发布创建/排队时对目标账号做一次真实检查（指调用适配器的 `check()`，而不是读库里的旧状态），未登录直接拦下并提示「重新登录」，publish 不落到执行阶段才失败。开发机验收用 stub driver 让 `check()` 返回未登录来验证拦截；真实平台上的检查列为「待人工」。
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
- [ACC-publish-04] 素材类型与平台能力不匹配时在**创建前**拒绝并说人话：素材类型与平台声明的 `assetTypes` 不符时，发布台直接提示该平台能发什么并不创建 publish；不得把图片当视频硬传（小红书图文支持后见 ACC-publish-06）。
- [ACC-publish-05] `auto_running` 有总时限（默认 5 分钟，可配置）：超时后转 `failed`，写 `error_code=timeout` 与人话原因（停在哪一步），关闭为它开的浏览器；发布台与 `vk publish list` 都能看到失败原因和「重试」入口。任何发布不得无限停在 `auto_running` 而没有错误。
- [ACC-publish-06] 小红书支持**图文**笔记：发布台选图片素材（jpg/png/webp，1–18 张）发小红书不再被拒；适配器在发布页切到「上传图文」、按顺序上传全部图片、填标题（≤20 字）与正文（≤1000 字）、话题从话题面板选；视频素材仍走「上传视频」，两种不混用。同一作品里图片与视频混选时创建前拒绝并说人话。
- [ACC-publish-07] （**仅用户本人手动执行，agent 不得执行**，见真机红线）用测试账号（「测试探针」组的 `@测试`）以**草稿/仅自己可见**方式真实发一条 2 张图的图文：publish 进入 `done`（或平台草稿成功的等价终态），创作服务平台里能看到这条图文且图片顺序正确；失败时有 `error_code` 与人话原因，不得停在 `auto_running`。验收证据含平台页面截图。
- [ACC-publish-08] （真机部分**仅用户本人手动执行**；agent 只用录制的接口响应 / fixture 验证判定逻辑）小红书点「发布」后，以平台的**发布接口响应**（或发布后在笔记管理里按标题+时间查到新笔记）判定成功，不只靠跳转 `/publish/success` 或页面文字；平台已发出时 publish 必须进入 `done` 并记下笔记 id/链接。用 `@测试` 发一条（仅自己可见/草稿）验证：平台出现该笔记 ⇔ versekit 显示成功。
- [ACC-publish-09] 点击「发布」之后判不出结果时，不得当作可重试的 `flaky_ui` 自动重试或转草稿（会重复发帖）：转为「结果待确认」类终态，error_message 说明「已点击发布、未确认结果，请到笔记管理核对」，并自动去笔记管理核对一次；核对到就改判成功。点击之前的失败仍按原重试规则。
- 实现提示 命令：`vk publish <asset> --group <g> --to ... --schedule ... --dry-run`

### 交给手机（已取消，2026-11-14）

用户决定不做该模式（手动步骤太多），#120 已关闭。下面 ACC-handoff-* 作废，不再验收；保留仅供将来重提时参考。真机红线不受影响。

- [ACC-handoff-01] 账号发布模式新增 `handoff`（交给手机）：`vk account mode <id> handoff` 可设，**新建的小红书账号默认 `handoff`**，已有小红书账号由迁移改为 `handoff`。handoff 账号的 publish 到点时**不启动浏览器、不发出任何访问小红书域名的请求**，直接进 `notify_pending`，`fallback_reason=phone_handoff`。测试用 stub driver / 拦截 fetch 断言调用次数为 0。
- [ACC-handoff-02] 交接页：每条 handoff publish 有一个签名链接 `/h/<token>`（复用审批链接的 HMAC 与 24 小时有效期；与 `/a/` 同一安全边界，是局域网可访问的第二个路径，其他接口仍只允许本机）。在 375px 宽的手机视口里依次显示：账号名、标题、正文（含话题）、全部图片（按作品顺序）或视频。图片可长按保存，另有「保存全部图片」入口。
- [ACC-handoff-03] 「复制标题」「复制正文」在 **http 局域网地址**（非 secure context）下也能用，复制成功有提示；失败时退回到选中文本并提示手动复制，不得无反应。
- [ACC-handoff-04] 「打开小红书」按钮用深链拉起 App（scheme 须在 PR 里给出处；查不到可靠出处时只拉起 App 首页）。当页面处在 secure context 且 `navigator.canShare({ files })` 为真时，额外显示「一键分享到小红书」，用 Web Share API 把图片和正文一起交给系统分享面板；条件不满足时该按钮不出现，也不报错。
- [ACC-handoff-05] 回执：交接页有「我已发布」（可选粘贴笔记链接，只接受 `xiaohongshu.com` / `xhslink.com`，记入 `external_url`）→ publish 进 `published`；「这次不发了」→ 终态并记原因。重复点击按 `command_audit` 去重；链接过期或 publish 已终结时页面说人话，不再显示按钮。CLI 有等价命令（走 `commands.mjs`）。
- [ACC-handoff-06] 通知：到点时飞书卡片带交接链接和标题；电脑端发布台 / 作品页对该 publish 显示「待在手机上发布」和交接链接的**二维码**（手机扫码直接打开交接页）。二维码生成零运行时依赖（可移植 MIT 实现，文件头写 `ported from`）。
- [ACC-handoff-07] handoff 账号不参加定时体检、不做数据采集、不要求电脑登录：账号页显示「交给手机 · 无需在电脑登录」，不得显示「未登录 / 已过期 / 重新登录」，`vk doctor` 也不把它算异常。
- [ACC-handoff-08] 验收全程不碰小红书：验收证据包含 driver 调用计数与网络请求记录，证明零访问小红书域名；真机「扫码打开交接页 → 在 App 里发布」列为 PR 的「待人工」，由用户本人做。
- [ACC-handoff-09] 手机经 Tailscale 访问：`vk serve` 新增 `--host <地址>`（可只绑一个地址，如本机的 `100.x` Tailscale IP，不必用 `--lan` 的 0.0.0.0）；生成交接链接时，若配置了 `server.public_url` / `VK_PUBLIC_URL` 就用它，否则在存在 Tailscale 地址（`100.64.0.0/10`）时**优先用它**，再退到局域网 IP。`vk doctor` 报告交接链接的实际地址，以及它在 http 下不是 secure context（只影响一键分享，复制与保存不受影响，见 ACC-handoff-03/04）。非本机请求仍只放行 `/a/` 与 `/h/`，其余接口 403（有测试）。

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
| ACC-harness-cycle-11 | 删掉本地分支 `issue-N-lane-1` 与 `rework-N` 目录（远端分支保留），让 `bin/cycle.sh --max 1` 为该 issue 新建返工 worktree | `ensure_rework_worktree` 的 stdout **只有** `path:<绝对路径>` 一行，git 的提示（如 `branch '…' set up to track '…'`）不得混入；`worker-start` 第一次就成功，不出现 `selector_not_found`（2026-11-15 #101 返工三连败的根因）|
| ACC-harness-cycle-12 | 用假 `orca` 让某个在跑的 worker：(a) `worker-read` 末尾出现额度/限流错误（`exceeded … quota`、`usage limit`、`HTTP 429`）；(b) 终端输出连续 30 分钟没有变化 | 循环**不得**再报「worker 仍在跑，无需处理」：(a) 下一次检查就以退出码 11 停下，(b) 30 分钟到点以退出码 11 停下；日志写明 issue 号、dispatch id、原因（额度用尽/疑似卡住）和 `worker-read` 末尾几行（不含密钥）。不自动 kill，由协调器决定 `worker-stop` 后重派。不以 `lastHeartbeatAt` 判活（正常干活的 worker 心跳也可能只有派出时一次）（2026-11-15 #102 验收因火山周额度用尽空挂近 1 小时）|
| ACC-harness-cycle-13 | 用假 `bin/ghx` 让 `issue view --json labels` 失败（首次失败、或两次都失败），对一个带 `model:opus` 的 `s:ready` issue 跑 `bin/cycle.sh --max 1` | 首次失败：重试一次后照常按 `model:opus` 派出；两次都失败：日志写 `✗ 取 #N 的 label 失败：<stderr 摘要>`，**该单本轮不派**、保持 `s:ready`，下一轮再试；任何情况下都不得在取不到 label 时退回 Sonnet 派出（2026-11-15 #145 带 `model:opus` 却被 Sonnet 做了） |
| ACC-harness-loop-01 | 在同一项目里先起一个 `bin/coordinator-loop.sh`，再起第二个；然后 `kill -9` 第一个，留下旧的锁文件，再起一次 | 第二个立即退出（退出码 14），stderr 写明「已有循环在跑：pid=<N>」，不调用任何 `orca`/`cycle.sh`；第一个不受影响。锁文件在 `COORD_STATE_DIR` 下，记 pid；锁里的 pid 已不存在（或不是本项目的循环）时视为陈旧锁，接管并在日志写一行；正常退出（任何退出码）都删掉自己的锁，不删别人的 |
| ACC-harness-loop-02 | 起循环后 `pgrep -fl 'coordinator-loop\[<项目名>\]'`；再在另一个项目目录里起一个同名脚本（或用临时目录模拟），重复一次 | 进程命令行带项目名，形如 `coordinator-loop[versekit]`；按项目名 pgrep 只命中本项目的循环；项目名默认取仓库名（`origin` 远端的仓库名，取不到用仓库目录名），可用 `COORD_PROJECT` 覆盖；脚本内容不写死 `versekit`，同一份脚本放进别的项目可直接用；`docs/COORDINATOR.md` 写明按项目名查进程的命令 |
| ACC-harness-leak-01 | 假 `orca` 包装脚本：让一个 worker 完成并被 `cycle.sh` 处理（ack）后，查看 `terminal close` 调用 | 该 worker 的终端被自动关闭；验收 worker 同理；仍在运行的 worker 终端不被关；关闭失败只写日志，不阻断整轮 |
| ACC-harness-leak-02 | 假 `orca` 与假 `dsh-model.sh`：`$role.channel` 记录 volc，本轮选 qwen，跑 `ensure_terminal` | 先关闭旧终端、再新建；日志含「通道切换，已关旧终端」；不出现两个终端同时留存 |
| ACC-harness-leak-03 | 假 `orca` 返回超过「lane 数 + 2」个已完成未关的 worker 终端，跑 `bin/cycle.sh --max 1` | 派工前先清理已完成终端；清完仍超上限则不再开新终端并写 `cycle-owner-alert.txt`；上限可配置 |
| ACC-harness-leak-04 | 读 `bin/cycle.sh` 验收任务书模板，并实际跑一次验收 | 任务书要求收尾关闭自己起的 Chrome 与测试服务，且只关自己启动的（按 pid/端口），不碰 `~/.local/state/versekit/browser/` 下的登录窗口；验收结束后 `ps` 中无该验收遗留的测试 Chrome |
| ACC-harness-leak-05 | 假 `orca`：`worker-list` 返回 50 个已结算 worker，它们的终端已不存在（如重启后），`terminal close` 回 `terminal_handle_stale`；跑 `bin/cycle.sh --max 1` 两轮 | 已不存在的终端按「已关」记入台账、不计入「未关」数，不触发上限告警，本轮照常派工；第二轮不再对这些 handle 重复 close、日志不刷屏（每轮至多一行汇总） |
| ACC-harness-claude-01 | 选定通道为 claude 时用 `bin/worker-up.sh` 起一个实现 worker 终端，发一条最小请求，读终端底部模型名与进程命令行 | 终端里跑的是 Claude Code（`claude`，不是 dsh），模型为 Sonnet（`claude-sonnet-5-5` 或别名 `sonnet`）；以跳过权限确认的模式启动，无人值守时不会停在权限确认框；起终端后能被 `worker-start --terminal` 正常派工并收到 `worker_done` |
| ACC-harness-claude-02 | `bin/cycle.sh --dry-run --no-consume`（或假 `orca`）各准备一个 `s:ready` 与一个 `s:review` 的 issue，看日志里每次派工选的通道 | 实现 worker（含返工）默认走 claude 通道；验收 worker **始终**走 DeepSeek 通道（volc 优先、qwen 兜底），不会选 claude；日志每次派工写明「角色 → 通道 → 模型」 |
| ACC-harness-claude-03 | 给 issue 打 `model:opus` label 后派实现；另造一个第 3 轮返工（round ≥ 3）派工 | **只有显式 `model:opus` label** 才用 Opus（`claude-opus-5-5` 或别名 `opus`）；返工轮次不再自动升 Opus（额度原因，2026-11-14）；其余实现单子用 Sonnet；日志写明选择原因 |
| ACC-harness-claude-04 | 让 claude 通道不可用（`PATH` 里没有 `claude`，或用假 `claude` 模拟额度用完/限流报错），跑一轮实现派工 | 自动降级到 DeepSeek 通道照常派工，stderr/日志写明降级原因；不会因 claude 不可用整轮停派；通道变化时按 ACC-harness-leak-02 先关旧终端；探测不打印任何凭据 |
| ACC-harness-claude-05 | 读 claude 通道实现 worker 的任务书；`bash -n bin/*.sh`；`grep -nP '\$[A-Za-z_]\w*[^\x00-\x7F]' bin/*.sh` | 任务书明确「只改本 worktree 内、工单涉及的文件，不碰 worktree 以外的路径、不改用户全局配置」；语法检查与 grep 均无输出 |
| ACC-harness-claude-06 | 给 issue 打 `model:deepseek` label 后派实现；再造该 issue 的一个返工（round 1）派工；用假 `claude`（调用即报错并记录）跑 | 实现与返工 worker 都走 DeepSeek 通道（`--agent opencode`，volc 优先、qwen 兜底），**全程不调用、不探测 claude**；日志写明「issue 带 model:deepseek label → DeepSeek」；DeepSeek 两个通道都不可用时本轮不派并说明原因，**不得自动改用 claude** |
| ACC-harness-claude-07 | `model:deepseek` 的 issue 造第 2 轮及以后的返工派工 | 自动升到 Sonnet（简单活 DeepSeek 做不好时的台阶），日志写明「DeepSeek 第 N 轮仍未过 → 升 Sonnet」；仍不自动升 Opus；`IMPL_CHANNEL` / `IMPL_MODEL` 显式覆盖照旧生效 |
| ACC-harness-claude-08 | 读 `docs/COORDINATOR.md` | 有「选哪个模型」一节：给出 `model:deepseek`（简单活）/ 默认 Sonnet / `model:opus`（须人点头）三档的判定表与例子；写新 issue 时协调器必须按它打 label，并在 issue 里写明理由 |
| ACC-harness-ci-01 | `npm run ci` | 五道门禁全绿，不新增 skip |

## 账号浏览器的内存（driver-browser）

每个账号一个独立 Chrome profile 是为了登录态隔离，必须保留；要管的是「用完不收、守护进程重启后留孤儿」。

| ACC id | 怎么验 | 通过标准 |
|---|---|---|
| ACC-browser-mem-01 | 起 `vk serve`，触发一次账号检查（会起该账号 Chrome），然后 `kill -TERM` 守护进程 | 守护进程退出前关闭它起的所有账号 Chrome；`ps` 里不再有 `--user-data-dir=…/browser/acc_*` 进程 |
| ACC-browser-mem-02 | 先手动留一个账号 Chrome（模拟上次守护进程被 `kill -9` 留下的孤儿），再起 `vk serve` 并空闲等待超过空闲回收时限（测试可用环境变量缩短） | 新守护进程接管或关闭孤儿：空闲时限到后该 Chrome 被关闭；正在被用户使用（有非空白标签页）的登录窗口不被强关 |
| ACC-browser-mem-03 | 在账号页点「重新登录」→ 扫码成功 | 登录确认成功后，登录用的可见窗口在 10 秒内自动关闭（或转为无头），不会一直留在屏幕和内存里 |
| ACC-browser-mem-04 | 设 `VK_BROWSER_POOL=2` 起服务，依次对 3 个账号触发检查 | 同时存活的账号 Chrome 不超过 2 个；第 3 个排队或复用槽位，不报错；默认值与上限行为不变 |
| ACC-browser-login-01 | 从**后台会话**（`launchctl managername` 输出 `Background`，例如 agent 的 shell）起 `vk serve` 或直接调 driver，对一个临时账号 id 开 Chrome，用 CDP 写入一个带 30 天有效期的测试 cookie，等待落盘后关闭该 Chrome，再重新打开同一账号 | 重新打开后该 cookie 仍在；profile 的 `Default/Cookies` 里 `cookies` 表行数 > 0。验收人必须自己实际执行这一步，不得引用实现方的证据；不得读取或打印任何真实账号 cookie 的值 |
| ACC-browser-login-02 | 构造「cookie 存不下来」的情形（例如用环境变量关掉修复、或让 cookie 存储不可写），然后跑 `vk doctor --human` 与一次账号检查 | 明确用人话报出「登录不会被保存」及原因，不静默；修复生效的正常情形下该项为通过 |
| ACC-browser-login-03 | 关闭账号 Chrome（空闲回收、守护进程退出、`closeAccount`）之前刚发生过登录或 cookie 变更 | 关闭前留出落盘时间或主动刷盘，优先 `Browser.close`；紧接着重开，刚写入的持久 cookie 不丢 |

## 十、v2 验收口径（作品为中心，2026-11-15）

依据：`docs/PRD.md` v0.2、`docs/design/HANDOFF.md`（v2）、`docs/design/*.html`、`docs/design/screenshots/v2/`。第一节的真机红线照旧适用。

### 模型与入库

- [ACC-v2-cut-01] 一个作品有 1 到多支成片，一支成片有 1 到多个语言版本。`vk work add <一个视频文件>` 得到 1 个作品、1 支成片、1 个版本；多支成片、多语言用同一条命令的完整形式入库。同一来源、同一标题重复入库是更新，不新建。
- [ACC-v2-cut-02] 平台稿挂在成片下并记录用的是哪个语言版本；同一作品在同一个账号上可以有多条平台稿（每支成片最多一条）。旧库升级后每个旧作品有一支成片，原有平台稿、快照、任务都还在；`npm test` 全绿。
- [ACC-v2-work-01] `vk work list` 和 `vk work show <id>` 输出 JSON：作品、成片、每条平台稿的状态。作品状态由平台稿推出，只取最要紧的一个：出了问题 > 等确认 > 已确认等时间 > 都发完了。

### 确认（红线）

- [ACC-v2-confirm-01] 没有人确认的平台稿，到了建议时间也不会被队列领取、不会发出。有测试钉住：造一条到点但未确认的平台稿，跑一轮队列，断言没有任何发布尝试。
- [ACC-v2-confirm-02] 按成片确认：一次确认这支成片下所有非小红书的待确认平台稿。小红书的平台稿不会被这次确认带上。有测试钉住。
- [ACC-v2-confirm-03] 小红书每条三种决定：按建议时间发、现在发、我自己发。"这支先不发"跳过整支成片，包括小红书那条；跳过的以后还能再确认。
- [ACC-v2-confirm-04] 确认前可以改每条的标题和时间，发布用的是改后的值（所有平台的适配器都读改后的标题）。
- [ACC-v2-confirm-05] 以上每个动作都是 `commands.mjs` 里的命令，CLI、HTTP、卡片按钮由它派生；现有 `publish.confirm`（notify 模式下确认已在 App 里发完）含义不变。
- [ACC-v2-confirm-06] 改的时间违反平台规则时拒绝，并给出最近的可用时间。默认值：每个平台、每个账号每日上限 10 条，最小间隔 10 分钟（所有者 2026-11-15 定），写在配置里，可以按平台覆盖。
- [ACC-v2-confirm-07] 平台稿用自己那支成片、那个语言版本的文件发布：传给适配器的素材路径由 core 按平台稿的 `version_id` 解析，适配器不自己读 `work` 表。有测试钉住：同一作品长片、短片各一条平台稿，发短片那条时，适配器拿到的是短片文件。

### 发布方案（最小形式，所有者 2026-11-16 定）

- [ACC-v2-plan-01] `vk plan apply <cutId> [--accounts a,b] [--group 名字]` 为这支成片生成平台稿（命令在 `commands.mjs` 定义为 `plan.apply`，CLI、HTTP 由它派生）。不给 `--accounts` 时按 PRD 的默认方案：当前账号组里**所有已接入平台**的账号各一条。每条挂在这支成片下、用它的语言版本（有多个版本时默认 `zh`，没有 `zh` 用第一个），状态一律是待确认，不会自动发。已经有平台稿的账号跳过并在输出里列出，重复执行不新建。
- [ACC-v2-plan-02] 建议时间按 ACC-v2-confirm-06 的平台规则排：从现在起找每个账号最近的可用时间，不违反每日上限和最小间隔；输出里每条带建议时间。有测试钉住：同一账号已有一条 10 分钟后的平台稿时，新稿的建议时间不早于它之后 10 分钟。
- [ACC-v2-plan-03] 平台稿发出去用的是**成片**的标题和元数据：生成时由 core 把成片标题写进平台稿（如 `overrides_json`，人在确认前改过的值优先），适配器不再 JOIN `work` 表取标题/元数据（与 ACC-v2-confirm-07 同理，零后门）。有测试钉住：作品标题与短片标题不同，发短片那条时适配器拿到的是短片标题。

### 今天、账号组、和平时比

- [ACC-v2-today-01] `vk today` 输出 JSON 四块：等确认的作品（按成片分）、出了问题的、已确认等时间的队列（按时间排）、最近发布满 24 小时的结果。
- [ACC-v2-group-01] work、today、stats 类命令默认只看当前账号组，可用 `--group` 指定；能查到其他每个组各有几件事等处理。
- [ACC-v2-base-01] 倍数 = 这条发布 24 小时的播放 ÷ 同一个账号最近 20 条发布 24 小时播放的中位数。2 倍及以上标"比平时好"，一半及以下标"比平时差"，阈值可配。这个账号历史不足 5 条时不给倍数。任何地方都不把不同平台的播放数相加。

### Web

- [ACC-v2-web-01] 真实服务上 `/today`、`/works`、`/work`、`/data`、`/system` 返回 200；侧栏四项顺序和 `docs/design` 一致；页面数据来自 `/api`，不含原型的演示数据（`WORKS`、"露营小记"）。还没实现的页面显示"还没做"的空状态，不能 404。
- [ACC-v2-web-02] 今天页的结构、文案、状态词和 `docs/design/today.html` 一致，1360 宽截图和 `docs/design/screenshots/v2/today.png` 并排对得上：聚焦面板（视频、各平台一行、小红书单独一块、吸底的确认按钮）、右侧成片列表与"接下来要发"、其他待办各一条、最近结果表。没有待办时是 `today.html` 里那个安静的空状态。
- [ACC-v2-web-03] 确认一支成片后自动跳到下一支还没处理的；按钮文字带条数（"确认这 6 条，按时间发"）；只有 1 支成片时不出现成片列表，只有 1 个语言版本时不出现语言切换。
- [ACC-v2-web-04] 作品页和作品详情页与 `works.html`、`work.html` 及对应截图一致：按状态筛选、按标题搜；平台图标三态（已发、未发、出问题）；详情里发过的成片每行显示倍数，出问题时有红底说明和"再试一次"。
- [ACC-v2-web-05] 账号组切换在侧栏顶部，只有一个组时也显示；别的组有待办时带数字；每页副标题带当前组名；切换后页面只显示那个组的内容。
- [ACC-v2-web-06] `npm run design:check -- --url <服务地址>` 通过；颜色、字号、圆角只用 `DESIGN.md` 里有的。

### 飞书卡片

- [ACC-v2-card-01] 新作品入库后 1 分钟内发"新作品，等你确认"卡片。点"开始确认"后按成片一支一支发确认卡片：上一支处理完（确认或先不发）才发下一支。
- [ACC-v2-card-02] 确认卡片、改标题或时间的表单、小红书单独卡片的结构与 `docs/design/feishu-cards/` 一致，平台行按这支成片实际的平台稿生成。点完后原卡片原地更新成结果，按钮消失，重复点不会执行第二次。
- [ACC-v2-card-03] 账号组多于一个时卡片标题带组名；只有一个时不带。
- [ACC-v2-card-04] 卡片测试只用 fixture 和假的发送函数，不往任何真实飞书会话发消息。

