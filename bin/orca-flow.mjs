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
//       .orca-kit/flow.json（可选，ACC-harness-orca-09）：
//         { "hooks": { "beforeTick": ["<命令>"…], "beforeMerge": ["<命令>"…] },
//           "release": true,          // false = 不跑 agentctl release-queued（项目用自己的放行，放进 beforeTick）
//           "inbox": "flow",          // "external" = 收件箱归别人（如 automation 里的协调器 agent），tick 不读不 ack
//           "ci": "npm run ci",       // 实现自查与验收要跑的 CI 命令（ACC-harness-orca-10）
//           "settle": true,           // false = 不做 retain / release（watch 不在 Run 所有者终端里跑的项目，ACC-harness-orca-11）
//           "cleanup": true }         // false = 合并后不回收 issue 的 worktree（ACC-harness-orca-12）

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
const STATE_DIR = process.env.FLOW_STATE_DIR ?? join(HOME, `.orca/${PROJECT}-state`);
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

/** 实现 / 返工 worker 还在跑的 issue：这些单不派验收（ACC-harness-orca-18）。 */
export function buildingIssues(state) {
  const byTask = new Map(state.tasks.map((t) => [t.id, t]));
  const busy = new Set();
  for (const w of state.workers) {
    if (!isActive(w)) continue;
    const meta = parseTaskTitle(byTask.get(w.taskId)?.task_title);
    if (meta && meta.kind !== "accept") busy.add(meta.issue);
  }
  return busy;
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

/**
 * 返工放在哪：复用原终端时也要带上本单 worktree——只带 --terminal，Orca 会按 --from（Run 所有者终端）
 * 所在的目录核对，报 terminal_worktree_mismatch（ACC-harness-orca-13）。新 agent 有本单目录就用，没有就新建 issue-N。
 */
export function reworkPlacement(reuse, wt, issue) {
  if (reuse) return { terminal: reuse.agentTerminalHandle, worktreeId: wt?.id ?? null };
  return wt ? { worktreeId: wt.id } : { name: `issue-${issue}` };
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

/** 拉 issue 评论取协调器裁定；GitHub 失败返回空（最坏少带裁定，不阻断派工）。 */
function fetchNotes(issue, since) {
  const r = run(join(ROOT, "bin/ghx"), ["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues/${issue}/comments`]);
  if (r.code !== 0) return "";
  try {
    return coordinatorNotes(JSON.parse(r.stdout).flat(), since ?? "");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ 返工核查（agentctl 支持时才做，ACC-harness-orca-11）
//
// agentctl 的返工认领结果带 bodyHash（trustbridge）＝ 它认 <状态目录>/rework/<issue>.json 这份记录：
// tick 据此判断「返工 worker 还没推新提交」不转 review；worker 结束后 rework-check 决定退回或挂人工。
// 认领结果没有 bodyHash（versekit、market-research）就什么都不写、不调。

const REWORK_DIR = join(STATE_DIR, "rework");

function writeReworkRecord(c, dispatchId) {
  try {
    mkdirSync(REWORK_DIR, { recursive: true });
    writeFileSync(join(REWORK_DIR, `${c.number}.json`), JSON.stringify({ head: c.head, bodyHash: c.bodyHash, dispatch: dispatchId, pull: String(c.pull) }) + "\n");
  } catch (err) {
    log(`  ✗ 返工记录没写上（#${c.number}）：${err.message.slice(0, 160)}`);
  }
}

/** 记录对应的 dispatch 已不在跑（Run 里找不到也算结束）的返工：交给 agentctl rework-check，再删记录。 */
export function settledReworks(records, workers) {
  return records.filter((r) => {
    const w = workers.find((x) => x.dispatchId === r.dispatch);
    return !w || !isActive(w);
  });
}

function reworkCheck(state, dryRun, requeue) {
  if (!existsSync(REWORK_DIR)) return;
  const records = [];
  for (const f of readdirSync(REWORK_DIR)) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    try {
      records.push({ issue: Number(m[1]), file: join(REWORK_DIR, f), ...JSON.parse(readFileSync(join(REWORK_DIR, f), "utf8")) });
    } catch {
      /* 坏文件跳过 */
    }
  }
  for (const r of settledReworks(records, state.workers ?? [])) {
    if (requeue?.has(r.issue)) continue;
    if (dryRun) {
      log(`  [dry-run] 返工 #${r.issue} 已结束，会 rework-check（派工时 head ${String(r.head).slice(0, 7)}）`);
      continue;
    }
    try {
      const out = agentctl(["rework-check", "--issue", String(r.issue), "--head", r.head, "--body-hash", r.bodyHash ?? ""]).trim();
      if (out) log(`  · 返工核查 #${r.issue}：${out.split("\n")[0].slice(0, 200)}`);
      unlinkSync(r.file);
    } catch (err) {
      log(`  ✗ 返工核查 #${r.issue}：${err.message.slice(0, 200)}`);
    }
  }
}

// ------------------------------------------------------------------ 项目配置（.orca-kit/flow.json）

/** 读 .orca-kit/flow.json；没有或写坏都回默认（写坏会在日志里说）。 */
export function flowConfig(text = null) {
  const defaults = { hooks: { beforeTick: [], beforeMerge: [] }, release: true, inbox: "flow", ci: "npm run ci", settle: true, cleanup: true };
  let src = text;
  if (src == null) {
    try {
      src = readFileSync(join(ROOT, ".orca-kit/flow.json"), "utf8");
    } catch {
      return defaults;
    }
  }
  let j;
  try {
    j = JSON.parse(src);
  } catch (err) {
    return { ...defaults, error: `.orca-kit/flow.json 解析失败：${err.message}` };
  }
  const list = (v) => (Array.isArray(v) ? v.filter((c) => typeof c === "string" && c.trim()) : []);
  return {
    hooks: { beforeTick: list(j.hooks?.beforeTick), beforeMerge: list(j.hooks?.beforeMerge) },
    release: j.release !== false,
    inbox: j.inbox === "external" ? "external" : "flow",
    ci: typeof j.ci === "string" && j.ci.trim() ? j.ci.trim() : defaults.ci,
    settle: j.settle !== false,
    cleanup: j.cleanup !== false,
  };
}

/** 跑一个钩子命令（sh -c，仓库根目录）：失败只记日志，不中断本轮。 */
function runHook(stage, cmd, dryRun) {
  if (dryRun) {
    log(`  [dry-run] 钩子 ${stage}：${cmd}`);
    return true;
  }
  const r = spawnSync("sh", ["-c", cmd], { cwd: ROOT, encoding: "utf8", timeout: 30 * 60 * 1000 });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").filter(Boolean).slice(-3).join(" ｜ ").slice(0, 400);
  if (r.status === 0) {
    log(`  · 钩子 ${stage}：${cmd}${tail ? ` → ${tail}` : ""}`);
    return true;
  }
  log(`  ✗ 钩子 ${stage} 失败（rc=${r.status ?? r.signal}）：${cmd}${tail ? ` → ${tail}` : ""}`);
  return false;
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

const commonConstraints = () => `- 只改本 worktree 内、工单「涉及」列出的文件；不碰 worktree 以外的任何路径；不改已有的 API 形状、数据库 schema 和 commands.mjs 里已有的命令定义；口径要求新增的命令、字段、表，可以向后兼容地加（只加不改不删）
- 不改用户全局配置（~/.claude、~/.codex 等）；临时文件放本 worktree 或 TMPDIR
- 不改 issue 的 s:* label（状态由协调器迁移）；不合并 PR、不给自己发通行证
- 完成后必须能通过 ${flowConfig().ci}
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

/**
 * 协调器裁定：上一轮验收评论之后、以「协调器裁定」「协调器：」开头的 issue 评论，最多取最近 3 条，原文带进返工任务书
 * （market-research ACC 同口径，移进通用脚本：ACC-harness-orca-10）。comments 是 GitHub issue 评论数组。
 */
export function coordinatorNotes(comments, since = "") {
  if (!Array.isArray(comments)) return "";
  const out = [];
  for (const c of comments) {
    if (since && String(c.created_at ?? "") <= since) continue;
    const b = String(c.body ?? "").trimStart();
    if (/^协调器(裁定|：|:)/.test(b)) out.push(`${c.html_url ?? ""}\n${String(c.body ?? "").trim()}`);
  }
  return out.slice(-3).join("\n\n");
}

/** agentctl 认领结果里自带的返工原因（trustbridge #737：最近验收之后的评论，含所有者的）。 */
export function reasonText(reasonComments) {
  if (!Array.isArray(reasonComments) || !reasonComments.length) return "";
  return reasonComments.map((c) => `- ${c.author ?? "?"}（${c.createdAt ?? ""}）：\n${c.body ?? ""}`).join("\n\n");
}

export function reworkSpec({ number, title, pull, branch, round, commentUrl, commentBody, body, notes = "", reason = "", lastVerdict = "" }) {
  const conflict = String(commentBody ?? "").startsWith("<!-- agent-merge-conflict -->");
  const task = conflict
    ? `解决 issue #${number} ${title} 的合并冲突（PR #${pull}，原分支 ${branch}）。`
    : `返工 issue #${number} ${title}（PR #${pull}，原分支 ${branch}，第 ${round} 轮）。`;
  const change = conflict
    ? "在原分支拉取并合并 PR 的目标分支（通常为 main），解决评论列出的冲突后提交，推送新 head 供重新验收"
    : "按最近验收意见在原分支继续修改";
  return `目标：${task}

${lastVerdict === "PASS" ? "验收已 PASS，本次返工原因见下方评论。\n\n" : ""}改动：${change}；不新建分支、不新建 issue、不改写历史。

最近评论：${commentUrl}

${conflict ? "合并冲突说明" : "验收意见"}（节选）：
${String(commentBody ?? "").slice(0, 6000)}
${reason ? `\n返工原因（最近一条验收之后的评论）：\n${reason}\n` : ""}${notes ? `\n协调器裁定（上一轮验收之后，原文，优先于工单旧口径）：\n${notes}\n` : ""}
约束：
- 在分支 ${branch} 上继续，PR #${pull} 保持同一个；改完 push 到同一分支
- 口径若在 main 上有修订，先 git merge origin/main
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
  // evidence 每条都要：有的项目（market-research）闸门缺证据就拒绝合并；versekit 解析时忽略它。
  const rows = (status) => ids.map((id) => `  - id: ${id}\n    status: ${status}\n    evidence: "<一行可回查证据：测试名 / 命令及输出；没有证据不得写 pass>"`).join("\n");
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
3. 本地跑 ${flowConfig().ci}
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

function run(cmd, args, { input, cwd = ROOT, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, env, encoding: "utf8", maxBuffer: 64 << 20 });
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
  if (!j || j.ok === false || (args[1] === "worker-start" && r.code !== 0)) {
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
  REPO_ID = repoId;
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

let REPO_ID = null;

/** 只列本仓库的 worktree：Orca 里有多个项目，issue 号会撞（ACC-harness-orca-12）。 */
function worktrees() {
  return (orca(["worktree", "list"]).worktrees ?? []).filter((w) => !REPO_ID || w.repoId === REPO_ID);
}

/** issue 关联：Orca 的 linkedIssue 或 linkedItems 里的 GitHub issue。 */
export function linkedIssueOf(w) {
  if (w.linkedIssue) return Number(w.linkedIssue);
  const it = (w.linkedItems ?? []).find((l) => l.provider === "github" && l.type === "issue");
  return it ? Number(it.number) : null;
}

/**
 * 纯函数：可以考虑回收的 worktree——关联了 issue、不是主仓库、不是脚本自己所在的目录、没有在跑的 worker。
 * 是否真的关闭、目录是否干净，由 cleanupWorktrees 逐个再查。
 */
export function cleanupCandidates(list, { root, busyPaths = [] } = {}) {
  return list.filter((w) => linkedIssueOf(w) && !w.isMainWorktree && w.path !== root && !busyPaths.includes(w.path));
}

const DISPOSABLE_DIRS = new Set(["node_modules", "dist", ".playwright-mcp", ".impeccable"]);

/** 被忽略的路径是不是依赖 / 构建产物 / 缓存：路径里某一级目录正好叫这些名字（任意层级），或文件是 .DS_Store。按整段比，dist-config.json 不算。 */
export function disposable(path) {
  const isDir = path.endsWith("/");
  const parts = path.split("/").filter(Boolean);
  if (parts.at(-1) === ".DS_Store") return true;
  const dirs = isDir ? parts : parts.slice(0, -1);
  return dirs.some((d) => DISPOSABLE_DIRS.has(d));
}

/** 目录里有没有不能丢的东西：未提交改动、不在任何远端的提交、除依赖与构建产物外的被忽略文件。 */
export function dirtyReason(porcelainIgnored, unpushed) {
  const lines = String(porcelainIgnored ?? "").split("\n").filter(Boolean);
  if (lines.some((l) => !l.startsWith("!!"))) return "有未提交的改动";
  if (Number(unpushed) > 0) return `有 ${unpushed} 个提交不在任何远端`;
  const kept = lines.map((l) => l.slice(3)).filter((f) => !disposable(f));
  if (kept.length) return `有被忽略但可能要留的文件（${kept.slice(0, 3).join("、")}${kept.length > 3 ? " 等" : ""}）`;
  return null;
}

/** 合并后回收：issue 已关闭、目录干净、没人在用 → orca worktree rm。不干净就留着，日志说明一次。 */
function cleanupWorktrees(state, dryRun) {
  const busy = [];
  const warned = join(STATE_DIR, "cleanup-warned");
  let seen = "";
  try {
    seen = readFileSync(warned, "utf8");
  } catch {
    /* 没有 */
  }
  for (const w of cleanupCandidates(worktrees(), { root: ROOT, busyPaths: busy })) {
    const n = linkedIssueOf(w);
    if (isActiveIssue(state, n)) continue;
    const st = run(join(ROOT, "bin/ghx"), ["issue", "view", String(n), "--json", "state", "-q", ".state"]);
    if (st.code !== 0 || st.stdout.trim() !== "CLOSED") continue;
    const porcelain = run("git", ["-C", w.path, "status", "--porcelain", "--ignored"]);
    if (porcelain.code !== 0) continue;
    const unpushed = run("git", ["-C", w.path, "rev-list", "--count", "HEAD", "--not", "--remotes"]).stdout.trim() || "0";
    const why = dirtyReason(porcelain.stdout, unpushed);
    if (why) {
      const key = `${w.path}\t${why}`;
      if (!seen.includes(key)) {
        log(`  ⚠ #${n} 已关闭，但 ${w.path} ${why}：不删，确认没用后 orca worktree rm`);
        try {
          appendFileSync(warned, key + "\n");
        } catch {
          /* 只是去重 */
        }
      }
      continue;
    }
    if (dryRun) {
      log(`  [dry-run] 会回收 #${n} 的 worktree ${w.path}`);
      continue;
    }
    try {
      orca(["worktree", "rm", "--worktree", `id:${w.id}`, "--force"]);
      log(`  · 回收 #${n} 的 worktree（已关闭、干净）：${w.path}`);
    } catch (err) {
      log(`  ✗ 回收 worktree ${w.path}：${err.message.slice(0, 200)}`);
    }
  }
}

/** issue 还开着，或它还有没回收的终端（在跑、交活待定、保留中）→ 不动它的目录。 */
export function isActiveIssue(state, n) {
  if (state.issues?.[n]) return true;
  const byTask = new Map((state.tasks ?? []).map((t) => [t.id, t]));
  return (state.workers ?? []).some((w) => {
    if (parseTaskTitle(byTask.get(w.taskId)?.task_title)?.issue !== n) return false;
    if (w.projection?.liveness?.verdict === "exited") return false;
    return !["released", "exited"].includes(w.terminalState);
  });
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

/**
 * worker-start 判为失败但回执里已有 dispatchId 时（例如 outcome_unknown：指令已写入、没看到这一轮开始），
 * 那个 agent 可能已经在跑。先 worker-stop 掉它，再让调用方退回或改派，避免同一 worktree 里出现两个 worker
 * （ACC-harness-orca-19；2026-11-25 #435）。
 */
export function orphanDispatch(receipt) {
  const id = receipt?.dispatchId;
  return typeof id === "string" && id && id !== "dry-run" ? id : null;
}

function fenceOrphan(receipt, label) {
  const id = orphanDispatch(receipt);
  if (!id) return;
  try {
    orca(["orchestration", "worker-stop", "--dispatch", id]);
    log(`  · ${label}：启动结果不明，已停掉 dispatch ${id} 再退回，免得留下孤儿 worker`);
  } catch (err) {
    log(`  ⚠ ${label}：停掉 dispatch ${id} 失败（${err.message.slice(0, 200)}），可能留下孤儿 worker，请协调器检查`);
  }
}

function startWorker(ctx, { taskId, placement, channel, label, dryRun, retryOf }) {
  const target = [];
  if (placement.terminal) target.push("--terminal", placement.terminal);
  else if (channel.agent === "opencode") target.push("--agent", "opencode");
  else target.push("--agent", channel.agent, "--model", channel.model);
  if (placement.worktreeId) target.push("--worktree", `id:${placement.worktreeId}`);
  else if (!placement.terminal) target.push("--worktree", "new-top-level", "--name", placement.name, "--repo", `id:${ctx.repoId}`, "--setup", "run");
  const args = ["orchestration", "worker-start", "--run", ctx.runId, "--from", ctx.from, "--task", taskId, ...target];
  if (retryOf) args.push("--retry-of", retryOf);
  if (dryRun) {
    log(`  [dry-run] orca ${args.join(" ")}`);
    return { dispatchId: "dry-run", worktreeId: placement.worktreeId ?? null };
  }
  let r;
  try {
    r = orca(args);
  } catch (err) {
    fenceOrphan(err.receipt?.result ?? err.receipt, label);
    throw err;
  }
  if (["failed", "outcome_unknown"].includes(r.status) || ["failed", "outcome_unknown"].includes(r.state)) {
    fenceOrphan(r, label);
    const err = new Error(r.lastFailure ?? r.lastError ?? r.error?.message ?? `worker-start: ${r.status ?? r.state}（${r.failedStage ?? r.stage ?? "?"}）`);
    err.receipt = r;
    throw err;
  }
  const created = (r.effects ?? []).find((e) => e.kind === "worktree")?.id ?? null;
  const eff = r.launch?.effective;
  log(`  ✓ ${label}：dispatch=${r.dispatchId}${eff ? `（${eff.agent}${eff.model ? `/${eff.model}` : ""}）` : ""}${created ? ` worktree=${created.split("::")[1] ?? created}` : ""}`);
  return { dispatchId: r.dispatchId, worktreeId: created ?? placement.worktreeId ?? null };
}

// ------------------------------------------------------------------ Codex 额度（ACC-harness-route-02）

/** Codex 额度用完后的冷却文件：「到期 epoch 秒<TAB>到期时间文本」，bin/worker-channel.sh 读同一个文件。 */
export function codexCooldown(stateDir = STATE_DIR, now = Date.now()) {
  try {
    const [ts, ...rest] = readFileSync(join(stateDir, "codex-exhausted"), "utf8").trim().split("\t");
    const until = Number(ts);
    if (!Number.isFinite(until) || until * 1000 <= now) return null;
    return { until, text: rest.join("\t") };
  } catch {
    return null;
  }
}

const pad2 = (n) => String(n).padStart(2, "0");
const fmtLocal = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** 解析「try again at …」里的时间，返回毫秒时间戳；解析不出返回 null。 */
function parseResetTime(text, now) {
  const t = text.trim().replace(/[.。]+$/, "");
  const rel = /^in\s+(?:(\d+)\s*(?:days?|d)\s*)?(?:(\d+)\s*(?:hours?|hrs?|h)\s*)?(?:(\d+)\s*(?:minutes?|mins?|m)\s*)?$/i.exec(t);
  if (rel && (rel[1] || rel[2] || rel[3])) return now + (((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60) + Number(rel[3] ?? 0)) * 60000;
  const full = Date.parse(t.replace(/(\d)(st|nd|rd|th)\b/gi, "$1"));
  if (Number.isFinite(full) && full > now) return full;
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t);
  if (clock) {
    let h = Number(clock[1]);
    if (clock[4]) h = (h % 12) + (/pm/i.test(clock[4]) ? 12 : 0);
    const d = new Date(now);
    d.setHours(h, Number(clock[2]), Number(clock[3] ?? 0), 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

/**
 * 从 Codex worker 的屏幕文本认「用量上限」。只看末尾 40 行；Codex 自带的 `Tip:` 提示行
 * （含 "usage limit" 字样）不算用完（ACC-harness-codex-07）。认到返回 { until(epoch 秒), text }，
 * 解析不出重置时间按 5 小时算；否则 null。
 */
export function codexExhaustion(text, now = Date.now()) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-40);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^(?:[•>■⚠*-]\s*)?Tip:/i.test(l)) continue;
    if (!/(hit|reached|exceeded)\s+(?:your|the)\s+(?:\w+\s+)?usage limit|usage limit\s+(?:reached|exceeded)/i.test(l)) continue;
    // 重置时间可能折到下一行
    const near = /try again/i.test(l) ? l : [l, lines[i + 1] ?? ""].join(" ");
    const m = /try again\s+(at|in)\s+(.+?)\s*$/i.exec(near);
    const ms = m ? parseResetTime(m[1].toLowerCase() === "in" ? `in ${m[2]}` : m[2], now) : null;
    const until = ms ?? now + 5 * 3600 * 1000;
    return { until: Math.floor(until / 1000), text: fmtLocal(new Date(until)) };
  }
  return null;
}

/** 读 worker 屏幕末尾；读不到返回空串（不影响本轮别的事）。 */
function readWorkerTail(dispatchId) {
  try {
    const r = orca(["orchestration", "worker-read", "--dispatch", dispatchId, "--source", "terminal", "--limit", "60"]);
    const tail = r.terminal?.tail;
    return Array.isArray(tail) ? tail.join("\n") : JSON.stringify(r);
  } catch {
    return "";
  }
}

/**
 * 每轮读在跑的 Codex 实现 / 返工 worker 的屏幕：认出用量上限就写 codex-exhausted、停掉它，
 * 同一轮在原 worktree 里改派 Sonnet 接着做（不丢已有提交与改动）。返回改派清单。
 * io 可注入（测试用）：{ read, stop, choose, createTask, start, link }。
 */
export function rerouteExhaustedCodex(state, ctx, { dryRun = false, now = Date.now(), stateDir = STATE_DIR, io = {} } = {}) {
  const f = {
    read: readWorkerTail,
    stop: (id) => orca(["orchestration", "worker-stop", "--dispatch", id]),
    choose: chooseChannel,
    createTask,
    start: startWorker,
    link: linkWorktree,
    ...io,
  };
  const byTask = new Map(state.tasks.map((t) => [t.id, t]));
  const out = [];
  for (const w of state.workers) {
    const task = byTask.get(w.taskId);
    const meta = parseTaskTitle(task?.task_title);
    if (!meta || meta.kind === "accept" || !isActive(w) || w.projection?.provider?.id !== "codex") continue;
    const ex = codexExhaustion(f.read(w.dispatchId), now);
    if (!ex) continue;
    const n = meta.issue;
    if (dryRun) {
      log(`  [dry-run] Codex 额度用完，到 ${ex.text} 为止 → #${n} 改派 Sonnet`);
      continue;
    }
    try {
      const keep = codexCooldown(stateDir, now);
      if (!keep || keep.until < ex.until) {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "codex-exhausted"), `${ex.until}\t${ex.text}\n`);
      }
      f.stop(w.dispatchId);
      let channel = f.choose(meta.kind === "rework" ? "rework" : "engineer", (state.board?.rows ?? []).find((i) => i.number === n)?.labels ?? [], meta.kind === "rework" ? String(parseInt(meta.extra.replace(/^r/, ""), 10) || 1) : "");
      if (channel.agent !== "claude") channel = { agent: "claude", model: "sonnet", reason: "Codex 额度用完，强制 Sonnet", channel: "claude" };
      log(`  ⚠ Codex 额度用完，到 ${ex.text} 为止 → #${n} 改派 Sonnet（${channel.channel}/${channel.model}），原 worktree 接着做`);
      const spec = `${task.spec ?? ""}\n\n【改派说明】上一个 worker（Codex）因额度用完被停掉。本 worktree 里已有它的提交与未提交改动：先 git status / git log 看进度，接着做，不要重做、不要丢弃。`;
      const title = taskTitle(meta.kind, n, meta.kind === "rework" ? `${meta.extra || "r1"}-sonnet` : "sonnet");
      const taskId = f.createTask(ctx, { title, display: `#${n} ${KINDS[meta.kind]}（改派 Sonnet）`, spec, dryRun });
      const worktreeId = w.resource?.worktreeId ?? null;
      const started = f.start(ctx, { taskId, placement: worktreeId ? { worktreeId } : { name: `issue-${n}` }, channel, label: `改派 #${n}`, dryRun });
      f.link(started.worktreeId, { issue: n, status: "in-progress", comment: "Codex 额度用完，改派 Sonnet" }, dryRun);
      out.push({ issue: n, kind: meta.kind, dispatchId: started.dispatchId, from: w.dispatchId });
    } catch (err) {
      log(`  ✗ #${n} Codex 额度用完后的改派失败：${err.message.slice(0, 300)}（下一轮再试）`);
    }
  }
  return out;
}

