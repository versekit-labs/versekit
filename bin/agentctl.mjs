#!/usr/bin/env node
// agentctl —— 多 agent 协作的协调器。
//
// 为什么需要它：docs/AGENT-COLLAB.md 定义了状态机（s:* label）与接力规则，但
// "谁该动、为什么"如果靠人肉判断，两个 agent 就会互相等，或者同时动。
// 这个脚本把判断变成确定性的：同样的工单状态，永远算出同样的结论。
//
// 写操作只有三处，且都能被机器复核：
//   - tick --apply   只做 doing → review 这类机械迁移
//   - claim          先删 s:ready 再写 s:doing（原子抢单）；口径不合格不抢
//   - merge          双门禁通过后 squash 合并（verdict/head_sha/ACC/CI 四道校验）
// 另外 reject 负责把人工验收意见变成结构化 FAIL 并回原 PR——不新建 issue。
// 不在合法迁移表里的迁移一律拒绝（`set --force` 才放行且告警）。
//
// 设计上的三个硬约束（来自 AGENT-COLLAB §3 / §6）：
//
//   1. label 是唯一事实源。运行态（谁在跑、跑到哪一步）不进 label，
//      所以这里也不猜测"某个 agent 是不是还活着"——那是 Orca 的事。
//   2. 一次 tick 的请求数有上界（2 个），因为本仓库的 API 配额可能低到 60/h。
//      宁可少查，不可把配额烧光后静默停摆（静默失败 = P0）。
//   3. 每个跳过都要给出原因。没有原因的输出等于没有输出。
//
// 用法：
//   node bin/agentctl.mjs tick             # 人类可读
//   node bin/agentctl.mjs tick --json      # 给编排器消费
//   node bin/agentctl.mjs tick --verbose   # 附带每个 issue 的原始 label
//
// 退出码：0 正常（无论有没有活）；1 配置/网络/API 出错。
// **不把"有活要干"当成失败**——那会让 cron/循环误判。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- 状态与动作
//
// 状态集合必须与 docs/AGENT-COLLAB.md §3 的表逐字一致。
// 多一个状态或改一个名字，label 就会漂；漂了以后脚本只会"认不出来"，不会报错，
// 所以这里显式列全，未知状态一律当成异常暴露出来。

const STATES = ["triage", "ready", "doing", "review", "changes", "accept", "blocked", "done"];

/** 每个状态对应"下一步该谁动"。角色不是模型名，是职责——换模型不影响判断。 */
const NEXT = {
  triage: { actor: "human", action: "补口径", why: "验收条目还没写清楚" },
  ready: { actor: "engineer", action: "派工实现", why: "口径齐，且没有进行中的 PR" },
  doing: { actor: "engineer", action: "等待中", why: "已有 agent 在跑（运行态在 Orca，不在 label）" },
  review: { actor: "acceptance", action: "派工验收", why: "PR 已开，等逐条比对验收条目" },
  changes: { actor: "engineer", action: "派工返工", why: "上轮打回，同一分支继续改" },
  accept: { actor: "coordinator", action: "合并", why: "验收通过且门禁全绿" },
  blocked: { actor: "human", action: "需要人", why: "状态机已停下，等人决策" },
  done: { actor: "coordinator", action: "应收口", why: "应已随 PR 合并关闭" },
};

/**
 * 合法迁移表。**只有这里列出的边才允许走。**
 *
 * 为什么要把这张表写死在脚本里：agent 能改 label，就等于 agent 能自己宣布
 * "验收通过"或"合并完成"。提示词约束不了这件事，只有"脚本拒绝并留事件"
 * 才能约束。`set --force` 是给补偿动作留的逃生口，会打印一行告警。
 *
 * 三条容易被忽略但必须存在的边：
 *   - doing → ready：派工失败回滚（worker 起不来）
 *   - accept → changes：验收方/人在合并前发现新问题，回原分支改，不新建 issue
 *   - done → changes：里程碑验收或事后复验打回，先 reopen 原 issue，同样不新建 issue
 */
const TRANSITIONS = {
  triage: ["ready", "blocked"],
  ready: ["doing", "triage", "blocked"],
  doing: ["review", "ready", "blocked"],
  review: ["changes", "accept", "blocked"],
  changes: ["doing", "blocked"],
  accept: ["done", "changes", "blocked"],
  blocked: ["triage", "ready", "doing", "review", "changes", "accept"],
  done: ["changes"],
};

function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------- 口径（ACC 条目）
//
// "口径齐"不能靠人肉判断：issue 正文里引用的每个 ACC-* 都必须能在
// docs/design/ACCEPTANCE.md 里 grep 到。引用不到 = 口径没写全 = 不该派工。
// 这条校验只读本地文件，不花 API 配额。

const ACCEPTANCE_FILE = join(ROOT, "docs/design/ACCEPTANCE.md");

let acceptanceCache = null;
function acceptanceIds() {
  if (acceptanceCache) return acceptanceCache;
  if (!existsSync(ACCEPTANCE_FILE)) return (acceptanceCache = new Set());
  const text = readFileSync(ACCEPTANCE_FILE, "utf8");
  acceptanceCache = new Set((text.match(/ACC-[A-Za-z0-9_-]+/g) ?? []).map((s) => s.replace(/[.,;:]+$/, "")));
  return acceptanceCache;
}

/** issue 正文里引用的 ACC id（去重，保持出现顺序）。 */
function issueAccIds(body) {
  const seen = new Set();
  const out = [];
  for (const id of (body ?? "").match(/ACC-[A-Za-z0-9_-]+/g) ?? []) {
    const norm = id.replace(/[.,;:]+$/, "");
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * 派工前的口径校验。返回 { ok, ids, why }。
 * 三种失败都要说清"缺什么"，否则 coordinator 只看到"跳过"会当成偶发。
 */
function validateScope(issue) {
  const ids = issueAccIds(issue.body);
  if (ids.length === 0) {
    return { ok: false, ids, why: "正文没有任何 ACC-* 验收条目 id（口径未定义，不该派工）" };
  }
  const known = acceptanceIds();
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    return { ok: false, ids, why: `引用了 ACCEPTANCE.md 里不存在的条目：${missing.join(", ")}` };
  }
  return { ok: true, ids, why: `引用 ${ids.length} 条口径` };
}

// ---------------------------------------------------------------- 认证

/** 从 .pi/gh-account 取账号名，交给 gh 换 token；不自己解析 hosts.yml。 */
function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  let account = "";
  try {
    account = execFileSync("cat", [join(ROOT, ".pi/gh-account")], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "读不到 .pi/gh-account，也没有 GH_TOKEN。\n" +
      "  修法：echo <账号名> > .pi/gh-account，或 export GH_TOKEN=...",
    );
  }
  try {
    return execFileSync("gh", ["auth", "token", "--user", account], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      `gh 拿不到账号 ${account} 的 token。\n` +
      `  修法：gh auth status 看该账号是否有效；不要用 gh auth switch（会污染别处）。`,
    );
  }
}

