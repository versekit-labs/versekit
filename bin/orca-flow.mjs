#!/usr/bin/env node
// Orca 原生派工（versekit ACC-harness-orca-03..08，替代 cycle.sh / coordinator-loop.sh / worker-up.sh）。
// 不绑项目：项目名取 FLOW_PROJECT，否则 origin 远端的仓库名；项目专属的任务书约束放 .orca-kit/flow-rules.md。
//
// 分工：
//   - GitHub（issue label、PR、验收判定）是给人看的事实源，读写只经 bin/agentctl.mjs。
//   - Orca 管执行：Task 与依赖、worker 放置（new-top-level / 已有 worktree）、复用同一终端、
//     liveness / attention、回收。脚本不建 worktree、不加锁、不写登记文件，
//     每一轮都从「GitHub 现状 + orca task-list / worker-list」重新算该做什么（可重入、幂等）。
//   - 收件箱归协调器 agent：tick 只 ack 纯事实类消息（worker_done / heartbeat / merge_ready），
//     遇到 question / escalation 停下，不 ack，留给协调器 reply（官方：协调器是 agent）。
//
// 用法：
//   node bin/orca-flow.mjs tick [--dry-run] [--json]   跑一轮：回收 → 迁移 → 合并 → 放行 → 验收 → 返工 → 实现
//   node bin/orca-flow.mjs status [--json]             只读：在跑的 worker、待回答的消息
//   node bin/orca-flow.mjs watch [--every 180]         前台每 N 秒 tick 一次（协调器不在时用；可放进 LaunchAgent）
//
// 环境：FLOW_LANES（实现+返工并行上限，默认 2）、FLOW_ACCEPT_MAX（验收并行上限，默认 1）、
//       FLOW_PROJECT（默认 origin 仓库名）、RUN_FILE（默认 ~/.orca/<项目>-run-id）、FLOW_LOG（默认 ~/.orca/<项目>-state/orca-flow.log）。
//       issue 带 by:coordinator label：协调器自己实现，验收 FAIL 后不自动派返工 agent（ACC-harness-orca-08）。

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();

/** 项目名：显式 FLOW_PROJECT > origin 远端仓库名 > 仓库目录名。决定 Run 文件、状态目录、进程名、Task 前缀。 */
export function projectName(env = process.env, originUrl = null, rootDir = ROOT) {
  if (env.FLOW_PROJECT) return env.FLOW_PROJECT;
  const url = originUrl ?? spawnSync("git", ["remote", "get-url", "origin"], { cwd: rootDir, encoding: "utf8" }).stdout?.trim();
  const m = /([^/:]+?)(?:\.git)?$/.exec(url ?? "");
  return m?.[1] || rootDir.split("/").pop();
}
const PROJECT = projectName();
const STATE_DIR = join(HOME, `.orca/${PROJECT}-state`);
/** Task 前缀：versekit 沿用 vk，其余用项目名。 */
const PREFIX = process.env.FLOW_TASK_PREFIX ?? (PROJECT === "versekit" ? "vk" : PROJECT);

export const KINDS = { impl: "实现", rework: "返工", accept: "验收" };
const KIND_BY_ZH = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));

/** Task 标题是脚本与 Orca 之间唯一的对应关系：`<前缀>#<issue> <实现|返工 r<k>|验收 <head7>>`（versekit 前缀 vk）。 */
export function taskTitle(kind, issue, extra = "", prefix = PREFIX) {
  return `${prefix}#${issue} ${KINDS[kind]}${extra ? ` ${extra}` : ""}`;
}

export function parseTaskTitle(title, prefix = PREFIX) {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc}#(\\d+) (实现|返工|验收)(?: (\\S+))?$`).exec(String(title ?? ""));
  if (!m) return null;
  return { issue: Number(m[1]), kind: KIND_BY_ZH[m[2]], extra: m[3] ?? "" };
}

const SETTLED = new Set(["completed", "failed", "cancelled", "canceled", "abandoned", "stopped", "superseded"]);

/** 还占着并行名额的 worker：Dispatch 没结算、进程也没被证实退出。 */
export function isActive(w) {
  if (SETTLED.has(w.dispatchStatus)) return false;
  return w.projection?.liveness?.verdict !== "exited";
}

/** 交活后还没决定去处的终端（官方 Completion accounting：复用 / 保留 / 回收三选一）。 */
export function isReclaimable(w) {
  return w.terminalState === "reclaimable";
}

/**
 * 纯函数：给定现状，算出本轮的动作。不碰网络，便于离线测试。
 * state = {
 *   lanes, acceptMax,
 *   tasks:   [{ id, task_title, status }],
 *   workers: [{ dispatchId, taskId, dispatchStatus, terminalState, agentTerminalHandle, projection }],
 *   issues:  { [number]: state }   // 只需要 s:* 状态（open issue）
 * }
 */
