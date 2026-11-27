# 设计验收

设计方（本分支）只做两件事：**定稿**与**验收**。实现由另一个 session 在 `packages/` 里做。
这份文件是验收口径，验收人只认这里写的东西。

## 一、验收怎么跑

```bash
# 1. 起离线服务（实现方负责）：只能用 --offline，不得起会连真实平台的服务
export VK_HOME=$(mktemp -d)
npm run hifabu -- demo seed            # 演示数据：待确认（长片+短片）、已发布（有好有差）、出问题
npm run hifabu -- serve --offline      # http://127.0.0.1:8787；不跑队列/体检/采集，不接飞书，平台类接口返回 offline_mode

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
- [ACC-account-10] 账号名是 VerseKit 里给自己看的名字，不影响平台，也不设无谓的限制（所有者 2026-11-23：各平台的号都叫 AssureLane，和账号组同名，被添加表单拦住）：添加或改名时，名字只要求去掉首尾空格后非空、不超过 40 个字；**可以和账号组同名，可以和同组其他平台的账号同名**（一个平台在一组里只有一个位置，靠平台区分）。系统页添加表单与 `vk account add` / `POST /api/accounts` 用同一套规则（规则在 core，网页不另加限制）；有测试钉住「名字 = 组名」「两个平台同名」都能加成功，空名被拒并用人话说明。**输入法组字时按回车不提交**（所有者 2026-11-23：用拼音输入法打英文，回车本想上屏，表单却直接提交，名字存成了「A s su re L a ne」并弹出登录）：网页所有「回车即提交」的输入框（添加账号名、改名、新建账号组、凭据、手机号、验证码等）在 `event.isComposing` 为真或 `keyCode === 229` 时不提交；有浏览器测试用组字中的回车事件钉住。
- [ACC-account-11] 账号能改名：`vk account rename <账号 id> --name <新名字>`（`commands.mjs` 定义一次，HTTP 与网页由它派生）；系统页账号行有「改名」，就地编辑、保存后不刷新页面即显示新名字。只改 VerseKit 里的名字：账号 id、平台标识（handle / 平台用户 id）、登录状态、凭据、已有平台稿与发布记录都不变；今天页、排期、作品页、飞书卡片之后都显示新名字。名字规则同 ACC-account-10；改名写一条事件。有测试钉住改名前后上述字段不变。
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
hifabu schedule list --group ai --from 2026-11-01 --to 2026-11-30 --json | jq '.works | length'
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
| ACC-harness-model-07 | 用假 `orca` 让在跑的验收 worker 的 `worker-read` 末尾出现 `You have exceeded the 5-hour usage quota. It will reset at 2026-11-16 13:47:50 +0800 CST`，此时 `dsh-model.sh` 的 1 token 探测仍返回 200（模拟 2026-11-16 实况）；跑一轮 `bin/coordinator-loop.sh` 与 `bin/cycle.sh` | 循环把火山记为「额度用尽，到 <重置时间> 为止」（解析消息里的时间，解析不出按 5 小时），写进 `STATE_DIR`；在此之前 `dsh-model.sh` 不再选 volc、直接给 qwen，并在 stderr 写原因；到点后自动恢复 volc。额度用尽是正证据：循环对该验收 worker 自动 `worker-stop`、清掉它的验收锁、本轮用 qwen 重派，日志写明三步；实现 worker 遇到 claude 额度用尽时同理降级（ACC-harness-claude-04）。不打印任何密钥 |
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
| ACC-harness-offline-01 | 用假 driver / 假适配器（被调用就记录）在临时 `VK_HOME` 里跑 `hifabu serve --offline`，库里放几个 `last_checked_at` 为空的账号和到点的已确认平台稿，等过一轮 daemon tick；再调 `/api` 的账号检查、发布、采集 | 全程**零次**体检/发布/采集/登录调用，没有起任何 Chrome；这些接口返回 `offline_mode` 和人话；启动时打印「离线模式：不会访问任何平台」；页面和只改库的动作（确认、改时间、跳过）照常可用。ACCEPTANCE 第一节与验收任务书只允许用 `--offline` 起服务（2026-11-16 验收起 daemon 自动体检访问了一次小红书） |
| ACC-harness-leak-01 | 假 `orca` 包装脚本：让一个 worker 完成并被 `cycle.sh` 处理（ack）后，查看 `terminal close` 调用 | 该 worker 的终端被自动关闭；验收 worker 同理；仍在运行的 worker 终端不被关；关闭失败只写日志，不阻断整轮 |
| ACC-harness-leak-02 | 假 `orca` 与假 `dsh-model.sh`：`$role.channel` 记录 volc，本轮选 qwen，跑 `ensure_terminal` | 先关闭旧终端、再新建；日志含「通道切换，已关旧终端」；不出现两个终端同时留存 |
| ACC-harness-leak-03 | 假 `orca` 返回超过「lane 数 + 2」个已完成未关的 worker 终端，跑 `bin/cycle.sh --max 1` | 派工前先清理已完成终端；清完仍超上限则不再开新终端并写 `cycle-owner-alert.txt`；上限可配置 |
| ACC-harness-leak-04 | 读 `bin/cycle.sh` 验收任务书模板，并实际跑一次验收 | 任务书要求收尾关闭自己起的 Chrome 与测试服务，且只关自己启动的（按 pid/端口），不碰 `~/.local/state/versekit/browser/` 下的登录窗口；验收结束后 `ps` 中无该验收遗留的测试 Chrome |
| ACC-harness-leak-05 | 假 `orca`：`worker-list` 返回 50 个已结算 worker，它们的终端已不存在（如重启后），`terminal close` 回 `terminal_handle_stale`；跑 `bin/cycle.sh --max 1` 两轮 | 已不存在的终端按「已关」记入台账、不计入「未关」数，不触发上限告警，本轮照常派工；第二轮不再对这些 handle 重复 close、日志不刷屏（每轮至多一行汇总） |
| ACC-harness-claude-01 | 选定通道为 claude 时用 `bin/worker-up.sh` 起一个实现 worker 终端，发一条最小请求，读终端底部模型名与进程命令行 | 终端里跑的是 Claude Code（`claude`，不是 dsh），模型为 Sonnet（`claude-sonnet-5-5` 或别名 `sonnet`）；以跳过权限确认的模式启动，无人值守时不会停在权限确认框；起终端后能被 `worker-start --terminal` 正常派工并收到 `worker_done` |
| ACC-harness-claude-02 | `bin/cycle.sh --dry-run --no-consume`（或假 `orca`）各准备一个 `s:ready` 与一个 `s:review` 的 issue，看日志里每次派工选的通道 | 实现 worker（含返工）默认走 claude 通道；验收 worker **始终**走 DeepSeek 通道（volc 优先、qwen 兜底），不会选 claude；日志每次派工写明「角色 → 通道 → 模型」（2026-11-24 起实现默认改为 Codex，以 ACC-harness-route-01 为准） |
| ACC-harness-claude-03 | 给 issue 打 `model:opus` label 后派实现；另造一个第 3 轮返工（round ≥ 3）派工 | **只有显式 `model:opus` label** 才用 Opus（`claude-opus-5-5` 或别名 `opus`）；返工轮次不再自动升 Opus（额度原因，2026-11-14）；其余实现单子用 Sonnet；日志写明选择原因 |
| ACC-harness-claude-04 | 让 claude 通道不可用（`PATH` 里没有 `claude`，或用假 `claude` 模拟额度用完/限流报错），跑一轮实现派工 | 自动降级到 DeepSeek 通道照常派工，stderr/日志写明降级原因；不会因 claude 不可用整轮停派；通道变化时按 ACC-harness-leak-02 先关旧终端；探测不打印任何凭据 |
| ACC-harness-claude-05 | 读 claude 通道实现 worker 的任务书；`bash -n bin/*.sh`；`grep -nP '\$[A-Za-z_]\w*[^\x00-\x7F]' bin/*.sh` | 任务书明确「只改本 worktree 内、工单涉及的文件，不碰 worktree 以外的路径、不改用户全局配置」；语法检查与 grep 均无输出 |
| ACC-harness-claude-06 | 给 issue 打 `model:deepseek` label 后派实现；再造该 issue 的一个返工（round 1）派工；用假 `claude`（调用即报错并记录）跑 | 实现与返工 worker 都走 DeepSeek 通道（`--agent opencode`，volc 优先、qwen 兜底），**全程不调用、不探测 claude**；日志写明「issue 带 model:deepseek label → DeepSeek」；DeepSeek 两个通道都不可用时本轮不派并说明原因，**不得自动改用 claude** |
| ACC-harness-claude-07 | `model:deepseek` 的 issue 造第 2 轮及以后的返工派工 | 自动升到 Sonnet（简单活 DeepSeek 做不好时的台阶），日志写明「DeepSeek 第 N 轮仍未过 → 升 Sonnet」；仍不自动升 Opus；`IMPL_CHANNEL` / `IMPL_MODEL` 显式覆盖照旧生效 |
| ACC-harness-claude-08 | 读 `docs/COORDINATOR.md` | 有「选哪个模型」一节：给出 `model:deepseek`（简单活）/ 默认 Sonnet / `model:opus`（须人点头）三档的判定表与例子；写新 issue 时协调器必须按它打 label，并在 issue 里写明理由 |
| ACC-harness-lane-01 | 从 market-research #40/#189（78a1dec）移植。离线测试造一个不能复用的 lane worktree（有已跟踪改动），调用 `prepare_lane_worktree` / `reset_lane_worktree` | 函数 stdout 只有 worktree 路径（或为空），说明性日志全部走 stderr，含原因与路径（如「有未提交或未跟踪文件：<前 5 个路径>」）。起因：versekit 2026-11-17 lane 1 每次派工都失败，「不能安全复用」这行日志混进了路径，`worker-start` 报 `selector_not_found`（#196、#197 都先在 lane 1 失败） |
| ACC-harness-lane-02 | 离线测试用临时 git 仓库覆盖三种情况，再跑 `node bin/agentctl.mjs tick` | ① 旧 worktree 只有未跟踪文件（无已跟踪改动、无未推送提交）→ `git clean -fd`（不带 `-x`）后复用；② 有已跟踪改动或未推送提交 → 不复用、不删，新建并写日志和 `cycle-owner-alert.txt`（同轮不被清掉）；③ 新建成功后旧的若已干净 → `orca worktree rm --force` 回收，失败只告警不阻塞派工；④ tick 列出「未登记 worktree」（排除主仓库、lane 登记、验收 worktree、协调器 worktree），不自动删除。lane 1 修好后实际派一单成功 |
| ACC-harness-codex-01 | 给 issue 打 `model:codex` label 后派实现；用假 `orca` 记录 `worker-start` 参数，跑 `bin/cycle.sh --max 1`（2026-11-21 所有者加了 Codex 账号） | 实现 worker 走 `--agent codex --model <CODEX_MODEL>`（默认 `gpt-6.2-sol`，环境变量可改）；日志写明「issue 带 model:codex label → Codex」；全程不调用、不探测 claude；不带这个 label 的单子照旧 Sonnet，验收照旧 DeepSeek |
| ACC-harness-codex-02 | 真机：派一张 `model:codex` 的小单，看 Orca 起的 Codex 终端 | 无人值守跑完：不停在登录、信任目录、权限确认或沙箱拦截（`git push`、`bin/ghx pr create` 能执行）；按任务书开 PR 带证据包并发 `worker_done`；Dispatch 正常结算、`worker-release` 后终端关闭 |
| ACC-harness-codex-03 | `model:codex` 的 issue 造返工 round 1 与 round 2 派工 | round 1 仍走 Codex；round ≥ 2 升 Sonnet，日志写明「Codex 第 N 轮仍未过 → 升 Sonnet」；不自动升 Opus；同时带 `model:opus` 时 Opus 优先 |
| ACC-harness-codex-04 | ① `PATH` 里没有 `codex`；② `codex login status` 显示未登录；③ 用假 `orca` 让在跑的 Codex worker 屏幕末尾出现用量上限提示（如 `You've hit your usage limit ... try again at <时间>`）；各跑一轮 | ①② 本单改派 Sonnet，日志写明原因；③ 循环记下「Codex 额度用完，到 <时间> 为止」（解析不出时间按 5 小时），停掉该 worker、issue 退回 `s:ready`，冷却期内 `model:codex` 的单子都改派 Sonnet，到点自动恢复；探测不花 token（不跑 `codex exec`），不打印凭据 |
| ACC-harness-codex-05 | 读 `docs/COORDINATOR.md` §5.1 | 选模型的表里多一档 `model:codex`：写明适合（口径写得死、不靠看图判断的后端/脚本/测试单，如核心逻辑、CLI、适配器内部、不稳定测试排查）和不适合（界面还原、要看设计稿的单、对外文案、须人拍板的单），以及额度用完自动改派 Sonnet；协调器打这个 label 要在 issue 里写理由（2026-11-24 起以 ACC-harness-route-04 为准） |
| ACC-harness-verdict-01 | `packages/core/test/agentctl.test.mjs` 用真实出现过的五种写法各造一条 PASS 判定评论（`acceptance:` 下的 ① `- id:` + `status:`；② `- item:` + `status:`（versekit #257/PR #260）；③ `- id:` + `result: pass`（trustbridge PR #683）；④ 行内 `- {id: ACC-x, status: pass}`（trustbridge PR #679）；⑤ 映射 `ACC-x: pass`（versekit #247）），调用 `parseVerdict` 和 `merge --pending --dry-run` | 五种都解析出同样的逐条结果，`merge --pending` 不再报「verdict 没有逐条覆盖」；只认 `acceptance:` 段，`failed:` 段里的 `- item:` 不会被当成 pass；同一条既有 pass 又有 fail 时按 fail；`status` 写成 pass/fail 以外的值（如 `待人工`）不算覆盖 |
| ACC-harness-verdict-02 | 读 `bin/cycle.sh` 里验收任务书 | 判定 YAML 给出一份完整可抄的样例（PASS 一份、FAIL 一份），`acceptance:` 每条固定 `- id:` + `status:`，`failed:` 每条也用 `id:` 而不是 `item:`；`agentctl reject` 写出的 FAIL 评论同样改用 `id:`（旧评论里的 `item:` 仍能被读） |
| ACC-harness-verdict-03 | 读 `bin/cycle.sh` 里的验收任务书；`bin/cycle.sh --dry-run --no-consume` 看渲染结果 | 任务书写明「PR head 落后 main」怎么判：某条口径只在 head 上失败、失败来自本 PR 没改过的文件、main 上已修好、PR 与 main 为 CLEAN 时，按合并 main 后的结果判，note 里写明 head 上的现象、合并后的现象和两边的复现命令；失败落在本 PR 改过的文件上，照 head 判。这种情况不发 question，直接判（2026-11-21 #293、#305 的验收员各为此问了一次，循环每问一次停一次）|
| ACC-harness-verdict-04 | `packages/core/test/agentctl.test.mjs` 造一条没有 ```yaml 代码块、正文直接以 `verdict: FAIL` 开头的判定评论（2026-11-21 PR #320 评论 7065173194 的原样），head 与 PR 当前 head 相同；再跑 `merge --pending` 与验收派工的 dry-run | ① 这种裸 YAML 也能解析出 verdict/round/head_sha/failed，`merge --pending` 照常打回 `s:changes`；② 同一个 head 已经有验收员发过判定评论（不论能不能解析）时，不再给它派验收；解析不了就写 `cycle-owner-alert` 并在日志里给出评论链接，不能悄悄重派。（2026-11-21：解析不到 FAIL，循环在 c1dccb7 上连派 2 次验收，都被协调器手动停掉）|
| ACC-harness-codex-06 | 读 `bin/cycle.sh` 给 Codex 通道的实现与返工任务书；`bin/cycle.sh --dry-run --no-consume` 看渲染结果 | 任务书写明：推本单分支、用 `bin/ghx pr create` 开 PR、工单「完成定义」里明确要求的 PR/issue 评论，都是本单交付物，允许执行，不用先问；Orca 前言里「不要向 GitHub 发帖」指不拿 GitHub 当汇报渠道（进度、提问、完成走 Orca）；除此之外不在别的 issue/PR 上发评论。2026-11-21 Codex 一单为此提问 2 次（#268、#269） |
| ACC-harness-codex-07 | 用假 `orca` 让在跑的 Codex worker 屏幕末尾只有 Codex 自带的提示行 `Tip: When signed in with ChatGPT, use /usage to check your account usage and access available usage limit resets.`（2026-11-21 真实出现过），跑一轮 `bin/coordinator-loop.sh`；再让屏幕出现真正的用量上限提示各跑一轮 | 只有提示行时不报「额度用尽」、不写任何冷却、不要协调器处理；真正的用量上限照 ACC-harness-codex-04 处理。通用的额度识别（火山、claude 等）也不会被这行提示触发。停摆报警里的 issue 号取自 `dispatch-<id>.json` 的派工记录，不从 worktree 目录名猜（那次把 #284 报成了 #197）；取不到就写「issue 未知」。测试不得碰真实 GitHub：`AGENTCTL_BIN`、`ghx` 一律指向测试目录里的假脚本，派工记录里用不存在的 issue 号（如 99999），测试跑完 `git grep` 不到真实 issue 号（2026-11-21 测试用 #284 和真 agentctl，把真单子改回 s:ready 九十次，循环重复派工） |
| ACC-harness-cycle-14 | 用假 `orca` 模拟「`git worktree add` 新建的 `rework-<issue>` 目录要过几秒才出现在 `orca worktree list` 里，在此之前 `worker-start --worktree path:…` 回 `selector_not_found`」（2026-11-21 #290 返工连败 6 次的真实情况）；跑一轮返工派工 | `bin/cycle.sh` 新建返工 worktree 后，先等它出现在 `orca worktree list` 里（有上限，如 60 秒，期间轮询）再 `worker-start`；等到上限还没出现就记一行人话（「Orca 还没认出新建的 worktree <路径>」）、不消耗 3 次重试、下一轮再派，不把任务标 failed。`selector_not_found` 的重试之间也要先确认 worktree 已被 Orca 认出。已有 worktree 的返工照旧。测试里不碰真实 orca、agentctl、GitHub（见 ACC-harness-codex-07）。 |
| ACC-harness-merge-01 | 离线测试（假 GitHub 接口）造一张 `s:accept`、verdict PASS、门禁全绿，但 PR `mergeable=false`（跟 main 冲突，2026-11-21 抖音 #276 的 PR #303 在视频号 #275 先合并后就是这样）的 issue，跑 `node bin/agentctl.mjs merge --pending` | 不调 GitHub 的合并接口；把 issue 打回 `s:changes`，PR 上留一条 FAIL 评论，写明「跟 main 冲突，合并 main 解决冲突后重验」和冲突的文件；这类打回不算质量 FAIL，不推高返工轮次，也不触发换模型；`mergeable` 还在计算（null）时本轮跳过、下轮再看；退出码 0，不再每轮报同一个错 |
| ACC-harness-arch-01 | 离线测试造两张 issue：「涉及」含 `packages/core/src/commands.mjs`、`schema.sql`、`store.mjs`、`handlers.mjs`、`daemon.mjs` 或 `packages/relay/` 之一，一张口径列了 ACC-arch-09、一张没列；再造一个对应 PR 描述里没有六问的情况，跑 `agentctl tick` 和 `merge --pending --dry-run` | 没列 ACC-arch-09 的那张被 tick 标「补口径」、不派工；PR 描述里没有六问（6 个编号答案）时 `merge --pending` 拒绝合并并写明「缺 ADR-0005 §13 六问」；不涉及这些文件的单子不受影响 |
| ACC-harness-ci-01 | `npm run ci` | 五道门禁全绿，不新增 skip |
| ACC-harness-queue-01 | 离线测试（假 GitHub、假 orca，见 ACC-harness-codex-07 的隔离要求）造：一张 `s:doing`、零张 `s:ready`、三张新状态 `s:queued`（口径已写好、排队等派；其中一张正文「**依赖**：#X」而 #X 还没 `s:done`，一张口径里有 ACCEPTANCE.md 里查不到的 id），`CYCLE_LANES=2`；跑一轮 `bin/cycle.sh --no-consume` 与 `bin/coordinator-loop.sh` 的派工段。再造「两条 lane 都占满」「已有一张 `s:ready`」两种情况各跑一轮 | ① `s:ready` 为空、活着的实现/返工 worker 少于 `CYCLE_LANES` 时，循环自己把排在最前、能派的那张 `s:queued` 转成 `s:ready` 并派出，日志写「从排队里放行 #N（排第 1，前面跳过 #M：依赖 #X 未完成）」；② 顺序：带 `prio:high` 的在前，其余按 issue 号从小到大；③ 跳过依赖没完成的、口径查不到的、缺 ACC-arch-09 的（与 ACC-harness-arch-01 同一套检查，不另写一份），被跳过的写进 `cycle-owner-alert.txt` 并说原因，不卡住后面的；④ lane 占满或已有 `s:ready` 时不放行；⑤ `s:triage` 只表示「还没写口径」，循环不碰它；有 `s:queued` 可放时，`coordinator-loop` 不因「s:triage 里还有」退出 13；⑥ `docs/COORDINATOR.md` 写明三态：`s:triage` 没口径 → 协调器写好口径转 `s:queued` → 循环自动放行成 `s:ready`；「一次只放 1 张 s:ready」由脚本保证，协调器不再手动转 `s:ready`；⑦ 仓库里建好 `s:queued`、`prio:high` 两个 label。（2026-11-22：#339 进了验收、第 2 条 lane 空着，#336、#333、#334 却停在 s:triage 等协调器手动放行，所有者问「为啥还没做」，并要求靠流程而不是靠协调器记住）|
| ACC-harness-accept-01 | 读 `bin/cycle.sh` 的验收任务书与 `--dry-run --no-consume` 渲染结果；离线测试造三张 `s:review` 的 PR：门禁全绿、门禁有红、门禁还在跑 | 验收不再在本机跑全量 `npm run ci`：任务书改成「门禁以 GitHub 上该 head 的 check-run 为准（`bin/ghx pr checks`），本机只跑与本单口径直接相关的测试文件，并实际操作验证行为」；口径本身要求并发或多轮全量测试的（如 ACC-test-load-01）照口径做。派验收前先看门禁：全绿才派；有红的不派验收，直接打回 `s:changes`，PR 上留 FAIL 评论写明哪道门禁红、失败用例名和日志链接，这类打回不计验收轮次，但同一 PR 连续 3 次门禁红就挂 `hold:human`；还在跑的本轮跳过。（2026-11-22：#332 第 1 轮验收花 26 分钟判出的问题，GitHub CI 早已是红的；验收和 CI 各跑一遍全量测试，一轮十几分钟，还各起一批 Chrome）|
| ACC-harness-accept-02 | 读实现、返工任务书；离线测试造「worker_done 到达时该 head 的门禁有红」 | 实现和返工的任务书写明：推完后等 GitHub 上的门禁全绿（`bin/ghx pr checks --watch`）再发 `worker_done`，红了自己接着修，本机 macOS 测试通过不算数；`worker_done` 之后不再往分支推提交。循环收到 `worker_done` 时门禁有红，按 ACC-harness-accept-01 打回，不转 `s:review`。（2026-11-22：#332 本机 872 项全绿，Linux CI 红；返工 worker 发完 worker_done 又推了两次）|
| ACC-harness-accept-03 | 离线测试（假 orca、假 GitHub）造一个正在跑的验收 Dispatch（记录的 head = A），PR 当前 head 变成 B；跑一轮循环 | 发现验收中的 PR head 变了：`worker-stop` 那个验收、清它的锁和 `acceptance.*` 记录，下一轮按新 head 重派，日志写「验收中 head 变了（A → B），重派」；作废的那次不计轮次、不留 FAIL。同一 PR 这样重派超过 2 次挂 `hold:human`。（2026-11-22：#332 第 2 轮验收验的是 d5744be，判完时 head 已是 86c0951，整轮作废）|
| ACC-harness-loop-01 | 离线测试造收件箱里一条验收发来的 `escalation`，对应 PR 上有可解析的 FAIL 判定且 head 对得上；再各造一条 `question`、一条非验收的 `escalation`、一条 FAIL 判定解析不了的 | 验收 FAIL 这一条循环自己处理：`merge --pending` 打回 `s:changes`、ack、接着派返工，不退出，日志一行「#N 第 k 轮验收 FAIL → 已打回返工」。其余三种照旧停下来等协调器（退出码 10）。3 轮上限、`hold:human` 的判断不变。（2026-11-22 一天里循环为验收 FAIL 停了 4 次，每次等协调器 ack、打回、重启）|
| ACC-harness-rework-01 | 离线测试（临时 git 仓库、假 orca）造一张 `s:changes`，它的原分支没有任何 worktree 检出（原 lane 已被别的单切走），循环自己跑在协调器 worktree（`COORD_WT` 或脚本所在仓库根）里；跑一轮返工派工 | 给原分支新建 `rework-<issue>` worktree 再派（等 Orca 认出，见 ACC-harness-cycle-14）；任何情况下都不把 worker 派进协调器 worktree 或主仓库，建不出来就本轮不派并写 `cycle-owner-alert.txt`。日志里不再出现「仍在 current 里派工」。（2026-11-22：#339 返工被派进协调器 worktree，把它切到了 issue-339-lane-1，循环此后读的是该分支的 `bin/` 和 `ACCEPTANCE.md`，协调器的口径 PR 也做不了）|
| ACC-harness-ci-02 | 读 `.github/workflows/ci.yml`；开一个 PR 推一次提交，看 Actions | 分支上的一次推送只触发一轮 CI：`push` 只对 `main` 生效，其余走 `pull_request`；同一 PR 有新提交时取消旧的那轮（`concurrency` + `cancel-in-progress`）。`.orca-kit/gates.txt` 里的门禁名在 PR head 上照样能查到，`agentctl merge --pending` 的门禁判断不受影响（PR 里贴一次真实的门禁输出）。（现在 `on: push` + `pull_request` 同时开，每次推送跑两遍）|
| ACC-harness-watch-01 | 跑新增的 `bin/coordinator-watch.sh`（给协调器挂 Monitor 用），用假日志喂各种事件 | 只在需要协调器动手时输出一行：循环退出（带退出码和原因）、`question`、非验收 `escalation`、worker 停摆、额度用尽、`hold:human` 新增、磁盘剩余低于阈值（默认 4GB，可配）；派工、交活、验收 PASS/FAIL、合并这些进度事件不输出。循环进程验活按完整命令行。`docs/COORDINATOR.md` 写明协调器用它盯循环，不再手写 grep。（2026-11-22：协调器的监控每个进度事件都通知一次，每次都要回一句，白耗 token）|
| ACC-harness-accept-04 | 离线测试造三张 issue：带 `verify:light`、PR 只改了允许的路径；带 `verify:light`、PR 改到了 `packages/*/src/`；不带。各跑一轮循环，再跑 `node bin/agentctl.mjs approve --issue N --pass` 与 `--fail --item … --expected … --observed …` | 分级验收（所有者 2026-11-22 同意）：协调器开单时给「只改测试、文档、`bin/`、`scripts/`、`.github/` 且口径都能用测试或命令机械判定」的单打 `verify:light`，在 issue「涉及」下一行写理由。轻验收单门禁全绿后不派验收员，循环发一条「#N 轻验收待协调器审」（进 ACC-harness-watch-01 的输出），协调器对照口径看 diff 和 CI 后用 `agentctl approve` 下结论：它按标准 YAML 在 PR 上发判定（head_sha 取 PR 当前 head、`acceptance` 逐条覆盖本单口径），之后照常 `merge --pending` 或打回返工，3 轮上限不变。PR 改到允许范围以外的文件时自动退回完整验收，日志写明哪个文件。`docs/COORDINATOR.md` 写明打 `verify:light` 的条件和不能打的情况（产品功能、界面、真机、对外文案）。|
| ACC-harness-orca-01 | 离线测试用假 `orca` 记录 `worker-start` 的参数，造：原分支已有登记过的 worktree；原分支没有任何 worktree；实现 worker 交活时门禁红且它的 Dispatch 终端仍是 Orca 证实可复用的 | 按 Orca 官方放置方式派工（`orca skills get orchestration --full` 的 placement 一节）：原分支已有 worktree 时用它的精确选择器 `--worktree id:<Orca 返回的完整 worktree id>`；没有时用 `worker-start --worktree new-top-level --name rework-<N>`，由 Orca 建好并登记，任务书写明先 `git checkout` 原分支；不再自己 `git worktree add` 再轮询等 Orca 认出；任何情况下都不用 `--worktree current`。门禁红打回时，如果原实现 worker 的终端仍可复用，就按官方「交活后复用同一终端」用 `worker-start --task <修复任务> --terminal <handle>` 让它接着修，不 release 再新起一个。|
| ACC-harness-orca-02 | 离线测试用假 `orca` 造 `worker-list --json` 的几种行：`projection.attention.requiresAction=true` 带 `nextAction` argv；终端输出 40 分钟没变但 `requiresAction=false`；有待回答的 `question`；`liveness=exited` 且没发 `worker_done` | 停摆判断按官方：只看 `worker-list` 的 `projection.attention` / `nextAction` 和 `liveness`，终端输出不变不算证据。`requiresAction` 或 `exited` 且没交活才报给协调器（带 `nextAction` 原样）；在等回答的报「有问题待回答」，不报卡住。`docs/COORDINATOR.md` 写明：给在跑的 worker 补充说明用 `orca orchestration send --to dispatch:<id>`，不往它的终端里直接打字（`orca terminal send`）；看 worker 输出用 `worker-read --source auto`。（2026-11-21 协调器把一个在等回答的验收员当卡死停掉；2026-11-22 协调器两次用 `terminal send` 给 worker 发话）|
| ACC-harness-orca-03 | `node --test packages/core/test/orca-flow.test.mjs`；本机 `node bin/orca-flow.mjs tick --dry-run` | 派工换成 Orca 官方原生流程（所有者 2026-11-23：「换成 orca 工作流，别自己搞了」）：`bin/orca-flow.mjs tick` 每轮从 GitHub 现状与 `orca task-list` / `worker-list` 重新算，不建 worktree、不加锁、不写登记文件。实现用 `worker-start --worktree new-top-level --name issue-N`（Orca 建目录）后 `worktree set --issue N`；验收建 Task `vk#N 验收 <head7>`，在本单 worktree 里起 DeepSeek（`worker-channel.sh` + `opencode-model.sh`），同一 issue + head 不重复建；返工优先 `worker-start --terminal` 复用本单保留着、liveness=live 的实现终端，否则在本单 worktree 起新 agent。实现 + 返工并行不超过 `FLOW_LANES`（默认 2），验收不超过 `FLOW_ACCEPT_MAX`（默认 1）；`exited` 之外的 liveness 都占名额。Task 标题 `vk#<issue> <实现|返工 r<k>|验收 <head7>>` 是唯一对应关系，可解析、别的标题不认。|
| ACC-harness-orca-04 | 同上测试 | 收件箱归协调器：tick 读一批消息，只有 `worker_done` / `heartbeat` / `merge_ready` 时 ack；含 `question` / `escalation` 时不 ack、日志写「⚠ 需要协调器」、`tick` 退出码 10，迁移、合并、派工照常进行（不再像旧循环那样整个停下）。|
| ACC-harness-orca-05 | 同上测试 | 官方 Completion accounting：交活（reclaimable）的实现 / 返工终端在 issue 处于 review / accept 时 `worker-retain`（FAIL 时复用），验收终端与 issue 已离开 review / accept / changes / doing 的保留终端 `worker-release`；不用 `terminal close` 代替。|
| ACC-harness-orca-06 | `ls bin/`；`grep -rn "cycle.sh\|coordinator-loop" docs/COORDINATOR.md bin/*.mjs`；本机起两次 `orca-flow watch` | 删除 `bin/cycle.sh`、`bin/coordinator-loop.sh`、`bin/worker-up.sh` 及只测它们的测试；仍有用的测试（验收任务书含落后 main 规则与可解析的判定样例、合并冲突返工任务书）改测 `orca-flow.mjs`。`docs/COORDINATOR.md` 第 1–3 节改写为新流程（谁跑 tick、遇到「需要协调器」怎么处理、任何 PR 都不手动 `gh pr merge`）。`orca-flow watch` 进程名 `orca-flow[versekit]`，同一项目第二个 watch 以退出码 14 拒绝并写出对方 pid。本表里描述 `cycle.sh` / `coordinator-loop.sh` 行为的旧 harness 行随之作废，以本行和 orca-03..07 为准。|
| ACC-harness-orca-07 | 读 `docs/COORDINATOR.md` §5.1 | 记下迁移后变成手动的部分，不假装还在：Codex / 火山额度用尽的屏幕识别与自动冷却（原 coordinator-loop.sh）改为协调器看 `orca-flow status` 的 attention 后手动处理；「终端输出 30 分钟不变判卡死」取消，只认 `worker-list` 的 attention / nextAction 与 `exited`（ACC-harness-orca-02）。|
| ACC-harness-orca-08 | `node --test packages/core/test/orca-flow.test.mjs packages/core/test/agentctl.test.mjs` | `orca-flow` 不绑项目，可进套件给别的项目用：项目名取 `FLOW_PROJECT`，否则 origin 远端仓库名（https / ssh、带不带 `.git`），都没有用目录名；Run 文件 `~/.orca/<项目>-run-id`、状态目录 `~/.orca/<项目>-state/`、进程名 `orca-flow[<项目>]`、Task 前缀（versekit 仍是 `vk`，其余用项目名，彼此不认）都由它决定。项目专属的任务书约束（versekit 的 8788 端口、真机红线、登录窗口）从 `.orca-kit/flow-rules.md` 的「## 实现」「## 验收」两节的列表行读，脚本里不再写死。issue 带 `by:coordinator` label（协调器自己实现的单）：`agentctl claim --role rework` 不认领它，`orca-flow` 日志提醒「等协调器自己改」，不派返工 agent。|
| ACC-harness-orca-09 | `node --test packages/core/test/orca-flow.test.mjs` | `orca-flow` 能接带定制的项目（trustbridge、market-research）：读可选的 `.orca-kit/flow.json`——`hooks.beforeTick`（每轮开头依次跑，如 pull main、内容引擎、项目自己的放行脚本）、`hooks.beforeMerge`（`merge --pending` 之前跑，如本机 CI 写提交状态）、`release:false`（不跑 `agentctl release-queued`）、`inbox:"external"`（收件箱归 automation 里的协调器 agent，tick 不读不 ack）。钩子在仓库根目录用 `sh -c` 跑，失败记「✗ 钩子」但不中断本轮；配置写坏按默认跑并在日志说明。`watch` 每轮起子进程跑 `tick`，磁盘上的新代码（含钩子刚 pull 下来的）下一轮生效，不用重启 watch。versekit 的 `flow.json` 只有一个钩子：协调器 worktree 处于分离 HEAD 时快进到 `origin/main`，在分支上就不动。|
| ACC-harness-orca-10 | `node --test packages/core/test/orca-flow.test.mjs` | 任务书里的 CI 命令取 `.orca-kit/flow.json` 的 `ci`（默认 `npm run ci`；空串按默认），实现、返工、验收三种任务书都用它，脚本不再写死。验收任务书的 PASS / FAIL 样例里，每个口径条目都带 `evidence:` 一行（要求写可回查的证据，没有证据不得写 pass）：有的项目闸门缺证据会拒绝合并，versekit 的判定解析忽略这个字段、照常合并。返工任务书带「协调器裁定」：上一轮验收评论之后、正文以「协调器裁定」「协调器：」「协调器:」开头的 issue 评论，最多最近 3 条，原文附在验收意见之后，并写明优先于工单旧口径；没有裁定不出现这一段；取评论失败不阻断派工。返工任务书提示「口径若在 main 上有修订，先 git merge origin/main」。|
| ACC-harness-orca-11 | `node --test packages/core/test/orca-flow.test.mjs` | 接 trustbridge 的返工协议，靠 agentctl 自己声明、脚本不认项目：返工认领结果带 `reasonComments` 时，任务书照抄为「返工原因（最近一条验收之后的评论）」（作者、时间、原文），并且不再另拉协调器裁定；带 `lastVerdict: PASS` 时任务书开头点明「验收已 PASS，本次返工原因见下方评论」。认领结果带 `bodyHash` 时，派出后写 `~/.orca/<项目>-state/rework/<issue>.json`（head、bodyHash、dispatch、pull）；之后每轮，记录对应的 dispatch 已不在跑（或 Run 里找不到）就调 `agentctl rework-check --issue --head --body-hash` 并删记录，失败只记日志。认领结果没有这两个字段（versekit、market-research）时行为与之前完全一样。另：`.orca-kit/flow.json` 的 `settle:false` 让 tick 跳过 retain / release 一段（watch 不在 Run 所有者终端里跑的项目，如 trustbridge 的守护终端，由协调器收尾），默认 true；这类项目由 Run 所有者（如 automation 里的协调器 agent）处理完收件箱后跑 `node bin/orca-flow.mjs settle`：只做 retain / release，不派工、不认领，可以和 watch 同时跑。|
| ACC-harness-orca-12 | `node --test packages/core/test/orca-flow.test.mjs` | 合并后回收 issue 的 worktree（所有者 2026-11-23：「不是说 orca 原生工作流可以复用 worktree 吗」——Orca 回收终端，不删目录，旧流程也从不清理，攒了 15 个约 1GB）。每轮在回收终端之后：只看本仓库（按 Orca 的 repoId 过滤，别的项目同号 issue 的目录不碰）、关联了 issue（`linkedIssue` 或 `linkedItems`）、不是主仓库、不是脚本所在目录的 worktree；issue 还开着、或它还有没回收的终端（在跑、交活待定、保留中）就不动；GitHub 上确认 issue 已 CLOSED；目录里有未提交改动、有不在任何远端的提交、或有依赖 / 构建产物 / 缓存以外的被忽略文件（只有路径里某一级目录正好叫 node_modules、dist、.playwright-mcp、.impeccable——任意层级都算，按整段比，`dist-config.json`、`dist-archive/` 不算——或文件是 .DS_Store，才算可丢），就不删并在日志写一次原因（同一目录同一原因不重复）；否则 `orca worktree rm --force`。`.orca-kit/flow.json` 的 `cleanup:false` 关掉这一步。另：查找本单 worktree 时同样只看本仓库。协调器自己实现的单要用 Orca 建 `issue-N` 目录并关联 issue（`docs/COORDINATOR.md`），验收才会复用它，不再另建 `accept-N`。|
| ACC-harness-orca-13 | `node --test packages/core/test/orca-flow.test.mjs` | 返工复用原 agent 终端时，`worker-start` 同时带 `--terminal` 与本单 worktree 的 `--worktree id:`（只带终端时 Orca 按 `--from` 即 Run 所有者终端所在目录核对，报 `terminal_worktree_mismatch`；market-research #267 2026-11-23 连续 3 次派不出去、单子在 s:doing / s:changes 间来回强制迁移）。复用失败（任何原因）就 `worker-release` 那个终端，同一轮改派新 agent（有本单目录用它，没有新建 `issue-N`）；只有新 agent 也派不出去才退回 s:changes。|
| ACC-harness-orca-14 | `node --test packages/core/test/agentctl.test.mjs` | `release-queued` 判断「已有 s:ready 不放行」时，不算挂着 `hold:human` 的 ready 单（它们不会被认领、不占派工）：只有 s:ready + hold:human 时照常从排队放行 1 张；还有不带 hold 的 s:ready 时照旧不放。2026-11-23 #35（v0.1 出门验收，等所有者真机）停在 s:ready + hold:human，把 #374/#375 堵了 30 分钟。|
| ACC-harness-orca-15 | `node --test packages/core/test/orca-flow.test.mjs` | versekit 的 `.orca-kit/flow-rules.md`「实现」节写明界面单（口径含 ACC-v3-fid-08）证据包三件事：1360 宽、`vk demo seed` 数据的截图放 `docs/design/screenshots/impl/`；PR 描述里与 `docs/design/screenshots/v3/` 同页并排；贴 ACC-v3-fid-01 实测值（#fafaf8、34px、antialiased、tabular-nums、焦点环 2px、#ffd84a）。实现与返工任务书都带这一行。2026-11-23 #374、#376 第 1 轮都只因这条被打回。|
| ACC-harness-orca-16 | `node --test packages/core/test/orca-flow.test.mjs` | orca-flow 转录 `agentctl merge` 的输出时，「✗ 不合并 #N：」后面以 `- ` 开头的原因行并进同一行（用「；」隔开）写进流程日志；✓ / ↩ / 迁移 / → 行照旧；其他行不写。2026-11-24 #395、#396 的日志只有「✗ 不合并 #N：」，看不出原因 |
| ACC-harness-orca-17 | 读 `bin/orca-flow.mjs` 的 `commonConstraints`；`node --test packages/core/test/orca-flow.test.mjs` | 实现与返工任务书的通用约束写成「不改已有的 API 形状、数据库 schema 和 commands.mjs 里已有的命令定义；口径要求新增的命令、字段、表，可以向后兼容地加（只加不改不删）」，不再一刀切禁止改 commands.mjs。2026-11-24 worker 为原句问了 4 次（#395、#396、#397） |
| ACC-harness-orca-18 | `node --test packages/core/test/orca-flow.test.mjs`；读 `bin/orca-flow.mjs` 派验收的循环 | 某张单的实现或返工 worker 还在跑（Dispatch 没结算、进程没退出）时，orca-flow 不给它派验收，日志写「#N 跳过验收：实现 / 返工 worker 还在跑，等它交活」；验收 worker 本身不算。2026-11-24 #398 的实现方开了 PR 后还在修 Linux 测试，同一目录里却被派了两个验收员 |
| ACC-harness-orca-19 | `node --test packages/core/test/orca-flow.test.mjs`；读 `bin/orca-flow.mjs` 的 `startWorker` | `worker-start` 被判为失败（命令出错，或者回执 status/state 是 failed、outcome_unknown），而回执里带有 dispatchId 时，先 `worker-stop --dispatch <id>` 停掉它，日志写「启动结果不明，已停掉 dispatch … 再退回」，然后再按原规则退回或改派；停不掉时写 ⚠ 提醒协调器。2026-11-25 #435 的第一次派工回执是 outcome_unknown，被退回后重派，同一个 worktree 里出现了两个 Codex |
| ACC-harness-scope-01 | `node --test packages/core/test/agentctl.test.mjs` | 工单「涉及」段里，「改：」和「不动：」下面缩进写的子条目，继承父行的归属：「改：」下的路径计入涉及文件，「不动：」下的不计入；单行写法照旧有效。2026-11-26，#482 把路径写成子条目，被判定为没写涉及，结果 #486 一直不能并行 |
| ACC-harness-arch-answers-01 | `node --test packages/core/test/agentctl.test.mjs` | 合并闸门判断「六问」小节时，标题里含「六问」「ADR-0005 §13」「ACC-arch-09」三者中任意一个都认；小节里仍须写全 1 到 6 条。（起因：2026-11-26，#496、#497 两单的标题没写「六问」两个字，验收已经 PASS，合并时却被拒） |
| ACC-harness-route-01 | 离线测试：`bin/worker-channel.sh --role engineer` 与 `--role rework --round 1/2`，分别给 label：无、`model:sonnet`、`model:opus`、`model:deepseek`、`model:neon`；用假 `codex` 分别模拟「可用」「没装」「未登录」「冷却期内（`codex-exhausted` 未到期）」（所有者 2026-11-24：「worker 可以先让codex去做，额度用完了再切换成sonnet」） | 没有 model label 的实现单和返工 round 1 **默认走 Codex**（`codex\|<CODEX_MODEL>\|…`）；Codex 不可用或在冷却期内时改派 Sonnet，原因写进日志；返工 round ≥ 2 升 Sonnet；`model:sonnet` 强制走 Sonnet；`model:opus`（显式、须人点头）、`model:deepseek` 的行为不变；`model:codex` 仍然认，效果和默认一样；验收仍优先走 DeepSeek（都不可用时的备用见 ACC-harness-route-05）；探测不跑 `codex exec`，不花 token |
| ACC-harness-route-02 | 离线测试（假 `orca`）：让一个在跑的 Codex 实现 worker 的 `worker-read` 输出末尾出现用量上限提示（如 `You've hit your usage limit ... try again at <时间>`）；另造一次只有 Codex 自带提示行 `Tip: ... /usage to check your account usage ...` 的情况；各跑一轮 `bin/orca-flow.mjs tick` | 出现用量上限提示时，orca-flow 写 `codex-exhausted`（「到期 epoch 秒<TAB>到期时间文本」；解析不出时间就按 5 小时算），停掉这个 worker，**同一轮里**把这张单改派 Sonnet，在原 worktree 接着做，不丢已有提交；日志写「Codex 额度用完，到 <时间> 为止 → #N 改派 Sonnet」；冷却期内新派的单都直接走 Sonnet，到点自动恢复 Codex；只有 Tip 提示行时不算额度用完，什么都不做 |
| ACC-harness-route-03 | 离线测试：给 issue 打 `model:neon`，跑 `bin/worker-channel.sh --role engineer`，再用假 `orca` 跑一轮 `bin/orca-flow.mjs tick` 并记录 `worker-start` 的参数；另模拟 `agy` 不在 `PATH` 里（所有者 2026-11-24：「设计方面的活、出图啊之类的可以让agy的neon模型去做」） | `model:neon` 的实现单和返工 round 1 走 `--agent antigravity --model <NEON_MODEL>`（默认 `gemini-4-neon-high`，环境变量可改）；返工 round ≥ 2 升 Sonnet；`agy` 不可用时改派 Sonnet，原因写进日志；验收仍优先走 DeepSeek（都不可用时的备用见 ACC-harness-route-05）；Neon 实现单的任务书同样带 ACC-v3-fid-08 证据包要求（界面单时） |
| ACC-harness-route-04 | 读 `docs/COORDINATOR.md` §5.1、§6 | 选模型的表改成：默认 Codex（额度用完自动 Sonnet）、`model:sonnet`、`model:neon`（设计稿、页面视觉、出图、截图对照这类设计活）、`model:deepseek`、`model:opus`（须人点头）；写明「`model:codex` 只是旧写法」、「同一时间最多 1 个 Codex worker」这条已经取消（并行上限仍是实现 2 个）；额度用完由 orca-flow 自动处理，不再要协调器手写 `codex-exhausted` |
| ACC-harness-route-05 | 离线测试：让火山与千问都不可用（无凭据），分别在「有 `agy`」「没有 `agy`」时跑 `bin/worker-channel.sh --role acceptance`，以及带 `--labels model:neon`；再读 `bin/orca-flow.mjs` 派验收时传给选通道的参数（所有者 2026-11-24 定：验收「DeepSeek 不行时用 Neon」） | DeepSeek 能用时验收照旧走 DeepSeek；火山和千问都不可用时改用 Neon（`antigravity\|<NEON_MODEL>`），日志写「DeepSeek 不可用 → 验收改用 Neon」；实现方就是 Neon（issue 带 `model:neon`）时改用 Sonnet，保证验收与实现不是同一个模型；`agy` 也不可用就退出码 1、本轮不派验收；探测 agy 只看 `command -v`，不发请求；orca-flow 派验收时把这张 issue 的 label 传给选通道 |
| ACC-harness-route-06 | 离线测试（假 `orca`）：让一个实现 worker 的 Dispatch 回 `status: failed`、`stage: agent_readiness`、`lastFailure: Agent startup blocked: agent-update-prompt`（2026-11-24 #395、#396 的实况），issue 在 `s:doing`，跑一轮 `bin/orca-flow.mjs tick`；返工 worker 同样造一次；另造一个 `s:doing` 的 issue，它的实现 Dispatch 已结算但既没有 PR、也没有 `worker_done` | 启动失败的单子**同一轮**改派：Codex 或 Neon 启动失败时改派 Sonnet，Sonnet 启动失败时退回 `s:ready` 并写「⚠ 需要协调器」；改派时沿用原 worktree，并在日志写「#N <通道> 启动失败（<lastFailure>）→ 改派 <新通道>」；同一张单同一通道启动失败两次后，这个通道在本轮不再用于新单；`s:doing` 却没有在跑的 worker、也没有 PR 的单子，每轮都写一次「⚠ 需要协调器：#N 在 s:doing 但没人在做」，不会静默。验收与 ACC-harness-route-05 的备用规则不变 |