/** 选通道：沿用 bin/worker-channel.sh 的规则（默认 Codex、额度用完 Sonnet；model:sonnet/neon/opus/deepseek label；验收固定 DeepSeek）。 */
export function chooseChannel(role, labels = [], round = "", { dryRun = false } = {}) {
  const args = ["--role", role];
  if (labels.length) args.push("--labels", labels.join(","));
  if (round !== "") args.push("--round", String(round));
  // 冷却文件与 orca-flow 写的是同一个目录（别的项目各用自己的 <项目>-state）。
  const r = run(join(ROOT, "bin/worker-channel.sh"), args, { env: { ...process.env, STATE_DIR: process.env.STATE_DIR ?? STATE_DIR } });
  if (r.code !== 0) throw new Error(`没有可用通道（${role}）：${r.stderr.trim().slice(0, 300)}`);
  const [ch, model, reason] = r.stdout.trim().split("|");
  if (ch === "claude") return { agent: "claude", model, reason, channel: ch };
  if (ch === "codex") return { agent: "codex", model, reason, channel: ch };
  if (ch === "antigravity") return { agent: "antigravity", model, reason, channel: ch };
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

/** 官方 Completion accounting：交活终端 retain 或 release。只做这一件事，不派工，可以和 watch 并行跑。 */
function settleTerminals(state, dryRun) {
  for (const a of planCompletion(state)) {
    settleTerminal(a, dryRun);
  }
}

function settleTerminal({ op, dispatchId, issue, kind }, dryRun) {
  if (dryRun) {
    log(`  [dry-run] ${op} ${dispatchId}（#${issue} ${kind ?? ""}）`);
    return;
  }
  try {
    orca(["orchestration", `worker-${op}`, "--dispatch", dispatchId]);
    log(`  · ${op === "retain" ? "保留" : "回收"} #${issue ?? "?"} ${kind ? KINDS[kind] : ""} 终端（${dispatchId}）`);
  } catch (err) {
    log(`  ✗ ${op} ${dispatchId}：${err.message.slice(0, 200)}`);
  }
}

const SONNET = { agent: "claude", model: "sonnet", channel: "claude" };
const STARTUP_CHANNEL = { codex: "Codex", antigravity: "Neon", claude: "Sonnet" };

function isStartupFailure(w) {
  return w?.dispatchStatus === "failed" && w.projection?.stage?.detail === "agent_readiness";
}

function inspectStartupFailure(w, channel) {
  const { dispatch, worker, projection } = orca(["orchestration", "worker-show", "--dispatch", w.dispatchId]);
  if (dispatch.status !== "failed" || worker.stage !== "agent_readiness") return null;
  const launch = worker.startOptions?.launch?.effective ?? worker.startOptions?.launch?.requested ?? channel ?? projection?.provider;
  const agent = launch?.agent ?? worker.startOptions?.agent ?? launch?.id;
  if (!Object.hasOwn(STARTUP_CHANNEL, agent) || (agent === "claude" && launch?.model !== "sonnet")) return null;
  return { agent, reason: dispatch.lastFailure ?? worker.lastError ?? "agent_readiness", worktreeId: worker.worktreeId ?? w.resource?.worktreeId };
}

/**
 * 纯函数：从 agentctl 输出里挑要写进流程日志的行。「✗ 不合并 #N：」后面以 `- ` 开头的原因行
 * 并进同一行（用「；」隔开），日志里看得到为什么不合并（ACC-harness-orca-16）。
 */
export function transcribeAgentctl(out) {
  const rows = [];
  let open = null;
  for (const raw of String(out ?? "").split("\n")) {
    const line = raw.trim();
    if (open && /^- /.test(line)) {
      open.reasons.push(line.slice(2).trim());
      continue;
    }
    open = null;
    if (!/✓|↩|✗ 不合并|已迁移|→/.test(line)) continue;
    const row = { line, reasons: [] };
    rows.push(row);
    if (/✗ 不合并/.test(line)) open = row;
  }
  return rows.map((r) => (r.reasons.length ? `${r.line.replace(/[：:]\s*$/, "：")}${r.reasons.join("；")}` : r.line));
}

function coordinatorNotice(report, issue, body) {
  log(`  ⚠ 需要协调器：${body}`);
  report.needsCoordinator.push({ type: "escalation", issue, subject: body, body });
}

// 同一轮共享失败计数和待回滚的 issue。回滚留到派工之后，避免本轮 claim 又拿到同一张单。
function startupRecovery(ctx, report, { dryRun, settle }) {
  const previous = new Map();
  const failures = new Map();
  const avoid = new Set();
  const requeue = new Map();

  function record(issue, w, failure) {
    const key = `${issue}:${failure.agent}`;
    if (avoid.has(failure.agent)) return;
    const earlier = failures.get(key);
    failures.set(key, w.dispatchId);
    const repeated = earlier && earlier !== w.dispatchId;
    if (repeated || (previous.get(issue) ?? []).some((row) => {
      if (row.dispatchId === w.dispatchId) return false;
      try {
        return inspectStartupFailure(row)?.agent === failure.agent;
      } catch (err) {
        log(`  · 检查 #${issue} 更早的失败 ${row.dispatchId}：${err.message.slice(0, 160)}`);
        return false;
      }
    })) {
      avoid.add(failure.agent);
      log(`  · #${issue} 的 ${STARTUP_CHANNEL[failure.agent]} 已启动失败两次，本轮新单停用该通道`);
    }
  }

  function recover(n, w, failure) {
    const detail = `#${n} ${STARTUP_CHANNEL[failure.agent]} 启动失败（${failure.reason}）`;
    if (failure.agent === "claude") {
      coordinatorNotice(report, n, `${detail}→ ${dryRun ? "将退回" : "退回"} s:ready`);
      requeue.set(n, "ready");
      return null;
    }
    if (!failure.worktreeId) {
      coordinatorNotice(report, n, `${detail}，找不到原 worktree，无法改派 Sonnet`);
      return null;
    }
    log(`  ${dryRun ? "[dry-run] " : ""}${detail}→ 改派 Sonnet`);
    try {
      const started = start(n, {
        taskId: w.taskId, retryOf: w.dispatchId, placement: { worktreeId: failure.worktreeId },
        channel: SONNET, label: `改派 #${n}`, dryRun,
      });
      return started && { ...started, rerouted: true };
    } catch (err) {
      report.errors.push(err.message);
      coordinatorNotice(report, n, `${detail} → 改派 Sonnet 未成功（${err.message.slice(0, 300)}）`);
      return null;
    }
  }

  function recoverExisting(state) {
    const byTask = new Map(state.tasks.map((t) => [t.id, parseTaskTitle(t.task_title)]));
    const busy = new Set(state.workers.filter(isActive).map((w) => byTask.get(w.taskId)?.issue));
    for (const w of state.workers.filter(isStartupFailure)) {
      const meta = byTask.get(w.taskId);
      if (!meta || meta.kind === "accept") continue;
      if (!previous.has(meta.issue)) previous.set(meta.issue, []);
      previous.get(meta.issue).push(w);
    }
    const seen = new Set();
    let startedAny = false;
    for (const w of state.workers) { // worker-list 按新到旧排列。
      const meta = byTask.get(w.taskId);
      if (!meta || meta.kind === "accept" || state.issues[meta.issue] !== "doing" || busy.has(meta.issue) || seen.has(meta.issue)) continue;
      seen.add(meta.issue);
      if (!isStartupFailure(w) || hasLabel(state, meta.issue, "hold:human")) continue;
      try {
        const failure = inspectStartupFailure(w);
        if (!failure) continue;
        record(meta.issue, w, failure);
        const started = recover(meta.issue, w, failure);
        if (!started) continue;
        report.dispatched.push({ issue: meta.issue, kind: meta.kind, dispatchId: started.dispatchId, rerouted: true });
        startedAny = true;
        linkWorktree(started.worktreeId, { issue: meta.issue, status: "in-progress", comment: "启动失败，改派 Sonnet" }, dryRun);
        if (!dryRun && meta.kind === "rework") {
          const file = join(REWORK_DIR, `${meta.issue}.json`);
          if (existsSync(file)) {
            const rec = JSON.parse(readFileSync(file, "utf8"));
            if (rec.dispatch === w.dispatchId) writeFileSync(file, JSON.stringify({ ...rec, dispatch: started.dispatchId }) + "\n");
          }
        }
      } catch (err) {
        report.errors.push(err.message);
        coordinatorNotice(report, meta.issue, `#${meta.issue} 核查或处理启动失败时出错（${err.message.slice(0, 300)}）`);
      }
    }
    return startedAny;
  }

  function start(issue, options) {
    try {
      return startWorker(ctx, options);
    } catch (err) {
      const w = listWorkers(ctx.runId).find((row) => row.taskId === options.taskId);
      if (!isStartupFailure(w) || w.dispatchId === options.retryOf) throw err;
      const failure = inspectStartupFailure(w, options.channel);
      if (!failure || (options.retryOf && failure.agent !== "claude")) throw err;
      if (settle && isReclaimable(w)) settleTerminal({ op: "release", dispatchId: w.dispatchId, issue }, dryRun);
      record(issue, w, failure);
      return recover(issue, w, failure);
    }
  }

  function routeNew(issue, channel, originalState) {
    if (!avoid.has(channel.agent) || (channel.agent === "claude" && channel.model !== "sonnet")) return channel;
    if (channel.agent !== "claude" && !avoid.has("claude")) {
      log(`  · #${issue} 本轮停用 ${STARTUP_CHANNEL[channel.agent]} → 改派 Sonnet`);
      return SONNET;
    }
    log(`  · #${issue} 本轮停用 ${STARTUP_CHANNEL[channel.agent]}，退回 s:${originalState}`);
    requeue.set(issue, originalState);
    return null;
  }

  return { recoverExisting, start, routeNew, requeue };
}

function reportOrphanedIssues(state, report, startup) {
  const activeTasks = new Set(state.workers.filter(isActive).map((w) => w.taskId));
  const activeIssues = new Set(state.tasks.filter((t) => activeTasks.has(t.id)).map((t) => parseTaskTitle(t.task_title)?.issue));
  for (const d of report.dispatched) activeIssues.add(d.issue);
  const waiting = (state.board.rows ?? []).filter((r) => r.state === "doing" && !activeIssues.has(r.number) && !startup.requeue.has(r.number));
  // 常规行已经由 agentctl 对过 PR。hold:human 等提前返回的行没有这个信息。
  const unknown = waiting.filter((r) => !["确认在跑", "查停滞", "转 review", "返工中"].includes(r.action));
  let pulls = [];
  if (unknown.length) {
    const response = run(join(ROOT, "bin/ghx"), ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/pulls?state=open&per_page=100"]);
    const pages = lastJson(response.stdout);
    if (response.code === 0 && Array.isArray(pages)) pulls = pages.flat();
    else {
      const error = `查询待巡检单的 PR 失败：${response.stderr.trim().slice(0, 300)}`;
      report.errors.push(error);
      log(`  ✗ ${error}`);
      pulls = null;
    }
  }
  for (const row of waiting) {
    const n = row.number;
    if (row.action === "转 review" || row.action === "返工中") continue;
    if (unknown.includes(row) && (!pulls || pulls.some((pr) =>
      new RegExp(`(close[sd]?|fix(es|ed)?|resolve[sd]?)\\s+#${n}\\b`, "i").test(pr.body ?? "") ||
      new RegExp(`(^|[/_-])issue-${n}([/_-]|$)`, "i").test(pr.head?.ref ?? "")))) continue;
    coordinatorNotice(report, n, `#${n} 在 s:doing 但没人在做`);
  }
}

export async function tick({ dryRun = false } = {}) {
  const ctx = context();
  const report = { needsCoordinator: [], dispatched: [], merged: [], errors: [] };
  log(`== tick（Run ${ctx.runId}${dryRun ? "，dry-run" : ""}）==`);
  const cfg = flowConfig();
  const startup = startupRecovery(ctx, report, { dryRun, settle: cfg.settle });
  if (cfg.error) log(`  ✗ ${cfg.error}（按默认配置跑）`);
  for (const cmd of cfg.hooks.beforeTick) if (!runHook("beforeTick", cmd, dryRun)) report.errors.push(`beforeTick: ${cmd}`);

  // 0. 收件箱：纯事实类 ack 掉；有提问 / 升级就留给协调器（不 ack，后面的消息也先不读）。
  if (cfg.inbox === "flow") try {
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
    if (what === "合并") for (const cmd of cfg.hooks.beforeMerge) if (!runHook("beforeMerge", cmd, dryRun)) report.errors.push(`beforeMerge: ${cmd}`);
    try {
      const out = agentctl(args).trim();
      for (const line of transcribeAgentctl(out)) {
        log(`  ${what}：${line.trim()}`);
        if (/✓ 合并/.test(line)) report.merged.push(line.trim());
      }
    } catch (err) {
      report.errors.push(err.message);
      log(`  ✗ ${what}：${err.message.slice(0, 300)}`);
    }
  }

  let state = snapshot(ctx);

  // 2. 交活后的终端：保留（等验收结论，FAIL 时复用）或回收。settle:false 的项目由 Run 所有者跑 `orca-flow settle`。
  if (cfg.settle) settleTerminals(state, dryRun);
  if (!dryRun) state = snapshot(ctx);
  if (startup.recoverExisting(state) && !dryRun) state = snapshot(ctx);
  reworkCheck(state, dryRun, startup.requeue);
  // Codex 额度用完：写冷却、停掉、同一轮改派 Sonnet（ACC-harness-route-02）。改派的 worker 占原来的名额。
  {
    const rerouted = rerouteExhaustedCodex(state, ctx, { dryRun });
    report.dispatched.push(...rerouted.map((r) => ({ issue: r.issue, kind: r.kind, dispatchId: r.dispatchId, rerouted: true })));
    if (rerouted.length) state = snapshot(ctx);
  }
  reportOrphanedIssues(state, report, startup);
  if (flowConfig().cleanup) cleanupWorktrees(state, dryRun);

  let free = countActive(state);
  log(`  在跑：实现/返工 ${free.build}/${state.lanes}，验收 ${free.accept}/${state.acceptMax}`);

  // 3. 排队放行：s:queued → s:ready（只补空位）。项目用自己的放行（flow.json release:false）就跳过。
  if (cfg.release && free.freeBuild > 0) {
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
      if (buildingIssues(state).has(q.number)) {
        log(`  · #${q.number} 跳过验收：实现 / 返工 worker 还在跑，等它交活`);
        continue;
      }
      try {
        const pr = lastJson(run(join(ROOT, "bin/ghx"), ["pr", "view", String(q.pull), "--json", "headRefName,comments"]).stdout) ?? {};
        const branch = pr.headRefName;
        const round = 1 + (pr.comments ?? []).filter((c) => /^verdict:\s*FAIL/m.test(c.body ?? "")).length;
        const channel = chooseChannel("acceptance", (state.board.rows ?? []).find((i) => i.number === q.number)?.labels ?? [], "", { dryRun });
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
      const spec = reworkSpec({ number: c.number, title: c.title, pull: c.pull, branch: c.branch, round: c.round, commentUrl: c.commentUrl, commentBody: c.commentBody, body: c.body ?? "", notes: c.reasonComments ? "" : fetchNotes(c.number, c.commentCreatedAt), reason: reasonText(c.reasonComments), lastVerdict: c.lastVerdict ?? "" });
      const taskId = createTask(ctx, { title: taskTitle("rework", c.number, `r${c.round}`), display: `#${c.number} 返工 r${c.round}`, spec, dryRun });
      let reuse = reusableTerminal(state, c.number);
      // 原终端是 Codex、而 Codex 正在冷却：复用只会立刻再撞上限，直接起新 agent（走 Sonnet）。
      if (reuse?.projection?.provider?.id === "codex" && codexCooldown()) {
        log(`  · #${c.number} 原终端是 Codex，额度冷却中，不复用`);
        reuse = null;
      }
      const wt = worktreeFor(c.number, c.branch);
      let started;
      if (reuse) {
        log(`  → 返工 #${c.number} round ${c.round}：复用原 agent 终端（${reuse.dispatchId}）`);
        try {
          started = startup.start(c.number, { taskId, placement: reworkPlacement(reuse, wt, c.number), channel: reuse.projection?.provider ?? {}, label: `返工 #${c.number}`, dryRun });
        } catch (err) {
          // 复用不成（终端已不在本单目录、已退出等）：回收它，同一轮改派新 agent，不把单子来回迁移（ACC-harness-orca-13）。
          log(`  ⚠ 复用 #${c.number} 原终端失败（${err.message.slice(0, 200)}），回收它，改派新 agent`);
          if (!dryRun) {
            try {
              orca(["orchestration", "worker-release", "--dispatch", reuse.dispatchId]);
            } catch {
              /* 回收失败不挡新派 */
            }
          }
        }
      }
      if (started === undefined) {
        const selected = chooseChannel("rework", (state.board.rows ?? []).find((i) => i.number === c.number)?.labels ?? [], c.round, { dryRun });
        const channel = startup.routeNew(c.number, selected, "changes");
        if (channel) {
          log(`  → 返工 #${c.number} round ${c.round}：新 agent（${channel.channel}/${channel.model}）`);
          started = startup.start(c.number, { taskId, placement: reworkPlacement(null, wt, c.number), channel, label: `返工 #${c.number}`, dryRun });
        }
      }
      if (started) {
        linkWorktree(started.worktreeId, { issue: c.number, pr: c.pull, status: "in-progress", comment: `返工 round ${c.round}` }, dryRun);
        report.dispatched.push({ issue: c.number, kind: "rework", dispatchId: started.dispatchId, ...(started.rerouted && { rerouted: true }) });
        if (c.bodyHash && !dryRun) writeReworkRecord(c, started.dispatchId);
      }
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
      const selected = chooseChannel("engineer", labels, "", { dryRun });
      const channel = startup.routeNew(c.number, selected, "ready");
      if (channel) {
        const branch = `issue-${c.number}`;
        log(`  → 实现 #${c.number} ${c.title}（${channel.channel}/${channel.model}，口径 ${(c.acc ?? c.ids ?? []).join(", ")}）`);
        const taskId = createTask(ctx, { title: taskTitle("impl", c.number), display: `#${c.number} 实现`, spec: implSpec({ number: c.number, title: c.title, body: c.body ?? "", branch }), dryRun });
        const wt = worktreeFor(c.number, branch);
        const started = startup.start(c.number, { taskId, placement: wt ? { worktreeId: wt.id } : { name: branch }, channel, label: `实现 #${c.number}`, dryRun });
        if (started) {
          linkWorktree(started.worktreeId, { issue: c.number, status: "in-progress", comment: "实现中" }, dryRun);
          report.dispatched.push({ issue: c.number, kind: "impl", dispatchId: started.dispatchId, ...(started.rerouted && { rerouted: true }) });
        }
      }
    } catch (err) {
      report.errors.push(err.message);
      log(`  ✗ 实现 #${c.number}：${err.message.slice(0, 400)}，退回 s:ready`);
      if (!dryRun) agentctl(["set", "--issue", String(c.number), "--to", "ready", "--force"]);
    }
    free = { ...free, freeBuild: free.freeBuild - 1 };
    if (dryRun) break;
  }

  if (!dryRun) for (const [issue, to] of startup.requeue) {
    try {
      // doing → ready 是派工失败的正常迁移。仅通道本轮停用而未启动的返工退回 changes。
      agentctl(["set", "--issue", String(issue), "--to", to, ...(to === "changes" ? ["--force"] : [])]);
    } catch (err) {
      report.errors.push(err.message);
      coordinatorNotice(report, issue, `#${issue} 退回 s:${to} 失败（${err.message.slice(0, 300)}）`);
    }
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
  if (cmd === "settle") {
    // 给 watch 不在 Run 所有者终端里的项目（flow.json settle:false）：所有者处理完收件箱后跑这一条收尾。
    const ctx = context();
    log(`== settle（Run ${ctx.runId}${dryRun ? "，dry-run" : ""}）==`);
    settleTerminals(snapshot(ctx), dryRun);
    return 0;
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
    // 每轮起一个子进程跑 tick：main 更新（含 beforeTick 里的 pull）后下一轮就用新代码，不用重启 watch。
    for (;;) {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "tick"], {
        cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], timeout: 60 * 60 * 1000, env: process.env,
      });
      if (r.error || (r.status !== 0 && r.status !== 10)) log(`✗ tick 子进程异常退出（rc=${r.status ?? r.signal}${r.error ? `，${r.error.message}` : ""}）`);
      await new Promise((res) => setTimeout(res, every));
    }
  }
  process.stderr.write("用法：node bin/orca-flow.mjs tick|settle|status|watch [--dry-run] [--json] [--every <秒>]\n");
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