// ---------------------------------------------------------------- 仓库与 API

/** 从 git remote 解析 owner/repo：换仓库地址时不用改代码。 */
function resolveRepo() {
  const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    cwd: ROOT,
  }).trim();
  const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
  if (!m) throw new Error(`remote.origin.url 不是 GitHub 地址：${url}`);
  return { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}` };
}

// 测试时允许指向本地 mock；生产不设该变量就走 GitHub。
const API = process.env.AGENTCTL_API_BASE || "https://api.github.com";
let TOKEN = "";

/** 唯一的出网口。所有请求都走这里，才能统一计数与报错。 */
async function api(path, { params, method = "GET", body } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `token ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "versekit-agentctl",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "-1");
  const limit = Number(res.headers.get("x-ratelimit-limit") ?? "-1");
  if (!res.ok) {
    // 失败必须留现场：状态码 + GitHub 的原话 + 这条路径。
    const text = await res.text();
    throw new Error(`${res.status} ${method} ${path}\n  ${text.slice(0, 300)}`);
  }
  return { data: await res.json(), remaining, limit };
}

// ---------------------------------------------------------------- 读取工单

/**
 * 拉一次全景：open issues（剔除 PR）+ open PR。
 * 两个请求是上界——本仓库配额可能只有 60/h，一次 tick 不能更贪心。
 */
async function loadBoard({ owner, repo }) {
  const [issuesRes, pullsRes] = await Promise.all([
    api(`/repos/${owner}/${repo}/issues`, { params: { state: "open", per_page: "100" } }),
    api(`/repos/${owner}/${repo}/pulls`, { params: { state: "open", per_page: "100" } }),
  ]);

  // GitHub 的 /issues 会把 PR 也混进来，靠 pull_request 字段剔除。
  const issues = issuesRes.data.filter((i) => !i.pull_request);
  const pulls = pullsRes.data;

  return {
    issues,
    pulls,
    quota: { remaining: Math.min(issuesRes.remaining, pullsRes.remaining), limit: issuesRes.limit },
  };
}

// ---------------------------------------------------------------- 状态判定

/** 取出唯一的状态 label。零个或多个都算异常，必须让人看见。 */
function readState(issue) {
  const names = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const states = names.filter((n) => n.startsWith("s:")).map((n) => n.slice(2));
  const hold = names.includes("hold:human");
  if (states.length === 0) return { state: null, hold, names, problem: "没有任何 s:* 状态" };
  if (states.length > 1) return { state: states.at(-1), hold, names, problem: `同时有多个状态：${states.join(", ")}` };
  return { state: states[0], hold, names, problem: null };
}

/** 找出引用该 issue 的 PR：认 body 里的 #N，也认分支名里的 issue-N。 */
function findPull(pulls, issue) {
  const n = issue.number;
  const byBody = pulls.find((p) => new RegExp(`(close[sd]?|fix(es|ed)?|resolve[sd]?)\\s+#${n}\\b`, "i").test(p.body ?? ""));
  if (byBody) return byBody;
  return pulls.find((p) => new RegExp(`(^|[/_-])issue-${n}([/_-]|$)`, "i").test(p.head?.ref ?? "")) ?? null;
}

/**
 * 决策表。**这是整个脚本唯一的判断逻辑**，改规则只改这里。
 * 返回的 action 是"该谁动"，不是"已经动了"——本脚本不产生副作用。
 */
function decide(issue, pulls, { now = Date.now() } = {}) {
  const { state, hold, problem } = readState(issue);

  if (hold) {
    return { actor: "human", action: "冻结中", why: "hold:human：调度器不得改动此 issue", blocked: true };
  }
  if (problem) {
    return { actor: "human", action: "修状态", why: problem, blocked: true };
  }
  if (!STATES.includes(state)) {
    return { actor: "human", action: "修状态", why: `未知状态 s:${state}`, blocked: true };
  }

  const pull = findPull(pulls, issue);
  const base = NEXT[state];

  // 口径不合格的 issue 派出去也只能猜。先纠正，再谈派工——
  // 这一步同时挡掉"引用了一个不存在的 ACC id"这种看似齐活的情况。
  if (state === "ready") {
    const scope = validateScope(issue);
    if (!scope.ok) return { actor: "human", action: "补口径", why: scope.why, blocked: true };
  }

  // 状态与现场不一致时，先纠正认知，再谈派工。这几种情况都是"label 说一套、实际是另一套"，
  // 直接派工会让 agent 对着错误的前提干活。
  if (state === "doing" && !pull) {
    const ageMin = Math.round((now - Date.parse(issue.updated_at)) / 60000);
    if (ageMin > 90) {
      return { actor: "human", action: "查停滞", why: `s:doing 但无 PR，且 ${ageMin} 分钟无更新`, blocked: true };
    }
    return { ...base, actor: "engineer", action: "确认在跑", why: "s:doing 且尚无 PR（正常）" };
  }

  // 有 PR 的 doing 不该继续挂着——这是最容易漏的一步：agent 交了 PR 但忘了推状态，
  // 流程就停在"实现中"，验收方永远等不到。**由协调器推，不由实现方推**，
  // 因为"我完成了"这件事必须由第三方确认，否则就是自证。
  if (state === "doing" && pull) {
    return {
      actor: "coordinator",
      action: "转 review",
      why: `PR #${pull.number} 已开，实现阶段结束`,
      transition: { from: "s:doing", to: "s:review" },
      blocked: false,
    };
  }

  if (state === "review" && !pull) {
    return { actor: "human", action: "修状态", why: "s:review 但找不到对应 PR", blocked: true };
  }
  if (state === "accept" && !pull) {
    return { actor: "human", action: "修状态", why: "s:accept 但找不到对应 PR", blocked: true };
  }
  if (state === "done") {
    return { actor: "coordinator", action: "关闭 issue", why: "s:done 但 issue 仍开着", blocked: false };
  }

  // 带上现场证据，让人一眼能核对。
  const withPull = pull ? { ...base, why: `${base.why}（PR #${pull.number} · ${pull.draft ? "草稿" : pull.head.sha.slice(0, 7)}）` } : base;
  return { ...withPull, blocked: state === "blocked" };
}

// ---------------------------------------------------------------- 输出

