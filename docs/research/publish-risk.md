# 发布方式与平台风控：竞品怎么发、我们怎么改

调研日期：2026-11-14。起因：`@测试` 小红书号被平台永久禁发。

## 事件

- 2026-11-14 15:55（北京时间），`@测试`（「测试探针」组）被处罚：永久禁止发布笔记、评论、私信；头像、昵称、简介被重置；一年内禁止注销后重新注册。
- 这是 11-13 才建的新号。处罚前约 1.5 小时内，协调器、验收 worker、返工 worker 用自动化 Chrome 发了 4 篇以上"图文测试"类仅自己可见笔记（#93 第 5、6 轮验收），中间多次重新登录；11-13 还发过 2 篇公开笔记。
- 处罚生效时间和 #93 第 6 轮真机验收重合。主页内容几乎全由程序发出。

## 竞品的三种发布方式

| 方式 | 例子 | 最后点「发布」的是谁 | 风险 |
|---|---|---|---|
| 官方 API | YouTube Data API；B站开放平台「服务端视频稿件投递」；海外 Buffer、Later 等 | 服务端 | 最低；要入驻或审核。小红书**没有**面向个人的发布 API |
| 官方「分享到 App」 | 小红书分享开放平台 `xhs.share()`；抖音 H5 分享（`open_ticket`）；myaibot（二维码扫码后在手机上发） | **用户在手机 App 里点** | 几乎为零 |
| 浏览器自动化 | social-auto-upload（Playwright，建议两次发布间隔 > 30 秒）、MultiPost（浏览器扩展）、versekit 原方案（CDP） | 程序 | 高；蚁小二、易媒助手的内部做法没有公开资料，未查证 |

## 平台规则

- 2026-04-27 小红书 AI 内容治理规则：「利用 AI 工具自动运营账号、冒充真人互动」属于违规，按情节「限制分发、封禁账号」梯度处置。（[IT之家](https://www.ithome.com/0/944/156.htm)）
- 有媒体转述 2026-03「AI 全托管账号」专项治理：主页全是 AI 代发属于系统性违规，直接封号。只有单一来源，没找到官方原文。

## 结论

1. 小红书默认改为**交给手机**（`handoff`）：电脑准备内容、生成交接页，人在手机 App 里点发布。自动发布只作为用户显式开启的选项。口径见 `docs/design/ACCEPTANCE.md` 的 ACC-handoff-*。
2. 交接页不依赖分享开放平台：用复制文本、保存图片、深链拉起 App；在 HTTPS 且浏览器支持文件分享时用 Web Share API 把图片和正文交给系统分享面板（这是浏览器能力，与小红书官方 `xhs.share()` 无关）。**2026-11-14 用户登录 `agora.xiaohongshu.com` 确认：分享开放平台已暂停接入**，官方 `xhs.share()` 拿不到 appKey，本方案不再依赖它；平台重新开放后再评估。
3. **真机红线**：agent 不再对小红书做真实登录、发布、体检、采集；其他平台的真机操作每账号每天不超过 1 次。
4. 速率预算（PLAN.md R10）仍要补。

## 来源

- [小红书 AI 内容治理规则（IT之家，2026-04-27）](https://www.ithome.com/0/944/156.htm)
- [小红书社区公约 2.0（IT之家，2026-01-19）](https://www.ithome.com/0/914/441.htm)
- [用小红书分享开放平台做一键发布（掘金，2025-09-22）](https://juejin.cn/post/7552489208804491316)
- [JS SDK 停止申请的说法（CSDN 问答）](https://ask.csdn.net/questions/8591398)
- [小红书开放平台开发者门户（只见登录授权，未见发布能力）](https://openaccount.xiaohongshu.com/)
- [myaibot：扫码后在手机上发布](https://www.myaibot.vip/docs/api)
- [抖音 open_ticket（H5 拉起发布器）](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/tools-ability/jsb-management/open-ticket)
- [B站开放平台文档镜像](https://bilibili.apifox.cn/doc-7492454)
- [MultiPost](https://multipost.app)
- [social-auto-upload 小红书上传](https://skillselion.com/skills/dreammis/social-auto-upload/xiaohongshu-upload)
