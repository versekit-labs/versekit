---
name: versekit-ingest
description: 入库一个作品时用：写清单 JSON（成片、语言版本、各平台的标题/正文/话题文案），用 vk work add 入库，再用 vk plan apply 按成片生成平台稿。Claude 替用户入库时照这份写文案；versekit 本身不接 LLM。
---

# versekit 入库说明（给 Claude 看）

各平台的**标题、正文、话题由你在入库时写好**，随清单交给 `vk work add`。versekit 不会替你写，也不会替你截断：超限就拒绝入库，并告诉你是哪个平台、哪个字段、限多少。

## 流程

```bash
vk work add 清单.json          # 入库：作品 → 成片 → 语言版本，文案存进语言版本
vk work show <workId>          # 看每支成片的 id、每条平台稿的标题/正文/话题
vk plan apply <cutId>          # 按成片生成平台稿（待确认，不会自动发）
vk publish approve --cut <cutId>   # 人确认后才发
```

`vk plan apply <cutId> [--accounts a,b] [--group <组>]`：

- 不给 `--accounts`：当前账号组（或 `--group`）里**所有账号各一条**；给了就只建这几个（写账号 id，或组里的平台名）。
- 语言版本：有 `zh` 用 `zh`，没有就用第一个。
- 建议时间从现在起按平台规则排（每日上限、最小间隔），输出里每条带建议时间。
- 已经有这支成片平台稿的账号跳过；失效账号、没有适配器、素材类型不支持、文案超限的**不会建，但会列出原因**。
- 文案从语言版本里取：该平台的文案 > 默认文案 > 成片标题（正文、话题空）。

## 清单格式

```json
{
  "title": "作品标题",
  "source": "可选：来源路径，同一来源同一标题重复入库是更新",
  "cuts": [
    {
      "title": "长片",
      "copy": {
        "bilibili":    { "title": "……", "body": "……", "tags": ["话题1", "话题2"] },
        "xiaohongshu": { "title": "……", "body": "……", "tags": ["话题1"] },
        "tiktok":      { "title": "……", "body": "……", "tags": [] }
      },
      "versions": [
        { "language": "zh", "asset": "long-zh.mp4" },
        { "language": "en", "asset": "long-en.mp4",
          "copy": { "tiktok": { "title": "English title", "body": "…", "tags": ["tag"] } } }
      ]
    },
    {
      "title": "短片",
      "copy": { "title": "不分平台的默认文案", "body": "没有单独写的平台都用这份" },
      "versions": [{ "language": "zh", "asset": "short-zh.mp4" }]
    }
  ]
}
```

- `asset` 相对清单所在目录；可以是视频文件，或图片目录（图文）。
- `copy` 可以写在成片上（所有语言版本共用），也可以写在语言版本上（按平台覆盖成片级的）。
- `copy` 里 `title` / `body` / `tags` 三个键直接写 = **默认文案**；以平台名为键 = 该平台文案；两种可以并用，平台文案按字段盖住默认文案。
- `tags` 是字符串数组，**不带 `#`**（写了也会去掉）。
- 平台名只能是 `bilibili` / `xiaohongshu` / `douyin` / `tiktok` / `youtube`（`tiktok` 同时覆盖浏览器和官方接口两种接入）。写错会被拒绝，免得文案悄悄落空。
- 单个文件的快捷形式 `vk work add <视频> --title <标题>` 没有文案，要文案就用清单。

## 各平台字段限制

长度按字符数（一个汉字算 1）。限制在 `packages/core/src/store.mjs` 的 `COPY_LIMITS` 里只写一处，改数字改那里。

| 平台 | 标题 | 正文 | 话题 |
|---|---|---|---|
| B站 `bilibili` | ≤ 80 | ≤ 2000（简介） | ≤ 10 个，每个 ≤ 20 字 |
| 小红书 `xiaohongshu` | ≤ 20 | ≤ 1000 | ≤ 10 个 |
| 抖音 `douyin` | 文案合计 ≤ 1000（标题 + 正文 + `#话题` 一起算） | | |
| TikTok `tiktok` | 文案合计 ≤ 2200（同上） | | |
| YouTube `youtube` | ≤ 100 | ≤ 5000（简介） | — |

标了「未核实」的平台不校验，会在 `vk doctor` 的 `copy_limits` 里列出。

## 写文案的要点

- **每个平台各写一份**，别把同一段话复制五遍：小红书标题要在 20 字内，B站标题可以写满 80 字。
- 默认文案放进某个平台超限时，那个平台的平台稿不会建（输出里写明原因）——给它单独写一份更短的。
- 平台稿状态是「待确认」：人在确认前还能改标题；正文、话题为空会在 `vk work show` 里标出「没有正文」「没有话题」，但不阻止确认。
- 示例：同一支短片
  - B站：`"title": "三分钟讲清楚 SQLite 的 WAL 模式：为什么读写不再互相阻塞"`，`"tags": ["数据库", "SQLite", "后端"]`
  - 小红书：`"title": "WAL 模式 3 分钟讲透"`（18 字），`"body": "……"`，`"tags": ["程序员", "数据库"]`
