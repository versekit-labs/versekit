---
version: 1
slug: "docs-design-groups-html"
primary_target: "docs/design/groups.html"
related_targets: []
---

# 选择账号组 · 工作区入口

- **Scope**：`groups.html`，进入产品时的组选择与新建入口。
- **Mode**：Operate。
- **Audience**：第一次使用的人，或想新开一个内容品牌的人。
- **Job**：选一个已存在的账号组进入，或新建一个。
- **Action**：进入某个组、新建组并进入。
- **Proof / Content**：每组已有几个平台账号、有没有登录异常。
- **Constraints**：无当前组时强制落到这里；不在这里管理账号细节。

## Direction contract

**THESIS**：账号组是工作区。进来先选一个，之后所有页面只服务它；这里不做别的。

**OWN-WORLD**：冷灰白场地、单列居中卡片、深蓝主按钮；每组一个字母标记；零阴影。

**STORY**：看到已有组与各自状态 → 点进入；或输入名字新建 → 直接进入空组。

**FIRST VIEWPORT**：标题与一句说明、组列表（名称 + 账号数与异常）、新建表单、底部信任说明。

**FORM**：延续既有卡片与表单语言；seed: seed:a61cb2af8194ee80

**FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
