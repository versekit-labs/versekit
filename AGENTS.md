# AGENTS.md

给 AI agent 与协作者的约定。**动手前先读这一页。**

## 1. GitHub 身份（重要）

这个仓库属于组织 **`versekit-labs`**，由 `buxibuxi` 账号持有。

> **为什么从 `versekit-app` 搬过来**：原组织的 owner `creator-omnikit` 被 GitHub 打了账号级标记（API 配额降到匿名档、GraphQL 禁用、Actions 全局禁用），且该标记会传染给它拥有的组织——升第二个 owner 也解不开。迁移证据见 `docs/AGENT-COLLAB.md` §10.1。**不要把 `creator-omnikit` 加进本组织**，否则会重蹈覆辙。

| 层 | 配置 | 说明 |
|---|---|---|
| `git push` | remote = `https://github.com/versekit-labs/versekit.git` | HTTPS + `gh auth setup-git`（凭据走 gh 存储，不落盘明文） |
| 仓库内 git 身份 | `user.name=versekit-labs` · `user.email=creater.omnikit@gmail.com` | 仅本仓库，不改全局 |
| `gh` 命令 | `.pi/gh-account`（内容 `buxibuxi`） | 由 pi 扩展自动注入 `GH_TOKEN` |

**硬规则**

- ✅ 用 `bin/ghx <...>` 或 `GH_TOKEN="$(gh auth token --user buxibuxi)" gh <...>`
- ❌ **禁止 `gh auth switch`** —— 那是全局状态，会污染本机其他项目
- ❌ 不要把 token 写进任何文件；只现取现用
- 新增仓库沿用同一套：`.pi/gh-account` + 该账号的凭据方式 + 局部 git 身份
- ❌ **不要用 `creator-omnikit` 做任何自动化**：它的 API 配额 60/h、Actions 全禁，且标记会传染组织

## 2. 动手前必读

| 文档 | 什么时候读 |
|---|---|
| **`docs/BLUEPRINT.md`** | **动手前必读——唯一架构权威，与任何旧文档冲突时以此为准** |
| `docs/PRD.md` | 判断"该不该做这个功能" |
| `docs/ARCHITECTURE.md` | 改内核、表结构、命令、事件时 |
| `docs/adapter-contract.md` | 写/改任何平台适配器时（14 条硬规则） |
| `docs/platforms.md` | 需要知道某平台怎么发、怎么采、会不会降级 |
| `docs/adr-0001-reuse.md` | 想复用外部代码之前 |

## 3. 三条不可违反的架构约束

1. **CLI 完整律**：任何能力必须先在 `vk` 上存在。Web / 飞书只能调用，不能拥有独占功能。
2. **三端一致律**：命令只在 `packages/core/src/commands.mjs` 定义一次；CLI / HTTP / 卡片按钮由它派生。
3. **零后门律**：适配器与通道不得直接读写 SQLite / 凭证目录，只能走 `core` 接口。

## 4. 代码约定

- ESM、Node ≥ 22.5。**`packages/core` 与 `packages/cli` 保持零运行时依赖**（`node:sqlite`、`WebSocket`、`fetch` 都是内置的）。
- 前端与工程化（测试、lint、浏览器验收如 Playwright、构建工具）可以引入成熟工具，但必须：放 `devDependencies` 或 `packages/web` 内、锁版本、在 PR 里说明为什么不自己写；core 不得反向依赖它们。
- 适配器是独立包：`packages/adapter-<platform>`，`export default { platform, capabilities, ready, publish, collect }`。
- 状态迁移必须走 `transitionPublish()`；非法迁移要抛错（有测试钉着）。
- 失败要留现场：`error_code` + 人话 + 事件；**静默失败是 P0 缺陷**。
- 移植外部代码：文件头写 `// ported from <repo>@<sha> <path>`，并逐条剥离硬编码（账号名、分区 TID、固定话题、目录约定）。

## 5. 常用命令

```bash
npm run vk -- init                 # 建库
npm run vk -- doctor --human       # 自检
npm run vk -- serve --once         # 跑一轮队列
npm test                           # 全部测试（当前 214 项）
npm run design:check               # 设计闸门：任务书/导航/死链/检测器/触控/溢出
bin/ghx issue list                 # 以 buxibuxi 身份操作 GitHub
```

## 6. 改界面之前（设计协议）

过去的教训：先写页面、再按反馈修补，结果每个页面都没有任务书，产品模型错了却"检测器 0 条"。
**顺序不能反。** 动 `docs/design/` 下任何页面之前：

1. **写任务书**：`.claude/skills/impeccable/scripts/impeccable context --target docs/design/<page>.html`，
   然后用 `surface-brief write` 落盘。任务书必须回答：这个页面为谁、解决什么问题、
   成功长什么样、什么是明确不做、数据从哪来。**没有任务书的页面不允许开始写。**
2. **先定结构，再写代码**：先定对象模型（一个排期是作品还是平台？）、页面职责（一页一个任务）、
   状态词表；结构错了，颜色再合规也是白做。
3. **提交前跑闸门**：`npm run design:check`。它会拦：
   - 页面缺任务书
   - 导航各页不一致 / 页面互相不可达
   - `href="#"` 死链接（点了没反应）
   - `hidden` 被 `display` 覆盖（"点了不跳转"的根因）
   - 机械检测不通过（颜色/字号/圆角/对比度）
   - 手机横向溢出、触控目标小于 32px
4. **有争议的页面跑 critique**：两个独立 agent（设计评审 + 检测证据），不要自己判自己。
   `detect` 只查机械项，**它通过不代表产品成立**。

跨项目沿用：把 `scripts/design-check.mjs` 和本节一起复制到新仓库，
在 `package.json` 加 `"design:check"`，并在 CI 里跑 `npm run check`。
闸门是仓库自带的，不依赖任何人的记忆。

## 7. 提交规范

`<type>(<scope>): <句子>`

- type：`feat` `fix` `docs` `chore` `test` `refactor`
- scope：`core` `cli` `adapter-bilibili` `adapters` `docs` `driver`
- 正文写**为什么**，不写"改了哪些文件"（diff 已经说明）
