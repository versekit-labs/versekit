---
version: 1
slug: "packages-web-public-account-wall-html"
primary_target: "packages/web/public/account-wall.html"
related_targets: ["docs/design/account-wall.html"]
---

# 账号页（当前组五槽位）· 实现任务书

- **Scope**：`packages/web/public/account-wall.html`，线上路径 `/accounts`；桌面 1440 与手机 390 同页两态。
- **Mode**：Operate。
- **Audience**：P1 独立创作者 / 一人公司；当前只管理一个账号组，需要确认五个平台槽位谁接入了、谁的登录态出问题。
- **Job**：一屏看清当前组五个平台槽位的接入与登录状态；异常账号就地处理，缺口就地补。
- **Action**：点账号行 → 组内详情原位展开；异常账号的主动作是「重新登录」，正常账号是「改为仅手动 / 恢复自动发布」；未接入槽位的主动作是「添加账号」。
- **Proof / Content**：当前组名；`N / 5 个平台已接入`；每个槽位的账号名、登录状态、最近发布结果与时间、最近采集结果与时间；详情的等价 `vk` 命令。
- **Constraints**：只显示当前账号组，不混入其他组；数据只来自 `/api`（bootstrap 与命令表派生路由），不引用原型 `store.js`；不伪造扫码授权；五个平台槽位由 `/api/bootstrap.matrix.columns` 决定，前端只补平台标识与授权方式；未接入必须是缺口，不能白屏。

## Direction contract

**THESIS**：账号页是「当前组的五个平台槽位」而不是跨组矩阵；接入的账号自证身份与状态，未接入的槽位保留缺口和添加入口。异常账号一眼可点、就地处理；正常账号退为安静的事实。

**OWN-WORLD**：沿用 `docs/design/app.css`：深海军蓝侧栏、冷灰白场地、白色槽位表、1px 发丝线、零阴影；正常态只有绿点 + 灰绿字，异常才用琥珀/红浅底签；时间与数字等宽 tabular-nums；平台标识是自绘 SVG。

**STORY**：进入页面先看到当前组名与「N / 5 个平台已接入」→ 五个槽位从上到下排列，接入的显示账号与状态，未接入的显示「未接入」与「+ 添加<平台>」→ 点某行，详情在该页下方就位：handle 主标题、一句异常结论、最近发布/采集两列证据、等价命令 → 点主动作处理这个具体账号（重新登录走 `account.reauth <id>`，模式切换走 `account.mode <id>`）。

**FIRST VIEWPORT**：桌面左侧 224px 深蓝导航（品牌 / 发布内容 / 四项导航 / 本地承诺）；主区依次为页头（`账号组 · <组名>`、`账号` 标题、口径摘要、管理账号组 + 添加账号）、待处理条 + 最近体检时间、五槽位表、选中账号的组内详情。未接入槽位保留「未接入」与预填平台的添加入口。手机 ≤900 每行退化为两列，槽位字段换行显示，按钮至少 40px。

**FORM**：沿用设计稿账号墙的单组槽位形态（`docs/design/account-wall.html`），seed: seed:a61cb2af8194ee80。

**FINISH**：unreviewed and undocumented is unfinished；本实现以 `npm run design:check`（静态）与对 `/accounts` 的运行时检查收尾，逐条引用 ACC-account-01 / 02 / 03。

## 实现与设计稿的差异（有意识决定）

- 数据源从原型 `store.js` 换成 `api.js` + `/api/bootstrap`；页面不再自算口径。
- 「看全部账号组」指向 `/groups.html`（矩阵页在 #26–#30）；「计划」导航项尚未建页，显示为非链接的待建项，避免 404。
- 原型的「看这条作品」在没有对应作品页前指向现有作品视图 `/#works`。
- 详情新增「移除账号」次动作（走 `account.remove`），否则「换号先移除」在 Web 上无路可走。
- 不展示原型的假二维码与「已自动排队首次采集」。
