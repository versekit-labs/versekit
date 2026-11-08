# 设计稿 → 代码：交接契约

这份文档是 `docs/design/` 下九个页面的开发契约。界面已定稿（commit `5075bbc`），代码按这里实现；实现完用同一套闸门验收。

> **基线已同步**：设计分支已合并 `main`（merge commit `125ada0`），工作区含 daemon、
> `packages/web`、路由派生与登录重做。直接从这里开工即可。

## 0. 开工前

```bash
git checkout fangyouxi/product-design
npm ci 2>/dev/null || true          # 零依赖仓库，这步可跳过
npm test                            # 214 项，全绿再动手
npm run design:check                # 设计闸门，全绿再动手
npm run serve                       # 起 http://127.0.0.1:8787，看现有 UI
```

现有 UI 在 `packages/web/public/`（单页，7 个视图）；设计稿在 `docs/design/`（9 页）。
两者并存是预期状态，按本文第 5 节逐步替换。

**给实现方的一句话**：设计稿是规范，`docs/design/*.html` 是像素参考，`DESIGN.md` 是 token 与规则；
任何与三者冲突的实现都是 bug，不是"优化"。

## 1. 现状差距（以当前 main 为准）

| 设计依赖 | main 现状 | 缺口 |
|---|---|---|
| `localhost:8787` 托管页面 + `/api/*` | ✅ `core/daemon.mjs` 已托管 `packages/web/public`，`/api` 由 `routes.mjs` 从命令表派生 | 无需新建，接上即可 |
| 命令注册表 | ✅ `core/commands.mjs` 已有 account/publish/stats/run/event 等 | 缺 `group.*`、`schedule.*` |
| 账号组 | ❌ `account` 表无 `group_id` | 需要 `account_group` 表与迁移 |
| 排期投影 | ⚠️ `publish.scheduled_at` 有，`publish.list` 有，但**没有按作品聚合的排期接口** | 需要 `schedule.list/move/cancel` |
| 平台级状态 | ✅ `publish.state` 天然逐账号 | 接口层按作品聚合即可，不要加字段 |
| 撞车检测 | ❌ 无 | 逻辑放 core，Web 只读结果 |
| 现有 Web UI | ⚠️ 单页 `packages/web/public/{index.html,style.css,app.js}`，1179 行，7 个视图 | IA 与设计稿不同，需要替换导航与页面结构 |

## 2. 三条架构约束怎么落到这份设计上

1. **CLI 完整律**：页面上的每个动作必须先在 `commands.mjs` 里出现。原型里那些 `vk xxx` 就是待补清单。
2. **三端一致律**：HTTP 不是新实现。`routes.mjs` 已经由命令表派生——**加命令即得路由**，不要手写第二套。
3. **零后门律**：Web 只走 `/api`；聚合、冲突、状态推导放 `core`。

**推论**：原型 `store.js` 里的 `aggregate()`、`conflicts()`、`counts()` 三处逻辑必须迁到 `packages/core`，
否则 Web 和 CLI 会各算一遍，数字迟早对不上。

## 3. 数据模型

```sql
CREATE TABLE IF NOT EXISTS account_group (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

ALTER TABLE account ADD COLUMN group_id TEXT REFERENCES account_group(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_group_platform
  ON account(group_id, platform) WHERE group_id IS NOT NULL;
```

**不需要排期表。** 一次排期 = 一个 `work` + N 条 `publish`（同 `scheduled_at`）。日历是投影：

```sql
SELECT w.id AS work_id, w.title, MIN(p.scheduled_at) AS at,
       a.platform, p.state, p.id AS publish_id
FROM work w
JOIN publish p ON p.work_id = w.id
JOIN account a ON a.id = p.account_id
WHERE a.group_id = ? AND p.scheduled_at BETWEEN ? AND ?
ORDER BY at;
```
接口把同一 `work_id` 的多行合成一张卡；作品状态取各平台最差（failed > limited/needs_human > scheduled > published）。

