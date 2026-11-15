# ADR-0001：复用哪些现成代码？

**状态**：已定（2026-10-27）　**决策人**：产品 + Claude　**影响**：v0.1 的全部适配器
**修订**：§4.2（social-auto-upload）由 [ADR-0002](adr-0002-sau-backend.md) 提议修订为"可作 sidecar 后端，移植需带声明"

---

## 1. 问题

手上有一堆候选资产：5 个调研过的开源项目 + 本机视频工厂（`trustbridge/videos/factory`，已生产运行半年）。问题是：**哪些直接复用、哪些只借思路、哪些必须重写？**

## 2. 判断标准（三道闸，顺序不可换）

| 闸 | 问题 | 不通过就出局 |
|---|---|---|
| **① 许可证** | 能不能合法进商业开源项目？ | 非商用/无许可证 → 直接排除，连设计都不抄 |
| **② 运行时同栈** | 是不是 Node？跨语言复用的真实成本是多少？ | Python/Go → 需要 sidecar（多一个运行时、IPC、打包、CI 矩阵、用户安装成本），**除非平台极难否则不值** |
| **③ 耦合度** | 能不能只抽出"选择器 + 等待条件 + 流程"，而不带上人家的账号名、目录结构、表格字段？ | 抽不干净 → 只能当参考读物 |

## 3. 资产清单与裁决

| 资产 | 许可证 | 规模/栈 | 裁决 |
|---|---|---|---|
| **trustbridge 视频工厂** | 自有（私有仓库） | Node + 自写 CDP，publishers 合计 992 行 | ✅ **移植流程，重写契约** |
| social-auto-upload | MIT | Python + Playwright，147 文件 / 20.9k 行 | ⚠️ **只读逻辑**（例外：抖音参考） |
| Postiz | **AGPL-3.0** | NestJS/TS | ⚠️ 只借设计，代码不进 |
| MediaCrawler | **非商用许可** | Python | ❌ 完全排除 |
| MultiPost-Extension | Apache-2.0 | TS 浏览器扩展 | ⏸ 暂不引入，记为形态选项 |
| CreatorHub | **无 LICENSE** | Python | ❌ 禁止使用（默认版权保留） |

---

## 4. 逐项理由

### 4.1 视频工厂 —— ✅ 移植流程，重写契约（价值最高）

**为什么值得**：这 992 行是**踩坑换来的知识**——"behavior:'instant' 才点得准""小红书按钮在 closed shadow root 里""Draft.js 在 macOS 上合成 Cmd+A 无效""TikTok 上传要给 20 分钟超时"。重写等于把这些坑再踩一遍，而且没有收益。

**直接搬**（结构可保留，语义要换）：

| 文件 | 行数 | 搬到哪 | 处理 |
|---|---|---|---|
| `browser.mjs` | 121 | `packages/driver-browser` | ✅ 已移植，新增 `collectJson()`（采集拦截用） |
| `tiktok.mjs` | 151 | `adapter-tiktok` | 移植发布流程；可见性改成参数 |
| `xiaohongshu.mjs` | 194 | `adapter-xiaohongshu` | 移植；含话题面板、首帧封面、shadow DOM 点击 |
| `bilibili.mjs` | 65 | `adapter-bilibili` | 移植；biliup 是 CLI，风险最低 |
| `youtube.mjs` | 143 | `adapter-youtube` | 移植；resumable upload + playlist + analytics |
| `metrics.mjs` | — | `core` | 快照模型已进 schema |

**必须剥离**（否则会变成"写死别人家的产品"）：

```js
const ACCOUNT = 'assurelane6';            // → account.handle（数据）
const TID = 208;                          // → platform profile 配置（B站分区）
const HOT = ['品牌出海', …];               // → 可配置话题池，默认空
meta.caption / meta.note / en/ 目录约定   // → 由 work.meta 与 adapter 各自的 asset spec 决定
files.mjs 的 episodes 目录结构            // → 重写：素材解析属于适配器，不属于内核
lark.mjs / worker.mjs / prompts/          // → 不搬（飞书表格 + claude -p 流水线，是另一个产品）
```

**做法**：不 fork、不 cherry-pick。新建 `adapter-*` 包，把逻辑改写为实现 `PlatformAdapter` 接口，文件头写 `// ported from trustbridge@<sha> publishers/tiktok.mjs`，便于上游修复时回填。

**许可证检查**：这些 publisher 是自写代码，只依赖 Node 内置模块（CDP 用 `WebSocket`/`fetch`），没有第三方运行时依赖 → 开源无污染风险。

### 4.2 social-auto-upload —— ⚠️ 只读逻辑，唯一例外是抖音

**为什么不全盘复用**：Python + Playwright，20.9k 行。跨语言复用的真实成本：

