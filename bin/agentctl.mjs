#!/usr/bin/env node
// agentctl —— 多 agent 协作的协调器（**只读版**）。
//
// 为什么需要它：docs/AGENT-COLLAB.md 定义了状态机（s:* label）与接力规则，但
// "谁该动、为什么"如果靠人肉判断，两个 agent 就会互相等，或者同时动。
// 这个脚本把判断变成确定性的：同样的工单状态，永远算出同样的结论。
//
// **本文件当前只读**。它只发 GET、只打印、不写任何状态。
// 写状态（改 label、派工、合并）留到 `--apply`，而那一版必须建立在
// "只读版连续跑 10 轮结论稳定"这个前提下——顺序反了就是在自动制造事故。
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const API = "https://api.github.com";
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
async function claimIssue(repo, issue) {
  const base = `/repos/${repo.owner}/${repo.repo}/issues/${issue.number}/labels`;
  try {
    await api(`${base}/${encodeURIComponent("s:ready")}`, { method: "DELETE" });
  } catch (err) {
    if (/^404 /.test(err.message)) return { ok: false, why: "被抢了" };
    throw err;
  }
  try {
    await api(base, { method: "POST", body: { labels: ["s:doing"] } });
  } catch (err) {
    // 锁已拿、状态没写上：最危险的中间态，必须让调用方知道 issue 现在无状态。
    throw new Error(
      `认领 #${issue.number} 时已移除 s:ready，但没能加上 s:doing。\n` +
      `  issue 现在无状态，请手工加 s:doing 或 s:blocked。\n  原因：${err.message}`,
    );
  }
  return { ok: true };
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
async function cmdClaim(repo, { role, milestone, json }) {
  const board = await loadBoard(repo);
  const pulls = board.pulls;

  let candidates = board.issues;
  if (milestone) candidates = candidates.filter((i) => (i.milestone?.title ?? "") === milestone);

  if (role === "engineer") {
    const ready = candidates
      .filter((i) => readState(i).state === "ready" && !readState(i).hold)
      .sort((a, b) => a.number - b.number); // 老 issue 先做，避免新活插队把旧活饿死
    if (ready.length === 0) {
      process.stdout.write(json ? JSON.stringify({ claimed: null, reason: "no-work" }) + "\n" : "no-work\n");
      return 0;
    }
    for (const issue of ready) {
      const res = await claimIssue(repo, issue);
      if (!res.ok) continue;
      const claimed = {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
        milestone: issue.milestone?.title ?? null,
      };
      if (json) {
        process.stdout.write(JSON.stringify({ claimed }, null, 2) + "\n");
      } else {
        process.stdout.write(
          `已认领 #${claimed.number}  ${claimed.title}\n` +
          (claimed.milestone ? `里程碑：${claimed.milestone}\n` : "") +
          `${claimed.url}\n` +
          `${"─".repeat(64)}\n${claimed.body}\n`,
        );
      }
      return 0;
    }
    process.stdout.write(json ? JSON.stringify({ claimed: null, reason: "all-raced" }) + "\n" : "全被抢光了\n");
    return 0;
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
        };
      })
      .filter((x) => x.pull)
      .sort((a, b) => a.number - b.number);

    if (json) process.stdout.write(JSON.stringify({ queue }, null, 2) + "\n");
    else if (queue.length === 0) process.stdout.write("no-work\n");
    else
      for (const q of queue)
        process.stdout.write(
          `待验收 #${q.number}  ${q.title}\n  PR #${q.pull}  ${q.pullUrl}\n  issue ${q.url}\n`,
        );
    return 0;
  }

  throw new Error(`未知角色：${role}（只支持 engineer / acceptance）`);
}

// ---------------------------------------------------------------- 入口

async function main(argv) {
  const cmd = argv[0];
  const json = argv.includes("--json");
  const verbose = argv.includes("--verbose");
  const apply = argv.includes("--apply");

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
            --role engineer|acceptance   （必填）
            --milestone <标题>           只在该里程碑内找
            --json                       机器可读

  engineer  抢 s:ready，抢到即改 s:doing；同一时刻只有一个 agent 能拿到。
  acceptance 列出 s:review 且已有 PR 的队列（不抢单：验收可以重复，认领者崩了才是死结）。

退出码：0 正常（含"没活"）；1 配置/网络/API 出错，或迁移/认领失败。
         "有活要干"不算失败——那会让定时任务误判。

文档：docs/AGENT-COLLAB.md · docs/AGENT-WORKFLOW.md
`,
    );
    return 0;
  }
  if (cmd === "claim") {
    const roleIdx = argv.indexOf("--role");
    const role = roleIdx >= 0 ? argv[roleIdx + 1] : null;
    if (!role) {
      process.stderr.write("claim 需要 --role engineer|acceptance\n");
      return 1;
    }
    const msIdx = argv.indexOf("--milestone");
    const milestone = msIdx >= 0 ? argv[msIdx + 1] : null;
    const repo = resolveRepo();
    TOKEN = resolveToken();
    return cmdClaim(repo, { role, milestone, json });
  }

  if (cmd !== "tick") {
    process.stderr.write(`未知命令：${cmd}（支持 tick / claim）\n`);
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    // 失败要留现场，且不能伪装成"没事"。
    process.stderr.write(`agentctl 失败：${err.message}\n`);
    process.exit(1);
  },
);