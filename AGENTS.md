# AGENTS.md

给 AI agent 与协作者的约定。**动手前先读这一页。**

## 1. GitHub 身份（重要）

这个仓库属于组织 **`fangyouxi`**，用**独立账号**推送，与本机另一个账号（`buxibuxi`，另一个项目的）并存。

| 层 | 配置 | 说明 |
|---|---|---|
| `git push` | remote = `git@github-fangyouxi:fangyouxi/versekit.git` | SSH 别名，身份绑在 URL 上，**不会推错账号** |
| 仓库内 git 身份 | `user.name=fangyouxi` · `user.email=creater.omnikit@gmail.com` | 仅本仓库，不改全局 |
| `gh` 命令 | `.pi/gh-account`（内容 `creator-omnikit`） | 由 pi 扩展自动注入 `GH_TOKEN` |

**硬规则**

- ✅ 用 `bin/ghx <...>` 或 `GH_TOKEN="$(gh auth token --user creator-omnikit)" gh <...>`
- ❌ **禁止 `gh auth switch`** —— 那是全局状态，会污染本机其他项目
- ❌ 不要把 token 写进任何文件；只现取现用
- 新增仓库沿用同一套：`.pi/gh-account` + SSH alias + 局部 git 身份

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

- ESM、Node ≥ 22.5、无运行时依赖（`node:sqlite`、`WebSocket`、`fetch` 都是内置的）。
- 适配器是独立包：`packages/adapter-<platform>`，`export default { platform, capabilities, ready, publish, collect }`。
- 状态迁移必须走 `transitionPublish()`；非法迁移要抛错（有测试钉着）。
- 失败要留现场：`error_code` + 人话 + 事件；**静默失败是 P0 缺陷**。
- 移植外部代码：文件头写 `// ported from <repo>@<sha> <path>`，并逐条剥离硬编码（账号名、分区 TID、固定话题、目录约定）。

## 5. 常用命令

```bash
npm run vk -- init                 # 建库
npm run vk -- doctor --human       # 自检
npm run vk -- serve --once         # 跑一轮队列
npm test                           # 全部测试（当前 29 项）
npm run design:check               # 设计闸门：任务书/导航/死链/检测器/触控/溢出
bin/ghx issue list                 # 以 fangyouxi 身份操作 GitHub
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