export function planCompletion(state) {
  const byTask = new Map(state.tasks.map((t) => [t.id, t]));
  const actions = [];
  for (const w of state.workers) {
    const meta = parseTaskTitle(byTask.get(w.taskId)?.task_title);
    if (isReclaimable(w)) {
      // 实现 / 返工交活后先保留：验收 FAIL 时让同一个 agent 接着改（官方「交活后复用同一终端」）。
      const keep = meta && meta.kind !== "accept" && ["review", "accept"].includes(state.issues[meta.issue]);
      actions.push({ op: keep ? "retain" : "release", dispatchId: w.dispatchId, issue: meta?.issue ?? null, kind: meta?.kind ?? null });
    } else if (w.terminalState === "retained" && meta && meta.kind !== "accept") {
      // 保留只为下一轮返工；issue 一旦离开 review/accept/changes（合并、关闭、转人工），就回收，不占内存。
      const st = state.issues[meta.issue];
      if (!["review", "accept", "changes", "doing"].includes(st)) {
        actions.push({ op: "release", dispatchId: w.dispatchId, issue: meta.issue, kind: meta.kind });
      }
    }
  }
  return actions;
}

export function hasLabel(state, issue, label) {
  return ((state.board?.rows ?? []).find((r) => r.number === issue)?.labels ?? []).includes(label);
}

export function countActive(state) {
  const byTask = new Map(state.tasks.map((t) => [t.id, t]));
  let build = 0;
  let accept = 0;
  for (const w of state.workers) {
    if (!isActive(w)) continue;
    const meta = parseTaskTitle(byTask.get(w.taskId)?.task_title);
    if (!meta) continue;
    if (meta.kind === "accept") accept++;
    else build++;
  }
  return { build, accept, freeBuild: Math.max(0, state.lanes - build), freeAccept: Math.max(0, state.acceptMax - accept) };
}

/** 某 issue 最近一个可复用的实现 / 返工终端：已保留、进程还活着。 */
export function reusableTerminal(state, issue) {
  const byTask = new Map(state.tasks.map((t) => [t.id, t]));
  const rows = state.workers.filter((w) => {
    const meta = parseTaskTitle(byTask.get(w.taskId)?.task_title);
    return meta && meta.issue === issue && meta.kind !== "accept" && w.terminalState === "retained" && w.projection?.liveness?.verdict === "live" && w.agentTerminalHandle;
  });
  return rows[0] ?? null; // worker-list 新的在前
}

/** 同一个验收（issue + head）已经建过 Task 就不再建：失败、被停（Orca 记为 blocked）、取消的除外。 */
const REBUILDABLE = new Set(["failed", "blocked", "cancelled", "canceled"]);
export function hasAcceptTask(state, issue, head7) {
  return state.tasks.some((t) => {
    const meta = parseTaskTitle(t.task_title);
    return meta && meta.kind === "accept" && meta.issue === issue && meta.extra === head7 && !REBUILDABLE.has(t.status);
  });
}

/** 收件箱一批消息：纯事实类可以直接 ack；有 question / escalation 就要协调器。 */
export function inboxVerdict(messages) {
  const needs = messages.filter((m) => m.type === "question" || m.type === "escalation");
  return needs.length ? { ack: false, needs } : { ack: true, needs: [] };
}

// ------------------------------------------------------------------ 任务书（官方 Task-spec contract）

/**
 * 项目专属约束：.orca-kit/flow-rules.md 里 `## 验收` / `## 实现` 两节的列表行，原样拼进任务书「约束」。
 * 没有这个文件就是空：通用任务书不带任何项目的端口、红线。
 */
export function projectRules(section, text = null) {
  let src = text;
  if (src == null) {
    try {
      src = readFileSync(join(ROOT, ".orca-kit/flow-rules.md"), "utf8");
    } catch {
      return "";
    }
  }
  const title = section === "accept" ? "验收" : "实现";
  const m = new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(src);
  if (!m) return "";
  return m[1].split("\n").filter((l) => /^- /.test(l)).map((l) => l + "\n").join("");
}