function render({ repo, rows, quota, verbose, transitions = [], applied = false }) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const lines = [];
  lines.push(`agentctl tick   ${repo.full}   ${stamp} UTC`);
  lines.push("─".repeat(64));

  if (rows.length === 0) {
    lines.push("  没有 open issue。");
  } else {
    const w = Math.max(...rows.map((r) => String(r.number).length), 2);
    for (const r of rows) {
      const tag = r.state ? `s:${r.state}` : "s:<none>";
      lines.push(
        ` #${String(r.number).padStart(w)}  ${tag.padEnd(11)} ${r.actor.padEnd(12)} ${r.action}`,
      );
      lines.push(`       └ ${r.why}`);
      if (verbose) lines.push(`       └ labels: ${r.labels.join(", ") || "（空）"}`);
      if (r.url) lines.push(`       └ ${r.url}`);
    }
  }

  const byActor = rows.reduce((m, r) => ((m[r.actor] = (m[r.actor] ?? 0) + 1), m), {});
  lines.push("─".repeat(64));
  lines.push(
    "  " +
      (Object.entries(byActor)
        .map(([a, n]) => `${a} ${n}`)
        .join(" · ") || "无") +
      `   |   配额 ${quota.remaining}/${quota.limit}`,
  );
  if (quota.remaining >= 0 && quota.remaining < 10) {
    lines.push("  ⚠ 配额不足 10，下一轮会被限流——降低 tick 频率或换认证方式。");
  }

  // 状态迁移单独一段：只读时显示"会改什么"，--apply 时显示"改成了什么"。
  // 两者共用同一条代码路径，行文用词区分，避免演练与实战不一致。
  if (transitions.length) {
    lines.push("");
    lines.push(applied ? "  已迁移：" : "  本轮会迁移（加 --apply 才执行）：");
    for (const t of transitions) {
      const mark = { changed: "✓", "would-change": "·", skipped: "−", failed: "✗" }[t.status] ?? "?";
      const tail = t.why ? `  （${t.why}）` : "";
      lines.push(`   ${mark} #${t.number}  ${t.from} → ${t.to}${tail}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- 写状态

/**
 * 执行状态迁移。**这是本文件唯一会改变外部世界的地方。**
 *
 * 安全设计：
 *   - 只执行决策里带 transition 的行；其余（human / engineer / acceptance）一律不碰。
 *   - 先删旧 label 再加新的。删除时若返回 404，说明状态已被别人改过——跳过而不是硬写，
 *     这比"覆盖"安全：覆盖会掩盖并发冲突，跳过会把冲突暴露出来。
 *   - 单条失败不中断其余，最后汇总；有任何失败就返回非零退出码。
 *   - 幂等：重复跑同一轮，因为源 label 已经没了，第二次会全部 skip。
 */
async function applyTransitions(repo, rows, { dryRun }) {
  const todo = rows.filter((r) => r.transition);
  const results = [];

  for (const row of todo) {
    const { from, to } = row.transition;
    if (dryRun) {
      results.push({ number: row.number, from, to, status: "would-change" });
      continue;
    }
    const base = `/repos/${repo.owner}/${repo.repo}/issues/${row.number}/labels`;
    try {
      await api(`${base}/${encodeURIComponent(from)}`, { method: "DELETE" });
    } catch (err) {
      if (/^404 /.test(err.message)) {
        results.push({ number: row.number, from, to, status: "skipped", why: "源状态已不存在（并发修改）" });
        continue;
      }
      results.push({ number: row.number, from, to, status: "failed", why: err.message });
      continue;
    }
    try {
      await api(base, { method: "POST", body: { labels: [to] } });
      results.push({ number: row.number, from, to, status: "changed" });
    } catch (err) {
      // 旧 label 已删、新 label 没加上，是最糟的中间态：必须喊出来并建议人工修复。
      results.push({
        number: row.number, from, to, status: "failed",
        why: `${err.message}\n  ⚠ 已移除 ${from} 但未能加上 ${to}，issue 现在无状态，请手工修复`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------- 认领（抢单）

/**
 * 认领一个 issue。**这是整套协作的原子操作。**
 *
 * 为什么必须原子：两个 engineer 同时看中同一个 issue，如果先查后改，两边都会认为
 * "它是我的"。这里用「先删 s:ready」当锁——只有删成功的那个赢，另一个收到 404 就换下一个。
 * 这比加 claimed 字段可靠：label 本身就是状态，不存在两份真相。
 */
async function claimIssue(repo, issue, from = "ready", to = "doing") {
  const base = `/repos/${repo.owner}/${repo.repo}/issues/${issue.number}/labels`;
  try {
    await api(`${base}/${encodeURIComponent(`s:${from}`)}`, { method: "DELETE" });
  } catch (err) {
    if (/^404 /.test(err.message)) return { ok: false, why: "被抢了" };
    throw err;
  }
  try {
    await api(base, { method: "POST", body: { labels: [`s:${to}`] } });
  } catch (err) {
    // 锁已拿、状态没写上：最危险的中间态，必须让调用方知道 issue 现在无状态。
    throw new Error(
      `认领 #${issue.number} 时已移除 s:${from}，但没能加上 s:${to}。\n` +
      `  issue 现在无状态，请手工加 s:${to} 或 s:blocked。\n  原因：${err.message}`,
    );
  }
  return { ok: true };
}

/** 给 issue 加冻结标记。3 轮封顶后必须停下来等人，而不是继续自动派工。 */
async function addHumanHold(repo, number) {
  await api(`/repos/${repo.owner}/${repo.repo}/issues/${number}/labels`, {
    method: "POST",
    body: { labels: ["hold:human"] },
  });
}

/**
 * 返工认领（role=rework）。
 *
 * 为什么单独一个角色：`s:changes` 与 `s:ready` 的派工输入完全不同——
 * 返工要回到**原 PR 的原分支**，任务书必须引用**最近一条验收 FAIL 评论**，
 * 而且轮次到顶后不能继续派。把它塞进 engineer 会让"新活"和"返工"抢同一个队列。
 *
 * 与 engineer 一样用「先删旧 label」做原子锁：多个协调器同时跑时只有一个能派出去。
 */
