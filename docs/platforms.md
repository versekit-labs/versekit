# 平台能力矩阵（首批 5 平台）

**更新** 2026-10-27（v2，修正：**自动化路线零资质**）　**配套** `docs/PRD.md` §7.2

**一句话**：产品的默认发布路线是「用你自己的登录态做浏览器/客户端自动化」，**不需要任何开发者资质**；官方 API 只是可选升级，不是门槛。

---

## 0. 先澄清一个概念错误

上一版把「资质」写成了自动发布的前置条件 —— **错了**。两件不同的事：

| | 官方 API 路线 | **自动化路线（我们的默认）** |
|---|---|---|
| 谁在授权 | 平台授权给"你开发的应用" | **用户本人授权给自己** —— 他扫码登录过 |
| 需要资质吗 | 需要（营业执照 / App 审核 / 能力申请） | **不需要，0 资质** |
| 谁承担风险 | 开发者（应用被封） | 用户自己的账号（正常用户行为） |
| 稳定性 | 高，但有审核与配额 | 中，随平台改版 |
| 能力覆盖 | 常常缺字段（无封面/无话题/无位置） | 对齐网页端全部能力 |

**视频工厂已经证明了这条路**（`videos/factory/publishers/`）：

| 平台 | 工厂实际做法 | 资质 |
|---|---|---|
| 小红书 | 驱动 `creator.xiaohongshu.com` 的发布页；登录有两个入口：主站扫码（网页内展示二维码）或短信验证码；采集走数据看板接口 | **无**（账号需登录一次） |
| B站 | `biliup` CLI + 你自己的 cookie（`~/.config/assurelane/bilibili-cookies.json`） | **无** |
| YouTube | 官方 Data API v3（唯一走官方 API 的） | 无（未审核项目会被锁私享） |
| TikTok | ⚠️ 目前是 5 行 `manual()` 占位，**还没跑通自动** | — |

> 所以：**自动化是主路，官方 API 是升级项。** 下面按这个前提重写矩阵。

---

## 1. 总表

| | YouTube | B站 | 抖音 | 小红书 | TikTok |
|---|---|---|---|---|---|
| **默认路线** | 官方 API v3 | biliup + cookie | 创作者中心自动化 | 创作服务平台自动化 | **TikTok Studio web 自动化** |
| **需要资质** | 否 | 否 | **否**（自动化路线） | **否** | **否**（web 路线）；API 路线才需 App 审核 |
| **成熟度** | 🟢 高（已在工厂跑通） | 🟢 高（已在工厂跑通） | 🟡 中（待建，social-auto-upload 有成熟参考） | 🟢 中高（已在工厂跑通，单账号） | 🟢 高（已在工厂跑通，151 行，含封面/AI 标签/可见性） |
| **凭证** | OAuth refresh token | cookie（`bili_ticket` 等） | cookie（扫码） | cookie（扫码） | Chrome profile（扫码登录 @assurelane6） |
| **草稿箱可用** | 否（直接发） | 是（`--draft`） | 是（存草稿） | 是（存草稿） | — （可见性当草稿用） |
| **指标采集** | Analytics API | 公开接口 | 创作者中心接口 | 创作服务平台接口 | 未接（工厂 `stats: null`） |
| **预期降级率** | <2% | 5–8% | 8–15% | **10–20%** | 5–10% |
| **波次** | Wave 1 | Wave 1 | Wave 2 | Wave 1 | Wave 1 |

> notify 占比是**适配器健康指标**，进 `vk doctor`；长期超标即红灯，优先修而不是让用户多点几下。

---

## 2. 逐平台

### YouTube — 🟢 官方 API（唯一）

- `videos.insert` 可续传，支持标题/描述/标签/AI 声明/缩略图/播放列表。
- **坑（工厂已验证）**：未审核项目的上传会被**强制锁成私享** → 必须回传 `visibility_forced_private` 提示，否则是"发了没人看"的静默失败。
- 采集：YouTube Analytics API + `videos.list`。
- 降级触发：OAuth 撤销、配额耗尽、账号被限。

### B站 — 🟢 biliup + cookie

- `biliup` 模拟投稿客户端接口，`biliup login` 一次后 cookie 存本地，`biliup renew` 续期。
- 支持**存草稿**（`draft` 模式天然可用）。
- 坑：合集（biliup 加不了，需创作中心补）、封面尺寸/时长约束、投稿频率风控。
- 采集：稿件公开 → 公开接口取播放/点赞/收藏，最稳的一条。
- 降级触发：cookie 过期、`bili_ticket` 签名变更、"投稿过于频繁"。

### 抖音 — 🟡 自动化待建