const commonConstraints = () => `- 只改本 worktree 内、工单「涉及」列出的文件；不碰 worktree 以外的任何路径；不改 api 形状、数据库 schema、commands.mjs 的命令定义
- 不改用户全局配置（~/.claude、~/.codex 等）；临时文件放本 worktree 或 TMPDIR
- 不改 issue 的 s:* label（状态由协调器迁移）；不合并 PR、不给自己发通行证
- 完成后必须能通过 npm run ci
- 需要协调器回答才能继续时（口径有歧义、要越出「涉及」范围、缺权限或账号），用任务书前言里给出的 ask 命令提问并等回答；不要自己猜，也不要用本地提问界面（协调器看不到）
- GitHub 交付物（本单要求，直接执行，不用先问）：推送本单分支；用 bin/ghx pr create 开 PR 或更新本单 PR。除此之外不在别的 issue/PR 上发评论；进度、提问、完成都走 orca orchestration
${projectRules("impl")}`;

export function implSpec({ number, title, body, branch }) {
  return `目标：#${number} ${title}

改动：按下面工单的「口径」逐条实现。

约束：
${commonConstraints()}
归属：你在 Orca 为本单新建的 worktree 里工作。先 git fetch origin，再 git switch -c ${branch} origin/main（分支已存在就 git switch ${branch}），只动这个分支。

可观察验收：
- 开 PR，body 含 Closes #${number} 与证据包 YAML（head_sha、acceptance 逐条 status: pass）
- 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome；--body 写三句话：做了什么、发现了什么、还剩什么

工单原文：
${body}`;
}

export function reworkSpec({ number, title, pull, branch, round, commentUrl, commentBody, body }) {
  const conflict = String(commentBody ?? "").startsWith("<!-- agent-merge-conflict -->");
  const task = conflict
    ? `解决 issue #${number} ${title} 的合并冲突（PR #${pull}，原分支 ${branch}）。`
    : `返工 issue #${number} ${title}（PR #${pull}，原分支 ${branch}，第 ${round} 轮）。`;
  const change = conflict
    ? "在原分支拉取并合并 PR 的目标分支（通常为 main），解决评论列出的冲突后提交，推送新 head 供重新验收"
    : "按最近验收意见在原分支继续修改";
  return `目标：${task}

改动：${change}；不新建分支、不新建 issue、不改写历史。

最近评论：${commentUrl}

${conflict ? "合并冲突说明" : "验收意见"}（节选）：
${String(commentBody ?? "").slice(0, 6000)}

约束：
- 在分支 ${branch} 上继续，PR #${pull} 保持同一个；改完 push 到同一分支
${commonConstraints()}
归属：本 worktree；先 git fetch origin，若当前不在 ${branch}，先 git switch ${branch} 并 git pull --ff-only。

可观察验收：
- 更新 PR #${pull} 的 body，含 Closes #${number} 与证据包 YAML（head_sha、acceptance 逐条 status: pass）
- 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome

工单原文：
${body}`;
}

export function acceptSpec({ number, title, pull, head, branch, acc, round }) {
  const ids = acc.length ? acc : ["ACC-example-01"];
  const rows = (status) => ids.map((id) => `  - id: ${id}\n    status: ${status}`).join("\n");
  return `目标：验收 issue #${number} ${title} 的 PR #${pull}（head ${head}）。

改动：不改实现代码，只产出判定。

约束：
- 只按 docs/design/ACCEPTANCE.md 的条目判定（本单：${ids.join(", ")}），条目外的「我觉得」不阻塞 PR
- PR head 落后 main 时，如果某条口径只在 head 上失败、失败来自本 PR 没改过的文件、main 上已修好，且 PR 与 main 的合并状态为 CLEAN，按合并 main 后的结果判定，并在该条 note 里记录两边现象与复现命令；失败来自本 PR 改过的文件时按 head 判定
- 不改实现代码、不合并 PR、不改 s:* label；不看实现方的思考过程，自己跑、留自己的证据
- 需要协调器回答才能继续时，用任务书前言里给出的 ask 命令提问并等回答
${projectRules("accept")}
归属：你和实现方共用本单的 worktree。开始前 git status 必须为空；git fetch origin && git switch --detach ${head}（即 origin/${branch} 的当前 head）；验收完 git switch ${branch} 并保证 git status 为空。

可观察验收（必须逐条做到）：
1. 拉 PR diff 与 body 里的证据包 YAML
2. 逐条比对：${ids.join(", ")}
3. 本地跑 npm run ci
4. 在 PR 留一条评论，按结论复制下面对应的一整块 YAML，acceptance 逐条填写 pass 或 fail；FAIL 时 failed 里为每条失败填写 id、expected、observed、repro

PASS 样例

\`\`\`yaml
verdict: PASS
round: ${round}
head_sha: "${head}"
acceptance:
${rows("pass")}
\`\`\`

FAIL 样例

\`\`\`yaml
verdict: FAIL
round: ${round}
head_sha: "${head}"
acceptance:
${rows("fail")}
failed:
  - id: ${ids[0]}
    expected: "…"
    observed: "…"
    repro:
      - "…"
\`\`\`

5. 判定发出后用 worker_done 结束（无论 PASS / FAIL 都是 --outcome succeeded；只有没能给出判定才 failed），--body 第一句写明 PASS 或 FAIL。不另发 escalation / merge_ready：合并与打回由协调器按判定自动做。`;
}