async function claimRework(repo, candidates, pulls, { json, dryRun }) {
  const changes = candidates
    .filter((i) => readState(i).state === "changes" && !readState(i).hold)
    .sort((a, b) => a.number - b.number);

  const skipped = [];
  const blocked = [];
  const viable = [];

  for (const issue of changes) {
    const pull = findPull(pulls, issue);
    if (!pull) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        why: "s:changes 但找不到对应 PR（无法定位原分支；请人工确认分支或改回 s:blocked）",
      });
      continue;
    }

    const comments = await listComments(repo, pull.number);
    const fail = latestFail(comments);
    if (!fail) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        why: `PR #${pull.number} 里没有可解析的验收 FAIL 评论（返工任务书无意见可引用）`,
      });
      continue;
    }
    const failCount = comments.filter((c) => parseVerdict(c.body)?.verdict === "FAIL").length;
    const round = Number(fail.round) || failCount || 1;

    if (round >= MAX_ROUNDS) {
      if (!dryRun) {
        await replaceState(repo, issue.number, "blocked");
        await addHumanHold(repo, issue.number);
      }
      blocked.push({
        number: issue.number,
        title: issue.title,
        round,
        pull: pull.number,
        why: `已打回 ${round} 轮（上限 ${MAX_ROUNDS}），不再自动派返工，转 s:blocked + hold:human`,
      });
      continue;
    }

    const scope = validateScope(issue);
    if (!scope.ok) {
      skipped.push({ number: issue.number, title: issue.title, why: scope.why });
      continue;
    }

    viable.push({ issue, pull, scope, fail, round });
  }

  const renderBlocked = () =>
    blocked.map((b) => `#${b.number} ${b.why}`).join("\n");

  if (dryRun) {
    const payload = {
      claimed: null,
      dryRun: true,
      wouldClaim: viable.map(({ issue, pull, scope, fail, round }) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        ids: scope.ids,
        pull: pull.number,
        pullUrl: pull.html_url,
        branch: pull.head.ref,
        head: pull.head.sha,
        round,
        commentUrl: fail.url,
        commentBody: fail.body,
        commentCreatedAt: fail.createdAt,
      })),
      wouldBlock: blocked.map(({ number, title, round, why }) => ({ number, title, round, why })),
      skipped,
    };
    if (json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else {
      for (const w of payload.wouldClaim) {
        process.stdout.write(
          `[dry-run] 会派返工 #${w.number}（PR #${w.pull}，原分支 ${w.branch}，round ${w.round}）\n` +
            `  最近验收评论：${w.commentUrl}\n`,
        );
      }
      for (const b of payload.wouldBlock) process.stdout.write(`[dry-run] 会转 s:blocked + hold:human #${b.number}：${b.why}\n`);
      for (const s of skipped) process.stdout.write(`✗ 跳过 #${s.number}：${s.why}\n`);
      if (!payload.wouldClaim.length && !payload.wouldBlock.length && !skipped.length) process.stdout.write("no-work\n");
    }
    return 0;
  }

  for (const { issue, pull, scope, fail, round } of viable) {
    const res = await claimIssue(repo, issue, "changes", "doing");
    if (!res.ok) continue;
    const claimed = {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      url: issue.html_url,
      milestone: issue.milestone?.title ?? null,
      acc: scope.ids,
      pull: pull.number,
      pullUrl: pull.html_url,
      branch: pull.head.ref,
      head: pull.head.sha,
      round,
      commentUrl: fail.url,
      commentBody: fail.body,
      commentCreatedAt: fail.createdAt,
    };
    if (json) process.stdout.write(JSON.stringify({ claimed, blocked, skipped }, null, 2) + "\n");
    else {
      process.stdout.write(
        `已认领返工 #${claimed.number}  ${claimed.title}\n` +
          `PR #${claimed.pull} · 原分支 ${claimed.branch} · head ${claimed.head.slice(0, 7)} · round ${claimed.round}\n` +
          `最近验收评论：${claimed.commentUrl}\n` +
          `${claimed.url}\n${"─".repeat(64)}\n${claimed.body}\n`,
      );
    }
    return 0;
  }

  const payload = {
    claimed: null,
    reason: blocked.length ? "blocked" : changes.length ? "all-raced" : "no-work",
    blocked,
    skipped,
  };
  if (json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else if (blocked.length) process.stdout.write(renderBlocked() + "\n");
  else if (skipped.length) process.stdout.write(skipped.map((s) => `✗ 跳过 #${s.number}：${s.why}`).join("\n") + "\n");
  else process.stdout.write("no-work\n");
  return 0;
}

/**
 * agent 自己找活。
 *
 * 设计要点：**由 agent 主动抢，而不是由协调器指派**。
 * 指派要求协调器知道"哪台机器上的哪个 session 是空闲的"，这在多 worktree 下会立刻失真；
 * 抢单只需要一个原子操作，谁抢到算谁的，天然适配任意数量的 worker。
 *
 *   engineer   —— 抢 s:ready，抢到即 s:doing（同一时刻只有一个在跑）
 *   acceptance —— 不抢，只列队列。验收没有"半成品"，重复审只是浪费；
 *                 而抢单会引入"认领者崩了没人接手"的死结。
 */
async function cmdClaim(repo, { role, milestone, json, dryRun }) {
  const board = await loadBoard(repo);
  const pulls = board.pulls;

  let candidates = board.issues;
  if (milestone) candidates = candidates.filter((i) => (i.milestone?.title ?? "") === milestone);

  if (role === "engineer") {
    const ready = candidates
      .filter((i) => readState(i).state === "ready" && !readState(i).hold)
      .sort((a, b) => a.number - b.number); // 老 issue 先做，避免新活插队把旧活饿死

    // 口径不合格的 issue 不认领：认领了 agent 也只能猜，最后一定打回。
    // 这类 issue 需要人补口径，所以列出来而不是静默跳过。
    const skipped = [];
    const viable = [];
    for (const issue of ready) {
      const scope = validateScope(issue);
      if (scope.ok) viable.push({ issue, scope });
      else skipped.push({ number: issue.number, title: issue.title, why: scope.why });
    }

    if (viable.length === 0) {
      const payload = { claimed: null, reason: ready.length ? "scope-invalid" : "no-work", skipped };
      process.stdout.write(
        json
          ? JSON.stringify(payload, null, 2) + "\n"
          : ready.length
            ? `没有可派工的 issue：${ready.length} 个 s:ready 的口径不合格\n` +
              skipped.map((s) => `  ✗ #${s.number} ${s.title}\n    ${s.why}`).join("\n") + "\n"
            : "no-work\n",
      );
      return 0;
    }

    if (dryRun) {
      // 只读：列出会认领谁、跳过谁，不改任何 label。
      const payload = {
        claimed: null,
        dryRun: true,
        wouldClaim: viable.map(({ issue, scope }) => ({ number: issue.number, title: issue.title, ids: scope.ids })),
        skipped,
      };
      process.stdout.write(
        json
          ? JSON.stringify(payload, null, 2) + "\n"
          : viable.map(({ issue, scope }) => `会认领 #${issue.number}  ${issue.title}\n  ${scope.why}`).join("\n") +
            (skipped.length ? "\n跳过：\n" + skipped.map((s) => `  ✗ #${s.number} ${s.why}`).join("\n") : "") +
            "\n",
      );
      return 0;
    }

    for (const { issue, scope } of viable) {
      const res = await claimIssue(repo, issue);
      if (!res.ok) continue;
      const claimed = {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
        milestone: issue.milestone?.title ?? null,
        acc: scope.ids,
      };
      if (json) {
        process.stdout.write(JSON.stringify({ claimed, skipped }, null, 2) + "\n");
      } else {
        process.stdout.write(
          `已认领 #${claimed.number}  ${claimed.title}\n` +
          (claimed.milestone ? `里程碑：${claimed.milestone}\n` : "") +
          `口径：${claimed.acc.join(", ")}\n` +
          `${claimed.url}\n` +
          `${"─".repeat(64)}\n${claimed.body}\n`,
        );
      }
      return 0;
    }
    process.stdout.write(json ? JSON.stringify({ claimed: null, reason: "all-raced", skipped }) + "\n" : "全被抢光了\n");
    return 0;
  }

  if (role === "rework") {
    return claimRework(repo, candidates, pulls, { json, dryRun });
  }

  if (role === "acceptance") {
    const queue = candidates
      .filter((i) => readState(i).state === "review" && !readState(i).hold)
      .map((i) => {
        const pull = findPull(pulls, i);
        return {
          number: i.number,
          title: i.title,
          url: i.html_url,
          pull: pull?.number ?? null,
          pullUrl: pull?.html_url ?? null,
          // 验收方拿到的口径必须是派工那一刻的，不能让它自己去猜
          acc: issueAccIds(i.body),
          head: pull?.head?.sha ?? null,
        };
      })
      .filter((x) => x.pull)
      .sort((a, b) => a.number - b.number);

    if (json) process.stdout.write(JSON.stringify({ queue }, null, 2) + "\n");
    else if (queue.length === 0) process.stdout.write("no-work\n");
    else
      for (const q of queue)
        process.stdout.write(
          `待验收 #${q.number}  ${q.title}\n  PR #${q.pull}  ${q.pullUrl}\n  head ${q.head}\n  口径 ${q.acc.join(", ") || "（无）"}\n  issue ${q.url}\n`,
        );
    return 0;
  }

  throw new Error(`未知角色：${role}（只支持 engineer / acceptance / rework）`);
}