## 账号浏览器的内存（driver-browser）

每个账号一个独立 Chrome profile 是为了登录态隔离，必须保留；要管的是「用完不收、守护进程重启后留孤儿」。

| ACC id | 怎么验 | 通过标准 |
|---|---|---|
| ACC-browser-mem-01 | 起 `hifabu serve`，触发一次账号检查（会起该账号 Chrome），然后 `kill -TERM` 守护进程 | 守护进程退出前关闭它起的所有账号 Chrome；`ps` 里不再有 `--user-data-dir=…/browser/acc_*` 进程 |
| ACC-browser-mem-02 | 先手动留一个账号 Chrome（模拟上次守护进程被 `kill -9` 留下的孤儿），再起 `hifabu serve` 并空闲等待超过空闲回收时限（测试可用环境变量缩短） | 新守护进程接管或关闭孤儿：空闲时限到后该 Chrome 被关闭；正在被用户使用（有非空白标签页）的登录窗口不被强关 |
| ACC-browser-mem-03 | 在账号页点「重新登录」→ 扫码成功 | 登录确认成功后，登录用的可见窗口在 10 秒内自动关闭（或转为无头），不会一直留在屏幕和内存里 |
| ACC-browser-mem-04 | 设 `VK_BROWSER_POOL=2` 起服务，依次对 3 个账号触发检查 | 同时存活的账号 Chrome 不超过 2 个；第 3 个排队或复用槽位，不报错；默认值与上限行为不变 |
| ACC-browser-login-01 | 从**后台会话**（`launchctl managername` 输出 `Background`，例如 agent 的 shell）起 `hifabu serve` 或直接调 driver，对一个临时账号 id 开 Chrome，用 CDP 写入一个带 30 天有效期的测试 cookie，等待落盘后关闭该 Chrome，再重新打开同一账号 | 重新打开后该 cookie 仍在；profile 的 `Default/Cookies` 里 `cookies` 表行数 > 0。验收人必须自己实际执行这一步，不得引用实现方的证据；不得读取或打印任何真实账号 cookie 的值 |
| ACC-browser-login-02 | 构造「cookie 存不下来」的情形（例如用环境变量关掉修复、或让 cookie 存储不可写），然后跑 `hifabu doctor --human` 与一次账号检查 | 明确用人话报出「登录不会被保存」及原因，不静默；修复生效的正常情形下该项为通过 |
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