// ------------------------------------------------------------------ 外部命令

function run(cmd, args, { input, cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", maxBuffer: 64 << 20 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error.message) : "") };
}

/** orca 的 --json 输出前面可能有 keepalive 行；取最后一个完整 JSON 对象。 */
export function lastJson(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* 多段输出 */
  }
  const lines = t.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
}

function orca(args) {
  const r = run("orca", [...args, "--json"]);
  const j = lastJson(r.stdout);
  if (!j || j.ok === false) {
    const why = j?.error ? JSON.stringify(j.error).slice(0, 600) : (r.stderr || r.stdout).slice(0, 600);
    const err = new Error(`orca ${args.slice(0, 2).join(" ")} 失败：${why}`);
    err.receipt = j;
    throw err;
  }
  return j.result ?? j;
}

function agentctl(args) {
  const r = run(process.execPath, [join(ROOT, "bin/agentctl.mjs"), ...args]);
  if (r.code !== 0) throw new Error(`agentctl ${args[0]} 失败（rc=${r.code}）：${(r.stderr || r.stdout).slice(0, 600)}`);
  // 坏判定、补口径这类告警 agentctl 写在 stderr：原样进日志，协调器才看得到。
  for (const line of r.stderr.split("\n").filter((l) => /^\[|⚠|告警/.test(l))) log(`  ⚠ ${line.trim()}`);
  return r.stdout;
}

function agentctlJson(args) {
  return lastJson(agentctl([...args, "--json"])) ?? {};
}

// ------------------------------------------------------------------ 日志

const LOG = process.env.FLOW_LOG ?? join(STATE_DIR, "orca-flow.log");
let QUIET = false;
function log(line) {
  const stamp = new Date().toTimeString().slice(0, 8);
  const text = `[${stamp}] ${line}`;
  if (!QUIET) process.stdout.write(text + "\n");
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, text + "\n");
  } catch {
    /* 日志写不进去不影响派工 */
  }
}

// ------------------------------------------------------------------ 现状

function context() {
  const runFile = process.env.RUN_FILE ?? join(HOME, `.orca/${PROJECT}-run-id`);
  if (!existsSync(runFile)) throw new Error(`没有 Run id 文件 ${runFile}：先在协调器终端 orca orchestration run-use，并把 id 写进去`);
  const runId = readFileSync(runFile, "utf8").trim();
  const run = orca(["orchestration", "run-show", "--id", runId]).run;
  const from = run?.coordinator_handle;
  if (!from) throw new Error(`Run ${runId} 没有协调器句柄：先在协调器终端 run-use`);
  const repoId = process.env.FLOW_REPO_ID ?? repoIdFor(ROOT);
  return { runId, from, repoId };
}

function repoIdFor(path) {
  const repos = orca(["repo", "list"]).repos ?? [];
  // 协调器 worktree 与主仓库同一个 repo：按 git common dir 对上。
  const common = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim().replace(/\/\.git$/, "");
  const hit = repos.find((r) => r.path === common || r.path === path);
  if (!hit) throw new Error(`Orca 里没登记这个仓库（${common}）：orca repo add --path ${common}`);
  return hit.id;
}

function listWorkers(runId) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const r = orca(["orchestration", "worker-list", "--run", runId, ...(cursor ? ["--cursor", cursor] : [])]);
    out.push(...(r.workers ?? []));
    if (!r.page?.hasMore) break;
    cursor = r.page.nextCursor;
  }
  return out;
}

function snapshot(ctx) {
  const tasks = (orca(["orchestration", "task-list", "--run", ctx.runId]).tasks ?? []).filter((t) => parseTaskTitle(t.task_title));
  const workers = listWorkers(ctx.runId);
  const board = lastJson(agentctl(["tick", "--json"])) ?? {};
  const issues = {};
  for (const row of board.rows ?? []) issues[row.number] = row.state;
  return {
    lanes: Number(process.env.FLOW_LANES ?? 2),
    acceptMax: Number(process.env.FLOW_ACCEPT_MAX ?? 1),
    tasks,
    workers,
    issues,
    board,
  };
}

function worktrees() {
  return orca(["worktree", "list"]).worktrees ?? [];
}

