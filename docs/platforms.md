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
| YouTube | 官方 Data API v3（唯一走官方 API 的）；已移植为 `packages/adapter-youtube` | 无（未审核项目会被锁私享，适配器会明说） |
| TikTok | ⚠️ 目前是 5 行 `manual()` 占位，**还没跑通自动** | — |

> 所以：**自动化是主路，官方 API 是升级项。** 下面按这个前提重写矩阵。

---

## 1. 总表

| | YouTube | B站 | 抖音 | 小红书 | TikTok |
|---|---|---|---|---|---|
| **默认路线** | 官方 API v3 | biliup + cookie | 创作者中心自动化（第一版只存草稿） | 创作服务平台自动化 | **TikTok Studio web 自动化** |
| **需要资质** | 否 | 否 | **否**（自动化路线） | **否** | **否**（web 路线）；API 路线才需 App 审核 |
| **成熟度** | 🟢 高（已在工厂跑通） | 🟢 高（已在工厂跑通） | 🟡 中（待建，social-auto-upload 有成熟参考） | 🟢 中高（已在工厂跑通，单账号） | 🟢 高（已在工厂跑通，151 行，含封面/AI 标签/可见性） |
| **凭证** | OAuth refresh token | cookie（`bili_ticket` 等） | cookie（扫码） | cookie（扫码） | Chrome profile（扫码登录 @assurelane6） |
| **草稿箱可用** | 否（直接发） | 是（`--draft`） | 是（存草稿） | 是（存草稿） | — （可见性当草稿用） |
| **指标采集** | Analytics API | 公开接口 | 创作者中心接口 | 创作服务平台接口 | 未接（工厂 `stats: null`） |
| **预期降级率** | <2% | 5–8% | 8–15% | **10–20%** | 5–10% |
| **波次** | Wave 1 | Wave 1 | Wave 2 | Wave 1 | Wave 1 |

> notify 占比是**适配器健康指标**，进 `hifabu doctor`；长期超标即红灯，优先修而不是让用户多点几下。

---

## 2. 逐平台

### YouTube — 🟢 官方 API（`packages/adapter-youtube`，platform = `youtube`）

移植自视频工厂 `trustbridge@1f9c92f videos/factory/publishers/youtube.mjs`；工厂里为某个频道写死的东西（播放列表名与简介、类目 28、只发英文版、AI 合成声明、话题过滤与 `#Shorts`、目录约定、`~/.config/assurelane` 凭证）全部剥掉，改成平台稿参数或 core 传入的文案与素材。

**怎么接入（全在系统页，界面上没有命令行）**：账号那一行「填应用凭证」→ 填你自己在 Google Cloud 控制台建的 OAuth 客户端（Desktop 类型）的 client id / client secret → 「Connect YouTube」→ 新标签页里用你的 Google 账号同意 → 本机 `127.0.0.1` 临时端口收回调（带 `state` 和 PKCE S256），拿到 code 立刻关端口。token 只在本机凭证目录（权限 600），账号表只存 `credential_ref`。用哪个 Google 号由你在授权页上选，适配器不写死。授权要勾全权限（上传、管理账号用来回读核实、Analytics 可选）。

**发布**：
- `videos.insert` 可续传，**分块**读文件（默认 8 MiB，必须是 256 KB 的整数倍），断线后先问服务端偏移再续传，不重传。整个发布受 `publish.timeout_ms`（默认 5 分钟）约束：上传大文件（如 4K 母版）要在 `config.json` 里调大。
- 标题、简介（正文 + 话题）、标签来自平台稿；语言来自成片的语言版本（`default` 不传）。
- 平台稿参数（逐条放 `overrides.youtube`，或作品 / 成片 `meta.youtube`，逐条的优先）：`privacy`（public / unlisted / private，缺省用平台稿可见性）、`category_id`（缺省 `config.json` 的 `youtube.default_category_id`，再缺省 22）、`contains_synthetic_media`（缺省不声明）、`made_for_kids`（缺省 false）、`playlist` 或 `playlist_id`（默认不加；按名字找已有列表，找不到只记 notes，不新建）、`captions`（`{ path, language, name }`）。缩略图用版本 `meta.cover`。
- 竖版（或方形）且时长不超过 180 秒的成片按 Shorts 处理（读 mp4 的 `tkhd` / `mvhd`，认得手机竖拍的旋转矩阵）；不靠话题，不追加 `#Shorts`。
- **预约发**：私享上传 + `publishAt`，到点由 YouTube 公开；core 在确认时就让它开始上传（`nativeSchedule`），不等到预约时间。离现在不到 15 分钟的按现在发。**现在发**：按平台稿的可见性直接发。
- 发布后一定 `videos.list` 回读核实 id、状态、`privacyStatus`，不信任上传返回。视频已在 YouTube 上之后，缩略图 / 字幕 / 播放列表失败只写进事件（`publish.needs_followup`，`kind: notes`），**不重传**；回读读不到则是「结果待确认」，同样不重传。