- [ACC-v2-plan-01] `hifabu plan apply <cutId> [--accounts a,b] [--group 名字]` 为这支成片生成平台稿（命令在 `commands.mjs` 定义为 `plan.apply`，CLI、HTTP 由它派生）。不给 `--accounts` 时按 PRD 的默认方案：当前账号组里**所有已接入平台**的账号各一条。每条挂在这支成片下、用它的语言版本（有多个版本时默认 `zh`，没有 `zh` 用第一个），状态一律是待确认，不会自动发。已经有平台稿的账号跳过并在输出里列出，重复执行不新建。
- [ACC-v2-plan-02] 建议时间按 ACC-v2-confirm-06 的平台规则排：从现在起找每个账号最近的可用时间，不违反每日上限和最小间隔；输出里每条带建议时间。有测试钉住：同一账号已有一条 10 分钟后的平台稿时，新稿的建议时间不早于它之后 10 分钟。
- [ACC-v2-plan-03] 平台稿发出去用的是**成片**的标题和元数据：生成时由 core 把成片标题写进平台稿（如 `overrides_json`，人在确认前改过的值优先），适配器不再 JOIN `work` 表取标题/元数据（与 ACC-v2-confirm-07 同理，零后门）。有测试钉住：作品标题与短片标题不同，发短片那条时适配器拿到的是短片标题。

### 平台文案：标题、正文、话题（所有者 2026-11-16 定：入库时由 Claude 写好）

- [ACC-v2-copy-01] `vk work add` 的完整形式（清单）可以给每支成片、每个语言版本带各平台的文案：`copy: { <platform>: { title, body, tags: [] } }`，也可以给一份不分平台的默认文案。入库时按平台字段限制校验，超限的拒绝入库并指出是哪个平台、哪个字段、限多少（不悄悄截断）。限制写在 core 的一张表里，至少覆盖：B站 标题 ≤80、简介 ≤2000、话题 ≤10 个且每个 ≤20 字；小红书 标题 ≤20、正文 ≤1000；抖音 文案含话题 ≤1000；TikTok 文案 ≤2200；YouTube 标题 ≤100、简介 ≤5000。查不到官方数字的平台在表里标「未核实」，不校验但在 `hifabu doctor` 里列出。
- [ACC-v2-copy-02] `plan.apply` 生成平台稿时把这支成片、这个语言版本、这个平台的文案（没有就用默认文案，再没有就用成片标题、正文空、话题空）写进平台稿；`vk work show` 每条平台稿输出 `title`、`body`、`tags`，并标出哪些是空的。
- [ACC-v2-copy-03] 发布时适配器拿到的标题、正文、话题来自平台稿（人在确认前改过的值优先），由 core 解析后传入，适配器不读 `work` 表。有测试钉住：同一作品 B站、小红书两条平台稿文案不同，各自适配器收到的是各自的文案；B站的 `--desc`、`--tag` 与小红书的正文、话题都按平台稿填写。
- [ACC-v2-copy-04] 确认时能看到并修改每条平台稿的标题、正文、话题（Web 确认面板与 `publish.edit` 命令；飞书卡片至少能看到正文前几行与话题）。正文或话题为空时在该行明确标出「没有正文」「没有话题」，不阻止确认。修改同样按 ACC-v2-copy-01 的限制校验。改页面前先改 `docs/design/` 的原型与任务书（AGENTS.md §6）。

- [ACC-v2-title-01] 「实际会发出去的标题」只有一份规则：core 的 `effectiveTitle`。`notify.mjs` 不再自己算标题。有测试钉住：同一条平台稿（分别覆盖人改过标题、成片标题与作品标题不同、都没有这三种情况），`vk work show` / workView、飞书确认卡片、适配器收到的标题三者相等。

### 今天、账号组、和平时比

- [ACC-v2-today-01] `hifabu today` 输出 JSON 四块：等确认的作品（按成片分）、出了问题的、已确认等时间的队列（按时间排）、最近发布满 24 小时的结果。
- [ACC-v2-group-01] work、today、stats 类命令默认只看当前账号组，可用 `--group` 指定；能查到其他每个组各有几件事等处理。
- [ACC-v2-base-01] 倍数 = 这条发布 24 小时的播放 ÷ 同一个账号最近 20 条发布 24 小时播放的中位数。2 倍及以上标"比平时好"，一半及以下标"比平时差"，阈值可配。这个账号历史不足 5 条时不给倍数。任何地方都不把不同平台的播放数相加。

### Web

- [ACC-v2-web-01] 真实服务上 `/today`、`/works`、`/work`、`/data`、`/system` 返回 200；侧栏四项顺序和 `docs/design` 一致；页面数据来自 `/api`，不含原型的演示数据（`WORKS`、"露营小记"）。还没实现的页面显示"还没做"的空状态，不能 404。
- [ACC-v2-web-02] 今天页的结构、文案、状态词和 `docs/design/today.html` 一致，1360 宽截图和 `docs/design/screenshots/v2/today.png` 并排对得上：聚焦面板（视频、各平台一行、小红书单独一块、吸底的确认按钮）、右侧成片列表与"接下来要发"、其他待办各一条、最近结果表。没有待办时是 `today.html` 里那个安静的空状态。
- [ACC-v2-web-03] 确认一支成片后自动跳到下一支还没处理的；按钮文字带条数（"确认这 6 条，按时间发"）；只有 1 支成片时不出现成片列表，只有 1 个语言版本时不出现语言切换。
- [ACC-v2-web-04] 作品页和作品详情页与 `works.html`、`work.html` 及对应截图一致：按状态筛选、按标题搜；平台图标三态（已发、未发、出问题）；详情里发过的成片每行显示倍数，出问题时有红底说明和"再试一次"。
- [ACC-v2-web-05] 账号组切换在侧栏顶部，只有一个组时也显示；别的组有待办时带数字；每页副标题带当前组名；切换后页面只显示那个组的内容。
- [ACC-v2-web-06] `npm run design:check -- --url <服务地址>` 通过；颜色、字号、圆角只用 `DESIGN.md` 里有的。

### YouTube 官方接口（`packages/adapter-youtube`，2026-11-21）

所有者 2026-11-21 定：先把自动发布跑通，YouTube 是海外第一个平台。移植自 `trustbridge@1f9c92f videos/factory/publishers/youtube.mjs`（`docs/adr-0001-reuse.md` §4.1）。agent 只对 mock 服务端验证，真机由所有者在同网电脑上做（第一节真机红线照旧）。

- [ACC-youtube-01] 结构与移植：`packages/adapter-youtube` 按 `docs/adapter-contract.md` 导出 `{ platform, capabilities, ready, publish, collect }`，`npm run check:contract` 通过；文件头写 `// ported from trustbridge@1f9c92f videos/factory/publishers/youtube.mjs`；不引入运行时依赖。工厂里的硬编码全部剥离，仓库里 grep 不到：播放列表名 `Overseas Compliance Explained`、`categoryId: '28'` 写死、`defaultLanguage: 'en'` 写死、过滤 `learnontiktok|techtok`、`filesOf()` / `episode` 目录约定、`~/.config/assurelane/youtube-*.json`。`hifabu publish --platform youtube --dry-run` 能单独跑、无副作用、产出将要提交的元数据。
- [ACC-youtube-02] 授权在网页上完成：系统页账号那一行「接入 YouTube」→ 填用户自己的 Google OAuth client（client id / secret）→ 打开 Google 授权页 → 只在 `127.0.0.1` 临时端口收回调（带 `state` 和 PKCE S256），拿到 code 立即关端口。token 经 core 接口存本地凭证目录，账号表只存 `credential_ref`；client secret 和 token 不进库、不进日志、不进审计参数，仓库里 grep 不到。token 过期前用 refresh 续期；续期失败或被撤销时账号变「需要重新登录」并发事件。界面上不出现命令行。对 mock 授权服务器有测试。
- [ACC-youtube-03] 发布：对 mock 服务端跑通 `videos.insert` 可续传上传，**分块读文件**，不整段读进内存（测试断言单次读取不超过分块大小）；中途断开从服务端报告的偏移续传。标题、描述、标签来自平台稿；语言来自成片的语言版本；类目、「含 AI 合成内容」声明、播放列表都是平台稿参数，默认不加播放列表。竖版且时长在 YouTube Shorts 上限内的成片按 Shorts 处理（按成片比例与时长判断，不靠写死话题）。「预约发」用私享上传加 `publishAt`，到点由 YouTube 公开；「现在发」按平台稿的可见性直接发。平台稿经 `transitionPublish()` 到已发布，并用 `videos.list` 回读核实 id、链接和状态，不信任上传返回。
- [ACC-youtube-04] 不静默的私享：回读的 `privacyStatus` 和请求的不一致时（API 项目未过 Google 审核会被强制锁成私享），平台稿记 `visibility_forced_private`，发事件，人话写「YouTube 把这条锁成了私享：接入用的 Google 项目还没过审，需要在 YouTube Studio 里手动改成公开」，今天页和成片面板看得到，不算悄悄成功。视频上传成功后，缩略图、字幕、播放列表这些步骤失败只写进 notes、尽力而为，不重传视频。有测试。
- [ACC-youtube-05] 错误与配额：429 和 5xx 指数退避重试；`quotaExceeded` 立即停下、不重试，该账号暂停到太平洋时间次日零点（配额重置）并发事件；`uploadLimitExceeded`、token 失效（转「需要重新登录」）、视频被拒等，每种都有 `error_code` + 人话 + 事件，测试逐个钉住。PR 里写明按官方文档（附链接和查阅日期）一次发布消耗多少配额单位、默认每日配额多少；发布前预估当天剩余配额不够就不开始，并说明原因。
- [ACC-youtube-06] 采集：`collect()` 用 `videos.list`（statistics）回填播放、点赞、评论；授权里有 Analytics 权限时再取观看时长，没有时不报错。数据页能看到 YouTube 的行，倍数口径和别的平台一致。有测试。
- [ACC-youtube-07] 待人工（所有者在同网电脑上做，agent 不做）：用所有者的 Google 账号真机授权一次、发一条私享视频，核对回读、强制私享提示和数据回填。写进 PR 的「待人工」，不计 pass/fail。

### 抖音（`packages/adapter-douyin`，第一版只存草稿，2026-11-21）

所有者 2026-11-21 定：先把自动发布跑通。流程参考 `dreammis/social-auto-upload@3847fff uploader/douyin_uploader/main.py`（MIT），按 `docs/adr-0002-sau-backend.md` §4.1 方式 B 带声明移植，用现有 `driver-browser` 重写，不走 Python sidecar。用哪个抖音号由用户自己在发布机上登录决定，适配器不写死账号。agent 只用录制页面和 stub driver 验证；真机由所有者在和手机同网的电脑上做（第一节真机红线照旧，本开发机不打开 `creator.douyin.com`）。

- [ACC-douyin-01] 许可与移植：仓库根先有 `THIRD_PARTY_NOTICES.md`，收录 social-auto-upload 的 MIT 全文、版本 `3847fff` 和移植了哪个文件；适配器文件头写 `// ported from dreammis/social-auto-upload@3847fff uploader/douyin_uploader/main.py`。SAU 里的账号名、cookie 目录、固定话题、写死的等待秒数等硬编码全部剥离，仓库里 grep 不到。不引入运行时依赖（不装 Python、patchright）。
- [ACC-douyin-02] 契约：按 `docs/adapter-contract.md` 导出，`capabilities.draft` 为 true，`npm run check:contract` 通过；遵守 14 条硬规则里适用的那些（持久 profile、真实鼠标事件、点前 `scrollIntoView`、中英文案双匹配、每步回读、按真实耗时给超时、失败留截图）。`hifabu publish --platform douyin --dry-run` 能单独跑，停在「存草稿」前一步并截图，不产生任何平台副作用。
- [ACC-douyin-03] 存草稿：对离线模拟页跑通（`fixtures/` 里手搭的页面，复现 SAU 依赖的发布页结构和文案；本开发机不能打开真实页面去录，真实页面上选择器对不对由 ACC-douyin-07 真机验证）：上传成片 → 填标题（不超过 55 字，超了在发布前就报错）→ 正文 → 话题（来自平台稿，逐个输入并回读）→ 封面（有入库封面用它，没有用平台默认）→ 点「存草稿」→ 到草稿箱回读出这一条，才记 `draft_pending`（状态「已送到抖音草稿箱，在手机上点发布」），不算已发布。每一步填完都回读，回读对不上就抛 `flaky_ui` 并留截图。
- [ACC-douyin-04] 时间：第一版不用抖音页面自带的定时。「预约发」到计划时间由 VerseKit 把稿子送进草稿箱，并在今天页、飞书卡片提醒「去手机上发」；「现在发」立即送草稿箱。小红书逐条确认的规则不受影响。
- [ACC-douyin-05] 登录与体检：`account.check` 打开创作者中心的一个只读页面判断登录态（正常 / 过期 / 被限），给人话；过期时账号变「需要重新登录」并发事件。登录走系统页已有的「在发布机上打开登录窗口」方式（ACC-v3-login-03），本单不做抖音扫码取二维码。
- [ACC-douyin-06] 风控与错误：适配器不另设每日条数上限（所有者 2026-11-21 定）。遇到验证码、滑块、「操作太频繁」这类风控页面立即停下、不重试，账号暂停到次日并发事件，人话写清「抖音要你在发布机的窗口里手动过一下验证」。每种失败都有 `AdapterError` 的 code + 截图 + 事件，测试逐个钉住。
- [ACC-douyin-07] 待人工（所有者在和手机同网的电脑上做，agent 不做）：用所有者自己的抖音号在发布机上登录一次，送一条成片进草稿箱，在手机上确认草稿内容（标题、正文、话题、封面）都对，再手动发布。写进 PR 的「待人工」，不计 pass/fail。

### 视频号（`packages/adapter-shipinhao`，登录提醒 + 存草稿，2026-11-21）

所有者 2026-11-21 说明：视频工厂 10-24 起视频号改成手动发，原因是**登录撑不了多久，老要重新扫码**。所以本单的重点不是发布本身，而是：量清楚登录实际能撑多久、让重新扫码尽量省事、过期前后提醒到位（保活不管用，不做）；发布第一版只存草稿，人在手机上点发表。移植自 `trustbridge@1f9c92f videos/factory/publishers/channels.mjs` 和 `videos/factory/keepalive.mjs`（`docs/adr-0001-reuse.md` §4.1）。agent 只用离线模拟页和 stub driver 验证；真机（扫码登录、看几天里记下的登录时长、送一条进草稿箱）由所有者在和手机同网的电脑上做，写进 PR 的「待人工」，不计 pass/fail（第一节真机红线照旧，本开发机不打开 `channels.weixin.qq.com`）。

- [ACC-shipinhao-01] 移植与契约：文件头写 `// ported from trustbridge@1f9c92f videos/factory/publishers/channels.mjs`（保活部分写 `keepalive.mjs`）；工厂里的硬编码剥离干净，仓库里 grep 不到 `assurelane`、`channels-error.png`、`filesOf(`、从 `youtube.json` 取 `short_title` 的约定、`ffmpeg` 调用；通知不直接调飞书，只发事件。不引入运行时依赖。按 `docs/adapter-contract.md` 导出，`capabilities.draft` 为 true，`npm run check:contract` 通过。dry-run 停在「保存草稿」前一步并截图，无平台副作用。
- [ACC-shipinhao-02] 存草稿：对离线模拟页（`fixtures/` 里手搭，复现视频号助手的 wujie 微前端 shadow root 结构和文案）跑通：上传成片 → 按工厂的判定等上传完成（封面卡片出现「编辑」且没有上传中/生成中/百分比，超时 20 分钟）→ 短标题 → 描述 → 封面（入库清单有就用，没有用平台默认；9:16 一张、16:9 两张的分支都有测试）→ 位置、「含 AI 生成内容」标注（平台稿参数，默认「不显示位置」「标注」）→ 填完逐项回读 → 点「保存草稿」→ 到草稿列表回读出这一条，才记 `draft_pending`（「已送到视频号草稿箱，在手机上点发表」）。短标题不合规（超过 16 字含空格，或有 `《》“”：+？%°` 以外的标点）、描述超 950 字，在人确认之前就拦下并说明，不等到发布时失败。回读对不上抛 `flaky_ui` 并留截图。
- [ACC-shipinhao-03] 登录检查：`account.check` 打开视频号助手的一个只读页面判断登录态；落到二维码页就是「过期」，人话写「视频号登录过期了，请重新扫码」，不能报成找不到元素。发布途中落到二维码页同样处理，抛 `auth`。
- [ACC-shipinhao-04] 量登录能撑多久：每次登录成功、每次检查的结果（正常 / 过期）都记成账号事件。系统页视频号账号那一行显示「这次登录已 X 小时」，以及「最近几次登录平均撑 Y 小时」（从登录成功到第一次查到过期）；`hifabu account show <id>` 输出同样的数字。不足一次完整记录时显示「还在记录」。用假时钟测试。
- [ACC-shipinhao-05] 不做保活，只在需要时查登录（所有者 2026-11-21：工厂的保活不管用）：不定时打开页面「续命」。登录检查只在这几个时机做：发布机启动时、每天早上一次（时间可在系统页设置里改，默认 08:00）、人确认视频号平台稿时、计划发布前 2 小时（见 06）。每次检查都进 04 的记录。登录态已是过期时不再反复打开页面，等人重新扫码。用 stub driver 和假时钟测试这几个时机和停止条件；仓库里不出现按固定小时间隔反复检查视频号的定时任务。
- [ACC-shipinhao-06] 提醒与重新扫码：查到过期立即发事件，今天页「要处理」和系统页账号行显示「视频号要重新扫码」，飞书通道按事件推送。有已确认、排了时间的视频号平台稿时，在计划时间前 2 小时额外查一次登录，过期就提前提醒，不等到发布失败。重新扫码走网页二维码（ACC-v3-login-01 的做法）：发布机取回视频号登录页的二维码，显示在账号那一行下面，用手机微信扫完自己变「正常」，不需要去发布机前开窗口。用录制页面 / stub 测试「出码 → 已扫 → 确认成功」与「二维码过期 → 换一个」。

