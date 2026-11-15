# 六平台发布规则（2026-11-15 调研）

平台：小红书、抖音、视频号、TikTok、YouTube、公众号订阅号。补充 `publish-risk.md`，不重复其内容。

来源标注：【官方原文】平台自己的页面或协议（抓取工具有摘要，关键数字落地前人工再核）；【媒体转述】【社区经验】【未查证】按字面理解；【建议】是保守取值，**不是平台公布的规则**，需要用户拍板。

## 一、影响设计最大的发现

1. **国内三家的用户协议都禁止第三方工具接入**：小红书协议 4.1、抖音协议 5.1、视频号运营规范 4.3【官方原文】。浏览器自动化的风险在协议层面，不只是风控。
2. **小红书 3-10 公告**：主页公开笔记全部由 AI 托管代发的账号会被封禁（[光明网](https://m.gmw.cn/2026-03/10/content_1304371172.htm)【媒体转述】）。
3. **公众号订阅号**：`draft/add` 可用；`freepublish` 只开放给企业主体已认证账号，个人主体 2025-07 起被回收，返回 48001（[freepublish](https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_submit)、[draft/add](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html)【官方原文】）。未认证订阅号调用 `draft/add` 有社区失败反馈，需实测。
4. **YouTube 2026-11-02 起取消"未审核项目强制私享"**；`videos.insert` 有独立配额桶，100 次/天（[修订历史](https://developers.google.com/youtube/v3/revision_history)、[配额](https://developers.google.com/youtube/v3/determine_quota_cost)【官方原文】）。网上"1600 units、强制私享"的说法已过时。
5. **TikTok 官方 API**：未审核应用只能发 `SELF_ONLY`，24 小时内最多 5 个用户；公开发需过 audit。社区准则禁止"绕过系统的自动化工具、脚本"（[Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)、[社区准则](https://www.tiktok.com/community-guidelines/en/integrity-authenticity)【官方原文】）。
6. **抖音有官方发布 API**：scope `video.create.bind`，需在开放平台申请；每用户每应用每天 ≤ 75 条；发布后进审核，审核期仅作者可见（[API 文档](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create)【官方原文】）。个人开发者能否申请通过未查到。
7. **AI 标识**：六个平台都要求对 AI 生成内容做显著标识。TikTok API 有 `is_aigc`；YouTube API 有 `status.containsSyntheticMedia`；抖音开放平台发布接口无 AI 字段；国内各平台发布页的开关位置未查到。

## 二、汇总表

| 平台 | 建议每日上限 | 最小间隔 | 新号策略 | AI 标识 | 官方 API |
|---|---|---|---|---|---|
| 小红书 | 1【建议】 | ≥ 4 小时【建议】 | 前 7 天只手动【社区经验】 | 要（协议 3.2） | 无面向个人的发布 API |
| 抖音 | ≤ 3【建议】；API 上限 75（官方） | ≥ 1 小时【建议】 | 未查到 | 要（协议 4.5） | 有，需申请 `video.create.bind` |
| 视频号 | ≤ 2【建议】 | ≥ 1 小时【建议】 | 未查到 | 要（规范 6.4） | 未查到个人可用的 |
| TikTok | ≤ 3【建议】；官方有创作者日上限（约 15 待复核） | 未查到；API 6 次/分钟 | 未查到 | 要；`is_aigc` | 有；未审核仅 `SELF_ONLY` |
| YouTube | ≤ 3【建议】；`videos.insert` 100 次/天（官方） | 未查到 | 手机验证可提额 | 要；`containsSyntheticMedia` | 有，OAuth |
| 公众号订阅号 | ≤ 1【建议】 | 未查到 | 未查到 | 要 | `draft/add` 可用；`freepublish` 不可用 |

## 三、可写进配置的规则

**硬规则（有官方依据）**
1. 公众号：订阅号只走 `draft/add`，人在后台点发表；48001 按"账号类型不支持"处理，不重试；服务器出口 IP 要进白名单，40164 提示未加白名单。
2. 公众号 `draft/add` 字段：标题 ≤ 32 字，作者 ≤ 16 字，摘要 ≤ 120 字，正文 < 2 万字符且 < 1MB，图片 ≤ 20 张，封面须为永久 MediaID，阅读原文链接 ≤ 1KB。
3. YouTube：按 100 次/天记账；`quotaExceeded` 停止并报警，不重试；隐私状态显式设置；AI 内容设 `containsSyntheticMedia`。
4. TikTok：先查 `creator_info` 取时长上限和可选隐私级别；429 指数退避；`spam_risk_too_many_posts`、`spam_risk_user_banned_from_posting`、`reached_active_user_cap` 立即暂停账号并报警；AI 内容设 `is_aigc`；隐私状态由用户手选、互动开关不默认勾选、不加品牌水印、文案允许发布前编辑。视频标题 ≤ 2200 字符；图文 ≤ 35 张，标题 ≤ 90、描述 ≤ 4000；视频最大 4GB。
5. 抖音开放平台：视频 ≤ 15 分钟，文案含话题与 @ ≤ 1000 字符；2114007、28003017 按额度用尽处理；"已提交"不等于"已发布"。
6. 作品元数据带 `ai_generated`，发布前提示，并映射到各平台的声明方式；不得删改平台加的隐式标识。

**保守默认（无官方数字，待用户确认）**
7. 每日上限与最小间隔见汇总表的【建议】列，可按账号配置。
8. 新号前 7 天只手动发。

**事故规则**
9. 同一账号只在固定的一个网络环境发布；依据是 11-14 事故的用户确认根因，没有平台公开说法。
10. 测试号与运营号分开。
11. 全局熔断：任何平台返回封禁、限流、`spam_risk_*`、要求验证码或重新登录，该账号暂停所有自动操作并通知，不自动重试。

## 四、未查到，需在用户同网电脑上人工核实

- 小红书、抖音 App、视频号、YouTube 频道侧的每日发布数、间隔、新号限制
- 国内平台发布页"AI 声明"开关的位置和字段
- 抖音开放平台个人开发者能否申请 `video.create.bind`
- 视频号是否有个人可用的发布 API
- 未认证订阅号 `draft/add` 实测
- 小红书、抖音、视频号的图片张数、标题与正文字数、话题数
- TikTok 创作者日上限的准确数字