**强制私享不静默**：未过 Google API 合规审核的项目，上传可能被锁成私享。回读的 `privacyStatus` 与请求不符时，平台稿记 `fallback_reason = visibility_forced_private`、状态 `published_limited`、一条 `set_visibility_public` 待办和一条事件，人话：「YouTube 把这条锁成了私享：接入用的 Google 项目还没过审，需要在 YouTube Studio 里手动改成公开」。预约发时 YouTube 丢了 `publishAt` 同理。

**配额**（2026-11-21 查阅官方文档）：
- `videos.insert` 有**独立配额桶**，默认每天 100 次、每次计 1；其余接口共用每天 10,000 单位：`videos.list` / `channels.list` / `playlists.list` = 1，`thumbnails.set` / `playlistItems.insert` / `playlists.insert` = 50，`captions.insert` = 400。配额每天**太平洋时间零点**重置。
- 官方页：<https://developers.google.com/youtube/v3/determine_quota_cost>、<https://developers.google.com/youtube/v3/getting-started>。数字都在 `src/quota.mjs` 一处；过审后额度调高了，写 `config.json` 的 `youtube.daily_inserts` / `youtube.daily_units`（或环境变量 `HIFABU_YOUTUBE_DAILY_INSERTS` / `HIFABU_YOUTUBE_DAILY_UNITS`），不要改代码。
- 本机按 Google 项目（client id）记账（凭证目录里，权限 600）；发布前预估今天剩的够不够，不够就**不开始上传**并说明原因。
- 接口回 `quotaExceeded`：立即停下、不重试，这个项目暂停到太平洋时间次日零点，撞上的账号同时暂停（和 TikTok 风控暂停是同一个开关），发事件；到点后由 core 自动放开。429 和 5xx 指数退避重试（1s、2s、4s、8s）。
- `uploadLimitExceeded`（频道当天传得太多）、token 失效（转「需要重新登录」）、视频被拒（`rejectionReason`）、文件被判损坏（`failureReason`）各有 `error_code` + 人话 + 事件。

**坑**：Google Cloud 项目的发布状态还是「测试」时，refresh token 7 天就失效，到点会转「需要重新登录」；改成「生产」才长期有效（与 API 合规审核是两件事）。

**采集**：`videos.list`（statistics）回填播放（键名 `play`，倍数口径和别的平台一致）、点赞、评论；授权里有 Analytics 权限时再取观看时长（`watch_minutes`、`avg_view_seconds`），没有或取失败不报错。

降级触发：OAuth 撤销、配额耗尽、账号被限。

### B站 — 🟢 biliup + cookie

- `biliup` 模拟投稿客户端接口，`biliup login` 一次后 cookie 存本地，`biliup renew` 续期。
- 支持**存草稿**（`draft` 模式天然可用）。
- 坑：合集（biliup 加不了，需创作中心补）、封面尺寸/时长约束、投稿频率风控。
- 采集：稿件公开 → 公开接口取播放/点赞/收藏，最稳的一条。
- 降级触发：cookie 过期、`bili_ticket` 签名变更、"投稿过于频繁"。

### 抖音 — 🟡 第一版只存草稿（`packages/adapter-douyin`，platform = `douyin`）