- 工厂**没有**抖音发布器（`schema.mjs` 的 PLATFORMS 里没有抖音），所以这是新工作。
- 路线：`creator.douyin.com` 发布页自动化（`social-auto-upload` 的 `douyin_uploader` 是成熟参考，1.1 万行上传器里验证过）。
- 支持存草稿 → `draft` 模式可用。
- 采集：创作者中心作品数据接口拦截。
- 降级触发：登录态失效、连续失败、风控。

### 小红书 — 🟢 已跑通，但风控敏感

- 工厂 `publishers/xiaohongshu.mjs` 已验证：驱动发布页 + 真实话题（`#tag` 从话题面板选，不是纯文本）+ 封面用视频首帧。
- 已沉淀的硬约束（可直接搬进适配器）：标题 ≤20 字、正文 ≤1000 字、话题 ≤10 个、期号不许进文案。
- 风险：改版频繁；不建议高频/矩阵式批量发。
- **2026-11-14 起默认「交给手机」（`handoff`）**：电脑准备内容，手机上由人点发布；自动发布降为用户显式开启的选项。原因：`@测试` 因自动化测试发布被永久禁发，详见 `docs/research/publish-risk.md`。官方分享开放平台已暂停接入（2026-11-14 确认），不走 `xhs.share()`。
- 采集：创作服务平台笔记数据接口拦截。

### TikTok — 🟢 web 自动化，已跑通

**结论先行：TikTok 走的是 TikTok Studio 网页上传自动化，不是 Content Posting API。** 之前把 `trustbridge-video` 里的 `manual()` 占位当成了实情——真实现己在 `trustbridge/videos/factory/publishers/tiktok.mjs`（151 行）。

- **入口**：`tiktok.com/tiktokstudio/upload`，在持久 Chrome（`browser.mjs`，CDP :9333）里，用 @assurelane6 已登录会话。
- **已完成的事**：上传英文竖版成片 → 填描述（Draft.js）+ 真实话题 → 传封面 → 设“谁可以看” → 开 AI 生成内容标签 → 发布 → 等内容检查 → 去主页取最新 `/video/` 链接得到 id。
- **可见性是选项不是障碍**：`--public` 直接发所有人；默认发“仅自己”是人自己的谨慎策略（先看一遭再改公开），**不是平台强制**。
- **对产品的启示**：把可见性做成 `public / private / private_then_public` 策略；后者“人决定、系统执行”而不是“让用户去 App 改”。
- **待补**：`stats: null`，TikTok 指标未接；自动化后的数据用 Display API 或后台拦截。
- **为什么不走 API**：Content Posting API 需要已审核的开发者应用才能公开；web 路线零资质、当天可用。

---

## 3. 官方 API 什么时候才值得用（升级项，不是门槛）

| 场景 | 例子 |
|---|---|
| 自动化不覆盖的能力 | YouTube 播放列表、Schedule 原生定时、TikTok 直接发布 |
| 稳定性/合规要求更高的批量场景 | 工作室客户账号、需要审计日志 |
| 平台明确鼓励且有独家字段 | YouTube Analytics 的观看时长/订阅增减 |

**产品策略**：适配器接口把「自动化实现」和「官方 API 实现」做成同一接口的两个后端，按 `account.capabilities` 选择；用户可以随时在 `vk account upgrade` 里切。**默认永远选能跑通、零配置的那个。**

---

## 4. 验收方式（每平台都过 5 关）

1. `vk publish <asset> --to <p> --dry-run` —— 输出步骤、字段映射、缺失项，零对外动作。
2. 真实发布 1 条（可用小号），核对标题/话题/封面/定时/可见性。
3. 采集对齐：平台后台 vs versekit 快照。
4. 断点演练：手动失效 cookie，验证 `blocked → reauth → 队列恢复`。
5. 降级演练：连续失败 → `auto → draft → notify`，`fallback_reason` 正确落到卡片。

---

## 5. 调研依据

- 工厂实证：`videos/factory/publishers/{xiaohongshu,bilibili,youtube,tiktok}.mjs`、`publishers/browser.mjs`（本机 Chrome、用户已登录会话）
- TikTok 未审核 client 只能 SELF_ONLY：[TikTok for Developers – App Review FAQ](https://developers.tiktok.com/docs/en/getting-started-faq)
- 抖音能力申请（走官方 API 才需要）：[发布能力使用规范](https://developer.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capability)
- 小红书无第三方发布 API：公开资料一致；因此只能自动化
- B站社区方案 biliup：模拟投稿客户端接口 + cookie

*局限：本表为 2026-10 检索 + 本机工厂实证；除 YouTube/B站/小红书外，抖音与 TikTok 的自动化尚未在本机跑通，需按 §4 逐项验证。*