| 成本项 | 后果 |
|---|---|
| 用户要装 Python + Playwright 浏览器 | 安装门槛从 `npx vk` 变成"配环境"，直接砍掉一半用户 |
| sidecar 进程 + IPC + 超时/杀进程 | 故障面翻倍，排障要跨两种语言 |
| 打包体积（Playwright 浏览器 ~150MB） | 与我们"单二进制 + 用你已有的 Chrome"路线冲突 |
| 两套等待/重试/日志体系 | 三端一致性的检查做不了 |

**但它的知识很值钱**，尤其抖音（`uploader/douyin_uploader/main.py`，**1261 行**），里面大量是登录、二维码、验证码、风控处理（`_wait_for_douyin_login`、`_save_douyin_qrcode`、`_read_verify_code`）。

**关键判断：抖音我们只需要它的一半。** 它花大力气做的是"扫码 + 验证码 + cookie 持久化"，而这部分在我们架构里由"用户在自己的 Chrome 里登录一次"天然解决（持久 profile）。所以：

> **抖音：读它的上传/填表/发布流程（约 400–500 行等价逻辑），自己用 CDP 重写；登录完全交给用户手动扫码。**

有意思的是它还支持 `cdp_url` 参数（连接已有 Chrome）——说明思路和我们一致，但语言不同仍是硬伤。

**如果哪天必须复用**：只做抖音一个平台的 sidecar，用 `uvx mcp-server-...` 式隔离安装，明确标注"可选组件"，不进入主安装路径。

### 4.3 Postiz —— ⚠️ 只借设计

- **AGPL-3.0**：SaaS 或分发场景下传染性极强。哪怕只 import 一个 provider 文件，也可能被要求开源整个产品。
- 它是**多租户 SaaS 架构**（组织、成员、计费、队列用 Redis），我们单机单用户，形状完全不同。

值得借的只有两样：`post()/analytics()/refreshToken()` 的 provider 抽象、以及各平台的 analytics 字段映射表（这个不看代码也能从文档拿到）。

### 4.4 MediaCrawler —— ❌ 完全排除

`NON-COMMERCIAL LEARNING LICENSE`。不仅代码不能用，**连它的设计也不学**：它解决的是"采集公开内容"，我们明确不做（PRD §2 anti-scope）。同一条河流、两个合规世界。

### 4.5 CreatorHub —— ❌ 禁止使用

**没有 LICENSE 文件 = 保留所有权利**。之前调研时觉得它"拦截页面自身请求"的思路很好——**思路可以学（这是通用技术常识），代码一行不能拿**。我们的 `driver.collectJson()` 是独立实现。

### 4.6 MultiPost-Extension —— ⏸ 记录为形态选项

Apache-2.0 可商用，但它是**浏览器扩展**形态：靠用户点扩展、在用户当前标签页操作。这跟我们"服务端常驻 + 定时任务 + 手机控制"的模型不兼容。
它的价值在于提示了 v2 的一种"零配置形态"（用户装扩展即用，不需要维护 Chrome profile）。**先记录，不引入。**

---

## 5. 结论

> **产品完全重写，平台自动化的"作业流程"大量移植。**
>
> 代码行级复用率约 **15–20%**（主要是 driver + 三个 publisher 的流程）；
> 但**踩坑知识复用率 > 80%** —— 这才是真资产。

| 层 | 复用率 | 来源 |
|---|---|---|
| 内核（队列/状态机/事件/命令表/DB） | **0%** | 全新（工厂是飞书表格驱动，模型不同） |
| 浏览器驱动 | **~90%** | 工厂 `browser.mjs`（已移植） |
| 适配器：TikTok / 小红书 / B站 / YouTube | **~70%** | 工厂 publishers |
| 适配器：抖音 | **~30%** | social-auto-upload 的流程 + 自写 CDP |
| 通道（飞书） | **~40%** | 工厂 `lark.mjs` 的字段与卡片经验；长连接是新的 |
| Web / CLI / Skill | **0%** | 全新 |

## 6. 防"复制腐烂"的三条纪律

1. **溯源注释**：每个移植文件头写 `// ported from trustbridge@<sha>`，上游修 bug 时能回填。
2. **剥离清单**：上面 §4.1 那 6 项在 code review 里逐条核对；出现 `assurelane`、`期`、固定目录名即打回。
3. **契约测试**：移植完后必须过 `packages/*/test/contract`（接口形状 + `ready()` 语义 + dry-run 不产生对外动作）。**移植不能变成"复制 bug"**——工厂里有些行为是为特定账号调的（如默认发私密），必须显式改成参数。

## 7. 工时估算（含剥离与测试）

| 平台 | 估算 | 主要风险 |
|---|---|---|
| B站（biliup） | 0.5 天 | 最低 |
| TikTok | 0.5–1 天 | 可见性参数化、内容检查弹窗 |
| 小红书 | 1 天 | shadow DOM、话题面板、AI 声明 |
| YouTube | 1 天 | API 配额、playlist、analytics 字段 |
| 抖音 | 2–3 天 | 从零写，风控最敏感 |