/**
 * 直接把某个 issue 拨到指定状态。给"派工失败要退回 s:ready"这类补偿用。
 *
 * 默认按 TRANSITIONS 校验：不在表里的边一律拒绝。这不是形式主义——"agent 能
 * 把 issue 拨到任意状态"等于"agent 能自己宣布验收通过"。--force 是给脚本补偿
 * 与人工抢修留的逃生口，会打印告警，方便事后审计。
 */
async function cmdSet(repo, { issue, to, json, force }) {
  if (!STATES.includes(to)) {
    throw new Error(`未知状态：${to}（合法值：${STATES.join(", ")}）`);
  }
  const cur = await api(`/repos/${repo.owner}/${repo.repo}/issues/${issue}`);
  const labels = (cur.data.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const from = labels.filter((n) => n.startsWith("s:")).map((n) => n.slice(2)).at(-1) ?? null;

  if (from && !canTransition(from, to) && !force) {
    const allowed = TRANSITIONS[from] ?? [];
    throw new Error(
      `非法迁移 #${issue}: s:${from} → s:${to}\n` +
      `  允许的下一状态：${allowed.length ? allowed.map((s) => `s:${s}`).join(", ") : "（无）"}\n` +
      `  确实需要强制迁移时加 --force（会留告警）。`,
    );
  }
  if (from && !canTransition(from, to) && force) {
    process.stderr.write(`⚠ 强制迁移 #${issue}: s:${from} → s:${to}（不在合法迁移表内）\n`);
  }

  const base = `/repos/${repo.owner}/${repo.repo}/issues/${issue}/labels`;
  for (const name of labels.filter((n) => n.startsWith("s:"))) {
    try {
      await api(`${base}/${encodeURIComponent(name)}`, { method: "DELETE" });
    } catch (err) {
      if (!/^404 /.test(err.message)) throw err;
    }
  }
  await api(base, { method: "POST", body: { labels: [`s:${to}`] } });
  if (json) process.stdout.write(JSON.stringify({ issue: Number(issue), from, to }) + "\n");
  else process.stdout.write(`#${issue} → s:${to}\n`);
  return 0;
}

// ---------------------------------------------------------------- 验收与合并
//
// 这一段解决两个具体毛病：
//   1. 验收方说"不行"时，默认只能新建 issue —— 分支越开越多，证据散在两处。
//      正确做法是打回原 PR、同一分支继续改（docs/AGENT-COLLAB.md §5）。
//   2. 合并靠人点 —— 人会忘、会看图省事。合并必须由脚本按机器可校验的条件执行：
//      head_sha 对得上、verdict=PASS、ACC 条目逐条覆盖、五道 CI 门禁全绿。
//
// 判定只认 PR 评论里那块 ```yaml```，不认散文。散文可以写得很像 PASS。

const MAX_ROUNDS = 3;
const HANDOVER_MARKER = "<!-- agent-handback -->";
const MERGE_MARKER = "<!-- agent-merge -->";

/** 五道门禁。与 .github/workflows/ci.yml 的 job name 逐字一致。 */
const REQUIRED_GATES = [
  "test / npm test",
  "parity / 命令表 = 路由 = 卡片 = CLI",
  "adapter-contract / 形状 + ready + dry-run 无副作用",
  "no-backdoor / web 与 channel 不得直连数据库",
  "design / 任务书 · 导航 · 死链 · 检测器 · 触控",
];

/** 从评论里解析 ```yaml 块。解析不出 verdict 就当没有判定，不猜。 */
function parseVerdict(body) {
  // 一条评论里可能同时有证据包 YAML 和判定 YAML——必须扫完所有块，
  // 只认带 verdict 的那一块。只看第一块会把"证据包在前"的评论误判成没有判定。
  const blocks = [...String(body ?? "").matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  const text = blocks.find((b) => /^verdict:\s*(PASS|FAIL)\s*$/im.test(b));
  if (!text) return null;
  const verdict = /^verdict:\s*(PASS|FAIL)\s*$/im.exec(text)?.[1]?.toUpperCase();
  if (!verdict) return null;
  const headSha = /^head_sha:\s*"?([0-9a-fA-F]{7,40})"?\s*$/im.exec(text)?.[1] ?? null;
  const round = Number(/^round:\s*(\d+)/im.exec(text)?.[1] ?? 0) || null;

  const acceptance = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const idm = /^\s*-\s*id:\s*(ACC-[A-Za-z0-9_-]+)/.exec(line);
    if (idm) {
      cur = { id: idm[1], status: null };
      acceptance.push(cur);
      continue;
    }
    const sm = /^\s*status:\s*(pass|fail)\b/i.exec(line);
    if (sm && cur) cur.status = sm[1].toLowerCase();
  }
  return { verdict, headSha, round, acceptance };
}

/** 最新一条带判定的评论。FAIL 之后又 PASS 是合法的，所以必须取最新。 */
function latestVerdict(comments) {
  for (const c of comments) {
    const v = parseVerdict(c.body);
    if (v) return { ...v, commentId: c.id, url: c.html_url, body: c.body ?? "", createdAt: c.created_at };
  }
  return null;
}

/** 最新一条验收 FAIL 评论（返工任务书要引用的就是它）。comments 已按时间倒序。 */
function latestFail(comments) {
  for (const c of comments) {
    const v = parseVerdict(c.body);
    if (v?.verdict === "FAIL") {
      return { ...v, commentId: c.id, url: c.html_url, body: c.body ?? "", createdAt: c.created_at };
    }
  }
  return null;
}

async function listComments(repo, number) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const { data } = await api(`/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`, {
      params: { per_page: "100", page: String(page) },
    });
    out.push(...data);
    if (data.length < 100) break;
  }
  // 新的在前，调用方只看"最新一条判定"
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

