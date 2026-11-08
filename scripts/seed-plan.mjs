#!/usr/bin/env node
// 把 docs/PLAN.md 的规划灌进 GitHub：labels → milestones → issues。
// 幂等：已存在的 label/milestone/issue（按标题）会跳过，可以反复运行。
//
//   node scripts/seed-plan.mjs [--dry]
//
// 身份来自 .pi/gh-account（不切换全局 gh 账号）。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "versekit-app/versekit";
const DRY = process.argv.includes("--dry");

const account = readFileSync(join(ROOT, ".pi", "gh-account"), "utf8").trim();
const token = execFileSync("gh", ["auth", "token", "--user", account], { encoding: "utf8" }).trim();

function api(method, path, body) {
  const args = ["api", "--method", method, path];
  if (body) args.push("--input", "-");
  if (DRY && method !== "GET") {
    console.log(`  [dry] ${method} ${path} ${body ? JSON.stringify(body).slice(0, 90) : ""}`);
    return { number: 0 };
  }
  const out = execFileSync("gh", args, {
    input: body ? JSON.stringify(body) : undefined,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token },
  });
  return out.trim() ? JSON.parse(out) : {};
}

const get = (path) => api("GET", path);

// ---------------------------------------------------------------- labels

const LABELS = [
  ["type: feat", "1f883d", "新功能"],
  ["type: fix", "d73a4a", "修缺陷"],
  ["type: docs", "0075ca", "文档"],
  ["type: test", "5319e7", "测试"],
  ["type: chore", "c2e0c6", "杂务/构建/CI"],
  ["area: core", "bfdadc", "内核：队列、状态机、事件、契约"],
  ["area: cli", "fbca04", "命令行"],
  ["area: adapter", "d4c5f9", "平台适配器"],
  ["area: channel", "f9d0c4", "飞书/Telegram 等通道"],
  ["area: web", "c5def5", "本地控制台"],
  ["area: docs", "fef2c0", "文档与设计稿"],
  ["P0", "b60205", "阻塞 v0.1"],
  ["P1", "d93f0b", "本里程碑内应完成"],
  ["P2", "fbca04", "可以晚一点"],
  ["good-first-issue", "7057ff", "适合新贡献者"],
];

// ---------------------------------------------------------------- milestones

const MILESTONES = [
  ["v0.1 内核闭环", "一条内容能真的发出去、数据能回到本地。出门条件见 docs/PLAN.md §3。"],
  ["v0.2 控制面", "手机上能拍板：飞书长连接 + 卡片审批 + 账号墙。"],
  ["v0.3 平台扩展", "五平台齐 + 可交付（英文 README、看板、CSV 兜底）。"],
  ["v0.4 agent 化", "Skill / MCP / 多维表格 / Telegram。"],
];

// ---------------------------------------------------------------- issues

const I = (title, body, labels, milestone) => ({ title, body, labels, milestone });