/** 找某 issue 的 worktree：先认 Orca 里挂着的 issue 号，再认分支名。 */
function worktreeFor(issue, branch) {
  const all = worktrees();
  const mine = all.filter((w) => w.repoId === undefined || !w.isArchived);
  const linked = mine.find((w) => Number(w.linkedIssue) === issue || (w.linkedItems ?? []).some((l) => l.provider === "github" && l.type === "issue" && Number(l.number) === issue));
  if (linked) return linked;
  const byBranch = branch && mine.find((w) => (w.branch ?? "").replace(/^refs\/heads\//, "") === branch);
  if (byBranch) return byBranch;
  return mine.find((w) => String(w.path ?? "").endsWith(`/issue-${issue}`)) ?? null;
}

// ------------------------------------------------------------------ 动作

function startWorker(ctx, { taskId, placement, channel, label, dryRun }) {
  const target = [];
  if (placement.terminal) target.push("--terminal", placement.terminal);
  else if (channel.agent === "opencode") target.push("--agent", "opencode");
  else target.push("--agent", channel.agent, "--model", channel.model);
  if (placement.worktreeId) target.push("--worktree", `id:${placement.worktreeId}`);
  else if (!placement.terminal) target.push("--worktree", "new-top-level", "--name", placement.name, "--repo", `id:${ctx.repoId}`, "--setup", "run");
  const args = ["orchestration", "worker-start", "--run", ctx.runId, "--from", ctx.from, "--task", taskId, ...target];
  if (dryRun) {
    log(`  [dry-run] orca ${args.join(" ")}`);
    return { dispatchId: "dry-run", worktreeId: placement.worktreeId ?? null };
  }
  const r = orca(args);
  const created = (r.effects ?? []).find((e) => e.kind === "worktree")?.id ?? null;
  const eff = r.launch?.effective;
  log(`  ✓ ${label}：dispatch=${r.dispatchId}${eff ? `（${eff.agent}${eff.model ? `/${eff.model}` : ""}）` : ""}${created ? ` worktree=${created.split("::")[1] ?? created}` : ""}`);
  return { dispatchId: r.dispatchId, worktreeId: created ?? placement.worktreeId ?? null };
}

/** 选通道：沿用 bin/worker-channel.sh 的规则（Sonnet 默认、model:opus/codex/deepseek label、验收固定 DeepSeek）。 */
function chooseChannel(role, labels = [], round = "", { dryRun = false } = {}) {
  const args = ["--role", role];
  if (labels.length) args.push("--labels", labels.join(","));
  if (round !== "") args.push("--round", String(round));
  const r = run(join(ROOT, "bin/worker-channel.sh"), args);
  if (r.code !== 0) throw new Error(`没有可用通道（${role}）：${r.stderr.trim().slice(0, 300)}`);
  const [ch, model, reason] = r.stdout.trim().split("|");
  if (ch === "claude") return { agent: "claude", model, reason, channel: ch };
  if (ch === "codex") return { agent: "codex", model, reason, channel: ch };
  if (ch === "volc" || ch === "qwen") {
    if (dryRun) return { agent: "opencode", model, reason, channel: ch }; // 空跑不改 opencode 配置
    const set = run(join(ROOT, "bin/opencode-model.sh"), [ch, model]);
    if (set.code !== 0) throw new Error(`无法把 opencode 切到 ${ch}/${model}：${set.stderr.trim().slice(0, 300)}`);
    return { agent: "opencode", model, reason, channel: ch };
  }
  throw new Error(`未知通道 ${ch}`);
}

function createTask(ctx, { title, display, spec, deps, dryRun }) {
  if (dryRun) return `dry-${title}`;
  const args = ["orchestration", "task-create", "--run", ctx.runId, "--from", ctx.from, "--task-title", title, "--display-name", display, "--spec", spec];
  if (deps?.length) args.push("--deps", JSON.stringify(deps));
  return orca(args).task.id;
}

function linkWorktree(worktreeId, fields, dryRun) {
  if (!worktreeId || dryRun) return;
  const args = ["worktree", "set", "--worktree", `id:${worktreeId}`];
  if (fields.issue) args.push("--issue", String(fields.issue));
  if (fields.pr) args.push("--pr", String(fields.pr));
  if (fields.status) args.push("--workspace-status", fields.status);
  if (fields.comment) args.push("--comment", fields.comment);
  try {
    orca(args);
  } catch (err) {
    log(`  · 卡片状态没写上（不影响派工）：${err.message.slice(0, 160)}`);
  }
}

// ------------------------------------------------------------------ 一轮

export async function tick({ dryRun = false } = {}) {
  const ctx = context();
  const report = { needsCoordinator: [], dispatched: [], merged: [], errors: [] };
  log(`== tick（Run ${ctx.runId}${dryRun ? "，dry-run" : ""}）==`);

  // 0. 收件箱：纯事实类 ack 掉；有提问 / 升级就留给协调器（不 ack，后面的消息也先不读）。
  try {
    const box = orca(["orchestration", "check", "--run", ctx.runId, "--terminal", ctx.from]);
    const messages = box.messages ?? [];
    if (messages.length) {
      const v = inboxVerdict(messages);
      for (const m of messages) log(`  ← [${m.type}] ${m.subject}`);
      if (v.ack && !dryRun) orca(["orchestration", "check", "--run", ctx.runId, "--terminal", ctx.from, "--ack", box.deliveryId]);
      else if (!v.ack) {
        report.needsCoordinator = v.needs.map((m) => ({ id: m.id, type: m.type, subject: m.subject, body: m.body, delivery: box.deliveryId }));
        log(`  ⚠ 需要协调器：${v.needs.length} 条（delivery=${box.deliveryId}，处理完 reply 并 ack）`);
      }
    }
  } catch (err) {
    log(`  · 读收件箱失败（跳过，不影响派工）：${err.message.slice(0, 200)}`);
  }

  // 1. 机械迁移（doing → review）与合并 / 打回：全在 agentctl，状态驱动，不依赖消息。
  for (const [what, args] of [
    ["迁移", ["tick", "--apply"]],
    ["合并", ["merge", "--pending", ...(dryRun ? ["--dry-run"] : [])]],
  ]) {
    if (dryRun && what === "迁移") continue;
    try {
      const out = agentctl(args).trim();
      for (const line of out.split("\n").filter((l) => /✓|↩|✗ 不合并|已迁移|→/.test(l))) {
        log(`  ${what}：${line.trim()}`);
        if (/✓ 合并/.test(line)) report.merged.push(line.trim());
      }
    } catch (err) {
      report.errors.push(err.message);
      log(`  ✗ ${what}：${err.message.slice(0, 300)}`);
    }
  }

  let state = snapshot(ctx);

  // 2. 交活后的终端：保留（等验收结论，FAIL 时复用）或回收。
  for (const a of planCompletion(state)) {
    if (dryRun) {
      log(`  [dry-run] ${a.op} ${a.dispatchId}（#${a.issue} ${a.kind ?? ""}）`);
      continue;
    }
    try {
      if (a.op === "retain") orca(["orchestration", "worker-retain", "--dispatch", a.dispatchId]);
      else orca(["orchestration", "worker-release", "--dispatch", a.dispatchId]);
      log(`  · ${a.op === "retain" ? "保留" : "回收"} #${a.issue ?? "?"} ${a.kind ? KINDS[a.kind] : ""} 终端（${a.dispatchId}）`);
    } catch (err) {
      log(`  ✗ ${a.op} ${a.dispatchId}：${err.message.slice(0, 200)}`);
    }
  }
  if (!dryRun) state = snapshot(ctx);

  let free = countActive(state);
  log(`  在跑：实现/返工 ${free.build}/${state.lanes}，验收 ${free.accept}/${state.acceptMax}`);

  // 3. 排队放行：s:queued → s:ready（只补空位）。
  if (free.freeBuild > 0) {
    try {
      const out = agentctl(["release-queued", "--free-lanes", String(free.freeBuild), ...(dryRun ? ["--dry-run"] : [])]).trim();
      for (const line of out.split("\n").filter((l) => /#\d+/.test(l))) log(`  放行：${line.trim()}`);
    } catch (err) {
      log(`  ✗ 放行：${err.message.slice(0, 200)}`);
    }
  }

  // 4. 验收：s:review 且当前 head 还没有判定。
  if (free.freeAccept > 0) {
    const queue = agentctlJson(["claim", "--role", "acceptance"]).queue ?? [];
    for (const q of queue) {
      if (free.freeAccept <= 0) break;
      const head7 = String(q.head ?? "").slice(0, 7);
      if (!q.head || hasAcceptTask(state, q.number, head7)) continue;
      try {
        const pr = lastJson(run(join(ROOT, "bin/ghx"), ["pr", "view", String(q.pull), "--json", "headRefName,comments"]).stdout) ?? {};
        const branch = pr.headRefName;
        const round = 1 + (pr.comments ?? []).filter((c) => /^verdict:\s*FAIL/m.test(c.body ?? "")).length;
        const channel = chooseChannel("acceptance", [], "", { dryRun });
        log(`  → 验收 #${q.number}（PR #${q.pull}，head ${head7}，round ${round}，${channel.channel}/${channel.model}）`);
        const taskId = createTask(ctx, {
          title: taskTitle("accept", q.number, head7),
          display: `#${q.number} 验收`,
          spec: acceptSpec({ number: q.number, title: q.title, pull: q.pull, head: q.head, branch, acc: q.acc ?? [], round }),
          dryRun,
        });
        const wt = worktreeFor(q.number, branch);
        // 没有 Orca 登记的本单 worktree 时另建 accept-N：用 issue-N 会和已检出的同名分支撞上。
        const placement = wt ? { worktreeId: wt.id } : { name: `accept-${q.number}` };
        const started = startWorker(ctx, { taskId, placement, channel, label: `验收 #${q.number}`, dryRun });
        linkWorktree(started.worktreeId, { issue: q.number, pr: q.pull, status: "in-review", comment: `验收中（head ${head7}）` }, dryRun);
        report.dispatched.push({ issue: q.number, kind: "accept", dispatchId: started.dispatchId });
        free = { ...free, freeAccept: free.freeAccept - 1 };
      } catch (err) {
        report.errors.push(err.message);
        log(`  ✗ 验收 #${q.number}：${err.message.slice(0, 400)}`);
      }
    }
  }

  // 5. 返工：s:changes → s:doing；优先复用同一个实现 agent 的终端。
  //    by:coordinator 的单由协调器自己返工：不认领，只提醒一次（ACC-harness-orca-08）。
  const selfOwned = Object.entries(state.issues).filter(([n, st]) => st === "changes" && hasLabel(state, Number(n), "by:coordinator"));
  for (const [n] of selfOwned) log(`  ⚠ #${n} 验收打回，是协调器自己实现的单（by:coordinator）：不派返工 agent，等协调器自己改`);
  while (free.freeBuild > 0) {
    const res = agentctlJson(["claim", "--role", "rework", ...(dryRun ? ["--dry-run"] : [])]);
    const c = dryRun ? res.wouldClaim?.[0] : res.claimed;
    for (const b of res.blocked ?? res.wouldBlock ?? []) log(`  ⚠ #${b.number} 返工到顶，转人工：${b.why}`);
    if (!c) break;
    try {
      const spec = reworkSpec({ number: c.number, title: c.title, pull: c.pull, branch: c.branch, round: c.round, commentUrl: c.commentUrl, commentBody: c.commentBody, body: c.body ?? "" });
      const taskId = createTask(ctx, { title: taskTitle("rework", c.number, `r${c.round}`), display: `#${c.number} 返工 r${c.round}`, spec, dryRun });
      const reuse = reusableTerminal(state, c.number);
      let placement;
      let channel = null;
      if (reuse) {
        placement = { terminal: reuse.agentTerminalHandle, worktreeId: null };
        log(`  → 返工 #${c.number} round ${c.round}：复用原 agent 终端（${reuse.dispatchId}）`);
      } else {
        channel = chooseChannel("rework", (state.board.rows ?? []).find((i) => i.number === c.number)?.labels ?? [], c.round, { dryRun });
        const wt = worktreeFor(c.number, c.branch);
        placement = wt ? { worktreeId: wt.id } : { name: `issue-${c.number}` };
        log(`  → 返工 #${c.number} round ${c.round}：新 agent（${channel.channel}/${channel.model}）`);
      }
      const started = startWorker(ctx, { taskId, placement, channel: channel ?? {}, label: `返工 #${c.number}`, dryRun });
      linkWorktree(started.worktreeId, { issue: c.number, pr: c.pull, status: "in-progress", comment: `返工 round ${c.round}` }, dryRun);
      report.dispatched.push({ issue: c.number, kind: "rework", dispatchId: started.dispatchId });
    } catch (err) {
      report.errors.push(err.message);
      log(`  ✗ 返工 #${c.number}：${err.message.slice(0, 400)}，退回 s:changes`);
      if (!dryRun) agentctl(["set", "--issue", String(c.number), "--to", "changes", "--force"]);
    }
    free = { ...free, freeBuild: free.freeBuild - 1 };
    if (dryRun) break;
  }

  // 6. 实现：s:ready → s:doing；Orca 新建 worktree（官方 new-top-level 放置）。
  while (free.freeBuild > 0) {
    const res = agentctlJson(["claim", "--role", "engineer", ...(dryRun ? ["--dry-run"] : [])]);
    for (const s of res.skipped ?? []) log(`  · #${s.number} 跳过：${s.why}`);
    const c = dryRun ? res.wouldClaim?.[0] : res.claimed;
    if (!c) break;
    try {
      const labels = (state.board.rows ?? []).find((i) => i.number === c.number)?.labels ?? [];
      const channel = chooseChannel("engineer", labels, "", { dryRun });
      const branch = `issue-${c.number}`;
      log(`  → 实现 #${c.number} ${c.title}（${channel.channel}/${channel.model}，口径 ${(c.acc ?? c.ids ?? []).join(", ")}）`);
      const taskId = createTask(ctx, { title: taskTitle("impl", c.number), display: `#${c.number} 实现`, spec: implSpec({ number: c.number, title: c.title, body: c.body ?? "", branch }), dryRun });
      const wt = worktreeFor(c.number, branch);
      const started = startWorker(ctx, { taskId, placement: wt ? { worktreeId: wt.id } : { name: branch }, channel, label: `实现 #${c.number}`, dryRun });
      linkWorktree(started.worktreeId, { issue: c.number, status: "in-progress", comment: "实现中" }, dryRun);
      report.dispatched.push({ issue: c.number, kind: "impl", dispatchId: started.dispatchId });
    } catch (err) {
      report.errors.push(err.message);
      log(`  ✗ 实现 #${c.number}：${err.message.slice(0, 400)}，退回 s:ready`);
      if (!dryRun) agentctl(["set", "--issue", String(c.number), "--to", "ready", "--force"]);
    }
    free = { ...free, freeBuild: free.freeBuild - 1 };
    if (dryRun) break;
  }

  if (!report.dispatched.length && !report.needsCoordinator.length) {
    const triage = Object.entries(state.issues).filter(([, s]) => s === "triage").map(([n]) => `#${n}`);
    if (free.build === 0 && free.accept === 0 && triage.length) log(`  · 没有在跑的活；s:triage 里还有 ${triage.join(" ")}（要协调器补口径转 s:queued）`);
  }
  return report;
}

function status() {
  const ctx = context();
  const state = snapshot(ctx);
  const byTask = new Map(state.tasks.map((t) => [t.id, t]));
  const rows = state.workers
    .filter((w) => parseTaskTitle(byTask.get(w.taskId)?.task_title) && (isActive(w) || w.terminalState === "retained" || isReclaimable(w)))
    .map((w) => ({
      task: byTask.get(w.taskId).task_title,
      dispatchId: w.dispatchId,
      stage: w.projection?.stage?.worker,
      liveness: w.projection?.liveness?.verdict,
      terminal: w.terminalState,
      attention: w.projection?.attention?.categories ?? [],
      requiresAction: w.projection?.attention?.requiresAction ?? false,
      nextAction: w.projection?.nextAction?.argv ?? [],
    }));
  return { runId: ctx.runId, active: countActive(state), workers: rows };
}

// ------------------------------------------------------------------ 入口

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // pid 可能被别的进程复用：只认本项目的 watch。
  const cmd = run("ps", ["-o", "command=", "-p", String(pid)]).stdout;
  return cmd.includes(`orca-flow[${PROJECT}]`) || /orca-flow\.mjs/.test(cmd);
}

async function main(argv) {
  const [cmd = "tick"] = argv;
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  if (cmd === "tick") {
    QUIET = json;
    const r = await tick({ dryRun });
    if (json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return r.needsCoordinator.length ? 10 : 0;
  }
  if (cmd === "status") {
    const s = status();
    if (json) process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    else {
      process.stdout.write(`Run ${s.runId}：实现/返工 ${s.active.build}，验收 ${s.active.accept}\n`);
      for (const w of s.workers) process.stdout.write(`  ${w.task}  ${w.dispatchId}  ${w.stage}/${w.liveness}/${w.terminal}${w.requiresAction ? `  ⚠ ${w.attention.join(",")} → ${w.nextAction.join(" ")}` : ""}\n`);
    }
    return 0;
  }
  if (cmd === "watch") {
    // 同一项目只允许一个 watch：两个 watch 会同时认领、把同一单派两次。
    process.title = `orca-flow[${PROJECT}]`;
    const lock = process.env.FLOW_LOCK ?? join(STATE_DIR, "orca-flow.lock");
    const other = existsSync(lock) ? Number(readFileSync(lock, "utf8").trim()) : 0;
    if (other && other !== process.pid && alive(other)) {
      process.stderr.write(`已有 orca-flow watch 在跑：pid=${other}\n`);
      return 14;
    }
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.pid));
    const drop = () => {
      try {
        if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
      } catch {
        /* 已经没了 */
      }
    };
    process.on("exit", drop);
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
    const i = argv.indexOf("--every");
    const every = Math.max(60, Number(i >= 0 ? argv[i + 1] : 180)) * 1000;
    for (;;) {
      try {
        await tick({});
      } catch (err) {
        log(`✗ tick 失败：${err.message.slice(0, 400)}`);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }
  process.stderr.write("用法：node bin/orca-flow.mjs tick|status|watch [--dry-run] [--json] [--every <秒>]\n");
  return 2;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`orca-flow：${err.message}\n`);
      process.exit(1);
    },
  );
}