视频工厂**没有**抖音发布器，这是新工作。流程参考 `dreammis/social-auto-upload@3847fff uploader/douyin_uploader/main.py`（MIT），按 ADR-0002 §4.1 方式 B 带声明移植（声明与移植范围见仓库根 `THIRD_PARTY_NOTICES.md`），用现有 `driver-browser` 重写，不走 Python sidecar（sidecar 要用户装 Python，违背「界面上不出现命令行」）。只搬上传、填表、封面、话题；SAU 里的扫码、验证码、cookie 持久化、账号名、固定话题、固定等待秒数都没搬。

**第一版做什么**：用发布机上用户自己已登录的 Chrome 驱动 `creator.douyin.com` 发布页，把成片和文案**存进抖音草稿箱**，人在手机上点发布。终点是 `draft_pending`（状态文字「已送到抖音草稿箱，在手机上点发布」，沿用平台稿已有的「已送到草稿箱」状态），**从来不记已发布**。自动直发、数据采集（`collect` 为 `none`）、抖音扫码登录另开单。

**怎么登录**：用哪个抖音号由用户自己绑定，适配器不写死账号。系统页点「在发布机上打开登录窗口」，在窗口里登录一次；登录态在这个账号自己的 Chrome profile 里。`account.check` 打开创作者中心首页（只读）判断：正常 / 登录过期（账号转「需要重新登录」并发事件）/ 被限制 / 需要人工验证。

**存草稿的步骤**（每一步填完都回读，对不上抛 `flaky_ui` 并留截图）：先到作品管理页的草稿箱数一遍同名草稿 → 上传页选视频 → 发布页填标题（不超过 55 字，超了在开浏览器之前就报错）→ 正文 → 话题（来自平台稿，逐个输入并回读，最多 5 个，多的不填并写进 notes）→ 封面（入库的版本封面 `meta.cover` 有就用，没有用平台默认）→ 点「存草稿」→ 回草稿箱再数一遍，**多出一条**才算存进去。草稿没有公开作品 id，结果的 id 由平台稿 id 派生（`draft-<publishId>`）。

**时间**：第一版不用抖音页面自带的定时。「预约发」到计划时间由 VerseKit 把稿子送进草稿箱，并在今天页、飞书卡片提醒「去手机上发」；「现在发」立即送草稿箱。core 对「只存草稿」的平台（适配器声明 `draftOnly`）把自动发当存草稿跑。小红书逐条确认的规则不受影响。

**安全预算**：**适配器不另设每日条数上限**（所有者 2026-11-21 定）：同一账号当天第 4 条及以后照送，预约到点也照送；只有撞验证码 / 滑块 / 操作太频繁才停。排期层的按平台额度（`plan-rules`，抖音沿用全局默认）仍是 core 的事，不在适配器里。遇到验证码、滑块、「操作太频繁」这类风控页面**立即停下、不重试**，账号暂停到次日本机零点并发事件，人话是「抖音要你在发布机的窗口里手动过一下验证」；到点由 core 自动放开。

**错误对照**：标题超长 / 文案超限 / 文件不对 → `asset_invalid`（没开浏览器）；被踢回登录页 → `auth`；找不到控件、回读对不上、草稿箱里没多出这条 → `flaky_ui`（带截图）；风控页面、账号暂停中 → `platform_reject`（风控还带账号暂停）。

**dry-run**：`hifabu publish --platform douyin --dry-run` 单独能跑，不产生平台副作用。真实站点上只出计划（标题、正文、话题、封面、步骤）；把 `HIFABU_DOUYIN_BASE` 指到本机模拟页（`packages/adapter-douyin/fixtures/`，回环地址）时，会真的走一遍，停在「存草稿」前一步并截图。开发机从不打开 `creator.douyin.com`。

**待人工（ACC-douyin-07）**：页面选择器只对照手搭的模拟页和 SAU 的记录写成，真实页面上对不对由所有者在和手机同网的电脑上验证——登录一次、送一条成片进草稿箱、在手机上确认标题、正文、话题、封面都对，再手动发布。「存草稿」按钮的文案（「暂存离开」）和草稿箱入口的位置尤其要核对：它们集中在 `src/page.mjs` 的 `T` 表里，改版只改那一处。