### 飞书卡片

- [ACC-v2-card-01] 新作品入库后 1 分钟内发"新作品，等你确认"卡片。点"开始确认"后按成片一支一支发确认卡片：上一支处理完（确认或先不发）才发下一支。
- [ACC-v2-card-02] 确认卡片、改标题或时间的表单、小红书单独卡片的结构与 `docs/design/feishu-cards/` 一致，平台行按这支成片实际的平台稿生成。点完后原卡片原地更新成结果，按钮消失，重复点不会执行第二次。
- [ACC-v2-card-03] 账号组多于一个时卡片标题带组名；只有一个时不带。
- [ACC-v2-card-04] 卡片测试只用 fixture 和假的发送函数，不往任何真实飞书会话发消息。

### TikTok 官方接口（审核演示用，2026-11-16）

开发机上只用本地 mock 的 TikTok 服务端，不连 `open.tiktokapis.com`、不用真实 client_key；真机与录屏由所有者在自己电脑上做（第一节红线）。

- [ACC-tiktok-api-01] PKCE：每次授权新生成 `code_verifier`，`code_challenge` 等于 verifier 的 **SHA256 hex**（不是 base64url），单测钉住；回调只在 `127.0.0.1` 的临时端口 `/callback/tiktok/` 上收，拿到 code 后立即关端口；`state` 不符时拒绝并给人话。
- [ACC-tiktok-api-02] 对 mock 服务端跑通 `vk` 授权 → `user.info.basic`（头像、昵称存到账号）→ token 存本地凭证目录、账号表只存 `credential_ref`；token 过期前用 refresh 续期，续期失败账号变「需要重新登录」并发事件。client_key/secret 只从环境变量或本地配置读，仓库里 grep 不到。
- [ACC-tiktok-api-03] 对 mock 跑通 Direct Post：`creator_info/query` → `video/init`（FILE_UPLOAD 分片）→ 轮询 `status/fetch` → 平台稿经 `transitionPublish()` 到已发布；`inbox/video/init` 草稿箱路径同样跑通，状态是「已送到草稿箱」、不算已发布。作品是 AI 生成时请求里 `is_aigc: true`。隐私级别没选时 CLI 拒绝并给人话；隐私选项只来自 creator_info，代码里不硬编码；时长超过 creator_info 上限在发布前就报错。
- [ACC-tiktok-api-04] 错误：429 指数退避后重试；`spam_risk_too_many_posts`、`spam_risk_user_banned_from_posting`、`reached_active_user_cap` 立即暂停账号、发事件、**不重试**；token 失效转「需要重新登录」。每种都有 `error_code` + 人话 + 事件，测试逐个钉住。浏览器自动化后端 `packages/adapter-tiktok` 行为不变（原测试全过），同一账号只能挂一个后端。
- [ACC-tiktok-api-05] Web：系统页账号处有 **Connect TikTok**，连上后显示头像和昵称；TikTok 平台稿确认时有设置面板：隐私级别下拉（选项来自 creator_info、默认不选，没选不能发）、评论/合拍/拼接三个开关默认全关且 creator_info 不允许的置灰、文案可改、AI 生成标记可见、**Post** 与 **Send to TikTok drafts** 两个按钮；发布后显示进度和结果（成功/失败原因）。无水印。按 AGENTS.md §6 先写任务书，`npm run design:check` 通过。
- [ACC-tiktok-api-06] 用 mock 服务端在本机 Web 上把审核视频要拍的四段走一遍并截图留证：授权显示头像昵称；选隐私→开关默认关→改文案→Post→成功；Send to drafts→显示已送到草稿箱；出错时的人话。证据附在 PR，不碰真实账号。
- [ACC-tiktok-api-07] 代理（所有者 2026-11-16 录审核视频时踩到）：环境里有 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（大小写都认，`NO_PROXY` 生效）时，官方接口适配器发出的所有请求都经过代理，用户不需要自己设 `NODE_USE_ENV_PROXY`；仍然不加运行时依赖。测试用本机假代理钉住：请求确实经过代理，`NO_PROXY` 命中的主机直连。连不上（超时、拒绝连接、代理不通）时，`error_code` 是 `network_unreachable`，人话里写明是网络或代理问题、该检查哪个变量，不能只显示 `fetch failed`。`hifabu doctor --human` 显示当前生效的代理（只显示主机和端口，不显示账号密码）。
- [ACC-tiktok-api-08] 未审核应用被拒（所有者 2026-11-16 录审核视频时踩到）：`unaudited_client_can_only_post_to_private_accounts` 的人话提示是"先在 TikTok App 里把账号设为私密（设置和隐私 → 隐私 → 私密账号），再重试；应用通过审核后就没有这个限制"，不能再写成"只能发仅自己可见"；测试钉住这条提示文案。作品页上，平台稿处于可重试状态（`failed` / `blocked` / `notify_pending`）时，那一行直接有「重试」按钮，走 `publish.retry`，和发布页、CLI 的结果一样；按 AGENTS.md §6 补任务书，`npm run design:check` 通过，并附重试前后的截图（用 `--offline` 加假数据，不碰真实账号）。


### 一键安装与后台运行（所有者 2026-11-17 定）

起因：所有者在自己电脑上照 README 做真机准备，要装 Node、clone、`brew install biliup`（Homebrew 里根本没有）、init、serve，终端还不能关。所有者原话："要做成一键脚本，一键安装启动，并且启动后 terminal 可以关闭"。目标用户就是不想碰命令行的创作者本人。

开发机红线照旧：验收只用临时 `HOME`、本机假下载源和 `--offline` 服务，不碰任何真实平台账号，不往真实的 `~/Library/LaunchAgents`、`~/.config/versekit`、`~/.local/state/versekit` 写东西。

- [ACC-install-01] 一条命令装好并启动：`curl -fsSL https://raw.githubusercontent.com/versekit-labs/versekit/main/install.sh | bash`。在一台**没有 Node、没有 Homebrew** 的 macOS（arm64 与 x86_64）上，全程不用 sudo、不问任何问题，依次完成：下载官方 Node **26 LTS**（版本号写死在脚本里、且是 CI 跑过 `npm test` 的那个版本；校验官方 SHASUMS256）到 `~/.versekit/node`，不动系统里已有的 Node；下载 versekit 到 `~/.versekit/app`（下载 tarball，不要求有 git）；按 CPU 架构下载 biliup-rs 到 `~/.versekit/bin`；`hifabu init`；注册后台服务（见 02）；等控制台真的能打开（`/today` 返回 200）后用默认浏览器打开 `http://127.0.0.1:8787`，最后打印一行"装好了，控制台地址 …，终端可以关了"。不跑 `npm test`。
- [ACC-install-02] 后台运行，终端可以关：macOS 用 LaunchAgent（`~/Library/LaunchAgents/` 下的 plist，`RunAtLoad` + `KeepAlive`），关掉终端、注销重登、重启电脑后控制台都还在，进程崩了会被拉起；服务环境的 `PATH` 含 `~/.versekit/bin` 和装好的 Node，所以 `hifabu doctor` 能找到 biliup；日志写进 `vk.log`。Linux 用 `systemd --user`；没有 systemd 时退回 `hifabu serve --detach`，并明确告诉用户"重启电脑后要再运行一次安装命令"。Windows 不在本次范围，脚本在 Windows/WSL 以外的系统上直接说不支持并退出。
- [ACC-install-03] 再运行一次就是升级：重复执行安装命令不报错，替换程序文件、重启服务，**数据库、配置、凭证、账号、浏览器登录全部保留**；输出升级前后的版本。任一步失败（断网、校验不过、端口被占）都说清是哪一步、为什么、该怎么办，退出码非 0，不留下半启动的服务；端口 8787 被别的程序占用时自动换一个空闲端口并在最后一行写明实际地址。
- [ACC-install-04] 装完后的日常操作都有现成命令（CLI 完整律）：`hifabu` 可以直接在新终端里用（安装脚本把 `~/.versekit/bin` 加进 shell 配置，只加一次，带注释标记）；`hifabu service status|start|stop|restart` 管后台服务，在 `commands.mjs` 定义，标 `localOnly`，不出卡片按钮；`hifabu service uninstall` 卸掉后台服务和程序文件，默认**保留数据**，加 `--purge` 才删数据并先列出要删的目录。README 第一屏的上手步骤只剩这一条安装命令，原来的手动步骤挪到"开发者"一节。
- [ACC-install-05] 可测、可在开发机上验：安装目录、服务名、端口、各下载地址都能用环境变量覆盖（例如 `VERSEKIT_PREFIX`、`VERSEKIT_PORT`、`VERSEKIT_SERVICE_LABEL`、`VERSEKIT_NODE_URL` 等），并支持 `VERSEKIT_OFFLINE=1` 让服务以 `--offline` 起。仓库里有自动化测试：起本机假下载源（假 Node 包 + SHASUMS、假 versekit tarball、假 biliup），在临时 `HOME` 里跑 `install.sh`，断言目录、服务文件、PATH 那一行、升级保留数据、校验失败时非 0 退出且不留服务；这个测试进 CI 的 `test` job（Linux 上走无 systemd 的退回路径）。PR 附 Mac mini 上的证据：临时 `HOME` + 测试用服务名 + 非 8787 端口跑一遍，在子 shell 里装完后退出该 shell，再 `curl` 控制台 200、`launchctl print` 显示服务已加载；然后 `hifabu service uninstall` 后服务和 plist 都不在了。

- [ACC-install-06] 安装时看得到进度、下载量小（所有者 2026-11-17 第一次真装时反馈："这个安装过程一点进度提示都没有"；实测程序包 47MB、约 60 秒，其中 `.claude/` 41MB、`docs/` 13MB，运行时只用到 `packages/` 约 1.6MB）：① 每个下载步骤显示进度（终端是 tty 时用 curl 进度条或等价的百分比/已下载量，非 tty 时不刷屏），并在步骤开头写明大概大小；解压、初始化、等服务起来这些超过 2 秒的步骤也有「正在…」提示，不出现长时间无输出。② 下载的程序包只含运行需要的文件：用 `.gitattributes` 的 `export-ignore`（GitHub 源码包遵守它）或发布包，把 `.claude/`、`.impeccable/`、`docs/`、`assets/`、`site/`、测试等排除；排除后 `hifabu init`、`hifabu serve`、控制台各页面、`hifabu doctor` 照常。验证：实测新地址下载量 ≤ 5MB；安装测试断言进度输出存在；PR 附一段真实安装的终端录屏或输出。

### 新版 Node 兼容（所有者 2026-11-17 在 Node 26 上跑测试时踩到）

- [ACC-compat-01] 在 Node 26 上 `npm test` 全部通过。代理走 HTTPS 隧道时，目标是 IP 地址就不设 TLS `servername`（Node 26 会直接拒绝，见 `packages/adapter-tiktok-api/src/proxy.mjs`），是域名照常设。某条测试失败时，该测试文件不能挂住两分钟才结束：要么测试自己有超时，要么失败路径把服务端、socket 都关掉。CI 增加一个用 Node 26 跑 `npm test` 的 job（一键安装装的就是 26，见 ACC-install-01），原来 Node 22 的五个 job 不变，`package.json` 的最低版本仍是 22.13。

### 系统页（所有者 2026-11-17 定：按设计稿做，做完对照设计稿验收）

设计稿：`docs/design/system.html`，截图 `docs/design/screenshots/v2/system.png`，任务书 `.impeccable/surfaces/docs-design-system-html.md`。验收方必须自己在 1360 宽打开真实服务的 `/system` 截图，和设计稿截图逐块并排对照，截图放进 verdict；只看实现方的证据不算。

**账号组与账号**

- [ACC-v2-sys-01] `/system` 的「账号组」「账号」两块结构、列、文案、状态词与设计稿一致（标题行「一切正常 / 有 N 件事要处理」、账号组表、账号表、每块下方一行等宽字的对应命令）；数据全部来自 `/api`，不含演示数据（"露营小记"、AssureLane 的假账号、"演示数据"字样）。没有账号时是安静的空状态，引导去接入。页面顶部「这一页还没做」和「现在还能用的旧流程」两块去掉。
- [ACC-v2-sys-02] 账号表：当前组每个账号一行——平台（图标 + 名字）、账号、登录（正常 / 要重新登录 / 没连上，带上次检查时间，来自 `account.check` 的结果）、今天还能发（`X 条 每天最多 Y 条`，按 `plan-rules` 生效的 `daily_cap` 减去今天已发和已排，不是写死的数字）、说明。TikTok 官方接口账号也是这张表里的一行，不再单独一张卡片。
- [ACC-v2-sys-03] 「重新登录」在系统页就地完成，不跳旧页面：B站 打开扫码窗口，扫完经 `account.check`（biliup renew）通过才显示正常；网页登录平台打开有头登录窗口；TikTok 官方接口走授权链接。进行中这一行显示「等你扫码 / 等你登录」，完成或失败后这一行就地刷新，失败写人话原因。
- [ACC-v2-sys-04] 账号表下方有「接入账号」：选平台（来自 `platform.list`，只列已安装的适配器）→ 填账号名 → 当场走 ACC-v2-sys-03 的登录，成功后出现在表里、归当前账号组。旧 `/accounts/add` 能做的（B站 扫码 + biliup 校验、网页登录、TikTok Connect）都能在这里做。这个入口设计稿里没有，按设计稿的现有样式补（表格下方一行，主按钮墨色），并更新任务书。
- [ACC-v2-sys-05] TikTok 没有应用凭证时，在那一行就地填 client key / client secret 并保存：写进本机 `config.json` 的 `tiktok.client_key / client_secret`（文件权限 600，环境变量仍优先），secret 输入框不回显，保存后任何 API 响应、日志、事件、数据库里都不出现 secret（有测试钉住）。保存后直接能 Connect。这条能力也要有 `vk` 命令（CLI 完整律），HTTP 由同一命令派生。
- [ACC-v2-sys-06] 账号组一块：列出所有组、每组账号数、等你处理件数（与侧栏一致）、当前组标「当前」、其他组「切过去」、「新建账号组」，与 `hifabu group list / add / use` 同一份结果。旧 `/groups` 能做的都能在这里做。
- [ACC-v2-sys-07] 旧地址 `/accounts/add`、`/groups` 跳转到 `/system` 对应位置，不 404；侧栏底部的状态摘要（几个账号登录正常、发布机在线、今天还能发）与账号表一致。`npm run design:check -- --url <服务地址>` 通过。

**发布方案、发布机、平台规则、最近出的问题**

- [ACC-v2-sys-08] 有 `hifabu plan show` 与修改发布方案的命令（在 `commands.mjs` 定义，CLI / HTTP 由它派生）：按当前账号组列出「成片类型 · 语言 → 发到哪些平台 → 节奏」；改动后新作品 `plan.apply` 按新方案生成平台稿，已生成的平台稿不变。有测试钉住。
- [ACC-v2-sys-09] 系统页「发布方案」「发布机」「平台规则」「最近出的问题」四块的结构、文案与设计稿一致，数据来自 `/api`：发布方案的「改」可以就地改并保存；发布机显示心跳、排着要发、正在发、等你确认（与今天页数字一致）；平台规则显示生效的每日上限与最小间隔（改过配置就显示改过的值，默认值标「默认值」）；最近出的问题来自 `run.list` 的失败记录，「再试一次」调 `publish.retry`，最近 7 天没有就显示设计稿里的空状态。

**清理旧实现（所有者 2026-11-17："做好后要把旧的实现相关代码给清理掉，保留新的就行"）**

- [ACC-v2-sys-10] 新版四页（今天、作品、数据、系统）做完后删掉旧实现：`packages/web/public/` 下的 `add.html`、`groups.html`、`publish.html`、`runs.html` 及只被它们用到的脚本/样式；`daemon.mjs` 里指向它们的路由改成跳转到新页对应位置（`/accounts/add`、`/groups` → `/system` 账号处，`/publish` → `/today`，`/runs`、`/tasks` → `/system` 最近出的问题），不 404；只为旧页存在的测试、`.impeccable/surfaces/packages-web-public-{add,groups,publish,runs,matrix,account-wall}-html.md` 任务书、`design:check` 里对它们的登记一并删掉；`docs/design/v1/` 旧原型删掉。删之前 PR 里列一张表：旧页的每项能力 → 新页位置或 `vk` 命令；有能力在新页和 `vk` 里都找不到的，不删那一页，先 `question` 问协调器。`npm test`、`npm run design:check` 通过，`grep -rn "add.html\|groups.html\|publish.html\|runs.html" packages scripts` 只剩跳转表。

**系统页收尾（协调器 2026-11-17 对照设计稿复看时发现）**

- [ACC-v2-sys-11] 侧栏底部「发布机在线」不再写死：和系统页「发布机」一块读同一份 `machine.status`，不在线时侧栏显示红点「发布机不在线」。有测试或截图钉住：离线服务（没有心跳）时侧栏与系统页都显示不在线。
- [ACC-v2-sys-12] 「接入账号」下拉框分清两种情况：一个适配器都没装时写「没有已安装的平台」；装了但当前组都已接入时写「这个组的平台都接上了」并禁用按钮；还有可接的平台时列出来。截图钉住后两种。

### 后台自动更新（所有者 2026-11-17："你应该支持在后台自动更新"）

开发机验证一律用临时 `HOME`、测试服务名、非 8787 端口、本地假 tarball 服务器和 `VERSEKIT_OFFLINE=1`，不碰真实账号，验完卸掉。

- [ACC-update-01] 装好的程序知道自己是哪个提交：程序包里带提交号（如 `.gitattributes` 的 `export-subst` 或安装时写入），`hifabu version` 输出版本号 + 短提交号 + 安装时间；系统页「发布机」一块显示当前版本。
- [ACC-update-02] `hifabu update`（在 `commands.mjs` 定义，CLI / HTTP 由它派生）：`--check` 只比较已装提交与 main 最新提交并说人话（「已是最新」/「有新版本：N 个提交」）；不带参数就更新：下载新程序包、**用新包里的 `install.sh` 以非交互方式升级**（这样 Node、biliup 的版本变化也跟着升），保留 `app.prev`，数据、账号、登录、配置全部保留。
- [ACC-update-03] 后台服务启动时和之后每 6 小时检查一次（`config.json` 的 `update.auto` 默认开、`update.interval_hours` 可改）。只在空闲时更新：没有正在发布的、没有打开的登录窗口、接下来 15 分钟内没有要发的；不空闲就推迟到下一次检查，不打断。网络失败只记日志，下一轮再试，不弹提醒。GitHub 请求不带任何个人信息。
- [ACC-update-04] 更新后自检：服务在 60 秒内重新起来且 `/api` 健康检查通过，否则自动退回 `app.prev` 并重启，留事件「自动更新失败，已回到 <旧版本>：<人话原因>」，在系统页「最近出的问题」里可见。有测试钉住：新包故意坏掉时会退回旧版本，服务照常可用。
- [ACC-update-05] 看得见、关得掉：系统页「发布机」一块显示当前版本、上次检查时间、自动更新开关（就地切换，对应 `hifabu update --auto on|off`）；刚自动更新过时显示一行「已更新到 <版本>（时间）」，附最多 5 条更新内容（提交标题）。
- [ACC-update-06] 版本号每次更新都不一样（所有者 2026-11-18：重装后显示「已升级 0.1.0 → 0.1.0」，看不出装没装上新版）：用户看得到的版本一律写成 `<package.json 版本>+<短提交号>`（如 `0.1.0+860ddc6`），只在一个函数里拼，`install.sh` 的「已升级 A → B」、`hifabu version`、系统页「当前版本」和「已更新到 <版本>」都用它；没有提交号时写「0.1.0+未知提交」，不假装是同一版。重装同一个提交时安装脚本说「已是最新（860ddc6），重新装了一遍」，不说「已升级」。有测试钉住：两个不同提交的包装上去，输出里前后版本不同。
- [ACC-update-07] 发布机换了版本后，已经打开的网页跟着换新（所有者 2026-11-22：自动更新后系统页的版本号已经是新的，但「通知」分段和出口位置列都没出来，刷新才有）：每个页面记下自己载入时服务端的提交号；服务端推送或接口返回的提交号变了，页面在没有正在编辑的内容时自动刷新一次；有未保存的输入（改稿、表单）时不自动刷新，改在页面顶部显示一行「发布机已更新到 <版本>，刷新后能用上新功能」和「刷新」按钮。提交号来自 `buildInfo()`，不另造一份。有测试：页面载入后服务端提交号变化，没有编辑中的内容会刷新，有编辑中的内容只出提示、不刷新、输入不丢。

### 账号浏览器隔离与换号（所有者 2026-11-17 在自己电脑上踩到）

所有者原话："第二个账号打开的时候弹出窗口都没有让我扫码，而是直接登陆进了第一个账号"。两个组各一个小红书账号，`state/browser/` 下是两个不同目录，但第二个账号的登录窗口直接是第一个号。开发机不碰真实平台，用假 profile、假页面或本地 mock 复现。

