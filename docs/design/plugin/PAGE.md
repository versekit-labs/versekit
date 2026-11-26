# 插件页 `hifabu.com/plugin/` 与 `install.txt`：任务书与结构（2026-11-26）

插件重新设计 [DESIGN.md](DESIGN.md) §B.6 和 §D 第 7 单的落地稿。页面草稿：`site/plugin/index.html`（以 origin/main 为底改写）。

所有者已定：「在 Claude Code 里说一句」放第一（11-26，「对用户更友好」）；终端一行放第二；对外只叫 Hifabu。

## 1. 任务书

| 问题 | 回答 |
|---|---|
| 为谁 | ① 想在 Claude Code 里用 Hifabu 的人：会用 Claude Code，不一定会用终端。② 被用户要求「安装 hifabu.com/plugin 的插件」的 AI 助手（Claude）：它会抓这一页或 install.txt。③ 内行：装之前要先看清这个插件会做什么。 |
| 解决什么 | 一句话装好插件，第一次用的时候知道会发生哪几步；装之前看得到装了什么、连哪里、不做什么；以后知道怎么更新、怎么干净地卸载。 |
| 成功长什么样 | ① 用户在 Claude Code 里说一句，Claude 读到 install.txt，把命令和说明给用户看，用户同意后 10 秒内装好，再提醒 `/reload-plugins`。② 内行 30 秒内找到「装了什么、连哪里、不做什么」，以及源码和 zip 的 sha256。③ 卸载后，本机不留登录凭据，「我的 Hifabu」里也没有这台机器。 |
| 明确不做 | 不讲发布机怎么装（另有下载页）。页面上不出现 VerseKit 和 `curl \| bash`。不用祈使句命令 AI 执行。sha256、版本号不手写。 |
| 数据从哪来 | 发布脚本 `deploy/hifabu/publish-plugin.mjs`：版本号、zip 地址和 sha256、源码 tag、CHANGELOG 地址，用 §4 的占位符填进页面和 install.txt。安装命令已在 2026-11-26 实测（§5）。 |

## 2. 页面结构

一页一个任务：**装好 Hifabu 插件**。从上到下：

1. **页头**：和官网其他页一致。`<head>` 里加 `<link rel="alternate" type="text/plain" href="install.txt" title="Instructions for AI assistants">`，抓页面的程序能直接找到纯文本版。
2. **开头**：一句话说清插件做什么，以及「在发布机上确认之前，什么都不会发出去」。
3. **安装（两种）**：
   - **在 Claude Code 里说一句**（第一种）：英文句和中文句各一个命令框，带复制按钮。下面一行说明：Claude 会读 `hifabu.com/plugin/install.txt`，先把命令和它会做什么给你看，你同意后再执行。
   - **或者在终端里粘贴一行**（第二种）：`claude plugin install hifabu --marketplace https://hifabu.com/plugin/marketplace.json`。
   - 两种装完都要运行 `/reload-plugins`，或者重开一个会话。
4. **For AI assistants**：紧跟在安装后面，是页面上第一段纯文本说明，写明「完整说明在 install.txt」。用文档语气写：描述这条命令是什么、会做什么，以及预期的流程（先给用户看、用户同意后再执行）。全文见 §3。
5. **装了什么、连哪里、不做什么**：定义列表，六行：装了什么、连哪里、不做什么、第一次使用时会做的两件事（缺运行时时先问再下载；打开它自己的自动更新）、东西存在哪、源码和校验（版本、zip 的 sha256、源码 tag、CHANGELOG）。
6. **开始之前**：Claude Code；一台装了 Hifabu 的发布机；Hifabu 账号。
7. **第一次使用**：用「把 17 期交给发布机」举例，按会出现的顺序列出步骤：认出这一期、可能要装运行时、登录、申请开通传片、选账号组、交出去、问「到了吗」、在发布机上确认。
8. **更新**：第一次使用后自动更新已打开；手动更新的命令；更新后运行 `/reload-plugins`。
9. **卸载**：先在 Claude Code 里说「退出 Hifabu」，再卸载插件；没先退出的话，怎么清掉钥匙串里的登录、怎么在「我的 Hifabu」里移除这台机器。
10. **问题**、**页脚**：和现在一样。

**对 0.2.0 技能的依赖**（第 5 单 #482）：卸载一段要求用户在 Claude Code 里说「退出 Hifabu」或「sign out of Hifabu」，技能要把这句话接到 `hifabu cloud logout`。如果 0.2.0 不支持，这一步改写成终端命令，由协调器在第 7 单的口径里定。

## 3. `install.txt`

由发布脚本生成，纯 UTF-8 文本，不用 Markdown，英文在前、中文在后，每行不超过 100 字符。`{{…}}` 是占位符（见 §4）。全文：