async function gateStatus(repo, sha) {
  const { data } = await api(`/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs`, {
    params: { per_page: "100" },
  });
  const byName = new Map();
  for (const run of data.check_runs ?? []) if (!byName.has(run.name)) byName.set(run.name, run);
  const results = REQUIRED_GATES.map((name) => {
    const run = byName.get(name);
    return { name, status: run?.status ?? null, conclusion: run?.conclusion ?? null };
  });
  return { ok: results.every((r) => r.status === "completed" && r.conclusion === "success"), results };
}

async function replaceState(repo, number, to) {
  const base = `/repos/${repo.owner}/${repo.repo}/issues/${number}/labels`;
  const cur = await api(`/repos/${repo.owner}/${repo.repo}/issues/${number}`);
  const labels = (cur.data.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  for (const name of labels.filter((n) => n.startsWith("s:"))) {
    try {
      await api(`${base}/${encodeURIComponent(name)}`, { method: "DELETE" });
    } catch (err) {
      if (!/^404 /.test(err.message)) throw err;
    }
  }
  await api(base, { method: "POST", body: { labels: [`s:${to}`] } });
}

/**
 * 人工/验收打回。**默认回原 PR，不新建 issue。**
 *
 * 三种来源都走这里：
 *   - 验收 agent 判 FAIL（附 evidence）
 *   - 人在验收时说"这里不对"（由协调器代跑，附 expected/observed/repro）
 *   - 里程碑复验发现问题（done → changes，先 reopen）
 *
 * 条目必须能在 ACCEPTANCE.md 里 grep 到；确实超出原口径时用
 * `--item manual-review --reason "..."`，显式承认这是人工观察到的新口径，
 * 由协调器补进原 issue 后再派工——仍然不新建 issue。
 */
async function cmdReject(repo, opts) {
  const { issue: number, item, expected, observed, repro, reason, dryRun, json } = opts;

  // 已合并的 issue 也是合法打回对象（里程碑验收 / 事后复验），所以不能只看 open issues。
  const { data: issue } = await api(`/repos/${repo.owner}/${repo.repo}/issues/${number}`);
  const { state, hold } = readState(issue);
  if (hold) throw new Error(`#${number} 有 hold:human，先由人解除冻结再打回`);
  if (!["review", "accept", "done"].includes(state)) {
    throw new Error(`#${number} 当前 s:${state ?? "<none>"}，只有 review/accept/done 可以打回`);
  }

  // PR 可能在打开状态（回原分支改），也可能已合并（分支已删，只能回 issue 上重开）。
  const { data: allPulls } = await api(`/repos/${repo.owner}/${repo.repo}/pulls`, {
    params: { state: "all", per_page: "100", sort: "updated", direction: "desc" },
  });
  const pull = findPull(allPulls, issue);
  if (!pull) throw new Error(`#${number} 找不到对应 PR；请先在 issue 里补一条能复现的说明，再派 engineer`);
  const pullOpen = pull.state === "open";

  // 条目校验：引用不到的 FAIL 无效，这是防"审美暴君"的机械保障。
  const known = acceptanceIds();
  if (!item) throw new Error("reject 需要 --item ACC-xxx（或 --item manual-review --reason '...'）");
  if (item !== "manual-review" && !known.has(item)) {
    throw new Error(
      `--item ${item} 不在 docs/design/ACCEPTANCE.md 里。\n` +
      `  如果这是原口径内的条目，请用正确的 ACC id；\n` +
      `  如果这是新发现的问题，用 --item manual-review --reason "<一句话>"，并把口径补进原 issue。`,
    );
  }
  if (item === "manual-review" && !reason) throw new Error("--item manual-review 需要 --reason 说明观察到什么");
  if (!expected) throw new Error("reject 需要 --expected：应该是什么样");
  if (!observed) throw new Error("reject 需要 --observed：实际是什么样");
  const reproList = (Array.isArray(repro) ? repro : [repro]).filter(Boolean);
  if (reproList.length === 0) throw new Error("reject 需要至少一个 --repro：怎么复现");

  const comments = await listComments(repo, pull.number);
  const round = comments.filter((c) => (c.body ?? "").includes(HANDOVER_MARKER)).length + 1;
  const q = (s) => JSON.stringify(String(s)); // YAML 接受 JSON 风格的带引号字符串

  const yaml = [
    "```yaml",
    "verdict: FAIL",
    `round: ${round}`,
    `head_sha: ${q(pull.head.sha)}`,
    "source: human-verification",
    "failed:",
    `  - item: ${item}`,
    `    expected: ${q(expected)}`,
    `    observed: ${q(observed)}`,
    "    repro:",
    ...reproList.map((r) => `      - ${q(r)}`),
    ...(reason ? [`    note: ${q(reason)}`] : []),
    "```",
  ].join("\n");

  const body = [
    HANDOVER_MARKER,
    `## 验收结论：FAIL（round ${round}，head \`${pull.head.sha.slice(0, 7)}\`）`,
    "",
    pullOpen
      ? "由协调器根据人工验收意见发出。**不新建 issue**：修复留在本 PR、本分支。"
      : "由协调器根据人工验收意见发出。原 PR 已合并/关闭，**不新建 issue**：reopen 本工单，在新分支上修。",
    "",
    yaml,
  ].join("\n");

  if (dryRun) {
    process.stdout.write(
      (json
        ? JSON.stringify({ dryRun: true, issue: Number(number), pull: pull.number, round, body }, null, 2)
        : `[dry-run] 会给 PR #${pull.number} 留 FAIL 评论，并把 #${number} 置 s:changes（round ${round}）\n` + body) + "\n",
    );
    return { merged: false, round };
  }

  // 评论落在"还能改的那个地方"：PR 开着就回 PR（同分支修），
  // 已合并/关闭就回 issue（重开、开新分支，但工单不变）。
  const commentTarget = pullOpen ? pull.number : Number(number);
  await api(`/repos/${repo.owner}/${repo.repo}/issues/${commentTarget}/comments`, {
    method: "POST",
    body: { body },
  });

  // 已合并的 issue 要先 reopen，状态才有意义。
  if (issue.state === "closed" || state === "done") {
    await api(`/repos/${repo.owner}/${repo.repo}/issues/${number}`, {
      method: "PATCH",
      body: { state: "open" },
    });
  }

  if (round > MAX_ROUNDS) {
    await replaceState(repo, number, "blocked");
    await api(`/repos/${repo.owner}/${repo.repo}/issues/${number}/labels`, {
      method: "POST",
      body: { labels: ["hold:human"] },
    });
    process.stdout.write(`#${number} 已打回 ${round} 轮，超过上限，置 s:blocked + hold:human，等人决定\n`);
    return { merged: false, round, blocked: true };
  }

  await replaceState(repo, number, "changes");
  process.stdout.write(
    `#${number} → s:changes（round ${round}），FAIL 评论已留在 ${pullOpen ? `PR #${pull.number}（同一分支继续改）` : `issue #${number}（重开，新分支修）`}\n`,
  );
  return { merged: false, round };
}

/**
 * 脚本合并。**只有机器可校验的条件全过才合。**
 *
 * 顺序是刻意的：先证"该合"（状态、判定、覆盖、门禁），再做唯一一次写操作。
 * 任何一条不过都不合，并把原因逐条打出来——含混的拒绝等于没拒绝。
 */
async function cmdMerge(repo, { issue: number, pending, dryRun, json }) {
  const board = await loadBoard(repo);
  let targets;
  if (pending) {
    // s:review 也要看：验收 agent 只负责给 verdict，状态迁移是协调器的事
    // （AGENT-COLLAB §2）。所以"verdict=PASS 但还挂在 review"不该等人手改。
    targets = board.issues.filter((i) => ["accept", "review"].includes(readState(i).state) && !readState(i).hold);
  } else {
    const issue = board.issues.find((i) => i.number === Number(number));
    if (!issue) throw new Error(`找不到 open issue #${number}`);
    targets = [issue];
  }

  const results = [];
  for (const issue of targets) {
    const problems = [];
    const { state, hold } = readState(issue);
    if (hold) problems.push("有 hold:human");

    const pull = findPull(board.pulls, issue);

    let verdict = null;
    if (pull) {
      const comments = await listComments(repo, pull.number);
      verdict = latestVerdict(comments);
    }

    // review → accept 的迁移由这里做：verdict=PASS 且 head 对得上才算验收通过。
    if (state === "review") {
      const headOk = verdict?.headSha && pull?.head.sha.startsWith(verdict.headSha);
      if (verdict?.verdict === "PASS" && headOk) {
        await replaceState(repo, issue.number, "accept");
      } else if (verdict?.verdict === "FAIL" && headOk) {
        // 验收方只给判定，迁移由协调器做——否则"谁改了状态"永远说不清。
        await replaceState(repo, issue.number, "changes");
        results.push({ issue: issue.number, merged: false, handback: true, pull: pull?.number ?? null });
        continue;
      } else {
        continue; // 还在验收中（没有 verdict）或 verdict 与 head 不匹配
      }
    } else if (state !== "accept") {
      problems.push(`当前 s:${state ?? "<none>"}，只有 s:accept（或已 PASS 的 s:review）才能合并`);
    }
    if (!pull) problems.push("找不到对应 PR");
    if (pull?.draft) problems.push("PR 还是草稿");

    if (pull) {
      if (!verdict) problems.push("PR 里没有可解析的 verdict（需要 ```yaml 块，含 verdict/head_sha）");
      else if (verdict.verdict !== "PASS") problems.push(`最新判定是 ${verdict.verdict}`);
      else if (!verdict.headSha || !pull.head.sha.startsWith(verdict.headSha)) {
        problems.push(`判定针对的是 ${verdict.headSha ?? "<无>"}，当前 head 是 ${pull.head.sha.slice(0, 7)}（验收后又改过代码）`);
      }
    }

    const wantedIds = issueAccIds(issue.body);
    if (wantedIds.length === 0) problems.push("issue 正文没有 ACC-* 口径，无法核对覆盖");
    if (verdict?.verdict === "PASS") {
      const passed = new Set(verdict.acceptance.filter((a) => a.status === "pass").map((a) => a.id));
      const uncovered = wantedIds.filter((id) => !passed.has(id));
      if (uncovered.length) problems.push(`verdict 没有逐条覆盖：${uncovered.join(", ")}`);
    }

    let gates = null;
    if (pull && problems.length === 0) {
      gates = await gateStatus(repo, pull.head.sha);
      if (!gates.ok) {
        problems.push(
          "门禁未全绿：" +
            gates.results.filter((g) => g.conclusion !== "success").map((g) => `${g.name}=${g.conclusion ?? g.status ?? "缺失"}`).join("; "),
        );
      }
    }

    if (problems.length) {
      results.push({ issue: issue.number, merged: false, problems });
      continue;
    }

    if (dryRun) {
      results.push({ issue: issue.number, merged: false, dryRun: true, pull: pull.number, head: pull.head.sha });
      continue;
    }

    // sha 作为守卫：合并瞬间 head 变了，GitHub 会拒绝，而不是合进没验过的代码。
    await api(`/repos/${repo.owner}/${repo.repo}/pulls/${pull.number}/merge`, {
      method: "PUT",
      body: { merge_method: "squash", sha: pull.head.sha },
    });
    const receipt = await api(`/repos/${repo.owner}/${repo.repo}/pulls/${pull.number}`);
    const mergeSha = receipt.data.merge_commit_sha ?? null;

    await replaceState(repo, issue.number, "done");
    if (issue.state === "open") {
      await api(`/repos/${repo.owner}/${repo.repo}/issues/${issue.number}`, {
        method: "PATCH",
        body: { state: "closed", state_reason: "completed" },
      });
    }
    await api(`/repos/${repo.owner}/${repo.repo}/issues/${pull.number}/comments`, {
      method: "POST",
      body: {
        body: [
          MERGE_MARKER,
          `已由 agentctl 合并：PR #${pull.number} head \`${pull.head.sha.slice(0, 7)}\` → \`${(mergeSha ?? "").slice(0, 7)}\``,
          "",
          `- verdict: PASS（${verdict.commentId ? `comment ${verdict.commentId}` : "PR 评论"}）`,
          `- 门禁：${REQUIRED_GATES.length}/${REQUIRED_GATES.length} 通过`,
          `- 口径：${wantedIds.join(", ")} 逐条 pass`,
        ].join("\n"),
      },
    });
    results.push({ issue: issue.number, merged: true, pull: pull.number, head: pull.head.sha, mergeSha });
  }

  const merged = results.filter((r) => r.merged);
  if (json) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
  } else if (results.length === 0) {
    process.stdout.write("没有待合并的 issue\n");
  } else {
    for (const r of results) {
      if (r.merged) process.stdout.write(`✓ 合并 #${r.issue}（PR #${r.pull} → ${(r.mergeSha ?? "").slice(0, 7)}）\n`);
      else if (r.handback) process.stdout.write(`↩ #${r.issue} 判定 FAIL → s:changes（PR #${r.pull}，回原分支改）\n`);
      else if (r.dryRun) process.stdout.write(`· [dry-run] 会合并 #${r.issue}（PR #${r.pull}，head ${String(r.head).slice(0, 7)}）\n`);
      else process.stdout.write(`✗ 不合并 #${r.issue}：\n${r.problems.map((p) => `    - ${p}`).join("\n")}\n`);
    }
  }
  // 显式指定单个 issue 时，合不了就是失败；--pending 是巡检，跳过不算错。
  if (!pending && results.length && !results[0].merged && !dryRun) return 1;
  return 0;
}