const ISSUES = [
  I(
    "ci: GitHub Actions —— test + commands-parity + adapter-contract",
    `**背景**：架构的承重墙是"命令注册表派生三端"，但校验只写在文档里（PLAN §2.2 R6）。没有 CI，这条约束等于不存在。

**要做**
- \`.github/workflows/ci.yml\`：Node 22.5+，跑 \`npm test\`
- \`commands-parity\`：\`vk commands --json\` 的命令集合 == HTTP 路由表 == 卡片按钮集合
- \`adapter-contract\`：对每个 \`packages/adapter-*\` 跑形状断言（platform/ready/publish/collect/capabilities）

**验收**：故意删掉一条注册表命令，CI 必须变红。`,
    ["type: chore", "area: core", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "core: 错误码枚举与人话映射（R4）",
    `**背景**：现在 \`error_code\` 是随手写的（\`auth_error\`/\`publish_failed\`），卡片没法按原因给不同按钮，\`doctor\` 也没法统计。

**要做**
- 定死枚举：\`auth | platform_reject | quota | flaky_ui | asset_invalid | unknown\`（见 ARCHITECTURE §4.3）
- 核心根据 code 生成人话与建议动作；**适配器不许自己拼文案**
- \`vk doctor\` 按 code 汇总最近 7 天

**验收**：同一错误在 CLI / 日志 / 卡片里显示同一句人话。`,
    ["type: feat", "area: core", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "core: 账号健康检查链路（run=check + adapter.check）",
    `**背景**：PRD 承诺"提前 72h 告警"（G3），但架构里 \`check\` 只是 schema 注释；B站适配器的 \`check\` 还是 null。结果是用户仍然"发布时才发现号掉了"。

**要做**
- 新增 \`run{kind:'check'}\`，每 6h/账号；实现 \`adapter.check()\` 契约（返回 AccountHealth）
- 被动信号：发布/采集遇 auth 错立即置 \`expired\`，不等下一轮
- 没实现 check 的适配器，在 \`doctor\` 里显式列为"只能被动发现失效"

**验收**：手动改坏 cookie，24h 内必须收到 \`account.expired\` 卡片（不需要发起发布）。`,
    ["type: feat", "area: core", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "core: followup 核实器（visibility / collection / captions）",
    `**背景**：PRD 说"系统自己核实"，但代码里 followup 只有创建没有核实（R3）——那就又退化成一句 notes 字符串。

**要做**
- \`followup.verify\` 映射到核实函数，随 \`check\` 任务顺带执行（不单开任务类型）
- 先实现两个：\`visibility\`（读回可见性）、\`collection\`（读合集归属）
- 核实通过 → \`done\`；不通过 → 保持 open + 卡片重试（带证据）

**验收**：B站发布后，"加入合集"能被自动判定为已完成/未完成。`,
    ["type: feat", "area: core", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "adapter-tiktok: publish（Studio web 自动化 + 可见性参数化）",
    `**背景**：工厂 \`publishers/tiktok.mjs\`（151 行）已验证，见 ADR-0001。移植但要剥离硬编码，并把可见性做成参数。

**要做**
- 移植上传/描述(Draft.js)/话题/封面/AI 标签/内容检查/发布后回读 id 全流程
- \`visibility\` 支持 \`public | private\`；\`private_then_public\` 由核心排一个"放行"步骤
- 剥离：账号名 \`@assurelane6\`、\`en/\` 目录约定、固定文案规则
- 失败留截图 + 错误码；\`--dry-run\` 产出截图

**验收**：以"仅自己"发一条 → 卡片出现「放行公开」→ 点完系统自己改成公开并核实。`,
    ["type: feat", "area: adapter", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "adapter-tiktok: collect（创作者后台响应拦截）",
    `**背景**：工厂 \`stats: null\`，TikTok 指标未接。数据是产品主线之一。

**要做**
- 用 \`driver.collectJson()\` 打开 tiktokstudio/content，拦截页面自身发出的 item_list 响应
- 按 \`publish.external_id\` 匹配作品，归一化 play/like/comment/share；**收藏不存在就不写 0**
- 失败区分 auth / 页面改版 / 作品找不到，各留事件

**验收**：一条已发作品能产出 \`source=intercept, status=ok\` 的快照，数值与后台一致。`,
    ["type: feat", "area: adapter", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "cli: vk account add / list / reauth（扫码落到 Web）",
    `**背景**：扫码是唯一必须用眼睛的环节；CLI 里贴二维码路径不可接受。

**要做**
- \`vk account add <platform> --name\` → 启动本地页 → 扫码 → 落 \`credential_ref\`
- \`vk account list\`（JSON/--human）、\`vk account reauth\`
- 凭证落盘即 0600，DB 只存引用

**验收**：新机器上 \`vk account add tiktok\` 到扫码成功 < 2 分钟。`,
    ["type: feat", "area: cli", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "cli: vk publish / collect / stats",
    `**要做**
- \`vk publish <asset> --to a,b [--schedule] [--visibility] [--dry-run] [--json]\`
- \`vk collect [--now] [--platform]\`、\`vk stats works|overview\`
- 默认 JSON；\`--dry-run\` 不产生任何对外动作

**验收**：\`vk publish --dry-run --human\` 能说清"将发到哪、每个平台缺什么"。`,
    ["type: feat", "area: cli", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "test: 适配器契约测试模板",
    `**背景**：移植最大的风险是"复制 bug"（ADR-0001 §6）。

**要做**
- \`packages/core/test/contract.mjs\`：给定一个适配器导出，断言形状 + \`ready()\` 语义 + dry-run 不产生对外动作
- 每个 adapter 包一行接入

**验收**：新增适配器不接契约测试则 CI 失败。`,
    ["type: test", "area: core", "P0"],
    "v0.1 内核闭环",
  ),
  I(
    "core: 时区与日界线约定落地（R5）",
    `**背景**：digest 9:00、按天聚合、每日发布上限都依赖"今天"的定义，目前没约定。

**要做**
- 存 UTC；日界线按账号平台的主要时区（国内 Asia/Shanghai / 海外 UTC）
- 展示按用户时区
- 写进 ARCHITECTURE §4.4 并在聚合查询里实现

**验收**：跨时区账号的"今日发布数"与当地日期一致。`,
    ["type: feat", "area: core", "P1"],
    "v0.1 内核闭环",
  ),

  I(
    "channel-feishu: 长连接 + 配对 + 卡片回调幂等",
    `**要做**
- WebSocket 长连接（不开公网端口）
- \`vk channel bind feishu\` → 6 位码配对
- 卡片按钮携带 \`command_id\`/\`idempotency_key\`/\`exp\`；回调校验后**原地更新**卡片

**验收**：断网 10 分钟后恢复，积压事件补投且不重复。`,
    ["type: feat", "area: channel", "P0"],
    "v0.2 控制面",
  ),
  I(
    "core: 事件投递器（event → delivery，合并投递）",
    `**要做**
- 事件落库后异步投递，\`dedupe_key\` 去重，at-least-once
- 合并投递：一条消息最多 3 个事件，带时序
- 敏感信息（路径/凭证/内部 id）永不出现在卡片

**验收**：同一事件重放 5 次，用户只收到 1 条。`,
    ["type: feat", "area: core", "P0"],
    "v0.2 控制面",
  ),
  I(
    "web: 账号墙 + 扫码登录页",
    `**要做**：账号状态色标（ok/expiring/expired/manual）、最近发布与采集、每行一个主按钮、扫码页。
**验收**：一屏看出"哪个号需要我处理"，点一次就能重新登录。`,
    ["type: feat", "area: web", "P0"],
    "v0.2 控制面",
  ),
  I(
    "web: 发布台（多平台差异编排）",
    `**要做**：拖入素材 → 勾平台 → 每平台覆盖标题/话题/封面/定时/可见性 → 发布或定时。
**验收**：5 平台差异编排 < 2 分钟（G2）。`,
    ["type: feat", "area: web", "P1"],
    "v0.2 控制面",
  ),
  I(
    "web: 作品详情 + 总览看板",
    `**要做**：三指标趋势 + 采集来源/状态标注 + 跨平台并排；总览按平台/账号/时间聚合。
**验收**：能一眼分辨"数据是 3 天前的"与"登录过期没采到"。`,
    ["type: feat", "area: web", "P1"],
    "v0.2 控制面",
  ),
  I(
    "core: digest.daily 调度（用户时区 9:00）",
    `**要做**：每日摘要（昨日发布/指标/异常），按用户时区 9:00 推一次，可关。
**验收**：跨时区用户收到的时间是当地 9:00。`,
    ["type: feat", "area: core", "P1"],
    "v0.2 控制面",
  ),

  I(
    "adapter-xiaohongshu: 发布 + 采集",
    `**背景**：工厂 \`xiaohongshu.mjs\`（194 行）已验证：话题面板选题、首帧封面、closed shadow DOM 按钮、AI 合成声明。
**要做**：移植 + 剥离去重（标题 20 字 / 正文 1000 字 / 话题 ≤10 是平台约束，留在适配器）；采集走创作服务平台接口拦截。
**验收**：发布后 followup 里出现"AI 声明"，并可核实。`,
    ["type: feat", "area: adapter", "P1"],
    "v0.3 平台扩展",
  ),
  I(
    "adapter-douyin: 发布 + 采集",
    `**背景**：工厂没有抖音（PLATFORMS 里没有），要从零写；social-auto-upload 的 \`douyin_uploader\`（1261 行）可读但登录部分不需要（我们用持久 profile）。
**要做**：创作者中心发布页自动化（上传/标题/话题/封面/可见性/定时/草稿）；采集拦截作品数据接口。
**验收**：auto 发一条 + 快照落库；连续失败能降级到 draft/notify。`,
    ["type: feat", "area: adapter", "P1"],
    "v0.3 平台扩展",
  ),
  I(
    "adapter-youtube: Data API 发布 + Analytics 采集",
    `**要做**：\`videos.insert\` 可续传、缩略图、播放列表、AI 声明；Analytics 取观看时长/订阅增减。
**注意**：未审核项目上传会被强制私享 → 必须回读 \`privacyStatus\` 并生成 \`published_limited\` + followup。
**验收**：强制私享的情况能在卡片上被看见，而不是"发了没人看"。`,
    ["type: feat", "area: adapter", "P1"],
    "v0.3 平台扩展",
  ),
  I(
    "core: CSV 导入兜底（source=csv）",
    `**要做**：\`vk collect import <csv>\`，与自动采集同构入库，\`source=csv\`、\`status=ok\`。
**验收**：无接口平台也能出一条趋势线。`,
    ["type: feat", "area: core", "P2"],
    "v0.3 平台扩展",
  ),
  I(
    "docs: 英文 README（R7）",
    `**背景**：全中文文档会让海外创作者与贡献者在第一屏流失。开源第一页必须有英文。
**要做**：\`README.md\` 双语（或 README.en.md + 顶部切换），只翻"是什么/为什么/快速开始/平台表/合规边界"，其余文档保持中文。
**验收**：不懂中文的人能照 README 跑通 \`vk init\` 与 \`vk doctor\`。`,
    ["type: docs", "area: docs", "P1", "good-first-issue"],
    "v0.3 平台扩展",
  ),
  I(
    "docs: 确定最终产品名，并收敛 versekit / versekit-app 的组织与品牌（R8）",
    `**背景**：三个名字并存，新人第一分钟就在猜。
**要做**：README 顶部一句话说明（品牌 / 组织 / 产品），或在 v1.0 前统一。
**验收**：README 前 10 行内能回答"这三个名字是什么关系"。`,
    ["type: docs", "area: docs", "P1", "good-first-issue"],
    "v0.3 平台扩展",
  ),
  I(
    "core: 发布速率预算（每账号每日上限）",
    `**背景**：runner 只保证同账号串行，没有每日上限；平台风控与账号健康的下一个隐患（R10）。
**要做**：每账号每日发布/采集上限可配；超限不是失败，而是延后（并计入 digest）。
**验收**：把上限设成 1，第二条自动排到次日且不报错。`,
    ["type: feat", "area: core", "P1"],
    "v0.3 平台扩展",
  ),
  I(
    "core: 重发语义（publish 唯一约束）",
    `**背景**：\`UNIQUE(work_id, account_id)\` 让"同一作品重发到同一账号"撞库（R9）。
**要做**：二选一——加 \`vk publish republish\`（新行、引用前一条），或在文档里写明并给替代路径。
**验收**：用户删稿后能按明确方式重发。`,
    ["type: feat", "area: core", "P2"],
    "v0.3 平台扩展",
  ),

  I(
    "skill / MCP: 把 vk 能力暴露给 agent",
    `**要做**：Skill（Claude Code / Codex）与 MCP 双形态，薄封装，不重复业务逻辑；只暴露命令注册表里的命令。
**验收**：一个 agent 能独立完成"加账号 → 发布 → 看数据 → 回报"。`,
    ["type: feat", "area: cli", "P2"],
    "v0.4 agent 化",
  ),
  I(
    "channel-feishu-bitable: 多维表格适配器",
    `**背景**：视频工厂的经验值得保留，但方向要反转：DB 是事实来源，飞书是视图 + 命令入口。
**验收**：断开飞书，内核与 CLI 功能不减；恢复后自动补推。`,
    ["type: feat", "area: channel", "P2"],
    "v0.4 agent 化",
  ),
  I(
    "channel-telegram",
    `**要做**：与飞书同一 \`Channel\` 接口的第二个实现（inline keyboard），验证通道抽象是否成立。
**验收**：不改内核就接入新通道。`,
    ["type: feat", "area: channel", "P2"],
    "v0.4 agent 化",
  ),
];

// ---------------------------------------------------------------- run

console.log(`repo: ${REPO}  account: ${account}${DRY ? "  (dry)" : ""}`);

const existingLabels = new Set(get(`repos/${REPO}/labels?per_page=100`).map((l) => l.name));
for (const [name, color, description] of LABELS) {
  if (existingLabels.has(name)) continue;
  api("POST", `repos/${REPO}/labels`, { name, color, description });
  console.log(`label  + ${name}`);
}

const msList = get(`repos/${REPO}/milestones?state=all&per_page=100`);
const msNumber = new Map(msList.map((m) => [m.title, m.number]));
for (const [title, description] of MILESTONES) {
  if (msNumber.has(title)) continue;
  const created = api("POST", `repos/${REPO}/milestones`, { title, description });
  if (created.number) msNumber.set(title, created.number);
  console.log(`milestone + ${title}`);
}

const existingIssues = new Set(
  get(`repos/${REPO}/issues?state=all&per_page=100`).filter((i) => !i.pull_request).map((i) => i.title),
);
let created = 0;
for (const issue of ISSUES) {
  if (existingIssues.has(issue.title)) continue;
  const milestone = msNumber.get(issue.milestone);
  api("POST", `repos/${REPO}/issues`, {
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    ...(milestone ? { milestone } : {}),
  });
  created++;
  console.log(`issue  + ${issue.title}`);
}
console.log(`\n完成：新增 ${created} 个 issue（共 ${ISSUES.length} 条规划）`);