降级触发：登录态失效、风控页面、连续 `flaky_ui`。

### 小红书 — 🟢 已跑通，但风控敏感

- 工厂 `publishers/xiaohongshu.mjs` 已验证：驱动发布页 + 真实话题（`#tag` 从话题面板选，不是纯文本）+ 封面用视频首帧。
- 已沉淀的硬约束（可直接搬进适配器）：标题 ≤20 字、正文 ≤1000 字、话题 ≤10 个、期号不许进文案。
- 风险：改版频繁；不建议高频/矩阵式批量发。
- **2026-11-14**：曾计划默认「交给手机」，用户决定不做（#120 已关闭）。小红书发布方式待定；**真机红线仍在**：agent 不对小红书做真实登录、发布、体检、采集。
- 采集：创作服务平台笔记数据接口拦截。

### 视频号 — 🟡 只存草稿，登录撑不久（`packages/adapter-shipinhao`，platform = `shipinhao`）

- 没有发布接口。驱动视频号助手（`channels.weixin.qq.com`）的发表页，表单在 wujie 微前端的 shadow root 里。移植自视频工厂 `publishers/channels.mjs`，登录探测参考 `keepalive.mjs`（`trustbridge@1f9c92f`）；选择器与 `dreammis/social-auto-upload@3847fff` 的 `tencent_uploader` 只读对照，没有搬它的代码。
- **第一版只存草稿**：上传成片 → 等处理完（封面卡片出现「编辑」、没有进度字样，最多 20 分钟）→ 封面（入库清单给了就用；9:16 一张、16:9 两张）→ 描述 → 短标题 → 位置 → 视频标注 → 逐项回读 → 点「保存草稿」→ 到草稿列表读回这一条，才记 `draft_pending`（「已送到视频号草稿箱，在手机上点发表」）。**没有自动直接发表**；采集也没有（工厂就是 `stats: null`）。
- 口径：短标题最多 16 字（空格也算），标点只能是 `《》“”：+？%°`；描述（正文加话题）最多 950 字。不合规在**人确认的那一刻**就拦下并说明，不等到发布。位置（默认「不显示位置」）、视频标注（默认「含AI生成内容」，可关）是平台稿参数 `overrides.shipinhao`，不再写死。
- **登录撑不了多久**：工厂 10-24 起改成手动发，原因就是老要重新扫码；所有者说工厂的保活不管用，所以**不做保活**。只在这几个时机查一次登录：发布机启动时、每天一次（默认 08:00，系统页可改）、人确认视频号平台稿时、计划发布前 2 小时。登录已经过期就不再自动查，等人扫码。通用的 6 小时体检不包含视频号。
- **量登录能撑多久**：每次登录成功、每次检查的结果都记成账号事件；系统页账号行显示「这次登录已 X 小时 · 平均撑 Y 小时」（最近 5 次，从登录成功到第一次查到过期），记录不够时写「还在记录」；`hifabu account show <id>` 同样的数字。
- **提醒与重新扫码**：查到过期立即发 `account.expired`（飞书照常推送），今天页「要处理」和系统页账号行写「视频号要重新扫码」。重新扫码在网页上完成：发布机取回登录页二维码，显示在账号那一行下面，用微信扫完自己变正常。
- 降级触发：落到二维码页（`auth`，「视频号登录过期了，请重新扫码」）、改版后找不到元素（`flaky_ui`，带截图）。
- 真机核对项（所有者在和手机同网的电脑上做，本开发机不打开视频号助手）：扫码登录、看几天里记下的登录时长、送一条进草稿箱；草稿列表页的地址与二维码元素的选择器以真机为准。

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

**产品策略**：适配器接口把「自动化实现」和「官方 API 实现」做成同一接口的两个后端，按 `account.capabilities` 选择；用户可以随时在 `hifabu account upgrade` 里切。**默认永远选能跑通、零配置的那个。**

---

## 4. 验收方式（每平台都过 5 关）

1. `hifabu publish <asset> --to <p> --dry-run` —— 输出步骤、字段映射、缺失项，零对外动作。
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