// ---------------------------------------------------------------- 入口

async function main(argv) {
  const cmd = argv[0];
  const json = argv.includes("--json");
  const verbose = argv.includes("--verbose");
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const arg = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
  };
  /** 同一个参数可以出现多次：--repro "第一步" --repro "第二步" */
  const argAll = (name) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] != null) out.push(argv[i + 1]);
    return out;
  };

  if (!cmd || ["-h", "--help", "help"].includes(cmd)) {
    process.stdout.write(
      `agentctl —— 多 agent 协作协调器

用法：
  node bin/agentctl.mjs <command> [options]

  tick      读一次工单全景，算「谁该动、为什么」。
            --apply   执行决策里带 transition 的迁移（目前只自动做 doing→review）
            --json    机器可读
            --verbose 附带原始 label 与链接

  claim     自己找活（worker 用，不需要人来派）。
            --role engineer|acceptance|rework  （必填；rework 只认 s:changes）
            --milestone <标题>           只在该里程碑内找
            --dry-run                    只列出会认领谁、跳过谁，不改状态
            --json                       机器可读

  set       把 issue 拨到指定状态（补偿用）。
            --issue <n> --to <state>
            --force                      跳过合法迁移校验（会告警）

  reject    人工/验收打回：回原 PR，同一分支继续改，**不新建 issue**。
            --issue <n>
            --item ACC-xxx | manual-review
            --expected "应该是什么样"
            --observed "实际是什么样"
            --repro "怎么复现"（可重复）
            --reason "..."               manual-review 时必填
            --round-limit 3              超过轮次强制 s:blocked + hold:human
            --dry-run

  merge     脚本合并：verdict=PASS + head_sha 对齐 + ACC 逐条覆盖 + 五门禁全绿。
            --issue <n>                  合这一个
            --pending                    把所有 s:accept 的都过一遍（巡检用）
            --dry-run

  engineer  抢 s:ready，抢到即改 s:doing；口径不合格（ACC 引用不到）不抢。
  rework    抢 s:changes，抢到即改 s:doing；附原 PR/分支/最近验收 FAIL 评论，round 到顶转 s:blocked + hold:human。
  acceptance 列出 s:review 且已有 PR 的队列（不抢单；附该 issue 的口径 id 与 head）。

退出码：0 正常（含"没活"）；1 配置/网络/API 出错，或迁移/认领/合并失败。
         "有活要干"不算失败——那会让定时任务误判。

文档：docs/AGENT-COLLAB.md · docs/AGENT-WORKFLOW.md · docs/ORCA-TEAM-PLAYBOOK.md
`,
    );
    return 0;
  }

  if (cmd === "claim") {
    const role = arg("--role");
    if (!role) {
      process.stderr.write("claim 需要 --role engineer|acceptance|rework\n");
      return 1;
    }
    const repo = resolveRepo();
    TOKEN = resolveToken();
    return cmdClaim(repo, { role, milestone: arg("--milestone"), json, dryRun });
  }

  if (cmd === "set") {
    const issue = arg("--issue");
    const to = arg("--to");
    if (!issue || !to) {
      process.stderr.write("set 需要 --issue <n> --to <state>\n");
      return 1;
    }
    const repo = resolveRepo();
    TOKEN = resolveToken();
    return cmdSet(repo, { issue, to, json, force });
  }

  if (cmd === "reject") {
    const issue = arg("--issue");
    if (!issue) {
      process.stderr.write("reject 需要 --issue <n>\n");
      return 1;
    }
    const repo = resolveRepo();
    TOKEN = resolveToken();
    const res = await cmdReject(repo, {
      issue,
      item: arg("--item"),
      expected: arg("--expected"),
      observed: arg("--observed"),
      repro: argAll("--repro"),
      reason: arg("--reason"),
      dryRun,
      json,
    });
    return res?.blocked ? 1 : 0;
  }

  if (cmd === "merge") {
    const issue = arg("--issue");
    const pending = argv.includes("--pending");
    if (!issue && !pending) {
      process.stderr.write("merge 需要 --issue <n> 或 --pending\n");
      return 1;
    }
    const repo = resolveRepo();
    TOKEN = resolveToken();
    return cmdMerge(repo, { issue, pending, dryRun, json });
  }

  if (cmd !== "tick") {
    process.stderr.write(`未知命令：${cmd}（支持 tick / claim / set / reject / merge）\n`);
    return 1;
  }

  const repo = resolveRepo();
  TOKEN = resolveToken();
  const board = await loadBoard(repo);

  const pulls = board.pulls;
  const rows = board.issues
    .map((issue) => {
      const d = decide(issue, pulls);
      return {
        number: issue.number,
        title: issue.title,
        state: readState(issue).state,
        labels: readState(issue).names,
        url: issue.html_url,
        ...d,
      };
    })
    .sort((a, b) => a.number - b.number);

  // 即使不加 --apply 也走一遍（dryRun），这样输出里能看到"本轮会改什么"——
  // 只读观察和真实执行共用同一条代码路径，避免"演练和实战不一样"。
  const transitions = await applyTransitions(repo, rows, { dryRun: !apply });

  if (json) {
    process.stdout.write(
      JSON.stringify({ repo: repo.full, quota: board.quota, rows, transitions, applied: apply }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(render({ repo, rows, quota: board.quota, verbose, transitions, applied: apply }) + "\n");
  }

  const failed = transitions.filter((t) => t.status === "failed");
  if (failed.length) {
    process.stderr.write(`\n${failed.length} 条迁移失败：\n`);
    for (const f of failed) process.stderr.write(`  #${f.number} ${f.from}→${f.to}: ${f.why}\n`);
    return 1;
  }
  return 0;
}

// 作为脚本执行时才跑 main；被测试 import 时只暴露纯函数。
// 判定逻辑（verdict 解析、迁移表、口径校验）必须能被单测钉住——
// 这些规则一旦漂了，整条流水线会静默放行。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      // 失败要留现场，且不能伪装成"没事"。
      process.stderr.write(`agentctl 失败：${err.message}\n`);
      process.exit(1);
    },
  );
}

export { TRANSITIONS, canTransition, issueAccIds, parseVerdict, validateScope };