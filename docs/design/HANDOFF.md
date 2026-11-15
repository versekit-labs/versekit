# 设计稿 → 代码：交接契约（v2）

2026-11-15 定稿。这份文档给协调器和实现 worker：照着它开 issue、派工、验收。旧版（九个页面、账号组 × 平台）已作废，旧页面在 `docs/design/v1/`。

## 0. 先读什么

| 要知道 | 读 |
|---|---|
| 产品定义、对象模型、里程碑 | `docs/PRD.md` v0.2（§3 对象、§3.1 通用性、§4.2 确认、§7 需求） |
| 每个时刻用户做什么、哪些机制藏起来 | `docs/design/FLOW-v2.md` |
| 页面长什么样（可点） | `docs/design/{today,works,work,data,system,feishu}.html`，直接用浏览器打开 |
| 颜色、字号、组件、文案规则 | 仓库根 `DESIGN.md` |
| 每个页面的任务书 | `.impeccable/surfaces/docs-design-<页面>-html.md` |
| 验收基线截图（1360 宽） | `docs/design/screenshots/v2/*.png` |
| 飞书卡片 JSON | `docs/design/feishu-cards/` |
| 验收口径（带 id） | `docs/design/ACCEPTANCE.md` 第十节，`[ACC-v2-*]` |

**给实现方的一句话**：`docs/design/*.html` 是结构和文案的规范，`DESIGN.md` 是 token 与规则，截图是像素参考。与三者冲突的实现是 bug。原型里的 `app.js` 是演示数据和演示逻辑，**不要搬进产品**：聚合、状态推导、倍数计算都放 `packages/core`。

## 1. 四条硬规则

1. **没有人确认，一条都不会发。** 平台稿到了建议时间但没确认，队列不领取，只提醒。有测试钉住。
2. **小红书逐条单独确认**，不能被"确认这 N 条"带上。有测试钉住。
3. **真机红线**（`ACCEPTANCE.md` 第一节）：开发机上的任何 agent 不得对任何平台的真实账号登录、发布、体检或采集。只用 stub driver、fixture。需要真实账号的验证写进 PR 的「待人工」。
4. **CLI 完整律 / 三端一致律 / 零后门律**（`AGENTS.md` §3）：页面和卡片上的每个动作先在 `commands.mjs` 里有命令。

## 2. 现状差距（以 main 为准）

| 设计需要 | main 现状 | 缺口 |
|---|---|---|
| 作品 → 成片 → 语言版本 → 平台稿 | `work` 表一个作品一个文件；`publish` 直接挂 `work`，`UNIQUE(work_id, account_id)` | 加成片层和语言版本；同一作品同一账号要能有多条平台稿（长片 1 条 + 短片 3 条） |
| 入库 `vk work add / list / show` | 只有 `publish.create`（一条内容 → 多平台） | 新增 work 命令；`vk work add 视频.mp4` = 1 作品 1 成片 1 版本 |
| 发布前人确认 | `publish` 默认 `state=queued` 直接进队列；`publish.confirm` 是"notify 模式下确认已在 App 里发完"，不是这个意思 | 新增"待确认"状态和 `publish.approve / skip / now / manual / edit`；别改 `publish.confirm` 的含义 |
| 账号组 | `group.list / add / rename / use` 已有 | work、today、stats 按当前组过滤；能查别的组的待办数 |
| 今天 | 没有 | `vk today` |
| 和平时比 | `stats.works`、`stats.series` 有原始数 | 基线（同账号最近 20 条、发布 24 小时的中位数）和倍数 |
| 发布方案 | 没有 | `vk plan show / edit`（M3） |
| Web | `packages/web/public/` 是旧的九页 | 换成四页：今天、作品（含详情）、数据、系统 |
| 飞书卡片 | 通道、配对、按钮回调（`executeAction`）已有 | 新的卡片内容与"一支一支发"的顺序 |

## 3. 建议的 issue 顺序

一次只放一个 `s:ready`；"涉及"的文件相交的串行。

| 顺序 | issue | 里程碑 | 依赖 | 建议谁做 |
|---|---|---|---|---|
| 1 | core：成片层与语言版本，`vk work add / list / show` | M1 | 无 | Sonnet / Opus（改表结构和迁移） |
| 2 | core：发布前人确认 | M1/M3 | 1 | Sonnet / Opus（状态机，有红线） |
| 3 | core：`vk today`、账号组过滤、和平时比 | M1/M4 | 1 | Sonnet |
| 4 | web：新外壳 + 今天页 | M1 | 2、3 | DeepSeek 可做（照原型接 API） |
| 5 | web：作品与作品详情 | M1 | 1、4 | DeepSeek 可做 |
| 6 | channel-feishu：入库与确认卡片 | M1/M3 | 2 | Sonnet |
| 之后 | 数据页（M4）、系统页与发布方案（M2–M3）、视频消息、图文和文章预览 | | | 口径到时再补 |

## 4. 原型里哪些是真的，哪些是演示

- 真的（要照做）：页面结构、文案、状态词、按钮含义、什么时候出现什么（只有 1 支成片不出现成片列表等）、颜色和间距。
- 演示（不要照搬）：`app.js` 里的作品、时间、播放数；"露营小记"账号组是虚构的；页面上写的 `vk plan show`、`vk stats --since`、`vk runs --failed`、`vk today`、`vk work …` 是提议的命令名，以 issue 里定的为准；系统页的每日上限和间隔数字是默认值，还没最后确定。
- 原型没有存储：在一页确认过的内容，跳到另一页会恢复。产品里当然要一致。
- 还没画：图文和文章的预览区。

## 5. 验收

```bash
npm run ci                                             # 合并前必须全绿
npm run serve                                          # 实现方起真实服务
npm run design:accept -- --url http://127.0.0.1:8787   # 机械验收（路径映射在 scripts/design-accept.mjs 的 PAGES）
```

界面类 issue 的证据包：1360 宽的截图，和 `docs/design/screenshots/v2/` 里对应的那张并排；逐条写出 ACC id 和证据。