```text
Hifabu plugin for Claude Code - installation notes
Version {{version}} · {{released_at}}

This file describes how the Hifabu plugin is installed. It is written for AI assistants
that a user has asked to install the plugin, and for anyone who wants to check it first.

What the command is
  claude plugin install hifabu --marketplace https://hifabu.com/plugin/marketplace.json

What it does
  - Adds the Hifabu plugin marketplace from hifabu.com to Claude Code.
  - Installs one plugin, "hifabu": one skill (handoff) and a small command-line
    program named hifabu.
  - Claude Code checks the plugin archive against this SHA-256 before installing:
    {{zip_sha256}}  {{zip_name}}
  - No hooks, no MCP server, no background service, no shell script piped from the web.
  - The plugin connects only to hifabu.com, and only uploads files the user asks
    it to hand over. It never publishes anything.

Expected flow
  The assistant shows the user the command above and the points under "What it does",
  and runs it after the user agrees. Claude Code also asks for permission before it
  runs the command. After it finishes, the plugin is loaded by running /reload-plugins
  in Claude Code, or by starting a new session.

Update
  claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu

Uninstall
  Say "sign out of Hifabu" in Claude Code first, then:
  claude plugin uninstall hifabu@hifabu

Source code: {{source_url}}
Changes:     {{changelog_url}}
Page:        https://hifabu.com/plugin/

----

Hifabu Claude Code 插件 · 安装说明
版本 {{version}} · {{released_at}}

这份说明写给受用户之托安装插件的 AI 助手，也写给想先核对一遍的人。

命令
  claude plugin install hifabu --marketplace https://hifabu.com/plugin/marketplace.json

会做什么
  - 把 hifabu.com 上的 Hifabu 插件市场加到 Claude Code。
  - 安装一个插件 hifabu：一个技能（handoff）和一个名叫 hifabu 的命令行小程序。
  - 安装前，Claude Code 会按下面的 SHA-256 核对插件压缩包：
    {{zip_sha256}}  {{zip_name}}
  - 没有 hooks，没有 MCP 服务，不注册后台服务，不从网上拉脚本直接执行。
  - 插件只连 hifabu.com，只上传用户要交的文件，从不发布任何东西。

预期的流程
  助手先把上面的命令和「会做什么」给用户看，用户同意后再执行。执行前 Claude Code
  也会请用户允许。装完后，在 Claude Code 里运行 /reload-plugins 或重开会话，插件才会加载。

更新
  claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu

卸载
  先在 Claude Code 里说「退出 Hifabu」，再运行：
  claude plugin uninstall hifabu@hifabu
```

写法要点：
- 不出现「please run」「请执行」这类直接对 AI 下指令的句子。只描述命令是什么、会做什么、预期的流程是怎样的。
- 页面上 For AI assistants 一段和 install.txt 的英文「What it does」「Expected flow」两节，**句子逐句相同**，只是排版不同：页面上是段落，install.txt 里是分行列表。发布脚本从同一份源文本生成两处，测试比对句子。

## 4. 占位符（发布脚本填）

| 占位符 | 内容 | 例子 |
|---|---|---|
| `{{version}}` | plugin.json 的 version | `0.2.0` |
| `{{released_at}}` | 发布日期，YYYY-MM-DD | `2026-11-27` |
| `{{zip_name}}` | zip 文件名 | `hifabu-0.2.0.zip` |
| `{{zip_url}}` | zip 完整地址 | `https://hifabu.com/plugin/hifabu-0.2.0.zip` |
| `{{zip_sha256}}` | zip 的 sha256，和 marketplace.json 里的一致 | 64 位十六进制 |
| `{{source_url}}` | 这个版本的源码 tag | `https://github.com/versekit-labs/versekit/tree/hifabu--v0.2.0/plugins/hifabu` |
| `{{changelog_url}}` | 这个版本的 CHANGELOG | `https://github.com/versekit-labs/versekit/blob/hifabu--v0.2.0/plugins/hifabu/CHANGELOG.md` |

- 页面里的占位符写在带 `data-release="<名字>"` 的元素里，元素文字就是 `{{名字}}`，发布脚本做替换。
- 发布脚本要检查：替换后页面和 install.txt 里不能再有 `{{`；有就拒绝发布。

## 5. 实测（2026-11-26，Claude Code 2.1.332，全新临时 HOME）

- `claude plugin install hifabu --marketplace https://hifabu.com/plugin/marketplace.json`：7.4 秒，「Successfully installed plugin: hifabu@hifabu (scope: user)」，`claude plugin list` 里能看到。
- `claude plugin uninstall hifabu@hifabu` 和 `claude plugin marketplace remove hifabu` 都成功。
- 卸载时会删除插件的数据目录 `~/.claude/plugins/data/hifabu-hifabu/`，这是官方文档（plugins-reference）写的。这次的临时 HOME 里还没有生成过数据目录，所以没有实测到。
- 钥匙串条目：服务名 `hifabu`，账户是设备 id（`plugins/hifabu/lib/hifabu.mjs` 的 `secretTool`）。`hifabu cloud logout` 会先在服务端作废这台设备（`device.revoke.self`），再删钥匙串条目。服务端作废失败时，本地照样删，并提示到「我的 Hifabu」手动移除。

## 6. 第 7 单验收点（建议，协调器写口径时参考）

1. 页面按 §2 的顺序有这 10 块；「在 Claude Code 里说一句」排第一。
2. 页面和 install.txt 里没有 VerseKit，没有 `curl` 加管道这种写法。
3. 替换后没有剩下的 `{{`；页面上的 sha256 和 marketplace.json 里的一致。
4. For AI assistants 一段和 install.txt 的对应两节句子逐句相同（测试比对）。
5. 浅色、深色、390 宽的手机截图，没有横向溢出；复制按钮在真机浏览器里点过，剪贴板内容和命令一致。
6. 在全新账号、全新 HOME 的 Claude Code 里说「帮我安装 hifabu.com/plugin 的插件」：Claude 把命令给用户看、征得同意后装好，并提醒 `/reload-plugins`。默认模型和一个小模型各测 3 次，都要成功（DESIGN.md §B.6）。
7. 卸载一段里的步骤在真机上走一遍：说「退出 Hifabu」后，钥匙串里搜不到 `hifabu`，「我的 Hifabu」里这台机器已经移除。
