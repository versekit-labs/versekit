# 账号组 × 平台矩阵：竞品调研与产品结论

调研日期：2026-11-07。仅使用公开官网、官方帮助文档与官方开源仓库；未登录竞品后台，因此“是否有矩阵视图”仅限公开资料可证实范围，不断言产品内部绝不存在该视图。

## 用户场景

versekit 的用户同时运营多个内容品牌 / 账号组。每个账号组分别在多个平台各有一个账号，例如：

| 账号组 | 小红书 | 抖音 | B站 | YouTube | TikTok |
|---|---|---|---|---|---|
| AI 工具研究所 | 1 个 | 1 个 | 1 个 | 1 个 | 1 个 |
| 剪辑日记 | 未接入 | 1 个 | 1 个 | 1 个 | 未接入 |

已确认的基数约束：**同一账号组在同一平台最多一个账号。** 因此矩阵的一格可以唯一映射到一个平台账号，不需要在单元格内再聚合多个账号。

## 竞品对照

| 产品 | 上层分组模型 | 一组能否跨平台 | 公开界面如何使用分组 | 是否直接呈现“组 × 平台”矩阵 |
|---|---|---|---|---|
| Postiz | Customer Group（客户组） | 能 | 左侧频道按客户组折叠；日历按客户筛选；各组有频道、日历与数据 | **未见到。** 是分组频道列表 + 日历，不是账号健康矩阵 |
| Metricool | Brand | 能，且每平台一个 | 通过 Brand 下拉框切换；每个 Brand 管理自己的连接、内容和数据 | **未见到。** 数据模型最接近，但主要交互是切换 Brand |
| Later | Social Set；上层为 Access Group | 能，且每平台一个 | 在设置中整理 Social Set；Access Group 各自有日历与媒体库 | **未见到。** 是集合与权限/资产容器 |
| Buffer | Channel Group | 能 | 保存一组发布目标，一次向组内频道发布；另有全频道日历 | **不是同一概念。** Channel Group 主要服务发布目标，而非账号组健康管理 |
| SocialBee | Workspace | 能 | 不同客户/品牌分 Workspace，隔离账号、素材、内容与权限 | **未见到。** 是工作区隔离，不是跨工作区矩阵 |
| 蚁小二 | 自定义账号分组 | 能 | 按平台、业务、区域、账号层级分组；按组筛选、批量运维、统计数据、分配权限 | **公开资料未证实矩阵视图。** 重点是分组、权限和批量操作 |
| 易媒助手 | 账号分组 | 能 | 分组登录管理；发布时选组；数据统计时选组；团队权限分配 | **公开资料未证实矩阵视图。** 主要是分组选择与批量分发 |

## 证据

### Postiz

官方主工作区代码将 integration 按 `customer.id` 分组，并以 `MenuGroupComponent` 渲染可折叠频道组；主区域仍是 `Filters` + `Calendar`。这证明分组存在于数据模型和频道侧栏，但不是二维账号矩阵。

- [Postiz 主工作区源码（官方仓库）](https://github.com/gitroomhq/postiz-app/blob/main/apps/frontend/src/components/launches/launches.component.tsx)
- [Postiz 日历与频道管理结构](https://deepwiki.com/gitroomhq/postiz-app/3.1-calendar-and-post-scheduling-interface)

### Metricool

官方连接指南明确：一个 Brand 是一个业务/客户的容器，**每个平台在该 Brand 下只能连接一个账号**；多个业务使用不同 Brand。连接流程从 Brand 下拉框开始。

- [How to Connect Social Media Accounts in Metricool](https://metricool.com/connect-social-networks-with-metricool/)
- [What’s a Brand in Metricool](https://help.metricool.com/whats-a-brand-in-metricool-and-how-does-it-work-5l78b)

### Later

官方 Social Sets 指南明确：每个 Social Set 可包含每个支持平台各一个账号，用于按 brand 或 identity 组织；Access Group 包含多个 Social Set，并各自拥有 Media Library 与 Calendar。

- [Create & Manage Social Sets](https://help.later.com/hc/en-us/articles/360044369654-A-Guide-to-Social-Sets)
- [Choosing a Later Social Plan](https://help.later.com/hc/en-us/articles/360059362253-Choosing-a-Later-Social-Plan)

### Buffer

官方 2025 年更新说明将 Channel Groups 定义为“保存一组频道并向它们一起发布”；同文的 All Channels View 是全频道日历，不是账号状态矩阵。

- [Everything we launched in Buffer in 2025](https://buffer.com/resources/everything-we-launched-in-buffer-in-2025/)

### SocialBee

官网将 Workspace 用于分隔不同客户的账号与资产，避免相互混淆；这是工作区隔离模型。

- [SocialBee 官网](https://socialbee.com/)

### 蚁小二

官方学院文章明确支持按平台、业务、区域、账号层级自定义分组，并按分组筛选账号、批量运维、复盘数据和分配权限。公开文字没有证明其首页使用“账号组 × 平台”的并排矩阵。

- [账号分组 + 权限分配：提升新媒体矩阵管理效率](https://xueyuan.yixiaoer.cn/article/46698)
- [自媒体矩阵管理系统使用指南](https://xueyuan.yixiaoer.cn/article/46492)

### 易媒助手

官方教程描述了创建分组、把账号拖入分组、发布时选择分组、按分组查看数据；公开文字同样未证明存在二维矩阵主页。

- [多平台账号分组登录管理教程](https://yimeizhushou.com/h-nd-485537.html)

## 结论：竞品有“分组”，但矩阵主视图仍有空位

竞品的共同做法是把分组当作**工作区、筛选器、权限边界或发布目标**。在已查到的公开资料中，尚未看到把“账号组 × 平台”直接作为首页主视图、并在每格同时呈现登录健康与最近证据的产品。

versekit 可以占据的空位不是“我们也有账号分组”，而是：

> **一眼看清每个账号组在每个平台是否健康，以及问题出在哪一格。**

差异化仍来自 versekit 自有约束：凭证留在本地、登录状态主动检查、最近发布与最近采集同时可见、失败必须留下原因。

## 对 versekit 的产品建议

### 领域模型

增加 `account_group`（用户界面称“账号组”）：

```text
account_group 1 ─── n account
platform       1 ─── n account
```

约束：`(group_id, platform)` 最多一个账号；现有 `UNIQUE(platform, handle)` 保留，用于防止同一个平台账号被重复接入。

这只增加账号归属，不改变 `work × account = publish`：发布仍落到具体平台账号；账号组只是选择、查看与聚合维度。

### 首页

首页从平铺账号表改为：

1. **行 = 账号组**；**列 = 平台**；**格 = 唯一平台账号**。
2. 每格只显示：登录状态、最近发布距今、最近采集距今。
3. 点击格子，下方展开该账号的作品标题、采集来源、失败原因和唯一动作。
4. 未接入也显示为空格，让用户看见矩阵缺口；不把它算作异常。
5. 默认选中第一个需要处理的格子，而不是默认展开所有详情。
6. 手机不横向挤压五列：每个账号组变成一段，平台逐行排列，保留相同字段。

### 不做什么

- 不把团队、权限、Workspace 引入 v0.1；P1 是一人或小团队共用本地内核。
- 不把“账号组”变成新的第五种发布对象；发布仍指向具体账号。
- 不在矩阵单元格里塞图表、粉丝数或完整作品列表。
- 不因为竞品没有矩阵视图就断定这是用户价值；需要用真实账号组的日常检查路径验证。
