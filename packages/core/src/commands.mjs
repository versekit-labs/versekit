// The single source of truth for what versekit can do.
// CLI help, HTTP routes and Feishu card buttons are all derived from this table, and CI asserts
// the three stay identical (docs/ARCHITECTURE.md §5, PRD §5.4).
//
// Adding a capability = adding an entry here. If a feature exists only in the web UI, it is a bug.
//
// Fields:
//   name       command id, stable — it is what a card button sends and what the audit row records
//   args       shape of the payload; the CLI and the HTTP layer both validate against it
//   remote     may be triggered by a card button (i.e. without the person sitting at the machine)
//   localOnly  explicitly cannot be triggered from a card (may still have a local HTTP route)
//   http       { method, path } — null only when localOnly is true
//   card       button projection; only allowed on remote commands
//   audit      "always" for anything remote, "never" for read-only local queries

export const COMMANDS = [
  {
    name: "init",
    summary: "建库、写配置、准备目录",
    remote: false,
    localOnly: true,
    args: {},
    http: null,
    cli: { usage: "vk init" },
    card: null,
    audit: "never",
  },
  {
    // 后台服务（ACC-install-04）：status / start / stop / restart / install / uninstall 由 CLI 在本机直接执行
    // （服务停了就没有守护进程可调，和 init 同理）；HTTP 只开放只读的 status，供控制台自检页看服务有没有在跑。
    name: "service",
    summary: "后台服务：status | start | stop | restart | uninstall [--purge]（卸载默认保留数据）",
    remote: false,
    localOnly: true,
    args: { action: "string?" },
    http: { method: "GET", path: "/api/service" },
    cli: { usage: "vk service status|start|stop|restart | uninstall [--purge]" },
    card: null,
    audit: "never",
  },
  {
    name: "now",
    summary: "一屏状态：账号健康 / 队列 / 通道",
    remote: true,
    args: {},
    http: { method: "GET", path: "/api/now" },
    cli: { usage: "vk now [--human]" },
    card: null,
    audit: "never",
  },
  {
    name: "doctor",
    summary: "自检：能不能跑 / 能不能发 / 能不能看到 / 能不能收到",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/doctor" },
    cli: { usage: "vk doctor [--human] [--json]" },
    card: null,
    audit: "never",
  },
  {
    name: "setup.status",
    summary: "接入进度：环境 / 账号 / 通道 / 第一条发布",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/setup" },
    cli: { usage: "vk setup [--json]" },
    card: null,
    audit: "never",
  },
  {
    name: "platform.list",
    summary: "已安装的平台适配器与可用状态",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/platforms" },
    cli: { usage: "vk platforms" },
    card: null,
    audit: "never",
  },
  {
    name: "group.list",
    summary: "列出账号组（含每组账号数与当前组）",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/groups" },
    cli: { usage: "vk group list" },
    card: null,
    audit: "never",
  },
  {
    name: "group.add",
    summary: "新建账号组并进入（创建即成为当前组）",
    remote: false,
    args: { name: "string" },
    http: { method: "POST", path: "/api/groups" },
    cli: { usage: "vk group add <名字>" },
    card: null,
    audit: "never",
  },
  {
    name: "group.rename",
    summary: "给账号组改个名字（只改显示名，组里的账号与排期都不动）",
    remote: false,
    args: { group: "string", name: "string" },
    http: { method: "POST", path: "/api/groups/:group/rename" },
    cli: { usage: "vk group rename <组 id 或名字> <新名字>" },
    card: null,
    audit: "always",
  },
  {
    name: "group.use",
    summary: "切换当前账号组（之后所有页面只看这个组）",
    remote: false,
    args: { group: "string" },
    http: { method: "POST", path: "/api/groups/current" },
    cli: { usage: "vk group use <组 id 或名字>" },
    card: null,
    audit: "never",
  },
  {
    name: "bootstrap",
    summary: "一次拉齐外壳快照：当前组、组列表、账号、数据新鲜度、口径化计数、跨组只读矩阵",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/bootstrap" },
    cli: { usage: "vk bootstrap [--json]" },
    card: null,
    audit: "never",
  },
  {
    name: "work.add",
    summary: "入库作品：一个视频文件 = 1 作品 1 成片 1 版本；多支成片、多语言用 cuts 完整形式。同一来源同一标题重复入库是更新",
    remote: false,
    localOnly: true,
    args: { asset: "string?", title: "string?", source: "string?", cuts: "array?" }, // cuts[].copy / versions[].copy：各平台文案，见 .claude/skills/versekit-ingest
    http: { method: "POST", path: "/api/works" },
    cli: { usage: "vk work add <视频文件或图片目录> [--title <标题>] | vk work add <清单.json>" },
    card: null,
    audit: "never",
  },
  {
    // 制作机 → 云端中转（ACC-relay-02）：清单先按 work.add 的规则校验，不合格当场报错不上传；
    // 文件传到中转（可断点续传），制作机本地不建作品。
    name: "work.push",
    summary: "制作机：把清单和成片传到云端中转，等发布机拉取入库（不在本机建作品）",
    remote: false,
    localOnly: true,
    args: { manifest: "string", group: "string" },
    http: { method: "POST", path: "/api/works/push" },
    cli: { usage: "vk work push <清单.json> --group <组名>" },
    card: null,
    audit: "never",
  },
  {
    name: "relay.status",
    summary: "中转连接状态：上次拉取时间、正在下载的投递和进度、最近失败（发布机）；是否配了推送（制作机）",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/relay" },
    cli: { usage: "vk relay status [--human]" },
    card: null,
    audit: "never",
  },
  {
    name: "relay.connect",
    summary: "写中转配置：发布机用拉取 token，制作机加 --push 用推送 token",
    remote: false,
    localOnly: true,
    args: { url: "string", token: "string", push: "boolean?" },
    http: { method: "POST", path: "/api/relay/connect" },
    cli: { usage: "vk relay connect <地址> --token <token> [--push]" },
    card: null,
    audit: "never",
  },
  {
    name: "relay.disconnect",
    summary: "断开中转：清掉本机保存的中转地址和令牌（已经下载入库的作品不动）",
    remote: false,
    localOnly: true,
    args: {},
    http: { method: "POST", path: "/api/relay/disconnect" },
    cli: { usage: "vk relay disconnect" },
    card: null,
    audit: "never",
  },
  {
    name: "relay.pull",
    summary: "发布机：现在就从中转拉一轮待投递（后台服务也会每 5 分钟自动拉）",
    remote: false,
    localOnly: true,
    args: {},
    http: { method: "POST", path: "/api/relay/pull" },
    cli: { usage: "vk relay pull" },
    card: null,
    audit: "never",
  },
  {
    name: "work.list",
    summary: "列出作品（含成片数、语言版本数、平台稿数；状态由平台稿推出；默认只看当前账号组，--group 指定别的组）",
    remote: false,
    args: { group: "string?" },
    http: { method: "GET", path: "/api/works" },
    cli: { usage: "vk work list [--group <组>]" },
    card: null,
    audit: "never",
  },
  {
    name: "work.show",
    summary: "看一个作品：成片、语言版本、每条平台稿的状态（默认只看当前账号组的平台稿，--group 指定别的组）",
    remote: false,
    args: { workId: "string", group: "string?" },
    http: { method: "GET", path: "/api/works/:workId" },
    cli: { usage: "vk work show <workId> [--group <组>]" },
    card: null,
    audit: "never",
  },
  {
    name: "today",
    summary: "现在要我做什么：等确认的作品（按成片）、出了问题的、已确认等时间的队列、满 24 小时的结果（含和平时比的倍数）；默认只看当前账号组，并列出其他组各有几件事",
    remote: false,
    args: { group: "string?" },
    http: { method: "GET", path: "/api/today" },
    cli: { usage: "vk today [--group <组>] [--human]" },
    card: null,
    audit: "never",
  },
  {
    name: "account.add",
    summary: "加一个账号（必须在账号组里；一个平台一个槽位）",
    remote: false,
    localOnly: true,
    args: { platform: "string", name: "string", handle: "string?", credentialRef: "string?", group: "string" },
    http: { method: "POST", path: "/api/accounts" },
    cli: { usage: "vk account add <platform> --group <组> --name <name> [--handle @x] [--credential <cookies.json>]" },
    card: null,
    audit: "never",
  },
  {
    name: "account.list",
    summary: "列出账号与登录状态（--group 只看某个组，附占用者信息）",
    remote: true,
    args: { group: "string?" },
    http: { method: "GET", path: "/api/accounts" },
    cli: { usage: "vk account list [--group <组>]" },
    card: null,
    audit: "never",
  },
  {
    name: "account.show",
    summary: "看一个账号的详情；视频号带登录时长（这次登录已多久、最近几次平均撑多久）",
    remote: true,
    args: { accountId: "string" },
    http: { method: "GET", path: "/api/accounts/:accountId" },
    cli: { usage: "vk account show <accountId>" },
    card: null,
    audit: "never",
  },
  {
    name: "login.checktime.show",
    summary: "看视频号每天检查登录的钟点（默认 08:00）",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/login-check/time" },
    cli: { usage: "vk account checktime" },
    card: null,
    audit: "never",
  },
  {
    name: "login.checktime.set",
    summary: "改视频号每天检查登录的钟点（时:分，如 08:00）；只在这个钟点、启动、确认、发布前 2 小时查，不做保活",
    remote: false,
    localOnly: true,
    args: { time: "string" },
    http: { method: "POST", path: "/api/login-check/time" },
    cli: { usage: "vk account checktime <时:分>" },
    card: null,
    audit: "always",
  },
  {
    name: "account.remove",
    summary: "移除账号（换号前；不删历史，只让出组里的平台槽位）",
    remote: false,
    localOnly: true,
    args: { accountId: "string" },
    http: { method: "DELETE", path: "/api/accounts/:accountId" },
    cli: { usage: "vk account remove <accountId>" },
    card: null,
    audit: "always",
  },
  {
    name: "account.reauth",
    summary: "重新登录某个账号（远程只能发起，扫码必须在电脑前完成）",
    remote: true,
    args: { accountId: "string" },
    idempotent: (a) => `reauth:${a.accountId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/accounts/:accountId/reauth" },
    cli: { usage: "vk account reauth <accountId>" },
    card: { label: "重新授权", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "account.login.open",
    summary: "打开这个账号的登录窗口（由人完成登录，浏览器保持不关）",
    remote: false,
    args: { accountId: "string" },
    http: { method: "POST", path: "/api/accounts/:accountId/login/open" },
    cli: { usage: "vk account login <accountId> --open" },
    card: null,
    audit: "never",
  },
  {
    name: "account.login.qr",
    summary: "小红书扫码登录：后台无头取二维码（重复调用=换新码），之后用 login.status 轮询",
    remote: false,
    args: { accountId: "string" },
    http: { method: "POST", path: "/api/accounts/:accountId/login/qr" },
    cli: { usage: "vk account login <accountId> --qr" },
    card: null,
    audit: "never",
  },
  {
    name: "account.login.start",
    summary: "开始短信验证码登录（小红书扫码登录的备用入口）",
    remote: false,
    args: { accountId: "string", phone: "string?" },
    http: { method: "POST", path: "/api/accounts/:accountId/login/start" },
    cli: { usage: "vk account login <accountId> --phone 138..." },
    card: null,
    audit: "never",
  },
  {
    name: "account.login.status",
    summary: "扫码登录是否完成（顺带刷新二维码）",
    remote: false,
    args: { accountId: "string" },
    http: { method: "POST", path: "/api/accounts/:accountId/login/status" },
    cli: { usage: "vk account login <accountId> --status" },
    card: null,
    audit: "never",
  },
  {
    name: "account.login.resend",
    summary: "重发小红书短信验证码",
    remote: false,
    args: { accountId: "string" },
    http: { method: "POST", path: "/api/accounts/:accountId/login/resend" },
    cli: { usage: "vk account login <accountId> --resend" },
    card: null,
    audit: "never",
  },
  {
    name: "account.login.verify",
    summary: "提交网页登录的验证码",
    remote: false,
    args: { accountId: "string", code: "string" },
    http: { method: "POST", path: "/api/accounts/:accountId/login/verify" },
    cli: { usage: "vk account login <accountId> --code 123456" },
    card: null,
    audit: "never",
  },
  {
    name: "account.login.cancel",
    summary: "放弃网页登录",
    remote: false,
    args: { accountId: "string" },
    http: { method: "POST", path: "/api/accounts/:accountId/login/cancel" },
    cli: { usage: "vk account login <accountId> --cancel" },
    card: null,
    audit: "never",
  },
  {
    name: "account.logout",
    summary: "退出登录：关掉这个账号的浏览器、删掉它自己的浏览器资料，状态变成没连上；之后可以重新登录另一个号（只动这一个账号）",
    remote: false,
    localOnly: true,
    args: { accountId: "string" },
    http: { method: "POST", path: "/api/accounts/:accountId/logout" },
    cli: { usage: "vk account logout <accountId>" },
    card: null,
    audit: "always",
  },
  {
    name: "account.connect",
    summary: "官方接口账号授权（TikTok Login Kit、YouTube 的 Google OAuth）：本机临时端口接回调、PKCE；完成后保存 token 到本机凭证目录，显示头像和昵称（YouTube 显示频道名）",
    remote: false,
    localOnly: true,
    args: { accountId: "string", timeoutMs: "number?" },
    http: { method: "POST", path: "/api/accounts/:accountId/connect" },
    cli: { usage: "vk account connect <accountId>" },
    card: null,
    audit: "always",
  },
  {
    name: "account.credentials",
    summary: "保存某个平台的应用凭证（TikTok 官方接口：client key / client secret；YouTube：Google OAuth 客户端的 client id / client secret；写进本机 config.json，权限 600；环境变量仍优先）",
    remote: false,
    localOnly: true,
    args: { platform: "string", clientKey: "string", clientSecret: "string" },
    http: { method: "POST", path: "/api/platforms/:platform/credentials" },
    cli: { usage: "vk account credentials tiktok|youtube --client-key <key 或 client id> [--client-secret <secret>]（secret 也可从 stdin 或 TIKTOK_CLIENT_SECRET 读）" },
    card: null,
    // 不审计：command_audit 会把 args 原样写进库，而这里的 args 里有 secret。保存动作留一条不含凭证的事件。
    audit: "never",
  },
  {
    name: "account.creator",
    summary: "查询这个 TikTok 账号现在的发帖设置（creator_info）：可选隐私级别、评论/合拍/拼接是否允许、最长时长",
    remote: false,
    args: { accountId: "string" },
    http: { method: "GET", path: "/api/accounts/:accountId/creator" },
    cli: { usage: "vk account creator <accountId>" },
    card: null,
    audit: "never",
  },
  {
    name: "account.mode",
    summary: "把账号设为自动发布 / 仅手动",
    remote: true,
    args: { accountId: "string", mode: "auto|manual" },
    idempotent: (a) => `mode:${a.accountId}:${a.mode}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/accounts/:accountId/mode" },
    cli: { usage: "vk account mode <accountId> auto|manual" },
    card: { label: "转手动跟踪", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "account.check",
    summary: "立即验证某个账号的登录态",
    remote: false,
    args: { accountId: "string" },
    http: { method: "POST", path: "/api/accounts/:accountId/check" },
    cli: { usage: "vk account check <accountId>" },
    card: null,
    audit: "never",
  },
  {
    name: "publish.create",
    summary: "创建发布（一条内容 → 多平台）",
    remote: false,
    localOnly: true,
    args: {
      asset: "string",
      to: "string[]",
      group: "string?",
      schedule: "number?",
      visibility: "string?",
      dryRun: "boolean?",
      title: "string?",
      body: "string?",
      tags: "string[]?",
    },
    http: { method: "POST", path: "/api/publishes" },
    cli: { usage: "vk publish <asset> --to <platforms> [--group <组>] [--title] [--body] [--tags a,b] [--schedule] [--visibility] [--dry-run]" },
    card: null,
    audit: "never",
  },
  {
    name: "plan.apply",
    summary: "按成片生成平台稿（待确认）：默认当前账号组里所有已接入平台各一条，建议时间守平台规则，文案取入库时写好的；已有平台稿的账号跳过",
    remote: false,
    localOnly: true,
    args: { cutId: "string", accounts: "string[]?", group: "string?" },
    http: { method: "POST", path: "/api/cuts/:cutId/plan" },
    cli: { usage: "vk plan apply <cutId> [--accounts a,b] [--group <组>]" },
    card: null,
    audit: "never",
  },
  {
    name: "plan.show",
    summary: "看发布方案（当前账号组）：成片类型 · 语言 → 发到哪些平台 → 节奏；附组内平台与生效的平台规则",
    remote: false,
    args: { group: "string?" },
    http: { method: "GET", path: "/api/plan" },
    cli: { usage: "vk plan show [--group <组>]" },
    card: null,
    audit: "never",
  },
  {
    name: "plan.set",
    summary: "改发布方案的一行（没有就新增；--remove 删掉）。只影响之后入库的作品，已经生成的平台稿不变",
    remote: false,
    localOnly: true,
    args: { kind: "string?", language: "string?", platforms: "string[]?", delayDays: "number?", remove: "boolean?", group: "string?" },
    http: { method: "POST", path: "/api/plan" },
    cli: { usage: "vk plan set [--kind video|image] [--lang zh|en|…] --to <平台,平台> [--delay-days N] [--remove] [--group <组>]" },
    card: null,
    audit: "always",
  },
  {
    name: "plan.reset",
    summary: "把发布方案恢复成默认（所有成片发到组里所有已接入的平台）",
    remote: false,
    localOnly: true,
    args: { group: "string?" },
    http: { method: "POST", path: "/api/plan/reset" },
    cli: { usage: "vk plan reset [--group <组>]" },
    card: null,
    audit: "always",
  },
  {
    name: "machine.status",
    summary: "发布机：守护进程心跳、排着要发、正在发、等你确认（与「今天」同一份数据）",
    remote: false,
    args: { group: "string?" },
    http: { method: "GET", path: "/api/machine" },
    cli: { usage: "vk machine [--group <组>]" },
    card: null,
    audit: "never",
  },
  {
    // 发布机出口位置（#310）。看：两条线路的 IP、国家城市、线路类型；每个账号平时的国家；谁被暂停。
    name: "egress.status",
    summary: "发布机的出口位置：国内、海外两条线路的 IP 与国家城市，和账号平时的国家不一样的账号（自动发布已暂停）",
    remote: false,
    args: { group: "string?" },
    http: { method: "GET", path: "/api/egress" },
    cli: { usage: "vk egress [--group <组>]" },
    card: null,
    audit: "never",
  },
  {
    name: "egress.recheck",
    summary: "现在就用发布机的浏览器再探测一次出口位置（位置回到平时的国家会自动恢复发布）",
    remote: false,
    localOnly: true,
    args: { group: "string?" },
    http: { method: "POST", path: "/api/egress/recheck" },
    cli: { usage: "vk egress recheck [--group <组>]" },
    card: null,
    audit: "always",
  },
  {
    name: "egress.accept",
    summary: "继续用新位置：把现在的国家定为这些账号平时的位置并恢复发布。要 confirm，因为代理没关时平台会看到账号突然换了国家",
    remote: false,
    localOnly: true,
    args: { group: "string?", accountId: "string?", confirm: "boolean?" },
    http: { method: "POST", path: "/api/egress/accept" },
    cli: { usage: "vk egress accept --yes [--group <组>] [--account <账号id>]" },
    card: null,
    audit: "always",
  },
  {
    name: "egress.wait",
    summary: "我去关掉代理：不改平时的位置，等发布机复查；探测到位置回到平时的国家就自动恢复发布",
    remote: false,
    localOnly: true,
    args: { group: "string?", accountId: "string?" },
    http: { method: "POST", path: "/api/egress/wait" },
    cli: { usage: "vk egress wait [--group <组>] [--account <账号id>]" },
    card: null,
    audit: "always",
  },
  {
    // 后台自动更新（#217）。看：版本 + 提交号 + 安装时间、上次检查、自动更新开关、上次更新内容与失败。
    name: "update.status",
    summary: "程序版本（版本号 + 提交号 + 安装时间）与自动更新状态：上次检查、开关、上次更新了什么、上次失败",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/update" },
    cli: { usage: "vk version [--json]" },
    card: null,
    audit: "never",
  },
  {
    // 做：--check 只比较提交并说人话；--auto on|off 开关后台自动更新；都不带就更新（下载新包、用新包里的
    // install.sh 非交互升级，保留 app.prev，数据不动；失败自动退回）。HTTP 上的「更新」交给脱离守护进程的 vk update 去做。
    name: "update",
    summary: "更新程序：--check 只看有没有新版本；--auto on|off 开关后台自动更新；不带参数就更新（失败自动退回旧版本，数据保留）",
    remote: false,
    localOnly: true,
    args: { check: "boolean?", auto: "string?", now: "boolean?" },
    http: { method: "POST", path: "/api/update" },
    cli: { usage: "vk update [--check] [--auto on|off] [--now]" },
    card: null,
    audit: "always",
  },
  {
    name: "publish.list",
    summary: "列出发布（按状态/平台筛选；给 from/to 就是日历用的时间范围）",
    remote: false,
    args: { state: "string?", platform: "string?", limit: "number?", from: "number?", to: "number?", group: "string?" },
    http: { method: "GET", path: "/api/publishes" },
    cli: { usage: "vk publish list [--state failed] [--platform tiktok] [--from 2026-11-16 --to 2026-11-22 [--group <g>]]" },
    card: null,
    audit: "never",
  },
  {
    name: "schedule.list",
    summary: "发布计划：一个作品一张卡（带平台与撞车标记）",
    remote: false,
    args: { group: "string?", from: "number?", to: "number?" },
    http: { method: "GET", path: "/api/schedule" },
    cli: { usage: "vk schedule list [--group <g>] [--from 2026-11-10] [--to 2026-11-17]" },
    card: null,
    audit: "never",
  },
  {
    name: "schedule.move",
    summary: "改期：整个作品的所有平台一起挪；过去时间拦截，撞车先提示",
    remote: false,
    args: { workId: "string", at: "number", force: "boolean?" },
    http: { method: "POST", path: "/api/schedule/:workId/move" },
    cli: { usage: "vk schedule move <workId> --at <2026-11-10T20:00|2h> [--force]" },
    card: null,
    audit: "always",
  },
  {
    name: "schedule.cancel",
    summary: "取消排期：整个作品不再发（保留现场，不删行）",
    remote: false,
    args: { workId: "string" },
    http: { method: "POST", path: "/api/schedule/:workId/cancel" },
    cli: { usage: "vk schedule cancel <workId>" },
    card: null,
    audit: "always",
  },
  {
    name: "approval.link",
    summary: "给一条要拍板的发布生成手机审批链接",
    remote: false,
    args: { publishId: "string" },
    http: { method: "GET", path: "/api/approvals/link" },
    cli: { usage: "vk approval link <publishId>" },
    card: null,
    audit: "never",
  },
  {
    name: "approval.apply",
    summary: "用审批链接重试或取消（手机页面也走它）",
    remote: false,
    args: { token: "string", decision: "string" },
    http: { method: "POST", path: "/api/approvals/apply" },
    cli: { usage: "vk approval apply <token> retry|cancel" },
    card: null,
    audit: "always",
  },
  {
    name: "publish.retry",
    summary: "重试一次发布",
    remote: true,
    args: { publishId: "string" },
    idempotent: (a) => `retry:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/retry" },
    cli: { usage: "vk publish retry <publishId>" },
    card: { label: "重试", style: "primary", confirm: false },
    audit: "always",
  },
  {
    name: "publish.release",
    summary: "把 private_then_public 的内容放行为公开",
    remote: true,
    args: { publishId: "string" },
    idempotent: (a) => `release:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/release" },
    cli: { usage: "vk publish release <publishId>" },
    card: { label: "放行公开", style: "primary", confirm: false },
    audit: "always",
  },
  {
    name: "publish.confirm",
    summary: "确认已在 App 内完成发布（notify 模式）",
    remote: true,
    args: { publishId: "string" },
    idempotent: (a) => `confirm:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/confirm" },
    cli: { usage: "vk publish confirm <publishId>" },
    card: { label: "我已发布", style: "primary", confirm: false },
    audit: "always",
  },
  // ---- 发布前人确认（#146，ACC-v2-confirm-*）。平台稿生成后停在「待确认」，只有下面这几条命令能放行。
  // 与 publish.confirm（notify 模式下确认已在 App 里发完）是两回事，与 approval.*（失败后的签名审批链接）也是两回事。
  {
    name: "publish.approve",
    summary: "确认发布：给成片就确认它下面所有非小红书的待确认平台稿，按建议时间发（when=now 则现在发，照样过每日上限、最小间隔、账号状态，过不了的留在待确认并写原因）；给平台稿就只确认这一条（小红书逐条）",
    remote: true,
    args: { cutId: "string?", publishId: "string?", when: "string?" },
    idempotent: (a) => `approve:${a.cutId ?? a.publishId}:${a.when ?? "scheduled"}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/approve" },
    cli: { usage: "vk publish approve --cut <cutId> | --publish <publishId> [--now]" },
    card: { label: "按时间发", style: "primary", confirm: false },
    audit: "always",
  },
  {
    name: "cut.edit",
    summary: "改一支成片的内容：通用文案、各平台单独写的字段、按时间发的时间，一次提交、带 rev（别处先改过就拒绝）",
    remote: true,
    args: { cutId: "string", rev: "number", language: "string?", generic: "object?", platforms: "object?" },
    // rev 本身就是幂等保护：同一个 rev 只能成功一次。
    idempotent: (a) => `cutedit:${a.cutId}:${a.rev}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/cuts/:cutId/edit" },
    cli: { usage: "vk cut edit <cutId> --rev <版本号> [--lang <语言>] [--title <通用标题>] [--body <通用正文>] [--tags <话题,逗号分隔>] [--platforms <JSON或文件>]" },
    card: null,
    audit: "always",
  },
  {
    name: "publish.now",
    summary: "这条现在就发（确认并把建议时间改成现在）",
    remote: true,
    args: { publishId: "string" },
    idempotent: (a) => `now:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/now" },
    cli: { usage: "vk publish now <publishId>" },
    card: { label: "现在发", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "publish.manual",
    summary: "我自己发：不自动发，转为等你在 App 里发完（发完用 publish confirm）",
    remote: true,
    args: { publishId: "string" },
    idempotent: (a) => `manual:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/manual" },
    cli: { usage: "vk publish manual <publishId>" },
    card: { label: "我自己发", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "publish.skip",
    summary: "这支先不发：整支成片的待确认平台稿都跳过（含小红书），以后还能再确认",
    remote: true,
    args: { cutId: "string" },
    idempotent: (a) => `skip:${a.cutId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/cuts/:cutId/skip" },
    cli: { usage: "vk publish skip --cut <cutId>" },
    card: { label: "这支先不发", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "publish.edit",
    summary: "确认前改这条平台稿的标题、正文、话题或建议时间（发布用改后的值；不改作品标题）",
    remote: true,
    args: {
      publishId: "string",
      title: "string?",
      at: "number?",
      // 确认时看得到、改得了每个平台的正文和话题（#175）：按平台文案限制校验，超限拒绝。
      body: "string?",
      tags: "string[]?",
      // TikTok 官方接口的发布设置（#143）：确认时由人填，存在这条平台稿的 overrides 里。
      privacy: "string?",
      comment: "boolean?",
      duet: "boolean?",
      stitch: "boolean?",
      caption: "string?",
      draft: "boolean?",
    },
    // 同一次改动点两下只执行一次；改成别的值是另一次改动。
    idempotent: (a) =>
      `edit:${a.publishId}:${a.title ?? ""}:${a.at ?? ""}:${a.body ?? ""}:${(a.tags ?? []).join(",")}:${a.privacy ?? ""}:${a.comment ?? ""}:${a.duet ?? ""}:${a.stitch ?? ""}:${a.caption ?? ""}:${a.draft ?? ""}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/edit" },
    cli: { usage: "vk publish edit <publishId> [--title <标题>] [--body <正文>] [--tags <话题,逗号分隔>] [--at <2026-11-10T20:00|2h>] [--privacy <级别>] [--comment|--no-comment] [--duet|--no-duet] [--stitch|--no-stitch] [--caption <文案>] [--draft|--no-draft]" },
    card: { label: "改标题、正文或时间", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "collect.now",
    summary: "立刻抓一次指标",
    remote: true,
    args: { publishId: "string?", platform: "string?" },
    // 按小时去重：连点两次不该排两次，隔一小时再点应该真的重抓。
    idempotent: (a) => `collect:${a.publishId ?? a.platform ?? "all"}:${new Date().toISOString().slice(0, 13)}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/collect" },
    cli: { usage: "vk collect [--now] [--platform <p>]" },
    card: { label: "立即重抓", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "stats.works",
    summary: "看作品指标（JSON；默认只看当前账号组，--group 指定别的组；每条带 24 小时播放与和平时比的倍数）",
    remote: true,
    args: { range: "string?", publishId: "string?", group: "string?" },
    http: { method: "GET", path: "/api/stats/works" },
    cli: { usage: "vk stats works [--range 7d] [--publish <id>] [--group <组>]" },
    card: { label: "看 24 小时数据", style: "default", confirm: false },
    audit: "never",
  },
  {
    name: "stats.series",
    summary: "某个作品的全部快照（画趋势用）",
    remote: false,
    args: { publishId: "string" },
    http: { method: "GET", path: "/api/stats/series" },
    cli: { usage: "vk stats series <publishId>" },
    card: null,
    audit: "never",
  },
  {
    name: "run.list",
    summary: "看任务队列与失败原因（--group 只看某个组）",
    remote: false,
    args: { state: "string?", limit: "number?", group: "string?" },
    http: { method: "GET", path: "/api/runs" },
    cli: { usage: "vk runs [--state failed] [--group <组>]" },
    card: null,
    audit: "never",
  },
  {
    name: "event.list",
    summary: "看事件（排障用）",
    remote: false,
    args: { since: "number?", limit: "number?" },
    http: { method: "GET", path: "/api/events" },
    cli: { usage: "vk events [--since <ms>]" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.status",
    summary: "飞书应用是否已配置 / 已授权 / 已配对",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/channels/feishu/status" },
    cli: { usage: "vk channel status feishu" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.subscription",
    summary: "飞书事件订阅是否生效（按钮能不能点）",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/channels/feishu/subscription" },
    cli: { usage: "vk channel subscription feishu" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.skip",
    summary: "先跳过手机通道（不挡发布）",
    remote: false,
    args: {},
    http: { method: "POST", path: "/api/channels/feishu/skip" },
    cli: { usage: "vk channel skip feishu" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.unskip",
    summary: "重新开启手机通道",
    remote: false,
    args: {},
    http: { method: "POST", path: "/api/channels/feishu/unskip" },
    cli: { usage: "vk channel unskip feishu" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.app.create.start",
    summary: "扫一次码建飞书机器人并配对（secret 只经 stdin 交给 lark-cli，不落盘）",
    remote: false,
    args: {},
    http: { method: "POST", path: "/api/channels/feishu/app/create" },
    cli: { usage: "vk channel app create feishu" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.app.create.status",
    summary: "扫码创建应用的进度",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/channels/feishu/app/create" },
    cli: { usage: "vk channel app create feishu --status" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.app.create.cancel",
    summary: "取消还没完成的扫码创建",
    remote: false,
    args: {},
    http: { method: "POST", path: "/api/channels/feishu/app/create/cancel" },
    cli: { usage: "vk channel app create feishu --cancel" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.app.set",
    summary: "保存你自己的飞书应用（secret 只走 stdin）",
    remote: false,
    args: { appId: "string", appSecret: "string" },
    http: { method: "POST", path: "/api/channels/feishu/app" },
    cli: { usage: "vk channel app set <appId>（secret 从 stdin 读）" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.bind",
    summary: "配对飞书账号（给 open_id，或用 lark-cli 已登录的人）",
    remote: false,
    localOnly: true,
    args: { openId: "string?" },
    http: { method: "POST", path: "/api/channels/feishu/bind" },
    cli: { usage: "vk channel bind feishu" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.settings",
    summary: "往飞书发哪几类：要你确认的 / 出了问题的 / 每天的结果（不带参数 = 只看）",
    remote: false,
    args: { confirm: "boolean?", issue: "boolean?", daily: "boolean?" },
    http: { method: "POST", path: "/api/channels/feishu/settings" },
    cli: { usage: "vk channel settings feishu [confirm|issue|daily on|off]" },
    card: null,
    audit: "always",
  },
  {
    name: "channel.unbind",
    summary: "断开飞书：不再往飞书发卡片，要你确认的只在网页上做；飞书里的机器人不删",
    remote: false,
    localOnly: true,
    args: {},
    http: { method: "POST", path: "/api/channels/feishu/unbind" },
    cli: { usage: "vk channel unbind feishu" },
    card: null,
    audit: "always",
  },
  {
    name: "channel.diagnose",
    summary: "飞书通道诊断：安装 / 登录 / 绑定 / 事件订阅",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/channels/feishu/diagnose" },
    cli: { usage: "vk channel diagnose feishu" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.test",
    summary: "飞书通道探活",
    remote: false,
    args: {},
    http: { method: "POST", path: "/api/channels/feishu/test" },
    cli: { usage: "vk channel test feishu" },
    card: null,
    audit: "never",
  },
];

export const findCommand = (name) => COMMANDS.find((c) => c.name === name) ?? null;

/**
 * 卡片上的「翻页」按钮（开始确认、切换按时间/现在发、取消回到确认卡）。它们只换卡片、不改数据，
 * 所以不是命令；但它们也必须在这张表里声明，并指明服务于哪条远程命令（`serves`）。
 * 卡片上出现既不是命令、也没在这里声明的 cmd，`check:parity` 与 card-parity 测试都会失败。
 * 真正改数据的动作（提交修改、确认、跳过）一律是命令本身，不在这里。
 */
export const CARD_VIEWS = [
  { name: "card.review", serves: "publish.approve", summary: "新作品卡片「开始确认」：发出第一支成片的确认卡" },
  { name: "card.edit", serves: "publish.edit", summary: "确认卡「改标题或时间」/ 编辑卡切换「按时间发 / 现在发」：原地换成编辑表单" },
  { name: "card.show", serves: "publish.approve", summary: "编辑卡「取消」：原地换回确认卡" },
];

export const findCardView = (name) => CARD_VIEWS.find((v) => v.name === name);

/**
 * 卡片按钮 value 的唯一造法：cmd 必须是 remote 命令，或 CARD_VIEWS 里声明过的翻页，否则当场抛错。
 * cards.mjs 不再自己手写 callback 的 cmd 字面量——翻页用 viewButton(name, ...)，命令用 commandButton(name, ...)，
 * 两者都经过这里，所以卡片上不可能出现表外动作（check:parity 再从源码层面兜一道）。
 */
export function cardCallbackValue(cmd, args, { key = null, now, ttlMs }) {
  const problems = cardActionProblems([{ cmd }]);
  if (problems.length) throw new Error(`卡片按钮不合法：${problems.join("；")}`);
  return { cmd, args, exp: now + ttlMs, ...(key ? { key } : {}) };
}

/**
 * 一组卡片按钮 value（{ cmd, ... }）里，哪些动作在表里找不到。每条返回人话。
 * 合法 = 远程命令，或 CARD_VIEWS 里声明过且 serves 指向远程命令的翻页。
 */
export function cardActionProblems(values) {
  const problems = [];
  for (const v of values) {
    const cmd = v?.cmd;
    if (!cmd) {
      problems.push("按钮没有带 cmd");
      continue;
    }
    const command = findCommand(cmd);
    if (command) {
      if (!command.remote) problems.push(`${cmd} 是命令但不是 remote，不能挂在卡片按钮上`);
      continue;
    }
    const view = findCardView(cmd);
    if (!view) problems.push(`${cmd} 既不在命令表、也没在 CARD_VIEWS 里声明`);
    else if (findCommand(view.serves)?.remote !== true) problems.push(`${cmd} 声明服务于 ${view.serves}，但它不是 remote 命令`);
  }
  return problems;
}

/** What a remote caller (card button) is allowed to trigger. */
export const remoteCommands = () => COMMANDS.filter((c) => c.remote);

/**
 * Argument validation shared by the CLI, the HTTP layer and the card handler. Returns the parsed
 * args or throws with a field name — never a silent coercion, because `publishId: undefined`
 * reaching the queue is how a card button "does nothing".
 */
// 空字符串本身是有意义的值的参数：publish.edit 的 body 给 "" 表示清空正文（ACC-v2-copy-04）。
// 其他可选参数仍把 "" 当成没填，避免表单里的空输入框变成"改成空"。
const EMPTY_STRING_MEANS_VALUE = { "publish.edit": ["body"] };

export function parseArgs(command, input = {}) {
  const args = command.args ?? {};
  const out = {};
  for (const [key, spec] of Object.entries(args)) {
    const optional = spec.endsWith("?");
    const type = spec.replace(/\?$/, "");
    const value = input[key];
    const keepEmpty = value === "" && optional && type === "string" && (EMPTY_STRING_MEANS_VALUE[command.name] ?? []).includes(key);
    if (!keepEmpty && (value == null || value === "")) {
      if (optional) continue;
      throw new Error(`命令 ${command.name} 缺少参数：${key}`);
    }
    if (type === "string" && typeof value !== "string") throw new Error(`参数 ${key} 必须是字符串`);
    if (type === "number" && typeof value !== "number") throw new Error(`参数 ${key} 必须是数字`);
    if (type === "boolean" && typeof value !== "boolean") throw new Error(`参数 ${key} 必须是布尔值`);
    if (type === "array" && !Array.isArray(value)) throw new Error(`参数 ${key} 必须是数组`);
    if (type === "object" && (typeof value !== "object" || Array.isArray(value))) throw new Error(`参数 ${key} 必须是对象`);
    if (type === "string[]" && !Array.isArray(value)) throw new Error(`参数 ${key} 必须是字符串数组`);
    if (type === "auto|manual" && !["auto", "manual"].includes(value)) throw new Error(`参数 ${key} 只能是 auto 或 manual`);
    out[key] = value;
  }
  for (const key of Object.keys(input)) {
    if (!(key in args)) throw new Error(`命令 ${command.name} 不认识参数：${key}`);
  }
  return out;
}