- [ACC-acct-iso-01] 给账号 X 打开浏览器（登录、扫码、发布、采集、体检）时，绝不连到 `--user-data-dir` 不是 X 的 profile 的 Chrome：`pickPort` 接管和 `adoptOrphanAccounts` 认领前，核对该端口上 Chrome 进程实际的 `--user-data-dir`（如按监听端口查进程命令行），对不上就不接管、换端口自己起，并清掉 X 过期的标记文件。有测试钉住：B 的标记指向 A 的 Chrome 正在用的端口时，B 起自己的 Chrome，A 的不受影响。
- [ACC-acct-iso-02] 登录成功后读出平台侧的用户标识（小红书取创作者账号 id；其他网页登录平台能取就取），存到账号上。同一平台标识已经接在另一个账号（任何组）上时，不标为正常，这一行就地显示人话：「这个小红书号已经接在「<组名>」的 <账号名> 上；要接另一个号，先点「退出登录」，再扫码或短信登录另一个号」。有测试钉住。
- [ACC-acct-iso-03] 系统页每个网页登录账号的行内有「退出登录」，对应 `hifabu account logout <账号 id>`（`commands.mjs` 定义）：关掉这个账号的 Chrome、删掉它自己的 profile 目录，状态变成「没连上」，然后可以重新登录另一个号。有测试钉住：只删这个账号的目录，别的账号的 profile、凭证文件不动。
- [ACC-acct-iso-04] 小红书扫码提示写明「扫码会登录手机 App 当前的号；要接另一个号，先在 App 里切换账号，或改用短信登录」。
- [ACC-acct-iso-05] 每个平台都能换号（所有者 2026-11-23：「我的B站账号登陆错了，不能切换账号」「可能不止b站」）：系统页每个账号行有「换号」（所有平台，含 B站和走官方接口的 YouTube、TikTok），二次确认写明「会清掉这个号在发布机上的登录数据；排着的内容留在这个账号位置上，换好后按新号发」。确认后清掉这个账号在发布机上的**全部**登录数据——浏览器资料、平台凭据文件（如 B站 cookies 文件）、官方接口的授权令牌——状态变「没连上」，并直接进入该平台的登录流程（扫码类在二维码旁提示「扫码登录的是手机 App 当前的号，先在 App 里切到要接的号」）。登录成功后若平台标识与换号前不同，行内显示「已换成 <新号>」。CLI 同等可用：`hifabu account switch <账号 id>`（`commands.mjs` 定义）。只动这一个账号，别的账号的资料、凭据不碰。开发机用 stub driver / 假凭据验证，真实平台换号列为「待人工」（所有者在发布机上做）。
- [ACC-acct-iso-06] 「退出登录」（ACC-acct-iso-03）对所有平台都清干净：除浏览器资料外，同时删掉这个账号自己的平台凭据文件（B站 `bili-<账号 id>.json` 等）和官方接口授权令牌；退出后 `account.check` 判「没连上」，发布不会再用旧号。系统页对 B站也显示「退出登录」。有测试钉住：B站退出后凭据文件不存在、check 判没连上；别的账号的凭据文件仍在。
- [ACC-acct-iso-07] 打开登录窗口不因页面没「加载完」而失败（所有者 2026-11-23：抖音点登录报「打不开登录窗口：等不到页面加载（https://creator.douyin.com/）」）：`account.login.open` 给人登录用的窗口，导航后只等到 DOM 就绪（`domcontentloaded`）或页面已显示即算打开成功；重页面一直不触发 load（长轮询、统计脚本）时不报错、不关窗口，交给后续的登录态轮询判断成功与否。只有导航本身失败（`Page.navigate` 返回 errorText，如断网、域名解析失败）才报「打不开」，并写出 errorText。所有平台的登录窗口都按这条走。有测试用一个永不触发 load 的本地页面钉住：窗口打开成功、状态进入「等你登录」。
- [ACC-acct-iso-08] 网页登录的登录态轮询不开新标签页，每个平台按自己的规则认出登录成功（所有者 2026-11-24：「抖音登陆有问题，不断起新的tab」）：没有自带 `loginStatus` 的网页登录平台（抖音、TikTok 网页登录）的 `account.login.status` 不再走小红书的检测，改由该平台的适配器判断（如 `loginStatus`）。判断只读这个账号**已经打开的登录窗口**的当前页面：不新开标签页、不在人正在操作的标签页里导航、不关它；登录窗口不在时返回「没在登录」（idle），不另开页面去查。抖音以创作者中心首页渲染出来（不是登录页、也不是验证页）算登录成功；TikTok 网页按它自己的页面规则。成功后账号变「正常」、收掉登录窗口，与小红书一致。小红书、B站、视频号现有的登录流程行为不变。有测试钉住：stub driver 下对抖音、TikTok 网页账号各连续轮询 30 次，这个账号 Chrome 实例的标签页数量不增加；抖音 stub 页面切到已登录后，状态返回 ok、账号变「正常」。真实平台登录列为「待人工」（所有者在发布机上做）。

### 制作机 → 云端中转 → 发布机（所有者 2026-11-17 定：经 volc1 中转投递）

所有者原话："你要把视频生产、传到我这个发布机，然后我再发布整个打通"。做视频在英国 Mac mini（制作机），发布在和手机同网的 Mac（发布机），中转在 volc1（ADR-0003 的最小一步：云端只存文件和投递清单，**不是**数据库，不存平台登录态、不连任何平台）。发布前必须人确认不变：投递只到「待确认」。

- [ACC-relay-01] `hifabu relay serve`（云端中转）：只监听 127.0.0.1，由反代提供 HTTPS；推送和拉取各用一个 token（`config.json` 的 `relay.*`，文件权限 600，不进仓库、不进日志）；成片按 sha256 存，同一文件只存一份；投递有状态（待拉取 / 已下载 / 已入库 / 失败），发布机回报「已入库」7 天后清理文件；磁盘剩余不足 2GB 拒收并说人话。没有 token 或 token 错一律 401，不泄露有哪些投递。
- [ACC-relay-02] 制作机 `vk work push <清单.json> --group <组名>`（`commands.mjs` 定义）：先按 `work.add` 的规则校验清单（成片存在、各平台文案齐），不合格当场报错不上传；上传成片和清单，失败自动重试、大文件可断点续传；输出投递 id 和「等发布机拉取」。制作机本地不建作品。
- [ACC-relay-03] 发布机 `hifabu relay connect <地址> --token <拉取 token>` 写配置；后台服务每 5 分钟（可配）拉取待投递：下载到本地、核对 sha256，按清单调用 `work.add` + `plan.apply` 入库到指定账号组，平台稿全部是待确认，再回报中转「已入库」。同一投递 id 只入库一次（重复拉取、服务重启都不重复）；哈希不符、组不存在、清单不合法时不入库，在系统页「最近出的问题」里写人话原因，并回报中转「失败」。
- [ACC-relay-04] 看得见：系统页「发布机」一块显示中转连接状态、上次拉取时间、正在下载的投递和进度；`hifabu relay status` 同一份结果。新作品入库后出现在「今天」等确认；没确认的到时间也不会发。
- [ACC-relay-05] 部署：仓库里有 volc1 的部署脚本和说明（systemd 服务、Caddy 反代、数据目录、token 生成），部署到 volc1 后用测试视频跑通一次「制作机 push → volc1 → 发布机拉取入库」：发布机用 Mac mini 上的临时 `HOME` 模拟，`VERSEKIT_OFFLINE=1`，不碰任何平台账号。不能动 volc1 上已有的服务和 Caddy 站点（radar 等），只新增 versekit 自己的站点块。
- [ACC-relay-06] `hifabu relay pull` 下载时不沉默（所有者 2026-11-18：连上后跑 `hifabu relay pull`，3 支视频下了 6 分钟，终端一行字都没有，以为卡住了）：先说这一轮有几个投递；每个投递开始和结束各一行（「正在下载 2/3：<作品标题>，24MB」「已入库 2/3：<作品标题>，平台稿 N 条待确认」），下载中至少每 10 秒更新一次已下载大小；后台服务正在拉同一批时不重复下载，说「后台正在拉取，进度：…」并跟着输出直到结束；结束给一行汇总（入库几个、失败几个及原因、去「今天」页确认）。没有待投递时说「没有新投递」。`relay connect` 的提示里写明连上后会自动拉，下载大文件需要几分钟。

## 十一、v3 验收口径（做成 SaaS、界面不出现命令，2026-11-18）

依据：`docs/adr-0005-saas-architecture.md`（连同 ADR-0003、ADR-0004，三篇评审通过后才派实现单）、`docs/design/HANDOFF-v3.md`、`docs/design/*.html`、`docs/design/screenshots/v3/`。第一节的真机红线、第十节的确认红线照旧适用。和第十节冲突的地方以本节为准，冲突的条目在 `HANDOFF-v3.md` §5 列出。

所有者 2026-11-18 原话的要点：新设计要考虑研发架构，后续验收也要在研发架构上把关；界面上的命令都去掉，所有操作在界面上完成，包括升级、登录账号；改内容要区分现在发和预约发，没改好要能取消；多个平台先改通用的再个别改；上传和下载在后台自动运行；发布机的 IP 和国家城市要看得到，但不占主要位置。

### 研发架构（每个实现单都要过）

- [ACC-arch-01] 库文件只有一个入口：除 `packages/core/src/tenancy.mjs` 外，任何文件不打开库文件、不拼库路径。`npm run check:tenant` 静态检查，进 `npm run ci`。
- [ACC-arch-02] 命令的执行上下文带当前用户的库句柄（`ctx.db`）；当前用户只来自会话或设备令牌。`commands.mjs` 里任何命令的参数都没有「用户」。`check:tenant` 检查参数表。
- [ACC-arch-03] 隔离遍历测试：两个用户各有账号组、账号、作品、成片、平台稿、设备。用 A 的会话、A 的制作机令牌、A 的发布机令牌，把 `commands.mjs` 里的每一条命令对着 B 的每种对象 id 调一遍，结果都是「不存在」，B 的库文件字节不变。测试从命令表生成用例；命令表多一条而测试里没有对应的对象类型时，测试失败。
- [ACC-arch-04] 单机模式不登录、不带令牌，行为和现在一样；合并前 `npm test` 现有用例全绿，不为多用户改写它们的断言。
- [ACC-arch-05] 表结构改动只加不减：迁移里出现 `DROP COLUMN`、`DROP TABLE`、改列含义时，PR 里指出「上一个发布的版本已经不读它」的提交。有测试：用上一个版本的库文件升级，升级前后跑同一组读命令，结果一致。
- [ACC-arch-06] 升级一个用户的库失败时，只有这个用户进入只读并产生一条运营可见的事件，别的用户照常；升级前有 `VACUUM INTO` 的副本。有测试。
- [ACC-arch-07] 新表是 `STRICT`；状态列有 `CHECK`，取值和状态机白名单同源（改一处，另一处不改则测试失败）；外键列有索引。
- [ACC-arch-08] `npm run check:parity` 检查四端：CLI、HTTP、卡片按钮、MCP 工具的命令集合一致；每条命令声明 `permission`，制作机和发布机能调哪些由它决定，有测试钉住两种设备各调不了什么。
- [ACC-arch-09] 改了表结构、命令、鉴权、文件、设备的 PR，描述里有 ADR-0005 §13 的六问检查表并逐条作答。没有的打回。
- [ACC-arch-11] 补答六问（2026-11-21 审计发现 ACC-arch-09 没执行）：v3 单机单里改了命令或存储、却没带六问的 PR #251、#253、#254、#255、#261，各补一条 PR 评论逐条回答 ADR-0005 §13 的六问，答案要对照该 PR 的 diff 写实（单机模式还没有 `ctx.db` 和 `permission` 的，如实写「单机模式，暂缓到第 6/8 单」）；答出来不符合的地方（如失败没留 `error_code` + 人话 + 事件、该建没建的索引、界面按钮没有对应命令）列成清单写进 issue 评论，由协调器另开单。
- [ACC-arch-10] 备份可恢复：从最近一次快照恢复一个用户的库，能登录、作品和排期都在。演练步骤写进运维文档，合并前实际做过一次并留记录。

### 架构补漏（2026-11-21 六问补答查出来的，见 `docs/design/ARCH-RETRO-2026-11-21.md`）

- [ACC-arch-12] 飞书卡片上的按钮只走命令表：改单卡片的模式切换、返回、提交不再用独立的 `card.*` 回调，按钮由 `commands.mjs` 派生，提交走 `publish.edit` 这条命令本身；`npm run check:parity` 能发现卡片上有命令表里没有的动作。有测试。
- [ACC-arch-13] 失败留现场补齐，每处都要 `error_code` + 人话 + 事件，有测试：网页拒绝改内容；飞书改单表单校验失败；日历参数被拒或查询失败；断开中转失败；数据页主查询失败；封面入库失败。另外：底栏「现在发」整批里被扣下（`held`）的那几条，页面要写出原因；取消登录请求失败时页面说出来，不清状态了事；作品列表取封面失败时给出原因，不当成「没有封面」；`/media` 打开库或查询出错返回 500 并记事件，不和「没有封面」一样返回 404。
- [ACC-arch-14] 日历、额度用到的时间范围查询有可用索引，`event` 表有 `publish_id` 索引，用 `EXPLAIN QUERY PLAN` 断言不再全表扫 `publish` / `event`；发布方式不再靠事件 payload 的 JSON 文本筛选（加列或换成已有字段，表结构只加不减）。有测试。
- [ACC-arch-15] 发布机版本不认识封面时不静默丢掉：中转投递带上能力标记，旧发布机拉到带封面的投递时，回报里写明「封面没带上」，系统页「最近出的问题」看得到，并提示更新发布机；新发布机照常带封面。有测试（模拟旧版本拉取）。

### 分布式（ADR-0003 §4 的验证计划，原样纳入）

- [ACC-dist-01] 用假适配器在本机起云端、发布机、制作机三个角色，跑通「制作机入库 → 云端排期 → 人确认 → 发布机领取 → 回报 → 状态正确」。
- [ACC-dist-02] 断线：发布机领取后断网，租约过期重排；恢复后重复回报，不产生重复发布。
- [ACC-dist-03] 绑定：账号绑定 A 机，B 机在线也领不到它的任务；A 机到了排期时间仍不在线，产生「发布机不在线」的待办和卡片。
- [ACC-dist-04] 开发机保护：标记为开发机的设备不能绑定国内平台账号。
- [ACC-dist-05] 上一个协议版本的发布机能对着新云端完成一次领取和回报；再旧的领不到活，系统页这台电脑显示「要更新才能继续发」。

### 界面上不出现命令

- [ACC-v3-nocli-01] `docs/design/*.html` 和 `packages/web/public/` 下的页面、脚本里没有命令行：没有 `vk …`、`npm …`、`curl …`、配置文件名、`<code>` 包着的命令。`npm run design:check` 的 `cli-in-ui` 检查两处都跑。
- [ACC-v3-nocli-02] 服务端返回给页面的报错和提示里也没有命令和内部标识（ISO 时间串、`error_code`、文件路径）。有测试：遍历 `handlers.mjs` 里会到达页面的错误文案。
- [ACC-v3-nocli-03] 以前靠命令才能做的事，页面上都有入口：新建和改名账号组、接入和登录账号、退出登录、填应用凭证、改发布方案、现在更新、开关自动更新、接入和断开设备。逐条在真实服务上点一遍。
- [ACC-v3-nocli-04] CLI 完整律不变：上面每个入口对应的命令在 `hifabu commands --json` 里。

### 改内容：通用文案和各平台单独写

- [ACC-v3-edit-01] 通用文案（标题、正文、话题）存在语言版本上；平台稿按字段覆盖，没覆盖的字段跟通用。生效文案只由 `effectiveCopy()` 一处计算，发布、卡片、页面都用它。有测试：改通用标题后，跟通用的平台稿发出去的是新标题，单独写过标题的不变。
- [ACC-v3-edit-02] 改内容是一次提交（`cut.edit`）：通用和各平台的改动在一个事务里，要么都存上要么都不存。带 `rev`；别处先改过时拒绝，文案是「这支成片刚在别处改过，重新打开再改」。
- [ACC-v3-edit-03] 页面：点「改内容」或某一行的「改」进入编辑；上面是通用文案，下面每个平台一行、可展开；每个字段标着「跟通用」或「单独写的」，单独写的可以「改回跟通用」。和 `docs/design/screenshots/v3/work-edit.png` 并排对照。
- [ACC-v3-edit-04] 通用文案超过某个跟通用的平台的限制时，在通用的那个字段下面当场说是哪个平台、限多少、现在多少，并给「给<平台>单独写一个」；解决前不能保存，底栏说明还有几处。不截断。
- [ACC-v3-edit-05] 取消：没改过直接退出；改过了在底栏就地问「放弃这 N 处改动？」，「接着改」回到编辑，输入都在。Esc 等于取消，焦点在哪都有效。打字时展开别的平台、切语言版本，已输入的内容不丢。改到一半点别的成片，同样先问这一句，不静默丢；关页面或跳走前浏览器拦一下。
- [ACC-v3-edit-08] 保存只校验这次动过的字段：入库时就有的问题不拦无关的保存。有错时底栏写「还有 N 处要先处理」并带「带我去」，点了跳到出错的语言版本和那一行并展开；收起的行、别的语言版本的分段上都看得出有错。通用标题不能存成空。
- [ACC-v3-edit-06] 已确认、还没发的平台稿也能改（按时间发的那些）；保存后仍是已确认、仍按原来的时间发，底栏写「已确认的仍按原来的时间发」。编辑里不能把它改成现在发（见 ACC-v3-time-08）。已经发出去的和正在发的不能改，也不出现「改」。
- [ACC-v3-edit-07] Claude 再次入库同一个作品时，不覆盖人改过的字段（`edited_fields`）。有测试。

### 时间：现在发和预约发

- [ACC-v3-time-01] 发布方式是「现在发」或「预约发」二选一，在哪里选见 ACC-v3-time-08。现在发没有时间字段，也不因为时间报错。
- [ACC-v3-time-02] 只改文案的保存不提交时间。有测试：一条建议时间已经过去的待确认平台稿，只改标题能保存成功。
- [ACC-v3-time-03] 建议时间过了还没确认的，读出来时按平台规则顺延到最近可用的时间，并带「原定…，已顺延」。确认按钮不会因为时间过期而失败。有测试。
- [ACC-v3-time-04] 预约的时间选到过去，或碰到平台规则：在时间下面当场说原因和最近能排的时间，带「用这个时间」。文案里的时间是「今天 20:00」这种说法。
- [ACC-v3-time-07] 现在发的平台稿确认后，各处说法一致：行上「正在发」，经过里「已确认，正在发」，不出现在「接下来要发」。编辑里每个平台的时间框标的是「按时间发的话，什么时候发」，旁边写「明天 20:00」这种说法；列表下面一句「现在发还是按时间发，在确认时选；这里只改时间」。
- [ACC-v3-time-05] 成片面板底栏有「预约发 / 现在发」；确认按钮的字跟着变：「确认这 N 条，按时间发」/「确认这 N 条，现在发」。小红书仍然逐条单独确认，不被带上。
- [ACC-v3-time-06] 飞书确认卡片的改单里有「什么时候发」：选现在发时不出现时间输入。
- [ACC-v3-time-08] 「现在发 / 预约发」只在成片面板底栏整批选（所有者 2026-11-18 定，解决 HANDOFF-v3 §6.1 第 3 条）：编辑里每个平台只改时间，没有「预约发 / 现在发」开关，和小红书现在的做法一样；不存在一批里有的现在发、有的按时间发的混合状态，底栏和确认按钮里不出现「开始发」。`work-edit.png` 里抖音那一行的开关以这一条为准、不做。
- [ACC-v3-time-09] 现在发不绕过任何检查：确认后照样过平台的每日上限、最小间隔、出口位置（暂停中的平台不发）、账号登录状态；过不了的不发，这一行写原因和最近能发的时间，留在「今天」等人处理，不静默。有测试：小红书当天已发 1 条时选现在发，这条不发并说明原因。

### 登录平台账号（在网页上）

- [ACC-v3-login-01] 扫码：二维码由发布机取回，显示在账号那一行下面；状态自己从「等你扫码」到「已扫码，在手机上点确认」到正常，不需要人点「我登录好了」。二维码过期显示「二维码过期了」和「换一个」。
- [ACC-v3-login-02] 短信：网页上填手机号、填验证码，转给发布机完成。手机号和验证码不落库、不进日志、不进审计的参数。有测试。
- [ACC-v3-login-03] 「在发布机上打开登录窗口」作为第三种方式保留；只有这种方式有「我登录好了」。
- [ACC-v3-login-04] 二维码、验证码、应用凭证只经云端转发：云端的库、日志、备份里都搜不到。有测试。
- [ACC-v3-login-05] 发布机不在线时登录按钮不可用，并说「发布机不在线，登录要它在线」。
- [ACC-v3-login-06] 第十节「账号浏览器隔离与换号」的四条照旧；其中写「扫码或短信登录」的文案保留，写「这台电脑」的改成发布机的名字。

### 设备：发布机和 Claude

- [ACC-v3-device-01] 设备码配对：设备发起，浏览器打开允许页；页面写明设备名、系统、角色、它能做什么、不能做什么、核对码。点「允许」后设备拿到令牌。码 10 分钟过期、只能用一次。有测试。
- [ACC-v3-device-02] 令牌只存哈希；绑定一个用户、一个角色、一台设备。断开后立刻失效（下一次请求就被拒）。有测试。
- [ACC-v3-device-03] 没登录时打开允许页，先去登录，登录后回到同一个允许页。
- [ACC-v3-device-04] 系统页「设备」：发布机每台一行（名字、在线、出口位置、账号数、版本），Claude 每个一行；能改名、断开。断开发布机前写出绑在它上面的账号数。
- [ACC-v3-device-05] 「现在更新」：点了之后这一行显示「正在更新…」，完成后版本变化并有一句提示；失败回到原版本并出现在「最近出的问题」。发布机不在线时按钮不可用并说明原因。自动更新每台可开关。
- [ACC-v3-device-06] 发布机从官网的安装页安装（所有者 2026-11-18 定：不做签名安装包）：macOS、Linux 用现有 `install.sh`，Windows 有等价的脚本并进同一套安装测试。装完注册成后台服务并自动打开允许页。产品界面里只有「打开安装页」和「复制安装页的地址」，不出现命令；命令只在官网的安装页上。在干净的 macOS 和 Windows 上各实测一次，写进「待人工」。

### 出口位置

- [ACC-v3-egress-01] 发布机用账号的浏览器探测出口 IP（不是 Node 的 `fetch`），国内、海外各一条线路；位置在**发布机本机**查离线库（所有者 2026-11-21 定：云端那一块先不做，改本机）：DB-IP City Lite 查国家城市，IPinfo Lite 查线路是不是机房；查询不把 IP 发给任何第三方；库文件不进仓库，发布机每月自动下载一次新库（下载失败沿用旧库并在系统页写明库的日期，没有库时位置写「查不到」、不暂停发布、要说明原因）；探测出口 IP 用到的回显地址写进 PR（国内、海外各一个），请求里不带任何账号或个人信息；系统页设备分段底部写明数据来源。有测试：浏览器走代理而 Node 不走时，报上来的是代理的出口。
- [ACC-v3-egress-02] 侧栏底部每一页都有发布机一行：在线与否 + 国家 城市 + IP。位置正常时是灰字加墨色地名；和账号平时的国家不一样时变成黄点「出口位置变了」。和 `screenshots/v3/today-ip-moved.png` 左下角对照。
- [ACC-v3-egress-03] 出口位置和账号上次登录成功时不在同一个国家：这个账号的自动发布暂停（队列不领取）；「今天」最上面（确认面板之上）出现一条待办，点「去处理」到系统页的设备分段；已确认的平台稿不丢。有测试钉住：位置变了之后跑一轮队列，没有任何发布尝试。
- [ACC-v3-egress-05] 暂停期间确认面板写明哪些平台暂停，暂停的行时间列是「暂停中」；确认后的提示是「其中 N 条等位置处理完再发」，不说「现在开始发」。侧栏第一行是「N 个账号暂停发布」。
- [ACC-v3-egress-06] 「继续用新位置」要行内再确认一次并写出后果，确认后才改基线、恢复发布。「我去关掉代理」不改基线，这一条变成「等发布机复查」，发布机探测到位置回到基线才自动恢复并消失。有测试钉住两条路径。
- [ACC-v3-egress-07] 接发布机的允许页、接受邀请的第 2 步写出那台电脑当时的位置、IP 和线路类型，并提醒先关代理。
- [ACC-v3-egress-08] 记下「账号登录成功时的出口国家」不依赖发布机后台服务有没有在跑：在 core 里写入登录成功的那一处直接记（不靠 `serve` 启动时挂的钩子）。用命令行单独登录（`hifabu account login`，没起 `hifabu serve`）也要记下；离线模式下没有 IP 库或探测失败时不记，并留事件说明原因，不静默。测试覆盖：命令行单独登录、网页登录、体检恢复为正常，三条路径都能做到「CN 登录、首次探测 JP → 暂停」。（2026-11-21 #310 合并时留下的边角：`notifyLogin` 只在 `serve` 非离线时挂上钩子）
- [ACC-v3-egress-09] IP 库在慢网络上也能下载下来（所有者 2026-11-22 在发布机上看到「DB-IP City Lite 没下载成功：The operation was aborted due to timeout」；库约 60MB，原来整份文件限 120 秒，网速低于约 500KB/s 必然失败）：(a) 超时按「连续一段时间收不到数据」算，不按总时长；边下边写临时文件，不把整份读进内存；中断后下次从断点续传（服务端不支持断点时从头下，并说明）；解压、校验能打开之后才替换旧库。(b) 失败后的重试间隔逐次拉长（例如 10 分钟、1 小时、6 小时，之后每 6 小时），不在每 10 分钟的探测里重下一整份；成功后回到每月一次。(c) 系统页说法分两种：从来没下载成功过时写「位置库还没下载下来：<人话原因>，已试 N 次，下次 <时间>」，不写「继续用旧库」；已有旧库时才写「继续用 <日期> 的库」。(d) 「出口位置」这一格有「现在重新下载」，对应一条命令（在 `commands.mjs` 定义，CLI / HTTP 由它派生），下载中显示进度，已在下载时不重复开始。测试用本地假下载源覆盖：慢速但持续有数据的下载能成功、中途断开后续传成功、连续失败的重试间隔、两种提示文字、按钮触发下载，不访问真实网络。
- [ACC-v3-egress-04] 两条线路出口不一样时，系统页两条都写出来，各自标明是国内平台还是海外平台看到的；机房线路用黄点标「可能是代理」（只提醒，不暂停）。查不到城市时只写国家。