改期 = 更新该 work 下所有 publish 的 `scheduled_at`（必须走 `transitionPublish` 之外的时间字段更新，状态不变）；
取消 = 迁到 `failed` 并写 `E_USER_CANCELLED`，**不要删行**，保留现场。

## 4. 需要新增的命令（加进 `commands.mjs`，路由自动出现）

| 命令 | HTTP（派生） | 用途 |
|---|---|---|
| `group.list` | `GET /api/groups` | 组列表 + 每组账号数 |
| `group.add` | `POST /api/groups` | 新建组 |
| `group.use` | `POST /api/groups/current` | 记录当前组（本地状态） |
| `account.add`（改造） | 已有 | 增加 `--group` 必填 |
| `account.remove` | `DELETE /api/accounts/:accountId` | 移除（换号前） |
| `schedule.list` | `GET /api/schedule?from&to` | 按当前组返回作品卡片 |
| `schedule.move` | `POST /api/schedule/:workId/move` | 改期 |
| `schedule.cancel` | `POST /api/schedule/:workId/cancel` | 取消排期 |
| `publish.create`（改造） | 已有 | 增加 `--group`，默认取当前组 |
| `stats.works` / `run.list`（改造） | 已有 | 增加 `--group` 过滤 |

## 5. 前端怎么落地（关键决策）

现有 `app.js` 是 1179 行单页，7 个视图；设计稿是「账号组工作区 + 6 个页面」。

**不要重写成一整套新框架**，按这个顺序替换：

1. **搬资产**：把 `docs/design/app.css` + 各页 CSS 合并进 `packages/web/public/`，设计稿的 `store.js` 换成 `api.js`。
2. **先换外壳**：导航 + 账号组切换器（`app.js` 里新增 `bootstrap()`，一次拉 `/api/bootstrap`）。
3. **逐页替换**：`accounts` → 账号页（五槽位）、新增 `plan` 页、`publish` 页对齐差异字段、`works`/`overview`/`tasks` 改皮肤。
4. **删除旧视图**：每替换一页，删掉 `app.js` 里对应的渲染函数，不留两套。

数据接口可以保持**同步门面**：页面加载抓一次快照，读是同步的，写操作 POST 后刷新——本地应用数据量小，不必把页面改成异步。

## 6. 实施顺序

| 阶段 | 做什么 | 验收 |
|---|---|---|
| **M0** | 合并 main，闸门仍绿 | `npm run design:check` 通过 |
| **M1 数据** | `account_group` + `account.group_id` + 迁移 + `group.*` | `vk group add/list`；同组同平台唯一约束有测试 |
| **M2 只读** | `schedule.list` + 三处聚合逻辑下沉 core；`api.js` 接 `bootstrap` | 账号页、计划页显示真实数据；`npm run design:check -- --url http://127.0.0.1:8787` 通过 |
| **M3 写** | `schedule.move/cancel`、`account.remove`、发布带组 | 每个动作都能在 CLI 找到同名命令，HTTP 只转发 |
| **M4 收口** | works/overview/tasks 接真实数据；`vk doctor` 加组维度 | CLI `--json` 与页面数字一致 |

**M2 是分水岭**：只读打通后，设计稿从"图"变成"跑得起来的界面"，之后每一步都在真实页面上验收。

## 7. 完成定义（每页）

- 数据来自 `/api`，不是硬编码；
- 每个可点动作在命令表里存在，且 HTTP 调用它；
- `design:check --url` 通过（任务书、导航、死链、检测器、触控、溢出、hidden）；
- 空态 / 错误 / 权限三种状态有真实表现。

## 8. 明确不做

不做评论私信 Inbox、公开内容采集、团队权限、托管、PWA；不做富文本编辑器。
发布台只编排差异字段，这既是 PRD 的反范围，也是设计稿的边界。