### Claude 接入（plugin）

- [ACC-v3-plugin-01] plugin 带入库技能和本机 MCP 服务；工具由 `commands.mjs` 派生，只有制作机角色允许的命令。
- [ACC-v3-plugin-02] 第一次调用没有令牌时，自动打开允许页；允许后重试成功。令牌存在系统的安全存储里，不在明文文件里。
- [ACC-v3-plugin-03] 入库立刻返回任务号；上传在后台进行，Claude 的会话不被占住；中途断网、关掉 Claude 再打开，接着传，不重传已完成的分片。
- [ACC-v3-plugin-04] 作品页最上面有正在上传的一行（来自哪个 Claude、传了几个文件）；传完变成普通一行。到了发布时间文件还没到发布机，按「出了问题」处理并说明还要多久。
- [ACC-v3-plugin-05] 用户 A 的 plugin 入库的作品只出现在 A 的库里；工具的参数里没有用户。包含在 ACC-arch-03 的遍历里。

### 文件

- [ACC-v3-file-01] 上传和下载用限时签名地址直连对象存储；应用服务器的访问日志里没有文件流量。键是 `u/<用户>/<sha256>`。
- [ACC-v3-file-02] 用户 A 的签名地址取不到、也覆盖不了 B 的文件。有测试。
- [ACC-v3-file-03] 上传完成时核对大小和哈希，对不上不入库并留事件；发布机下载后核对哈希，对不上不发布并按「出了问题」处理。
- [ACC-v3-file-04] 平台稿一确认，绑定的发布机就开始预取，不等到发布时间。
- [ACC-v3-file-05] 单机模式用本地目录，不需要对象存储；同一组测试对两种存储都跑。

### 飞书（每个用户接自己的）

- [ACC-v3-feishu-01] 系统页有「通知」分段。没接时写明接了有什么用、不接会怎样，两个选择「接飞书」「不用飞书」。
- [ACC-v3-feishu-02] 接飞书全程在页面上：出二维码 → 飞书扫码建机器人 → 还差「让卡片上的按钮能点」时给一个按钮跳到飞书里开通 → 接好后自动发一张测试卡片。每一步自己往下走，没有「我弄好了」；不需要用户填任何凭证。
- [ACC-v3-feishu-03] A 的卡片只发给 A；用 A 的卡片按钮动不了 B 的任何对象（包含在 ACC-arch-03 的遍历里）。飞书应用的凭证加密存放，库、日志、备份里搜不到明文。有测试。
- [ACC-v3-feishu-04] 可以选往飞书发哪几类：要你确认的、出了问题的、每天的结果。关掉「要你确认的」或选「不用飞书」后，确认只在网页上做，「今天」照常列出；没有人确认，一条都不会发。
- [ACC-v3-feishu-05] 卡片发不出去时：系统页「通知」是红色的「卡片发不出去」和原因，带「重新接」；分段计数加一；要你确认的回到网页上。不静默。
- [ACC-v3-feishu-06] 能发一张测试卡片、能断开；断开要行内确认，写明断开后会怎样。
- [ACC-v3-feishu-08] 发布机的 `install.sh`（官网安装页那一行）顺带装好飞书组件 `lark-cli`：用官方发布渠道、固定版本、校验文件完整性，装在 versekit 自己的目录（跟 Node 一样，不动系统里已有的 `lark-cli`），channel-feishu 默认用这一份。重复运行 `install.sh` 不重复下载；下载或校验失败时说清原因，不影响 versekit 其余部分的安装，系统页「通知」显示「发布机上还没有飞书组件」，并给出重新运行安装的说明。测试用假的下载源和假的 `lark-cli` 覆盖：首次安装、重复运行、校验失败三种情况，不访问真实网络。（2026-11-21 #311 开工时发现：接飞书全程依赖本机已装 `lark-cli`，页面上装不了；按 ADR-0005，发布机只在安装时碰一次终端）
- [ACC-v3-feishu-07] v3 的卡片（改单里的「什么时候发」、出口位置变了的卡片）在真实飞书的手机端和桌面端各走一遍，由所有者实测，写进「待人工」。这一版之前没有在飞书上测过。
- [ACC-v3-feishu-09] 接飞书出错时，页面写的是真正的原因（所有者 2026-11-22 第二次扫码失败，页面显示的是 `lark-cli` 给 AI 助手看的 800 字说明，真正的错误被截掉了）：读 `lark-cli` 的输出时去掉 `[AI agent]` 开头的说明段和「等待用户授权...」这类过程行，从中取出 `{"ok":false,"error":...}` 的 `error.message`；常见情况翻成人话并给下一步：授权码过期或作废（`device_code is invalid` / `expired`）→「二维码过期了，点重新来」；在飞书里点了拒绝（`access_denied`）→「你在飞书里点了拒绝」；其余照原文显示，但不超过两行。完整原始输出只进日志，不进页面。授权失败后作废的二维码立刻收起，只留「重新来」，不能出现「报错」和「还能扫的二维码」同时在页面上。扫码建机器人（`config init`）那一步同样处理。测试用假的 `lark-cli`（输出说明段 + 错误 JSON）覆盖上面三种情况和二维码收起。
- [ACC-v3-feishu-10] 接飞书只扫一次码（所有者 2026-11-22 第二次扫码时手机提示「没有需要申请的权限」，授权永远完成不了）：根因是第二步 `lark-cli auth login` 不带 `--scope/--domain` 时默认申请飞书全部业务的用户权限，新建的机器人一个都没开，飞书授权页无权限可批，设备码最终作废。而第二步唯一的用途是拿到所有者的 `open_id`，扫码建机器人那一步飞书本来就会返回它：应用注册接口（`lark-cli` 源码 `internal/auth/app_registration.go`，`archetype=PersonalAgent`、`request_user_info=open_id tenant_brand`）的结果里有 `user_info.open_id`，只是 `lark-cli config init --new` 没有保存。改为：channel-feishu 自己走应用注册的 begin / poll（接口、参数、轮询间隔、过期处理照 `lark-cli` 源码，在文件头写 `// ported from larksuite/cli@<sha> internal/auth/app_registration.go`），拿到 `client_id`、`client_secret`、`open_id`；`client_secret` 只经 stdin 交给 `lark-cli profile add --app-secret-stdin` 存进钥匙串，不进 argv、日志、库、页面；`open_id` 直接用来配对；然后照旧探订阅、发测试卡片。整个流程不再调用 `lark-cli auth login`，也不再依赖用户身份令牌（`ready()` 只看应用配置和 bot 身份）；页面上只出现一个二维码，没有「再用飞书 App 扫一次」。注册结果里的 `tenant_brand` 与请求的品牌矛盾时报错，不静默。已经建好应用、但还没配对的发布机（所有者现在的状态）：页面给「重新接」，重新走一次注册，不要求先手动删旧应用。测试用本地假注册接口覆盖：成功（拿到三样并配对、发测试卡片）、用户取消、二维码过期、品牌矛盾，以及 secret 不出现在任何日志和子进程参数里；不访问真实飞书。
- [ACC-v3-feishu-11] 「重新接」扫完码能把新机器人存下来（所有者 2026-11-23 扫码成功后页面只显示「没接成：}}」，状态停在「差一次扫码」）。根因两处，都用本机 `lark-cli 1.0.97` 在隔离 HOME 里复现过：① 保存前删旧配置写成了 `profile remove --name versekit`，而真实命令是 `profile remove <name>`（位置参数），并且**不允许删除唯一的一个 profile**（报 `cannot remove the only profile`），这一步的失败被 `catch {}` 吞掉，接着 `profile add` 报 `profile "versekit" already exists`；② lark-cli 的错误 JSON 是**多行缩进**输出，`explainLarkFailure` 只逐行找 `{...}`，找不到就取最后两行，于是页面上只剩 `} }`。要求：(a) 已有 `versekit` 时按「`profile add --name <临时名>` → `profile remove versekit` → `profile rename <临时名> versekit`」替换（三步都在本机隔离 HOME 实测通过）；任一步失败时不丢掉旧配置也不留下临时名，页面写出 lark-cli 给的 `message`（如「profile "versekit" already exists」），不写 `}`；(b) `explainLarkFailure` 能从多行缩进的 JSON 里取出 `error.message`，测试用 lark-cli 1.0.97 的原样输出（含 `_notice.update` 段）做输入；(c) 测试用的假 lark-cli（`packages/cli/test/fixtures/fake-lark.mjs`、`packages/channel-feishu/test/registration.test.mjs` 里的那份）照真实行为：`remove` 只认位置参数、唯一 profile 删不掉、重复 `add` 报 already exists、错误一律多行缩进 JSON 输出到 stdout 并退出码 2；原来「`profile remove` 什么都返回 0」的写法删掉；(d) 离线测试覆盖：第一次接（没有 profile）、重新接（已有 `versekit` 且是唯一 profile）、替换中途 `rename` 失败三种，后两种跑完 `profile list` 里只有一个 `versekit` 且 appId 是新的（失败那种是旧的）。

### 用户（ADR-0004 的部分）

- [ACC-v3-user-01] 邮箱加密码登录；密码只存 scrypt 哈希；会话令牌只存哈希，cookie 是 HttpOnly、Secure、SameSite=Lax。
- [ACC-v3-user-02] 邀请链接只能用一次、7 天过期；过期或用过的显示「这条邀请不能用了」。
- [ACC-v3-user-03] 密码输错：按账号、按 IP 分别限速；A 被限速不影响 B 登录。报错不区分「邮箱不存在」和「密码不对」。
- [ACC-v3-user-04] 停用用户：她的会话和所有设备令牌立刻失效，排着要发的不发，数据保留；重新启用后数据都在。
- [ACC-v3-user-05] 接受邀请页四步：设密码、接发布机、登录第一个平台账号、接 Claude；后两步可跳过；中途离开，下次登录回到没做完的那一步。跳过的步骤不打勾，结尾写「还差 N 步才能发第一条」并能当场回去接。第 3 步换平台时，二维码和说明立刻跟着换。
- [ACC-v3-device-07] 一台发布机都没有时：侧栏写「没有发布机」，账号表的操作列是「先接一台发布机」，设备表有一句空状态。
- [ACC-v3-user-06] 系统页「用户」分段只有服务的所有者看得到；没有任何入口能看到别的用户的作品、文案、数据。
- [ACC-v3-user-07] 用户能导出自己的数据（库和文件清单）、删除自己的账号（库、文件、控制库里的行都删掉）。入口在侧栏底部的用户菜单。

### 日历（作品页的周视图和月视图）

- [ACC-v3-cal-01] 作品页顶部有分段「列表 / 周 / 月」，三个视图是同一批数据；不新增导航项。选了哪个视图、翻到哪一周（月）记在地址里，刷新不丢。
- [ACC-v3-cal-02] 日历上的最小单位是一条平台稿。已发布的用实际发布时间，没发的用计划时间；按用户所在时区显示。现在发的、我自己发的、这条不发的不上日历。
- [ACC-v3-cal-03] 周视图：周一到周日七列，今天的日期是墨色。同一天、同一支成片的平台稿收在一块，块头是作品标题和成片名；每条一行：时间、平台标志、状态。可以上一周、下一周、回到这一周。和 `screenshots/v3/works-week.png`、`works-week-next.png` 并排对照。
- [ACC-v3-cal-04] 月视图：一格一天，一天按作品收拢，每个作品一行（最要紧的状态点、标题、条数），最多三行，多了写「还有 N 个」。点日期进那一周的周视图。和 `screenshots/v3/works-month.png` 对照。
- [ACC-v3-cal-05] 状态只有四种，沿用现有的点：黄「等你确认」、墨圈「已确认」、灰「已发布」、红「出了问题」。已发布的是灰字，不带播放数。出口位置变了时暂停的平台写「暂停中」。
- [ACC-v3-cal-06] 今天和以后的列头写当天的平台额度（来自发布方案的平台规则），只在那天有这个平台的稿子时出现；超了是红字。数字和后端排期用的是同一条规则，有测试。
- [ACC-v3-cal-07] 点一行进那支成片；日历上不能确认、不能拖动改时间、不能新建。
- [ACC-v3-cal-08] 日历的数据来自一条带时间范围的命令（`publish.list` 加起止时间），CLI 上同样能用；一次只取当前可见的范围。

### 实现对设计的还原（2026-11-18 审计出来的）

- [ACC-v3-fid-01] `packages/web/public/app.css` 里旧版（v1）的样式全部删掉。实测：页面底色 `#fafaf8`；导航项高 34px；`body` 有 `-webkit-font-smoothing:antialiased` 和 `tabular-nums`；按钮、输入框、下拉框继承正文字体；焦点环是 2px 墨色、偏移 2px；选中色 `#ffd84a`。
- [ACC-v3-fid-02] 数据页按 `docs/design/data.html` 做完；做完之前，「今天」不出现指向它的「看全部」。
- [ACC-v3-fid-03] 作品列表、成片列表、今天页用真实封面：有入库封面就用它；没有就用成片视频的首帧（`<video preload="metadata">` 加 `#t=` 取帧，`/media` 支持 Range，不整段下载）；图文用第一张图；素材读不到或不是视频才用占位。（协调器 2026-11-18 裁定：入库时没有生成缩略图，首帧先顶上；入库封面另立条目 ACC-v3-fid-10。）
- [ACC-v3-fid-04] 侧栏「今天还能发」按平台说（「小红书 1 条」），不跨平台相加。
- [ACC-v3-fid-05] 一屏至多一个墨色主按钮。今天页只有「确认这 N 条」是墨色，其余待办卡片上的按钮是描边。
- [ACC-v3-fid-06] 已发布的行，时间列是发布时间；成片标题旁有时长；竖版成片的视频框是 360px 高。
- [ACC-v3-fid-07] 设计没覆盖、实现各自补的状态，按下面统一：素材读不到 → 视频框位置是占位封面加一行灰字「成片文件读不到」，不是黑底白字；没有建议时间 → 「还没定时间」灰字；平台稿没挂成片是数据问题，由迁移补上，页面不为它单独画状态。
- [ACC-v3-fid-09] 平台徽章用各平台的官方标志，形状不改；颜色是各平台的品牌色。「还没发」是灰色标志，「出了问题」是红底白色标志。素材以各平台品牌资源页的正式文件为准，来源和许可证写在文件头。TikTok 相关界面遵守 TikTok 的品牌规范。
- [ACC-v3-fid-08] 界面类实现单的证据包：1360 宽的截图和 `docs/design/screenshots/v3/` 里对应的那张并排；并贴出上面 fid-01 的实测值。（截图放 `docs/design/screenshots/impl/<页面>.png`，用 `hifabu demo seed` 的演示数据截，每次覆盖同名文件；PR 描述里用相对链接和 v3 那张并排。不放所有者的作品封面。）
- [ACC-v3-fid-10] 入库可以带封面：清单的成片上可写 `cover`（图片路径，相对清单），`vk work add`、`vk work push` 和发布机拉取都带上它，`/api/works` 返回封面地址；页面有封面用封面，没有才退回首帧。入库技能 `versekit-ingest` 的清单说明补上这个字段。不引入 ffmpeg 等运行时依赖。有测试。

### 实现对设计的还原（2026-11-21 审计出来的）

独立 agent 用 `vk demo seed` 的离线演示数据把 main（3868e04）和定稿并排比过。下面四条是那次查出来、此前口径没写到或验收漏判的。

- [ACC-v3-fid-11] 成片面板底栏选「现在发」以后，各平台行的时间列整列显示「现在发」（同 `docs/design/work.html` 切换后的样子），切回「预约发」恢复成时间。改内容里「跟通用」的字段是灰字、「单独写的」是墨色（同 `docs/design/screenshots/v3/work-edit.png`）。发布机相关文案里不再出现「这台电脑」，一律写发布机的名字（不是主机名 `xxx.local`，用设备名；没起名时用「发布机」）。
- [ACC-v3-fid-12] 同一件事各处说法一致，有测试：① 作品列表「最好的一条」和数据页对同一作品用同一个「平时」口径，倍数一致；② 成片还没有平台稿时，成片列表不显示「已发布」，和页头的「还没有平台稿」一致；③ 系统页页头「有 N 件事要处理」的 N 等于页面上列出来的条数。
- [ACC-v3-fid-13] 去掉定稿里没有的说明文字和区块：今天页底部「没确认的到时间也不会发；小红书每条单独确认。」；作品页周视图、月视图底部「日历只看不改：点一行进那支成片。」；系统页设备分段的「这台发布机现在」一块（排着要发 / 正在发 / 等你确认）。
- [ACC-v3-fid-14] 细节对齐：成片没时长时标题后不出现孤立的「·」；改内容里「各平台」小标题和通用文案框之间的间距同定稿；数据页每一条的作品标题下面有成片名，结论列只写倍数；`/api/works` 已返回 `cover: null` 时前端不请求 `/media/<id>?cover=1`（控制台没有 404）。

### 测试稳定（2026-11-18）

- [ACC-test-iso-01] `packages/driver-browser/test/isolation.test.mjs` 在全量 `npm test` 里稳定通过：本机全量连跑 5 次、CI 上 Node 22 和 Node 26 都不失败。查清楚原因（端口、Chrome 启动、并行抢资源）写进 PR；不许用加长固定等待或跳过测试的办法掩盖。
- [ACC-test-update-01] `packages/cli/test/update.test.mjs` 的「ACC-update-03 自动更新关掉：服务启动后不检查、不更新」在全量 `npm test` 里稳定通过：本机全量连跑 5 次、CI 上 Node 22 和 Node 26 都不失败（2026-11-18 起 CI 上偶发失败）。查清原因写进 PR（端口、计时、与别的测试抢资源、服务启动顺序）；修测试或修实现都可以，但不许加长固定等待、放宽断言或跳过。`packages/core/test/update.test.mjs` 的 ACC-update-03 照旧通过。
- [ACC-test-flaky-01] 在本机按默认并发跑 `npm run ci`，连续跑 5 次都必须通过。这里专门盯两类测试：一类是 `packages/relay/test/rename-deploy.test.mjs` 里 ACC-brand-08 的 Seoul 检查（以前会跑到 5000ms 超时），另一类是登录、cookie 相关的 Chrome 夹具（以前出现过 SIGABRT）。修的时候先查清原因并写进 PR；可以改测试，也可以改实现，但不许加长超时、放宽断言、跳过测试，也不许调低并发。2026-11-26 这一天，#482、#487、#491、#495 都碰到了这两个问题。
- [ACC-test-browser-01] `packages/driver-browser` 里「ACC-browser-login-01/03：写入持久 cookie → closeAccount → Cookies 表有行、重开仍在」在全量 `npm test` 里稳定通过：本机全量连跑 5 次、CI 上 Node 22 和 Node 26 都不失败（2026-11-21 前 15 次 main CI 挂过 2 次，PR #266 也挂过 1 次）。查清原因写进 PR（Chrome 落盘 Cookies 的时机、关浏览器的顺序、端口或 profile 目录竞争）；不许加长固定等待、放宽断言或跳过。
- [ACC-test-load-01] 机器负载高时全量 `npm test` 仍稳定（2026-11-21 PR #287 记录：几个 worker 同时跑测试时，`packages/channel-feishu/test/feishu.test.mjs` 的假 `lark-cli` 5 秒探测超时，报「飞书未配置：没有找到 lark-cli」，事件测试报 `0 !== 1`；`packages/cli/test/login-xhs.test.mjs` 等报「tab 连接已断开」「tab 已关闭」；单独复跑全过）。复现办法写进 PR（如同时起 3 份全量测试）；查清是探测超时写死、子进程启动慢还是共用端口或 Chrome；修测试的等待条件或实现的超时设置，不许加长固定等待、放宽断言或跳过。验收：同时起 3 份全量 `npm test`，连做 3 次都不失败；CI 上 Node 22 和 Node 26 都绿。
- [ACC-test-load-02] `packages/core/test/egress.test.mjs` 的「ACC-v3-egress-09 慢但一直有数据的下载能成功」在 CI 上偶发失败（2026-11-23 PR #352 的 Node 26 一次失败、重跑通过）：夹具每 20ms 给一块、无数据超时只有 120ms，机器一卡、两块之间超过 120ms 就被判成「连续没数据」。改成不依赖真实时钟的判定（例如给 `refreshGeoDb` 注入时钟或计时器，测试里推进假时间），或者让夹具在两块之间的真实间隔与超时之间有数量级的余量，同时仍能证明「总时长超过超时也能成功」；不许删掉这条测试、放宽断言或改成跳过。同文件里另外几条用 `idleMs` 的 egress-09 测试按同样方式检查。验收：本机同时起 3 份 `node --test packages/core/test/egress.test.mjs`，连做 5 次都不失败；CI 上 Node 22 和 Node 26 都绿。
- [ACC-test-cleanup-01] 测试跑完不留 Chrome 和临时目录（2026-11-22 协调器 Mac mini 磁盘写满、worker 全部停住：查到 55 个测试起的 Chrome 还活着，最早的跑了好几天，来自 `vk-yt-*`、`vk-tta-*`、`vk-sph-core-*`、`vk-sched-*`、`vk-acct-fresh-*`、`/tmp/vkt-*`、`/tmp/vks-*`、`/tmp/vkf-*`、`vk-click-*`、`vk-xhs-qr-*`；系统临时目录里测试残留约 48GB；Chrome 每次被强杀都在 `X/com.google.Chrome.code_sign_clone/` 留一份程序副本，已累计 1277 份）。根因：`driver-browser` 用 `detached` + `unref` 起 Chrome，测试结束时杀掉 `hifabu serve` / CLI 子进程或直接退出，没人关浏览器；全仓只有 2 个测试文件调 `closeAllAccounts()`；多数测试不删自己建的临时 `VK_HOME`。要求：(a) 测试共用一个收尾工具（例如 `test/helpers` 里登记临时目录和起过的子进程），每个起浏览器、守护进程或建临时目录的测试文件都用它，`after` 里关掉本文件起的全部 Chrome（按 `--user-data-dir` 落在本测试临时目录下识别，不碰别的 Chrome）、结束子进程、删临时目录；测试失败或超时也照样收尾。(b) `hifabu serve` 收到 SIGTERM / SIGINT 时调 `closeAllAccounts()` 再退出（有测试）。(c) 加一个检查进 `npm test`：全量跑完后，用户临时目录和 `/tmp` 下本次新出现的 `vk*` 目录为 0，`--user-data-dir` 在这些目录下的 Chrome 进程为 0；有残留时列出来并失败。(d) 不许为了过检查把浏览器改成不起、或跳过原本起浏览器的测试。验收：连跑 3 次全量 `npm test`，前后 Chrome 进程数和临时目录数不变；CI 上 Node 22 和 Node 26 都绿。

## 十二、Hifabu 账号与「交给发布机」（2026-11-24）

所有者 2026-11-24 定稿：「去做吧，问题都按照你的建议来」。依据是 `docs/design/account/BRIEF.md`、`docs/design/handoff/BRIEF.md`（任务书、结构、状态、出错文案），以及同目录下用浏览器直接打开的 `proposals.html`（页面和文案以它为准），ADR-0005 §15 第 10–13 条。

真机红线照旧：本机是开发机，不碰任何真实平台账号；验收不连真实的 Google、hifabu.com、volc1，一律用本地假服务。部署到 hifabu.com、真实 Google 登录、volc1 上线，都列为「待人工」（所有者做）。

### 账号服务（hifabu.com）

- [ACC-cloud-01] 账号服务是新包 `packages/cloud`，零运行时依赖。控制库用 `node:sqlite`，有 `user`、`identity`、`session`、`login_code`、`device`、`relay_grant` 六张表，独立于本机的 versekit 库，不读写本机凭证目录。账号服务上的命令（`device.list / device.revoke / relay.grant.request / relay.grant.set / user.list`）和本机命令（`cloud.login / cloud.logout / cloud.status`）都只在 `commands.mjs` 定义一次，CLI 和 HTTP 由它派生；不新增 `account.*`（那是平台账号）。有测试钉住：建库幂等；同一邮箱从不同登录方式进来是同一个 `user`。
- [ACC-cloud-02] Google 登录：授权码 + PKCE（S256）+ `state` 校验，只要 `openid email`（不要 `profile`，不存头像和昵称，与隐私政策一致）；只接受 `email_verified` 为真的邮箱。会话 cookie 是 HttpOnly、Secure、SameSite=Lax；改状态的请求校验 Origin，不符就 403。没有密码、没有找回密码、没有邀请码，注册开放（第一次登录就建账号）。登录页 `/login` 按 `docs/design/account/proposals.html` 做，覆盖 BRIEF §3 的状态：初始、Google 那边取消了、从接入页带来（多一句「登录后继续接入『<机器名>』」）。测试用本地假 Google（假授权端点和令牌端点）跑通「登录 → 建账号 → 有会话」，以及「state 不符 → 拒绝」「邮箱未验证 → 拒绝」。client id 和 secret 只从配置读，不进仓库、不进日志。真实 Google 登录列为待人工。
- [ACC-cloud-03] 接入机器：本机 `cloud.login` 向账号服务申请一次接入，拿到 6 位核对码和接入网址，用默认浏览器打开 `/link`；页面显示机器名、角色（制作机或发布机）、这台机器能做什么不能做什么，以及核对码，点「允许」后那台电脑自己继续，不用在页面上填任何东西。状态覆盖等你允许、接上了、已拒绝、过期（10 分钟）、没登录（先登录再回来）。`cloud.status` 返回是否已登录、Hifabu 账号邮箱、机器角色、传片是否开通；`cloud.logout` 清掉本机的令牌。CLI 和 HTTP 都走 `commands.mjs`。测试覆盖：允许、拒绝、过期三条路径各自的终态。
- [ACC-cloud-04] 机器令牌：账号服务用 Ed25519 私钥签（`node:crypto`）。内容有账号 id、机器 id、角色、能不能用传片、容量上限，1 小时过期。机器用长期的刷新凭证换新令牌；「退出这台」（`device.revoke`）之后刷新被拒，旧令牌最多 1 小时内失效。私钥只在账号服务的配置里（权限 600），公钥可以公开取。刷新凭证在库里只存哈希。账号服务的日志最多保留 30 天（隐私政策承诺），日志里不出现令牌、验证码、刷新凭证。测试覆盖：签发、验签、过期、篡改、退出后刷新被拒。
- [ACC-cloud-05] 我的 Hifabu `/account`：下载发布机程序**不用登录**；登录后能看到安装插件的那一句话、自己接了哪些机器（名字、角色、最近在线时间、「退出这台」）、传片状态。传片状态覆盖新账号、已申请开通、已开通（用量条）、快满（黄）、满了（红）；没开通时有「申请开通」，点了记一条申请，不发飞书。不出现作品、排期、数据。页面按 `docs/design/account/proposals.html` 做。
- [ACC-cloud-06] 管理页 `/admin`：只有所有者能进（所有者的邮箱在配置里，别人访问一律 403），列出所有账号、待处理的开通申请、每个账号的传片用量；点一下就能开通或关闭传片，默认容量 10GB，可以改。看不到任何人的作品和文案，也不能替用户操作。所有者能删除一个账号（隐私政策承诺收到邮件后 30 天内删）：删掉控制库里这个账号的所有行（身份、会话、机器、开通记录），并让中转删掉这个账号的目录；删除前二次确认，CLI 有等价命令。有测试钉住：非所有者访问 403；开通后这个账号签出的机器令牌里「能用传片」为真。
- [ACC-cloud-07] 本机系统页里「Hifabu 账号」一段：状态覆盖没登录（说明不登录也能用）、等浏览器里允许、已登录但传片没开通、已登录且传片已开通、连不上 hifabu.com（已登录的照常用，并说明上次核对的时间）。点「登录」走 ACC-cloud-03；登录成功后，中转地址和机器令牌由账号服务带下来，用户不用填任何地址或令牌。界面上不出现命令行，词表按 BRIEF §2.2（「Hifabu 账号」「传片」「退出这台」，不说 relay、令牌、设备）。界面单，按 ACC-v3-fid-08 交证据包。

### 中转按账号分

- [ACC-cloud-08] 中转（`packages/relay`）只认账号服务签的机器令牌：用公钥离线验签，不实时连账号服务；过期、篡改、没开通传片，一律 401 或 403，并说人话。投递和成片按 `<账号 id>/` 分目录存放，**只有同一账号的发布机拉得到**。测试造两个账号、各一台发布机，同时拉取，各自只拿到自己的投递，不会把对方的标成失败（这是 2026-11-24 的起因）。超过容量上限时拒收，并说还剩多少。现有的两个固定令牌暂时保留，有开关控制；所有者两台机器换成账号登录之后，按开关关掉，迁移步骤写进 `docs/deploy-relay.md`。发布机到 volc1 的实测下载速度写进 PR，列为待人工。

### 交给发布机（hifabu 侧能力）

- [ACC-deliver-01] 同一期再交是**更新，不是新建**：发布机入库时，优先用清单里的 `source`（制作机上那一期的路径）当作品来源，不再用 `inbox/<投递号>`。同一 `source` 再次投递时更新这个作品的成片、封面、文案；还没发出去的平台稿按新内容更新；已经发出去的不动，并在投递回报里说明。测试：同一期连交两次，只有一个作品。
- [ACC-deliver-02] 预览：`work.push` 支持 `dryRun`，只校验、不传任何字节。返回会传哪些文件、各多大、按最近实测速度估多久到发布机、哪些平台的文案会被拒、拒的原因（比如「小红书标题 24 字，限 20 字」）。中转剩余空间不到 2GB 时提示空间不够和剩多少。`relay.connect` 或登录时可以记一个默认账号组，交付时不用每次给组名。CLI 和 HTTP 都走 `commands.mjs`。
- [ACC-deliver-03] 上传不占着会话：`work.push` 登记任务后立刻返回投递号，由制作机的后台服务负责上传，支持断点续传和断网重试；关掉 Claude Code、重启后台服务，都会接着传。中转连不上时排队，网通了自动接着传。测试用本地假中转，在上传中途断开再恢复，最终文件 sha256 一致，不重复投递。
- [ACC-deliver-04] 状态回到制作机：`delivery.list` 和 `delivery.show <id>` 返回 BRIEF §3.3 的状态：正在传（已传多少、还要多久）、等发布机来取（附发布机上次来取的时间）、发布机在下载、等你确认、没交成（原因和下一步）。发布机回报「已入库」时，带上作品 id、每条平台稿的平台、账号和建议时间，以及被拒的平台和原因；中转原样存下，并记录发布机最后一次来取的时间。发布机 6 小时没来取时，状态文案按 BRIEF §5 写。入库后在飞书和「今天」页出一条「新到 1 期：<选题>，N 条等你确认」，已有这类通知就复用。
- [ACC-deliver-05] 插件（方案 A）：一个 Claude Code 插件，里面一个技能，只调用 `vk`，不直接读写库，也不直接连中转。在制作机的会话里说「交给发布机」或 `/hifabu:handoff <期号>` 就触发。技能按**项目交付约定**（每个项目一份文件，先写 vibe-video 的）认出这一期：成片取 `成片/` 里版本号最大的（带水印的那份）；「灵动版」这类不是版本号的变体每次都问；封面取 `封面/<编号>_<选题>_封面.png`；文案取 `文案/发布文案.md` 里对应的那一节，绝不把 `_文案.txt`（字幕时间轴）当正文；没有发布文案时按选题起草一份，给人看一眼再交。素材齐全就直接交，只在猜过的地方停下来问。还没登录 Hifabu 时先走登录，登录完接着交，不用重说。出错文案按 `docs/design/handoff/BRIEF.md` §5 写。用 vibe-video 的真实目录结构做离线测试（复制文件名，不复制视频内容），覆盖：多版本、灵动版、缺封面、缺文案。

### 插件对外分发（2026-11-25）

- [ACC-plugin-dist-01] 插件名改为 `hifabu`，目录改为 `plugins/hifabu`，技能命令是 `/hifabu:handoff`；`plugin.json` 写明 description、author（Hifabu）、homepage（`https://hifabu.com/plugin/`）、license 和 `version`（语义化版本，从 `0.1.0` 开始）。插件目录里任何文件改了就必须升版本：仓库里记一份「版本号 → 插件内容哈希」，测试发现内容哈希变了而版本没升就失败。这样 `claude plugin validate --strict` 能通过，用户执行 `claude plugin update` 也能拿到新版本（2026-11-25 实测：Claude Code 2.1.332 的 strict 校验会把缺 version 当失败）。仓库里任何地方都不再出现 `versekit` 插件名或 `/versekit:handoff`。
- [ACC-plugin-dist-02] 仓库根目录有 `.claude-plugin/marketplace.json`，市场名为 `hifabu`，`owner` 为 Hifabu，只列 `hifabu` 一个插件，source 写 `./plugins/hifabu`。`claude plugin validate . --strict` 和 `claude plugin validate plugins/hifabu --strict` 都通过。仓库根目录这份清单只给开发者在本地调试用；对外的安装方式见 ACC-plugin-dist-05。PR 里附上一份在临时 HOME 下用 `claude plugin marketplace add <本地仓库>` 加 `claude plugin install hifabu@hifabu` 装成功的记录（不改开发机自己的 Claude 配置）。
- [ACC-plugin-dist-03] 第一次使用的引导：找不到 `vk` 时，技能给出一键安装命令（`curl -fsSL https://raw.githubusercontent.com/versekit-labs/versekit/main/install.sh | bash`）并说明会装什么，用户同意后才执行；装完用 `$HOME/.versekit` 下的 `vk` 继续这一期，不让用户重说。之后按已有规则走登录 Hifabu、开通传片、预览、登记。插件里不写死任何个人路径、账号或邮箱。
- [ACC-plugin-dist-04] `https://hifabu.com/plugin/` 是公开页面，不用登录：写明前提（Claude Code、一台装了 Hifabu 的发布机、Hifabu 账号）、ACC-plugin-dist-05 的一句话安装（Claude Code 里一句话，或终端一行命令）、第一次怎么用（举「把 17 期交给发布机」的例子）、怎么更新和卸载；页头、页脚和首页、隐私政策、服务条款保持一致，首页链到这一页。
- [ACC-plugin-dist-05] 插件从 hifabu.com 分发，新用户一句话装好，不需要 GitHub 账号或 SSH 密钥，也不克隆整个仓库：
  - 发布脚本把 `plugins/hifabu` 打成 zip，生成 `https://hifabu.com/plugin/marketplace.json`，市场名为 `hifabu`，插件 source 用 `archive`，写上 zip 的 https 地址和 sha256。zip 文件名带版本号，旧版本的 zip 保留，不覆盖。
  - 终端一行命令：`claude plugin marketplace add https://hifabu.com/plugin/marketplace.json && claude plugin install hifabu@hifabu`。在一个全新的临时 HOME 里（没有 SSH 密钥、没有 GitHub 登录），从执行这行命令到 `claude plugin list` 里看到 hifabu，60 秒内完成。PR 里附上这次安装的记录。
  - Claude Code 里一句话：用户说「帮我安装 hifabu.com/plugin 的插件」，Claude 打开这个页面后，能照页面上写给 AI 助手的说明执行上面那行命令。说明写成纯文本，放在页面上，并另存一份 `https://hifabu.com/plugin/install.txt`。装好后提醒用户运行 `/reload-plugins` 或重开会话。
  - 升级插件：升 `version`，然后重跑发布脚本。用户执行 `claude plugin update hifabu@hifabu` 就能拿到新版本。发布脚本支持 `--dry-run`，只列出要上传的文件，不连网。

### 插件重设计：交付接口 v1（2026-11-26）

设计依据：`docs/design/plugin/DESIGN.md` §A.4（所有者 2026-11-26 定稿）。交付接口是制作机插件和发布机之间唯一的约定。下面的口径取代 ACC-deliver-01 里用 `source`（本机路径）认作品的做法，改用 `work.key`；旧投递照旧可用。

- [ACC-iface-01] 接口单独成文：`docs/delivery-interface.md` 写明清单格式、文件身份、更新规则、版本兼容和账号组快照，配 JSON Schema `schemas/delivery-v1.json`（`schema: "hifabu.delivery/1"`，`work.key`、`work.title`、`cuts[].video{name,sha256,size}`、可选的 `cover`、`copy.default` 和平台键、必填的 `target.group`、`from.client`）。测试用 schema 校验文中每个示例，全部通过；再各改坏一处（缺 `target.group`、`sha256` 不是 64 位十六进制、多出未知的主版本号），确认会被拒。
- [ACC-iface-02] 同一期再交就是更新：中转按原样接收并保存 v1 清单；发布机入库时按 `work.key` 找作品，找到就更新成片、封面和文案；还没发出去的平台稿按新内容更新，已经发出去的不动，并在回报里写明哪些没动。测试：同一个 `work.key` 连交两次，库里只有一个作品，已发平台稿的内容和状态都不变。v1 清单和现有的 `work.push` / `work.add` 在接口层做字段映射（`video` ↔ `versions[].asset`），发布机的入库逻辑不重写。
- [ACC-iface-03] 清单里不放本机路径：`work.key`、`name` 或任何字段里出现绝对路径（以 `/`、`~`、盘符开头，或者含 `..`）时，中转和发布机都拒收，错误码 `local_path_in_manifest`，并写人话原因。测试覆盖 macOS、Linux、Windows 三种路径写法。
- [ACC-iface-04] 版本兼容：只做加字段的改动不升主版本，读的一方忽略不认识的字段（测试：v1 清单多出一个未知字段，照常入库）。发布机每次来取时声明 `accepts: ["hifabu.delivery/1"]`，中转的 `ping` 回报这台发布机最近一次声明的 `accepts`。发布机遇到不认识的主版本（比如 `hifabu.delivery/2`）不入库，回报 `failed` 和 `errorCode: schema_unsupported`，原因和下一步在制作机的 `delivery.show` 里看得到。
- [ACC-iface-05] 旧投递照旧：0.1.0 插件发出的旧清单（没有 `schema`，用 `source` 当本机路径）仍然能入库，照旧按 `source` 匹配，不做迁移。测试用一份真实格式的旧清单。
- [ACC-iface-06] 账号组快照：发布机每次来取时，顺带把账号组快照报给中转（`device{id,name}`、`reportedAt`、`groups[{name, default?, accounts[{platform, name}]}]`），中转按账号只存最新一份。快照里只能有这些字段，**不能有**凭据、cookie、token、账号 id 或本机路径：测试用字段白名单断言，并故意让本地账号带上 cookie 和 id，确认它们不会出现在上报里。中转提供只读接口给制作机读这份快照（带 `reportedAt`，按账号隔离，A 账号读不到 B 账号的）。
- [ACC-iface-07] 隐私政策（`site/privacy/index.html`）补一句：发布机会把账号组名和账号显示名同步到你的 Hifabu 账号，用于在 Claude 里选择交到哪个组；不同步登录凭据。中英文都补。

### 插件重设计：hifabu 制作机小程序（2026-11-26）

设计依据：`docs/design/plugin/DESIGN.md` §A.1、§A.2、§A.7。所有者 11-26 定：形态用小程序，不用 MCP。小程序只包含制作机要用的 7 条命令（覆盖设计 §A.1 的 8 项能力），由 `commands.mjs` 派生，和完整版 `hifabu` 同名、同参数。

- [ACC-maker-01] 命令表标角色：在 `commands.mjs` 的 `COMMANDS` 里，给制作机要用的 7 条已有命令加上 `roles: ["maker"]`，只加这个字段，已有字段不改。这 7 条是：`cloud.login`、`cloud.status`、`cloud.logout`、`work.push`（含 `--dry-run`，对应设计 §A.1 里「预览」「交付」两项能力）、`delivery.list`、`delivery.show`、`group.list`。`group.list` 在制作机上读中转里发布机上报的账号组快照（ACC-iface-06），在完整版里读本机库；两边的 `--json` 输出格式相同，都带 `reportedAt`，完整版填读取时间。另外，在 `CLOUD_COMMANDS` 里新增服务端命令 `device.revoke.self`，和 `device.revoke`、`device.refresh` 放在同一张表，由 `packages/cloud` 派生出 HTTP 路由。它的作用是让设备用自己的凭据在服务端注销自己，供 `cloud.logout` 调用（见 ACC-maker-05）；它不进制作机小程序的命令集合。CI 里加一个 parity 测试：小程序 `--help` 列出的命令集合，必须等于 `COMMANDS` 里 `roles` 含 `maker` 的那 7 条。
- [ACC-maker-02] 校验抽成纯函数：`work.push` 用到的清单校验、文案限制、违规检查（现在挂在 `store` 上）抽到 `packages/core/src/plan-rules.mjs`，改成不碰数据库的纯函数，完整版和小程序共用。上传队列和失败记录抽象成一个小接口：完整版用库实现，小程序用数据目录里的 JSON 文件实现。抽完以后，完整版的已有测试全部照常通过。
- [ACC-maker-03] 构建：`scripts/build-maker-client.mjs` 生成 `plugins/hifabu/bin/hifabu`（启动脚本）和 `plugins/hifabu/lib/hifabu.mjs`（单文件 ESM，可读、不压缩，不超过 256KiB，文件头写构建脚本路径、构建输入的 SHA-256 和正文的 SHA-256）。产物里不能 import `node:sqlite`，也不能带平台适配器、浏览器驱动或 Web 代码（测试扫描产物来断言）。同一提交构建两次，产物的 sha256 相同。不新增运行时依赖；如果要加构建期依赖，必须在 PR 里说明理由。
- [ACC-maker-04] 输出一致：同一份清单，`hifabu work push <清单> --dry-run --json` 用完整版跑和用小程序跑，输出逐字相同（时间戳一类的易变字段除外，测试里列出这些字段）。小程序接受 `--data <目录>` 参数，把凭据、队列、项目选择存到这个目录；不给 `--data` 时，用一个写在文档里的默认目录。
- [ACC-maker-05] 登出：`hifabu cloud logout` 先调 `device.revoke.self`，在服务端作废这台设备，再删除本地凭据。之后用旧的刷新凭据去刷新，服务端拒绝（测试用本地假云端）。服务端不可达时，本地凭据照样删除，并说明「服务端没能注销这台设备，到 hifabu.com 的『我的 Hifabu』里手动移除」。

### 插件重设计：后台上传与运行时凭据（2026-11-26）

设计依据：`docs/design/plugin/DESIGN.md` §A.3、§A.5、§A.7。所有者 11-26 定：不加 SessionStart hook。

- [ACC-maker-06] 上传不占用会话：`hifabu work push` 先校验、算 sha256，再把投递写进 `<数据目录>/queue/<投递号>.json`，然后起一个分离子进程 `hifabu _uploader`（`detached` + `unref`，stdio 全部忽略），立刻返回 `{id, state: "pending"}`。测试要求：100MB 以内的清单从调用到返回不超过 1 秒（不含算 sha256 的时间）；杀掉父进程（模拟关闭 Claude）后，上传照样完成，最终在中转上的 sha256 一致。不写任何 launchd、systemd 文件，也不用 Claude Code 的后台任务。
- [ACC-maker-07] 上传进程只有一个，会续传，会自己退出：用 `<数据目录>/uploader.lock` 做单例（`O_EXCL` 加 pid 加心跳）；pid 不存在或心跳超过 60 秒没更新，就视为已死，由下一个进程接管。上传按分块续传，失败自动重试。测试用本地假中转：中途断开再恢复，最终只产生一个投递，已经传完的分块不重传。队列清空后进程自己退出，`ps` 里看不到残留。macOS 上传期间用 `caffeinate -i -w <pid>` 防止空闲睡眠，上传结束自动解除。
- [ACC-maker-08] 重启后接着传：只要有任何一次 `hifabu` 调用（包括 `delivery list`、`delivery show`、`work push`、`cloud status`），都先检查队列；有没传完的、又没有活着的上传进程，就把它拉起来。测试：杀掉上传进程，再调一次 `hifabu delivery list`，上传恢复并完成。`delivery.show` 在本地还在传的阶段，显示已传多少、预计还要多久；传完以后显示中转上的状态。
- [ACC-maker-09] 交互式会话真机验收：在一个真实的交互式 Claude Code 会话里交付一个超过 200MB 的测试文件（只用测试数据，传到本地假中转或测试中转，不碰真实平台账号），交付后立刻退出 Claude Code 并关掉终端窗口，上传照样完成。PR 里附上这次的记录。如果实测上传被连带清理掉，停下来报告给协调器，不要自己改方案。
- [ACC-maker-10] 运行时：`bin/hifabu` 先找系统 `node`（版本 ≥ 22.13），再找 `<数据目录>/runtime/` 里的 Node。两处都没有时，不运行，以非 0 退出，并输出一段机器可读的说明，包括需要什么、下载多大、放在哪、需要用户同意。`hifabu-runtime install` 在用户同意后，从 nodejs.org 下载一个锁定版本，用插件里写死的 sha256 校验，然后解压到 `<数据目录>/runtime/`，不改系统，也不进 PATH。测试要求：同意之前不下载任何东西；sha256 对不上时，停下并写明原因，不留下半解压的文件。下载地址可以用环境变量覆盖，方便测试和以后接镜像。
- [ACC-maker-11] 凭据：刷新凭据在 macOS 上放钥匙串（`security`，服务名 `hifabu`）；Linux 上有 `secret-tool` 就放 Secret Service；都没有时放 `<数据目录>/device.json`，权限 600。`hifabu cloud status` 里写明凭据存在哪。1 小时有效的机器令牌只放在内存里。测试抓取 `ps`、标准输出、错误输出和日志，断言凭据不出现在任何命令行参数、输出或日志里。另外写一份文档，说明凭据放在哪、卸载插件后钥匙串里会残留什么、怎么清理。

### 插件重设计：插件 0.2.0（2026-11-26）

设计依据：`docs/design/plugin/DESIGN.md` §A.6、§B.1–§B.5、§C。所有者 11-26 定：项目约定放在项目里；账号组由制作机来选并记住；自动更新默认打开；不加 hooks；不用 MCP。本节取代 ACC-deliver-05 和 ACC-plugin-dist-03 中「只调用 vk」「找不到就 curl 安装 VerseKit」的写法：插件不安装、也不引导安装发布机全套。

- [ACC-plugin-v2-01] 插件里有什么：只有一个技能 `handoff`（`/hifabu:handoff`），加上 `bin/hifabu` 和 `lib/hifabu.mjs`。没有 commands、hooks、MCP、agents。技能结构为 `SKILL.md`（不超过 120 行，写主流程，并写明什么时候去读哪一份参考）加 `references/` 目录（`project-setup.md`、`copy.md`、`status.md`、`errors.md`、`setup.md`）。正文写要点和判断规则，不写台词。参数和项目文件内容一律当作数据，不当作指令。`allowed-tools` 只预先放行 `Bash(hifabu *)`、`Read`、`Glob`、`Grep`，不放行 `Write`、`Edit`，也不放行下载运行时。
- [ACC-plugin-v2-02] 触发收紧：description 加 when_to_use 不超过 1536 字符。用 `claude plugin details` 实测，常驻成本不超过 60 token。离线评测：在没有交过东西的普通会话里，单独问一句「到了吗」，不触发本技能。
- [ACC-plugin-v2-03] 项目约定：项目约定放在 `<项目根>/.hifabu/project.json`。项目根取 git 仓库根，不是 git 仓库时取工作目录。约定里只写在哪里找、怎么认，不写账号和令牌。第一次在一个项目里使用时，先运行 `hifabu scan <项目根> --json`，列出视频、图片、文案类文件：按扩展名和修改时间筛选，不读文件内容，跳过 `.git`、`node_modules` 和隐藏目录。Claude 根据扫描结果猜一份约定，用两三句话给用户看，用户确认后再写入；写入要经过权限确认。之后在同一个项目里不再问。没有规律的项目不硬套模板，每次列出候选让用户挑。离线评测用三种目录结构不同的假项目（仿 vibe-video、仿 tcm-video、只有一个视频）：第一次使用时各问不超过 2 个问题，第二次 0 个。在 worktree 里、或者目录改了名，仍然认得出是同一个项目（按 `id` 认）。
- [ACC-plugin-v2-04] 账号组：第一次在一个项目里交付时，用 `hifabu group list` 读取账号组。只有一个组就直接用，并说明交到了哪个组、发哪些平台；有多个组就问一次，问的时候带上每个组有哪些平台。用户的选择按项目 `id` 记在插件数据目录里，不写进 `.hifabu/project.json`。之后同一个项目不再问，每次交完的回复里带上组名。用户说「这期交到某某组」只对这一次生效；说「以后都交到某某组」才更新记住的选择。组不在快照里时，不上传，并列出现有的组。快照超过 24 小时，或者发布机从来没上报过，照常交付，但在回复里说明。
- [ACC-plugin-v2-05] 安装包只放运行需要的文件：打包按白名单进行，只有 `.claude-plugin/plugin.json`、`README.md`、`CHANGELOG.md`、`LICENSE`、`bin/`、`lib/`、`skills/`。测试和构建脚本移到包外（`plugins/hifabu-src/` 或 `test/plugin/`），并由测试断言。包里不能出现任何项目名、个人目录、邮箱、`.DS_Store`、`..` 路径。`plugin.json` 要写明 version `0.2.0`、displayName、author、homepage、repository（公开仓库地址）、license、keywords、`engines.claude-code`、`network.hosts`，并通过 `claude plugin validate --strict`。README 写明以下内容：插件做什么；会运行什么；会把什么发到哪里；数据和凭据放在哪里；只能在 Claude Code 里用（带 `bin/` 的插件在网页版装不了）；怎么卸载、怎么清理凭据；对应哪个源码 tag，以及怎么重建 `lib/hifabu.mjs`、核对 sha256。CHANGELOG 写 0.2.0 和 0.1.0 两版。`version-lock.json` 取消第 2 单加的排除，对全量文件算哈希，并记录 0.2.0。
- [ACC-plugin-v2-06] 自动更新：第一次使用时，技能用 `Edit` 在用户的 `~/.claude/settings.json` 里给 `hifabu` 市场加上 `"autoUpdate": true`。这一步要经过权限确认，用户能看到改了什么。改完说一句「已打开 Hifabu 插件的自动更新，不想要可以在 /plugin 里关掉」。用户拒绝后不再问，并把「已问过」记在插件数据目录里。离线评测覆盖同意和拒绝两种情况。
- [ACC-plugin-v2-07] 不装发布机：技能里没有任何安装 VerseKit、Hifabu 完整版、biliup、lark-cli 的步骤，也没有 `curl | bash`。找不到 Node 时，走 ACC-maker-10 的运行时流程。没登录、或者没开通传片时，按 `references/setup.md` 的说法引导用户去 hifabu.com。发布机不在线、或者版本太旧时，告诉用户「到发布机那台电脑上打开或更新 Hifabu，下载地址 hifabu.com」。对外只出现 Hifabu 这个名字，不出现 VerseKit、vk。
- [ACC-plugin-v2-08] 端到端离线评测：在临时 HOME 里，从本地生成的市场安装 0.2.0，用本地假云端和假中转跑完整流程，覆盖以下情况：第一次使用（扫描并确认约定、选账号组、打开自动更新）、预览、交付、关掉会话后上传继续、问「到了吗」、多个候选文件、没有封面、没有文案（起草后先给用户看）、上传途中断网。PR 里附上评测记录。发布到 hifabu.com 由协调器在合并后执行；0.1.0 的 zip 保留，市场清单只指向 0.2.0。
- [ACC-plugin-v2-09] 项目变大以后，作品的 `work.key` 保持不变。路径里能认出期号的（比如 `07_草本故事/` 里的 `07`），即使目前只有一个视频，也按期号定 `work.key`。认不出期号的单视频项目，才用 `works` 里经用户确认的作品名。
  - 离线评测要加一个固定场景，分三步：
    1. 嵌套目录下只有第 07 期，交付一次；
    2. 再交付一次，两次的 `work.key` 必须相同；
    3. 加入第 08 期后交付第 08 期，第 07 期的 `work.key` 仍然不变，第 08 期拿到它自己的 key。
  - 这几次交付都不能追问作品是哪一期。
  - 这个场景要写进 `test/plugin/real-model.mjs`。真实模型的结果在 PR 里原样贴出来。
- [ACC-plugin-v2-10] 版本与更新（插件第 6 单）：
  - 插件页上写的更新命令，与 `claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu` 一致。在临时 HOME 里先装旧版、再在本地假 hifabu.com 上发布新版，照着页面上的命令能更新到新版。
  - `hifabu` 发现自己的版本落后于 hifabu.com 上的最新版时，在回复末尾提醒一次，提醒里带上更新命令，不阻断交付。同一个版本每天最多提醒一次。
  - 查新版本失败时只记日志，不打扰用户。请求里不带任何个人信息。
  - 有测试覆盖：落后时提醒；已是最新时不提醒；查不到新版本时不提醒，交付照常。
- [ACC-plugin-v2-11] 插件页与安装说明（插件第 7 单），依据 `docs/design/plugin/PAGE.md`，页面底稿是设计提交 d7f09bd 里的 `site/plugin/index.html`：
  - 页面要写清以下几点：插件里有什么、没有什么、源码链接、zip 的 sha256、怎么卸载。
  - 「在 Claude Code 里说一句」放在第一位。给 AI 助手的那一段，改成「先给用户看命令和它做什么，用户同意了再执行」。另外提供 `install.txt`。
  - 页面和 `install.txt` 由发布脚本从同一份来源生成：版本号、sha256 自动填进 `{{…}}` 占位；生成结果里还留有 `{{`，就拒绝发布。要有测试钉住这一条。
  - 实测：在全新账号、全新 HOME 的 Claude Code 里说一句「安装 hifabu.com/plugin 上的 Hifabu 插件」，Claude 要能找到命令、先给用户看、得到同意后装好，并提醒用户运行 `/reload-plugins`。默认模型和一个小模型各测 3 次，6 次都要成功，记录写进 PR。
  - 页面上不出现 VerseKit，也不出现 `curl | bash`。

### 发布机下载与正式发版（2026-11-26）

设计依据：`docs/design/download/DESIGN.md`。所有者 11-26 定（原话「按照你的建议来」）：
- 测试期用锁定版本的一行安装脚本，不出未签名的 .pkg；
- 在 hifabu.com 镜像 Node、biliup、lark-cli，sha256 以上游为准；
- 所有者的发布机改为跟正式发版走，不再跟 main；
- 新的更新逻辑上线前，发布机先关掉自动更新。

本节取代 ACC-update-02、ACC-update-03 中「比较 main 最新提交」「从 GitHub main 下载」的写法，以及 ACC-install-01 中「从 GitHub main `curl | bash`」的写法；空闲判断、自检、退回仍按原口径。凡是改到命令、文件、服务、更新的单，都要附 ACC-arch-09。

- [ACC-release-01] P1 发布脚本与版本清单：`deploy/hifabu/publish-release.mjs` 加 `schemas/release-v1.json`，`docs/deploy-cloud.md` 新增「发版」一节。要求：
  - 同一个 tag 打两次包，程序包 sha256 相同；
  - 程序包按白名单装文件，体积小于 5MB；
  - 工作区不干净或不在 tag 上时拒绝运行；
  - `--dry-run` 不连网，列出文件和 sha256；
  - 已存在的版本文件，内容不同时拒绝覆盖，文件只增不改，`latest.json` 最后原子替换；
  - 上游文件（Node、biliup、lark-cli）的 sha256 与上游校验和一致，才写进清单和镜像；
  - 核对 biliup-rs、lark-cli 的许可证是否允许再分发，不允许的只记上游地址、不镜像，结论写进 PR。
- [ACC-release-02] P2 安装脚本改为「锁定清单，只装核心」：`hifabu.com/download/<版本>/install.sh` 写死所有文件的 sha256。要求：
  - 在全新的临时 HOME 里，用本地假下载源安装，装完只有 Node 和程序，没有 biliup、lark-cli；
  - 任何一个文件 sha256 不符就停下，说明是哪个文件，不留下半截安装；
  - 注册后台服务前，先打印服务名、它做什么、日志在哪；
  - 在已有安装上升级（带 biliup、lark-cli 和数据），数据和组件都保留，版本按清单；
  - 在 macOS 14、15 真机上各装一次，没有被 Gatekeeper 拦截，结果写进 PR；
  - 从 main 上旧的 install.sh 地址运行，装到的是 `latest.json` 指定的版本；
  - 模拟旧更新程序（`VERSEKIT_UPDATE=1` 加 `VERSEKIT_APP_URL=file://…`）调用 main 上的 install.sh，升级后 `app.prev` 还在，旧更新程序的自检和退回照常可用。
- [ACC-release-03] P3 自动更新跟着发版走：`update.mjs` 改为读 `https://hifabu.com/download/latest.json`。要求：
  - 下载的 install.sh 的 sha256 对不上时不升级，并留事件；
  - 空闲判断、自检、退回保持不变，沿用 ACC-update-03、ACC-update-04 的测试；
  - 系统页显示这个版本的 CHANGELOG；
  - 请求里不带任何个人信息；
  - 没有「跟 main 走」的配置项。
- [ACC-release-04] P4 组件用到时才装：在 `commands.mjs` 新增 `component.list`、`component.install`、`component.remove`。要求：
  - 没装 biliup 时，添加 B 站账号会先出现「安装并继续」这一步，装完直接进入扫码；接飞书同理；
  - 下载按清单校验，sha256 不符就不装；
  - biliup 被删后，到点要发 B 站时，这一条进入「出了问题」，带 `error_code: component_missing` 和事件，不能静默跳过；
  - 已经装好的组件不动；
  - 网页上不出现命令行；
  - 三端一致测试覆盖这几条新命令。
- [ACC-release-05] P5 下载页 `hifabu.com/download`：要求：
  - 版本号、大小、sha256 都取自清单，不手写；
  - 设计稿 §3.1 的 9 块内容都有，第一块讲「发布机要和发布用的手机在同一个网络」；
  - 浅色、深色、手机宽度三种截图，都没有横向溢出；
  - 「先校验再运行」的三行命令在真机上跑通；
  - 页面上不出现 VerseKit 和 vk；
  - 页头导航、首页、「我的 Hifabu」都能链到这一页。
- [ACC-release-06] P6 第一个正式版本，以及所有者那台机器的升级：发布 `0.3.0`。要求：
  - 先演练：在临时 HOME 里用真机数据的副本，从所有者机器当前的版本模拟点「现在更新」升级到 0.3.0，前后账号数、作品数、排期数、登录状态文件都一致；
  - 所有者在系统页点一次「现在更新」，协调器陪同，挑接下来 1 小时内没有要发的时段；升级后系统页显示 0.3.0，后台服务只剩 `com.hifabu.daemon`；
  - 升级后 24 小时内，到点的发布照常执行；
  - 核对通过后再打开自动更新，之后只装 `latest.json` 指定的版本。

### 改名 Hifabu（2026-11-26）

所有者定：产品名改为 Hifabu，遗留的 versekit、vk 命令都改成 hifabu 体系。GitHub 仓库 `versekit-labs/versekit` 和 Orca 流程（orca-flow、worktree 路径、协调器脚本）这次不改。计划见 `docs/design/RENAME-HIFABU.md`，分 R1–R8 八步串行做。

- [ACC-brand-01] `npm run check:brand`（脚本 `scripts/ci/check-brand.mjs`）扫描仓库里所有已跟踪的文本文件，找出 `versekit`（不分大小写）、`VERSEKIT_`、`VK_`，以及作为独立命令出现的 `vk`（单词边界：命令行开头、反引号里、`npm run vk`；`vkey` 这类词里的 vk 不算）。输出按类别分组统计（用户看得见的字、命令、环境变量、本机路径、内部名字、服务器、其他），每类给出数量和前几处的 `文件:行号`，最后给总数。本单是报告模式：发现残留也以 0 退出，`npm run check` 接入它，但不因为它失败。加 `--strict` 时，白名单以外只要有残留就以 1 退出（留给 R8 用），测试要覆盖这两种模式。
- [ACC-brand-02] 白名单是显式文件 `scripts/ci/brand-allowlist.txt`，每条写明路径或匹配规则、理由类别（协议常量 / 仓库地址 / Orca 流程 / 历史文档 / 迁移代码 / 白名单本身）和一句话理由。没写理由的条目，脚本在任何模式下都报错。首批白名单至少包括：中转令牌 audience `versekit-relay` 等线上协议常量、`github.com/versekit-labs/versekit` 仓库地址、`bin/orca-flow.mjs` 和 `.orca-kit/` 等 Orca 流程文件、标注日期的历史文档。测试要能证明：命中白名单的不计入残留；没写理由的条目会报错。
- [ACC-brand-03] R2 用户看得见的字改为 Hifabu：本地控制台每一页的 `<title>` 和侧栏、飞书卡片、中转和投递状态的文案（比如「打开那台电脑上的 Hifabu」）、CLI 的人话输出和错误信息、`site/`、`docs/design` 里现行的设计稿和 `.impeccable` 任务书，都不再出现 VerseKit 或 versekit 字样。浅色和深色各截一张主要页面的图，附在 PR 里；`npm run design:check` 通过。命令名、环境变量、本机路径、内部包名不在本单范围内。改完后，`check:brand` 报告里「用户看得见的字」这一类归零。
- [ACC-brand-04] R3 命令改名为 `hifabu`：`package.json` 的 bin 和 scripts（`npm run hifabu -- …`）、`commands.mjs` 每条 `cli.usage`、AGENTS.md §5、技能和文档里的命令示例、`install.sh` 都改成 `hifabu`。子命令和参数不变。`vk` 作为别名保留两个小版本：照常可用，每次在 stderr 提示一句「vk 已改名为 hifabu」，stdout 和退出码与 `hifabu` 完全一致。测试要覆盖三点：`hifabu --help` 和 `vk --help` 列出的命令集合相同；完整版 `hifabu` 接受 `--data <目录>` 参数并忽略它（和插件小程序的调用方式兼容，见 RENAME §2.1）；三端一致测试仍然通过。
- [ACC-brand-05] R4 环境变量改名：所有 `VERSEKIT_*` 和 `VK_*` 改为 `HIFABU_*`（例如 `VK_HOME` 改为 `HIFABU_HOME`）。只设旧名时照样生效，并在 stderr 提示一次；新旧都设时用新名。测试改用新名，另外加一组测试专门覆盖旧名后备。本机数据目录的默认值不变，仍是 `~/.versekit`、`~/.config/versekit`、`~/.local/state/versekit`。
- [ACC-brand-06] R5 后台服务改名，数据目录不动：后台服务从 `com.versekit.daemon` 改为 `com.hifabu.daemon`（Linux 的 systemd user 单元同理）。更新时先注册并启动新服务，确认它健康后再卸载旧服务。更新完成后只剩新服务；新服务读的仍是原来的数据目录，更新前后账号数、作品数、各平台登录状态都一致。更新中途任何一步失败，旧服务照常运行，并写明原因。先在临时 HOME 里测完，PR 里附上记录；所有者在自己那台发布机上点更新，作为最后一道验收。
- [ACC-brand-07] R6 内部名字：根包名改为 `hifabu`，`@versekit-app/*` 改为 `@hifabu/*`，`vk.mjs` 等文件改名，`.claude/skills/versekit-ingest` 改为 `hifabu-ingest`，品牌图标改名，代码注释里的产品名一并改掉。`npm test` 全绿，`check:brand` 报告里「内部名字」这一类归零。
- [ACC-brand-08] R7 服务器：volc1 和 seoul 上的 systemd 单元、数据目录、`/opt` 目录、Caddy 片段，以及 `deploy/` 下的脚本和文档，都改成 hifabu 的名字。数据目录用 `mv`，旧路径留一个符号链接，保留一周。仓库里要有切换脚本和回滚脚本，并且支持 `--dry-run`。切换由协调器在部署窗口执行：切换前后，中转上的投递数和 blob 数一致；0.1.0 插件和旧版发布机切换后照常能拉取（协议常量没改）；同机的其他服务（assurelane 等）不受影响。
- [ACC-brand-09] R8 闸门改为拦截：`npm run check` 改用 `check:brand --strict`。白名单以外的残留为 0；新增任何一处 `versekit`、`VERSEKIT_`、`VK_` 或独立的 `vk` 命令，CI 都会失败（测试里用一个故意写入的样例来证明）。本机数据路径和飞书 profile `versekit` 这一条白名单，理由写「暂不迁移，待发布机新安装器」。

### 部署（2026-11-25）

- [ACC-deploy-cloud-01] seoul-vps 上的账号服务部署材料放在 `deploy/hifabu/`：
  - systemd 单元以非 root 用户运行 `packages/cloud`，只监听 `127.0.0.1`；
  - nginx 片段加在现有的 `hifabu.conf` 里，把 `/login`、`/login/google/callback`、`/account`、`/admin`、`/link`、`/.well-known/hifabu-machine-key.pem` 和账号服务的接口转给它，其余路径照旧由 `/var/www/hifabu` 提供静态页；
  - 不新增公网监听，不改 assurelane 的配置；
  - 配置模板列出全部 `HIFABU_*` 配置项（`HIFABU_GOOGLE_CLIENT_ID` 预填 `877087769526-u44jrpc2fie2p3meh6s6b2oto8cuqrv0.apps.googleusercontent.com`），环境文件权限 600；
  - 签名私钥第一次部署时在服务器上生成（权限 600），以后不重新生成。
- [ACC-deploy-cloud-02] `deploy/hifabu/deploy.sh` 能重复执行：
  - `--dry-run` 列出要写的文件和要执行的命令，不连网；
  - Google 客户端密钥只能在服务器上交互输入（不回显），不能出现在命令行参数、仓库或日志里；已经存过的，再部署时不再询问；
  - 部署后自检：`nginx -t` 通过，assurelane.ai 和 hifabu.com 首页都是 200，`/.well-known/hifabu-machine-key.pem` 能取到公钥，`/login` 能跳转到 accounts.google.com，并且回调地址是 `https://hifabu.com/login/google/callback`。
- [ACC-deploy-cloud-03] volc1 上的中转配置加上 Hifabu 的机器公钥和控制端凭据（`deploy/volc1` 与 `docs/deploy-relay.md`），旧的固定令牌照常可用；`docs/deploy-cloud.md` 写明部署日顺序：账号服务 → 中转 → 所有者的制作机和发布机在系统页登录 → 核对传片 → 再决定什么时候关掉旧令牌。每一步都写明怎么回退。

### 第二批

- [ACC-cloud-09] 邮箱验证码登录：验证码 6 位数字，10 分钟有效，输错 5 次作废；按邮箱和按 IP 分别限速；库里只存哈希。发信方式写在配置里（SMTP，或某家发信服务的 HTTP 接口），不引入任何 SDK。登录页的状态包括：验证码已发、码不对、码过期、试太多次。同一个邮箱，用 Google 登录和用验证码登录进的是同一个账号。测试用本地的假发信服务。QQ 邮箱、163 邮箱能不能收到信要实测，列为待人工。
