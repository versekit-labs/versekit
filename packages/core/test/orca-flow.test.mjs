// bin/orca-flow.mjs 的纯逻辑与离线派工测试。
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const testState = mkdtempSync(join(tmpdir(), "orca-flow-state-"));
after(() => rmSync(testState, { recursive: true, force: true }));
const originalLog = process.env.FLOW_LOG;
process.env.FLOW_LOG = join(testState, "flow.log");
const {
  taskTitle, parseTaskTitle, isActive, planCompletion, countActive, reusableTerminal,
  hasAcceptTask, inboxVerdict, lastJson, implSpec, reworkSpec, acceptSpec,
  buildingIssues, transcribeAgentctl, projectName, projectRules, hasLabel, flowConfig, coordinatorNotes, reasonText, settledReworks,
  linkedIssueOf, cleanupCandidates, dirtyReason, isActiveIssue, reworkPlacement,
  codexExhaustion, codexCooldown, rerouteExhaustedCodex, chooseChannel,
} = await import("../../../bin/orca-flow.mjs");
if (originalLog === undefined) delete process.env.FLOW_LOG;
else process.env.FLOW_LOG = originalLog;

const task = (id, title, status = "dispatched") => ({ id, task_title: title, status });
const worker = (dispatchId, taskId, { dispatchStatus = "dispatched", terminalState = "owned", liveness = "live", handle = `term_${dispatchId}` } = {}) => ({
  dispatchId, taskId, dispatchStatus, terminalState, agentTerminalHandle: handle,
  projection: { liveness: { verdict: liveness } },
});
const base = (over = {}) => ({ lanes: 2, acceptMax: 1, tasks: [], workers: [], issues: {}, ...over });

test("Task 标题是脚本和 Orca 之间唯一的对应：能写能读，别的标题不认", () => {
  assert.equal(taskTitle("impl", 12), "vk#12 实现");
  assert.equal(taskTitle("rework", 12, "r2"), "vk#12 返工 r2");
  assert.equal(taskTitle("accept", 12, "abc1234"), "vk#12 验收 abc1234");
  assert.deepEqual(parseTaskTitle("vk#12 验收 abc1234"), { issue: 12, kind: "accept", extra: "abc1234" });
  assert.deepEqual(parseTaskTitle("vk#7 实现"), { issue: 7, kind: "impl", extra: "" });
  assert.equal(parseTaskTitle("issue #356 实现（Orca 原生试跑）"), null);
  assert.equal(parseTaskTitle(undefined), null);
});

test("并行名额只算没结算、没被证实退出的 worker；验收与实现分开数", () => {
  const s = base({
    tasks: [task("t1", "vk#1 实现"), task("t2", "vk#2 返工 r1"), task("t3", "vk#3 验收 aaaaaaa"), task("t4", "vk#4 实现"), task("t5", "别的项目")],
    workers: [
      worker("d1", "t1"),
      worker("d2", "t2", { liveness: "unverifiable" }), // 缺证据不等于退出，照样占名额
      worker("d3", "t3"),
      worker("d4", "t4", { dispatchStatus: "completed", terminalState: "retained" }),
      worker("d5", "t5"),
    ],
  });
  assert.equal(isActive(s.workers[3]), false);
  assert.deepEqual(countActive(s), { build: 2, accept: 1, freeBuild: 0, freeAccept: 0 });
});

test("交活后：实现/返工在等验收时保留（FAIL 时复用），验收与已合并的回收", () => {
  const s = base({
    tasks: [task("t1", "vk#1 实现", "completed"), task("t2", "vk#2 验收 bbbbbbb", "completed"), task("t3", "vk#3 返工 r1", "completed"), task("t4", "vk#4 实现", "completed")],
    workers: [
      worker("d1", "t1", { dispatchStatus: "completed", terminalState: "reclaimable" }),
      worker("d2", "t2", { dispatchStatus: "completed", terminalState: "reclaimable" }),
      worker("d3", "t3", { dispatchStatus: "completed", terminalState: "reclaimable" }),
      worker("d4", "t4", { dispatchStatus: "completed", terminalState: "retained" }),
    ],
    issues: { 1: "review", 2: "review", 3: "done", 4: "done" },
  });
  assert.deepEqual(planCompletion(s).map((a) => [a.dispatchId, a.op]), [
    ["d1", "retain"],
    ["d2", "release"],
    ["d3", "release"],
    ["d4", "release"],
  ]);
});

test("返工优先复用同一 issue 保留着、进程还活的实现终端；退出的、别的 issue 的不复用", () => {
  const s = base({
    tasks: [task("t1", "vk#5 实现", "completed"), task("t2", "vk#6 实现", "completed"), task("t3", "vk#5 返工 r1", "completed")],
    workers: [
      worker("d3", "t3", { dispatchStatus: "completed", terminalState: "retained", liveness: "exited" }),
      worker("d2", "t2", { dispatchStatus: "completed", terminalState: "retained" }),
      worker("d1", "t1", { dispatchStatus: "completed", terminalState: "retained", handle: "term_impl5" }),
    ],
  });
  assert.equal(reusableTerminal(s, 5)?.agentTerminalHandle, "term_impl5");
  assert.equal(reusableTerminal(s, 7), null);
});

test("同一 issue 同一 head 建过验收 Task 就不重复建；失败、被停（blocked）的可以重建；换了 head 要重验", () => {
  const s = base({ tasks: [task("a", "vk#9 验收 1111111", "completed"), task("b", "vk#9 验收 2222222", "failed"), task("c", "vk#9 验收 4444444", "blocked")] });
  assert.equal(hasAcceptTask(s, 9, "1111111"), true);
  assert.equal(hasAcceptTask(s, 9, "2222222"), false);
  assert.equal(hasAcceptTask(s, 9, "4444444"), false, "额度用尽被 worker-stop 的验收要能用千问重派");
  assert.equal(hasAcceptTask(s, 9, "3333333"), false);
});

test("收件箱：只有事实类消息就 ack；有提问或升级就留给协调器，不 ack", () => {
  assert.deepEqual(inboxVerdict([{ type: "worker_done" }, { type: "heartbeat" }, { type: "merge_ready" }]), { ack: true, needs: [] });
  const v = inboxVerdict([{ type: "worker_done" }, { type: "question", id: "q1" }]);
  assert.equal(v.ack, false);
  assert.deepEqual(v.needs.map((m) => m.id), ["q1"]);
});

test("orca --json 输出前面有 keepalive 行时，取最后一个完整 JSON", () => {
  const out = '{"_keepalive":true}\n{"_keepalive":true}\n{\n  "ok": true,\n  "result": {"x": 1}\n}\n';
  assert.deepEqual(lastJson(out), { ok: true, result: { x: 1 } });
  assert.equal(lastJson(""), null);
});

test("任务书：实现在 Orca 新建的 worktree 里从 origin/main 开分支；返工留在原分支；都写明 GitHub 交付物与 ask", () => {
  const impl = implSpec({ number: 3, title: "t", body: "## 验收口径\n- [ACC-x-01]", branch: "issue-3" });
  assert.match(impl, /git switch -c issue-3 origin\/main/);
  assert.match(impl, /Closes #3/);
  assert.match(impl, /ask 命令/);
  assert.match(impl, /bin\/ghx pr create/);
  const rw = reworkSpec({ number: 3, title: "t", pull: 4, branch: "issue-3", round: 2, commentUrl: "u", commentBody: "verdict: FAIL", body: "b" });
  assert.match(rw, /第 2 轮/);
  assert.match(rw, /git switch issue-3/);
  assert.match(rw, /不新建分支/);
});

test("验收任务书：在共用 worktree 里切到 PR head、验完恢复干净；判定后只发 worker_done，不另发 escalation", () => {
  const s = acceptSpec({ number: 3, title: "t", pull: 4, head: "abcdef0123", branch: "issue-3", acc: ["ACC-x-01"], round: 2 });
  assert.match(s, /git switch --detach abcdef0123/);
  assert.match(s, /git status 为空/);
  assert.match(s, /round: 2/);
  assert.match(s, /不另发 escalation \/ merge_ready/);
});

test("项目名：FLOW_PROJECT 优先，否则取 origin 仓库名（https / ssh / 带不带 .git），都没有用目录名", () => {
  assert.equal(projectName({ FLOW_PROJECT: "x" }, "https://github.com/a/b.git"), "x");
  assert.equal(projectName({}, "https://github.com/versekit-labs/versekit.git"), "versekit");
  assert.equal(projectName({}, "git@github.com:buxibuxi/trustbridge.git"), "trustbridge");
  assert.equal(projectName({}, "https://github.com/a/market-research"), "market-research");
  assert.equal(projectName({}, "", "/tmp/some/dir"), "dir");
});

test("Task 前缀可换：别的项目用自己的前缀，互不认", () => {
  assert.equal(taskTitle("impl", 5, "", "trustbridge"), "trustbridge#5 实现");
  assert.deepEqual(parseTaskTitle("trustbridge#5 验收 abc1234", "trustbridge"), { issue: 5, kind: "accept", extra: "abc1234" });
  assert.equal(parseTaskTitle("trustbridge#5 实现", "vk"), null);
  assert.equal(parseTaskTitle("vk#5 实现", "trustbridge"), null);
});

test("项目专属约束只从 .orca-kit/flow-rules.md 的对应小节取列表行；没有就是空", () => {
  const md = "# 说明\n\n## 实现\n- 实现规则 A\n说明文字不进任务书\n\n## 验收\n- 验收规则 B\n- 验收规则 C\n";
  assert.equal(projectRules("impl", md), "- 实现规则 A\n");
  assert.equal(projectRules("accept", md), "- 验收规则 B\n- 验收规则 C\n");
  assert.equal(projectRules("accept", "# 没有小节\n"), "");
});

test("by:coordinator 标记从看板的 labels 读", () => {
  const s = base({ board: { rows: [{ number: 8, labels: ["s:changes", "by:coordinator"] }, { number: 9, labels: ["s:changes"] }] } });
  assert.equal(hasLabel(s, 8, "by:coordinator"), true);
  assert.equal(hasLabel(s, 9, "by:coordinator"), false);
});

test("flow.json：没有就是默认；钩子只收非空字符串；release:false 与 inbox:external 生效；写坏回默认并报错", () => {
  const d = flowConfig("{}");
  assert.deepEqual(d, { hooks: { beforeTick: [], beforeMerge: [] }, release: true, inbox: "flow", ci: "npm run ci", settle: true, cleanup: true });
  assert.equal(flowConfig(JSON.stringify({ settle: false })).settle, false);
  assert.equal(flowConfig(JSON.stringify({ ci: "npm --prefix research-console run ci" })).ci, "npm --prefix research-console run ci");
  assert.equal(flowConfig(JSON.stringify({ ci: "  " })).ci, "npm run ci");
  const c = flowConfig(JSON.stringify({ hooks: { beforeTick: ["a", "", 3, "b"], beforeMerge: ["node bin/local-ci.mjs --pending"] }, release: false, inbox: "external" }));
  assert.deepEqual(c.hooks.beforeTick, ["a", "b"]);
  assert.deepEqual(c.hooks.beforeMerge, ["node bin/local-ci.mjs --pending"]);
  assert.equal(c.release, false);
  assert.equal(c.inbox, "external");
  assert.equal(flowConfig(JSON.stringify({ inbox: "whatever" })).inbox, "flow");
  const bad = flowConfig("{ 不是 json");
  assert.match(bad.error, /flow\.json 解析失败/);
  assert.equal(bad.release, true);
});

test("验收样例每条都带 evidence（有的项目闸门缺证据就拒绝合并）", () => {
  const spec = acceptSpec({ number: 1, title: "t", pull: 2, head: "abc1234", branch: "b", acc: ["ACC-a-01", "ACC-a-02"], round: 1 });
  assert.equal((spec.match(/^    evidence: /gm) ?? []).length, 4, "PASS、FAIL 两个样例各 2 条");
  assert.match(spec, /本地跑 npm run ci/);
});

test("协调器裁定：只取上一轮验收之后、以协调器开头的评论，最多 3 条；返工任务书带上并提示先合 main", () => {
  const c = (t, body) => ({ created_at: t, body, html_url: `u${t}` });
  const cs = [c("1", "协调器裁定：旧的"), c("3", "别人的评论"), c("4", "协调器：A"), c("5", "  协调器裁定 B"), c("6", "协调器:C"), c("7", "协调器：D")];
  const notes = coordinatorNotes(cs, "2");
  assert.doesNotMatch(notes, /旧的|别人/);
  assert.doesNotMatch(notes, /协调器：A/, "只留最近 3 条");
  assert.match(notes, /B[\s\S]*C[\s\S]*D/);
  assert.equal(coordinatorNotes(null), "");
  const spec = reworkSpec({ number: 1, title: "t", pull: 2, branch: "b", round: 1, commentUrl: "x", commentBody: "FAIL", body: "", notes });
  assert.match(spec, /协调器裁定（上一轮验收之后，原文，优先于工单旧口径）/);
  assert.match(spec, /先 git merge origin\/main/);
  assert.doesNotMatch(reworkSpec({ number: 1, title: "t", pull: 2, branch: "b", round: 1, commentUrl: "x", commentBody: "FAIL", body: "" }), /协调器裁定（/);
});

test("返工原因：认领结果自带 reasonComments 就照抄；上一轮是 PASS 要点明", () => {
  const reason = reasonText([{ author: "owner", createdAt: "2026-11-23", body: "标题再短一点" }]);
  assert.match(reason, /owner（2026-11-23）：\n标题再短一点/);
  assert.equal(reasonText(undefined), "");
  const spec = reworkSpec({ number: 1, title: "t", pull: 2, branch: "b", round: 1, commentUrl: "x", commentBody: "PASS", body: "", reason, lastVerdict: "PASS" });
  assert.match(spec, /验收已 PASS，本次返工原因见下方评论/);
  assert.match(spec, /返工原因（最近一条验收之后的评论）：\n- owner/);
  assert.doesNotMatch(reworkSpec({ number: 1, title: "t", pull: 2, branch: "b", round: 1, commentUrl: "x", commentBody: "FAIL", body: "", lastVerdict: "FAIL" }), /验收已 PASS|返工原因（/);
});

test("返工核查：记录对应的 dispatch 不在跑（或 Run 里找不到）才交给 rework-check", () => {
  const recs = [{ issue: 1, dispatch: "d1" }, { issue: 2, dispatch: "d2" }, { issue: 3, dispatch: "gone" }];
  const workers = [
    { dispatchId: "d1", dispatchStatus: "dispatched", terminalState: "live" },
    { dispatchId: "d2", dispatchStatus: "completed", terminalState: "exited" },
  ];
  assert.deepEqual(settledReworks(recs, workers).map((r) => r.issue), [2, 3]);
});

test("回收 worktree：只看关联了 issue、不是主仓库、不是脚本所在目录的；issue 还开着或还有没回收的终端就不动", () => {
  const list = [
    { id: "a", path: "/w/issue-1", linkedIssue: 1 },
    { id: "b", path: "/w/accept-2", linkedItems: [{ provider: "github", type: "issue", number: 2 }] },
    { id: "c", path: "/repo", linkedIssue: 3, isMainWorktree: true },
    { id: "d", path: "/w/coordinator", linkedIssue: 4 },
    { id: "e", path: "/w/design" },
  ];
  assert.equal(linkedIssueOf(list[1]), 2);
  assert.deepEqual(cleanupCandidates(list, { root: "/w/coordinator" }).map((w) => w.id), ["a", "b"]);
  const s = base({
    issues: { 5: "review" },
    tasks: [task("t6", "vk#6 验收 abc1234", "completed"), task("t7", "vk#7 实现", "completed")],
    workers: [
      { dispatchId: "d6", taskId: "t6", dispatchStatus: "completed", terminalState: "reclaimable" },
      { dispatchId: "d7", taskId: "t7", dispatchStatus: "completed", terminalState: "released" },
    ],
  });
  assert.equal(isActiveIssue(s, 5), true, "还开着");
  assert.equal(isActiveIssue(s, 6), true, "终端还没回收");
  assert.equal(isActiveIssue(s, 7), false);
});

test("回收 worktree：有改动、有不在远端的提交、有要留的被忽略文件就不删；依赖与缓存不算", () => {
  assert.equal(dirtyReason("", "0"), null);
  assert.equal(dirtyReason("!! node_modules/\n!! dist/\n!! .playwright-mcp/\n!! .impeccable/hook.cache.json\n!! packages/cli/node_modules/", "0"), null);
  assert.match(dirtyReason(" M a.js", "0"), /未提交/);
  assert.match(dirtyReason("?? new.txt", "0"), /未提交/);
  assert.match(dirtyReason("", "2"), /2 个提交不在任何远端/);
  assert.match(dirtyReason("!! .accept-evidence/ci.log", "0"), /被忽略但可能要留.*\.accept-evidence/);
  // 验收 #368 第 1 轮：任意层级的同名目录都算，按整段比
  assert.equal(dirtyReason("!! research-console/dist/\n!! a/b/node_modules/\n!! web/.DS_Store", "0"), null);
  assert.equal(dirtyReason("!! research-console/dist/app.js", "0"), null);
  for (const f of ["dist-config.json", "dist-archive/", "node_modules-backup/", "dist", "notes/dist"]) {
    assert.notEqual(dirtyReason(`!! ${f}`, "0"), null, f);
  }
});

test("返工放置：复用原终端时带上本单 worktree（否则 Orca 按 Run 所有者目录核对报 terminal_worktree_mismatch）", () => {
  const reuse = { agentTerminalHandle: "term_x", dispatchId: "d1" };
  assert.deepEqual(reworkPlacement(reuse, { id: "wt-267" }, 267), { terminal: "term_x", worktreeId: "wt-267" });
  assert.deepEqual(reworkPlacement(null, { id: "wt-267" }, 267), { worktreeId: "wt-267" });
  assert.deepEqual(reworkPlacement(null, null, 267), { name: "issue-267" });
});

test("返工：复用原终端失败就回收它、同一轮改派新 agent，不退回 s:changes", () => {
  const src = readFileSync(new URL("../../../bin/orca-flow.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("let reuse = reusableTerminal(state, c.number);"), src.indexOf("// 6. 实现"));
  assert.match(block, /catch \(err\) \{[\s\S]*?worker-release[\s\S]*?\}\s*\}\s*\}\s*if \(started === undefined\)/);
  assert.match(block, /reworkPlacement\(reuse, wt, c\.number\)/);
});

test("versekit 实现 / 返工任务书写明界面单证据包三件事（ACC-harness-orca-15）", () => {
  const rule = projectRules("impl", readFileSync(new URL("../../../.orca-kit/flow-rules.md", import.meta.url), "utf8"));
  for (const part of ["ACC-v3-fid-08", "1360 宽", "vk demo seed", "docs/design/screenshots/impl/", "docs/design/screenshots/v3/", "#fafaf8", "34px", "antialiased", "tabular-nums", "焦点环 2px", "#ffd84a"]) {
    assert.ok(rule.includes(part), `实现约束缺：${part}`);
  }
});

// ---- ACC-harness-route-02：Codex 额度用完，同一轮改派 Sonnet ----

const LIMIT = "■ You've hit your usage limit. Upgrade to Pro or try again at Nov 25th, 2099 3:41 AM.";
const TIP = "Tip: When signed in with ChatGPT, use /usage to check your account usage and access available usage limit resets.";

test("route-02：用量上限提示认得出（含时间解析）；只有 Tip 提示行不算；解析不出时间按 5 小时", () => {
  const now = Date.parse("2026-11-24T10:00:00");
  const hit = codexExhaustion(`working...\n${LIMIT}\n❯`, now);
  assert.equal(hit.text, "2099-11-25 03:41:00");
  assert.equal(hit.until, Math.floor(new Date(2099, 10, 25, 3, 41).getTime() / 1000));
  assert.equal(codexExhaustion(TIP, now), null);
  assert.equal(codexExhaustion(`${TIP}\nsome output\n`, now), null);
  const noTime = codexExhaustion("You've hit your usage limit.", now);
  assert.equal(noTime.until, Math.floor((now + 5 * 3600 * 1000) / 1000));
  // Tip 在上限提示之后也不盖掉它
  assert.ok(codexExhaustion(`${LIMIT}\n${TIP}`, now));
  assert.equal(codexExhaustion("hit usage limit of tokens in file foo.txt", now), null);
});

function fakeState(provider = "codex", { title = "vk#99999 实现", status = "dispatched", labels = [] } = {}) {
  return {
    tasks: [{ id: "t1", task_title: title, status, spec: "原任务书" }],
    workers: [{ dispatchId: "d1", taskId: "t1", dispatchStatus: "dispatched", terminalState: "owned", agentTerminalHandle: "term_1",
      resource: { worktreeId: "repo::/wt/issue-99999" }, projection: { liveness: { verdict: "live" }, provider: { id: provider } } }],
    board: { rows: [{ number: 99999, labels }] },
  };
}
function fakeIo(text) {
  const calls = [];
  return {
    calls,
    io: {
      read: () => text,
      stop: (id) => calls.push(["stop", id]),
      choose: (role, labels, round) => { calls.push(["choose", role, round]); return { agent: "claude", model: "sonnet", channel: "claude", reason: "cooldown" }; },
      createTask: (_c, t) => { calls.push(["task", t.title, t.spec]); return "t2"; },
      start: (_c, a) => { calls.push(["start", a.placement, a.channel.agent]); return { dispatchId: "d2", worktreeId: a.placement.worktreeId }; },
      link: () => {},
    },
  };
}

test("route-02：Codex worker 屏幕出现用量上限 → 写 codex-exhausted、停掉、同一轮在原 worktree 改派 Sonnet", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-route-"));
  const { io, calls } = fakeIo(`x\n${LIMIT}`);
  const out = rerouteExhaustedCodex(fakeState(), { runId: "r" }, { stateDir: dir, io });
  assert.deepEqual(out.map((o) => [o.issue, o.kind, o.dispatchId]), [[99999, "impl", "d2"]]);
  const body = readFileSync(join(dir, "codex-exhausted"), "utf8").trim();
  const [ts, text] = body.split("\t");
  assert.equal(text, "2099-11-25 03:41:00");
  assert.ok(Number(ts) > Date.now() / 1000);
  assert.deepEqual(calls.map((c) => c[0]), ["stop", "choose", "task", "start"]);
  assert.deepEqual(calls[3], ["start", { worktreeId: "repo::/wt/issue-99999" }, "claude"]);
  assert.match(calls[2][1], /^vk#99999 实现 sonnet$/);
  assert.match(calls[2][2], /原任务书[\s\S]*已有它的提交/);
  assert.equal(codexCooldown(dir)?.text, "2099-11-25 03:41:00");
});

test("route-02：只有 Tip 提示行、worker 不是 Codex、验收 worker、已结算 worker：什么都不做", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-route-"));
  for (const [state, text] of [
    [fakeState(), TIP],
    [fakeState("claude"), LIMIT],
    [fakeState("codex", { title: "vk#99999 验收 abc1234" }), LIMIT],
    [(() => { const s = fakeState(); s.workers[0].dispatchStatus = "completed"; return s; })(), LIMIT],
  ]) {
    const { io, calls } = fakeIo(text);
    assert.deepEqual(rerouteExhaustedCodex(state, { runId: "r" }, { stateDir: dir, io }), []);
    assert.deepEqual(calls, []);
  }
  assert.equal(existsSync(join(dir, "codex-exhausted")), false);
});

test("route-02：返工 worker 也改派（Task 标题带 -sonnet、round 传给选路）；dry-run 只记日志不动手", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-route-"));
  let { io, calls } = fakeIo(LIMIT);
  rerouteExhaustedCodex(fakeState("codex", { title: "vk#99999 返工 r1" }), { runId: "r" }, { stateDir: dir, io });
  assert.deepEqual(calls[1], ["choose", "rework", "1"]);
  assert.match(calls[2][1], /^vk#99999 返工 r1-sonnet$/);
  assert.deepEqual(parseTaskTitle("vk#99999 返工 r1-sonnet"), { issue: 99999, kind: "rework", extra: "r1-sonnet" });
  const dry = mkdtempSync(join(tmpdir(), "flow-route-"));
  ({ io, calls } = fakeIo(LIMIT));
  assert.deepEqual(rerouteExhaustedCodex(fakeState(), { runId: "r" }, { stateDir: dry, dryRun: true, io }), []);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(dry, "codex-exhausted")), false);
});

test("route-02：冷却期内派新单直接走 Sonnet，到点恢复 Codex（chooseChannel 读同一个冷却文件）", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-route-"));
  mkdirSync(join(dir, "bin"));
  const exe = (n, b) => { writeFileSync(join(dir, "bin", n), `#!/usr/bin/env bash\n${b}\n`); chmodSync(join(dir, "bin", n), 0o755); };
  exe("codex", 'echo "Logged in"; exit 0');
  exe("agy", "exit 0");
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: `${join(dir, "bin")}:/usr/bin:/bin:${process.env.PATH}`, STATE_DIR: dir, CLAUDE_PROBE: "0" });
  try {
    writeFileSync(join(dir, "codex-exhausted"), `${Math.floor(Date.now() / 1000) + 3600}\t2099-01-01 00:00:00\n`);
    assert.equal(chooseChannel("engineer", []).agent, "claude");
    writeFileSync(join(dir, "codex-exhausted"), `${Math.floor(Date.now() / 1000) - 5}\t过去\n`);
    assert.equal(chooseChannel("engineer", []).agent, "codex");
    // route-03：Neon 走 antigravity 通道，worker-start 带 --agent antigravity --model gemini-4-neon-high
    const neon = chooseChannel("engineer", ["model:neon"]);
    assert.deepEqual([neon.agent, neon.model], ["antigravity", "gemini-4-neon-high"]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

const REASON = "Agent startup blocked: agent-update-prompt";
const testHead = "a".repeat(40);
const flowScript = fileURLToPath(new URL("../../../bin/orca-flow.mjs", import.meta.url));

function boardIssue(number, state, file = null) {
  const scope = file ? `\n## 涉及\n- 改：\`${file}\`\n` : "";
  return {
    number, title: `工单 ${number}`, updated_at: new Date().toISOString(),
    body: `## 验收口径\n- [ACC-harness-route-06]\n${scope}`,
    labels: [{ name: `s:${state}` }],
  };
}

function startupAttempt(dispatchId, taskId, issue, agent) {
  return {
    dispatchId, taskId, terminalState: "reclaimable", dispatchStatus: "failed",
    projection: { provider: null, stage: { detail: "agent_readiness" } },
    resource: { worktreeId: `repo::/wt/issue-${issue}` },
    agent, model: { codex: "gpt-6.2-sol", antigravity: "gemini-4-neon-high", claude: "sonnet" }[agent],
  };
}

function fakeOrca() {
  const fs = require("node:fs");
  const path = process.env.FAKE_ORCA_STATE;
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  const [, , object, command, ...args] = process.argv;
  const arg = (name) => args[args.indexOf(name) + 1];
  const save = () => fs.writeFileSync(path, JSON.stringify(state));
  let result;
  switch (`${object} ${command}`) {
    case "orchestration run-show": result = { run: { coordinator_handle: "term_coordinator" } }; break;
    case "orchestration check": result = { messages: [] }; break;
    case "orchestration task-list": result = { tasks: state.tasks }; break;
    case "orchestration worker-list": result = { workers: state.workers }; break;
    case "orchestration worker-show": {
      const w = state.workers.find((row) => row.dispatchId === arg("--dispatch"));
      result = {
        dispatch: { id: w.dispatchId, status: w.dispatchStatus, lastFailure: state.reason },
        worker: { stage: w.projection.stage.detail, worktreeId: w.resource.worktreeId, startOptions: { launch: { effective: { agent: w.agent, model: w.model } } } },
      };
      break;
    }
    case "orchestration worker-release":
      state.workers.find((row) => row.dispatchId === arg("--dispatch")).terminalState = "released";
      save();
      result = {};
      break;
    case "orchestration task-create": {
      const task = { id: `new-task-${state.tasks.length}`, task_title: arg("--task-title"), spec: arg("--spec") };
      state.tasks.unshift(task);
      save();
      result = { task };
      break;
    }
    case "orchestration worker-start": {
      const taskId = arg("--task");
      const issue = Number(/#(\d+)/.exec(state.tasks.find((row) => row.id === taskId).task_title)[1]);
      const agent = arg("--agent");
      const model = arg("--model");
      const retryOf = args.includes("--retry-of") ? arg("--retry-of") : null;
      const dispatchId = `start-${state.starts.length + 1}`;
      const worktree = arg("--worktree");
      const worktreeId = worktree === "new-top-level" ? `repo::/wt/issue-${issue}` : worktree.slice(3);
      const fail = state.fail[issue]?.includes(agent);
      state.starts.push({ issue, taskId, agent, model, retryOf, dispatchId, worktree });
      state.workers.unshift({
        dispatchId, taskId, agent, model,
        dispatchStatus: fail ? "failed" : "dispatched", terminalState: fail ? "reclaimable" : "active",
        resource: { worktreeId }, projection: { stage: { detail: fail ? "agent_readiness" : "ready" }, provider: null },
      });
      save();
      if (fail) {
        process.stdout.write(JSON.stringify({ ok: false, error: { message: state.reason, data: { dispatchId, failedStage: "agent_readiness" } } }));
        process.exit(1);
      }
      result = { status: "ready", dispatchId, effects: [{ kind: "worktree", id: worktreeId }] };
      break;
    }
    case "worktree list": result = { worktrees: [] }; break;
    case "worktree set": result = {}; break;
    default: throw new Error(`unexpected orca command: ${object} ${command}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

async function offlineTick(t, { issues, pulls = [], tasks = [], workers = [], fail = {}, lanes = 2 }) {
  const dir = mkdtempSync(join(testState, "tick-"));
  const fixture = join(dir, "orca.json");
  const flowLog = join(dir, "orca-flow.log");
  writeFileSync(fixture, JSON.stringify({ tasks, workers, fail, reason: REASON, starts: [] }));
  writeFileSync(join(dir, "run"), "offline-run");
  writeFileSync(join(dir, "orca"), `#!/usr/bin/env node\n(${fakeOrca})();\n`, { mode: 0o755 });
  writeFileSync(join(dir, "codex"), "#!/bin/sh\necho 'Logged in'\n", { mode: 0o755 });
  // CI 的 HEAD 可能是 detached。测试让协调器钩子看到分支，并拦住任何真实 fetch / checkout。
  writeFileSync(join(dir, "git"), `#!/bin/sh
case "$1" in
  symbolic-ref) echo refs/heads/offline; exit 0 ;;
  fetch|checkout) exit 87 ;;
esac
PATH="$FIXTURE_PATH" exec git "$@"
`, { mode: 0o755 });
  writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$1 $2" in
  "auth token") echo fixture ;;
  "api --paginate") printf '%s\\n' "$FIXTURE_PULLS" ;;
  *) exit 87 ;;
esac
`, { mode: 0o755 });
  const labelChanges = [];
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/repos\/example\/versekit\//, "");
    const [, number, label] = /^issues\/(\d+)(?:\/labels(?:\/(.*))?)?$/.exec(path) ?? [];
    const issue = issues.find((row) => row.number === Number(number));
    let data;
    if (req.method === "GET") {
      if (path === "issues") data = issues;
      else if (path === "pulls") data = pulls;
      else if (/^issues\/\d+\/comments$/.test(path)) data = [{ body: `verdict: FAIL\nhead_sha: ${testHead}\n` }];
      else data = issue;
    } else if (req.method === "DELETE" && issue?.labels.some((l) => l.name === label)) {
      issue.labels = issue.labels.filter((l) => l.name !== label);
      data = issue.labels;
    } else if (req.method === "POST" && issue && path.endsWith("/labels")) {
      let input = "";
      for await (const chunk of req) input += chunk;
      for (const name of JSON.parse(input).labels) {
        issue.labels.push({ name });
        labelChanges.push([issue.number, name]);
      }
      data = issue.labels;
    }
    res.writeHead(data === undefined ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data ?? path));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const env = {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_ORCA_STATE: fixture,
    FIXTURE_PATH: process.env.PATH, FIXTURE_PULLS: JSON.stringify([pulls]),
    FLOW_REPO_ID: "repo", FLOW_PROJECT: "versekit", FLOW_TASK_PREFIX: "vk", FLOW_LANES: String(lanes), FLOW_ACCEPT_MAX: "0",
    FLOW_STATE_DIR: dir, FLOW_LOG: flowLog, STATE_DIR: dir, RUN_FILE: join(dir, "run"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "https://github.com/example/versekit.git",
    GIT_ALLOW_PROTOCOL: "file", GH_TOKEN: "fixture", AGENTCTL_API_BASE: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_PROBE: "0", CODEX_BIN: "codex", IMPL_CHANNEL: "", IMPL_MODEL: "",
  };
  return {
    labelChanges,
    async tick() {
      let code = 0;
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [flowScript, "tick", "--json"], { env, timeout: 20_000 }).catch((err) => {
        code = err.code;
        return err;
      });
      assert.ok(code === 0 || code === 10, stderr);
      const report = JSON.parse(stdout);
      assert.deepEqual(report.errors, []);
      return { report, code, log: readFileSync(flowLog, "utf8"), ...JSON.parse(readFileSync(fixture, "utf8")) };
    },
  };
}

test("route-06：已结算的 Codex 实现和 Neon 返工同轮复用原 worktree，Codex 两次失败后本轮新单走 Sonnet", async (t) => {
  const runner = await offlineTick(t, {
    issues: [boardIssue(406, "doing", "bin/orca-flow.mjs"), boardIssue(407, "doing", "bin/worker-channel.sh"), boardIssue(408, "ready", "README.md")],
    pulls: [{ number: 500, body: "Closes #407", head: { sha: testHead, ref: "issue-407" } }],
    tasks: [task("impl", "vk#406 实现", "failed"), task("rework", "vk#407 返工 r1", "failed")],
    workers: [
      startupAttempt("d2", "impl", 406, "codex"),
      startupAttempt("r1", "rework", 407, "antigravity"),
      { ...startupAttempt("d1", "impl", 406, "codex"), terminalState: "released" },
    ],
    lanes: 3,
  });
  const result = await runner.tick();
  assert.equal(result.code, 0);
  assert.deepEqual(result.starts.map(({ issue, taskId, agent, model, retryOf, worktree }) => [issue, taskId, agent, model, retryOf, worktree]), [
    [406, "impl", "claude", "sonnet", "d2", "id:repo::/wt/issue-406"],
    [407, "rework", "claude", "sonnet", "r1", "id:repo::/wt/issue-407"],
    [408, "new-task-2", "claude", "sonnet", null, "new-top-level"],
  ]);
  assert.deepEqual(result.report.dispatched.map(({ issue, kind, rerouted }) => [issue, kind, rerouted]), [
    [406, "impl", true], [407, "rework", true], [408, "impl", undefined],
  ]);
  assert.match(result.log, /#406 Codex 启动失败（Agent startup blocked: agent-update-prompt）→ 改派 Sonnet/);
  assert.match(result.log, /#407 Neon 启动失败（Agent startup blocked: agent-update-prompt）→ 改派 Sonnet/);
  assert.ok(result.workers.filter((w) => ["d2", "r1"].includes(w.dispatchId)).every((w) => w.terminalState === "released"));
  assert.deepEqual(runner.labelChanges, [[408, "s:doing"]]);
  assert.equal((await runner.tick()).starts.length, 3, "下一轮不会重试已有新 worker 的旧 Dispatch");
});

test("route-06：worker-start 当场失败便原地改派，Sonnet 也失败则本轮退回 ready 并告警", async (t) => {
  const runner = await offlineTick(t, {
    issues: [boardIssue(406, "ready", "bin/orca-flow.mjs"), boardIssue(407, "ready", "README.md")],
    fail: { 406: ["codex", "claude"] },
  });
  const { starts, log, code, report } = await runner.tick();
  assert.deepEqual(starts.map(({ issue, agent, retryOf, worktree }) => [issue, agent, retryOf, worktree]), [
    [406, "codex", null, "new-top-level"],
    [406, "claude", "start-1", "id:repo::/wt/issue-406"],
    [407, "codex", null, "new-top-level"],
  ]);
  assert.deepEqual(runner.labelChanges, [[406, "s:doing"], [407, "s:doing"], [406, "s:ready"]]);
  assert.equal(code, 10);
  assert.deepEqual(report.needsCoordinator.map(({ issue }) => issue), [406]);
  assert.match(log, /⚠ 需要协调器：#406 Sonnet 启动失败（Agent startup blocked: agent-update-prompt）→ 退回 s:ready/);
});

test("route-06：已结算且无 PR、无 worker_done 的 doing 工单每轮只报一次", async (t) => {
  const frozen = boardIssue(409, "doing");
  frozen.labels.push({ name: "hold:human" });
  const runner = await offlineTick(t, {
    issues: [boardIssue(406, "doing"), boardIssue(407, "doing"), boardIssue(408, "doing"), frozen],
    pulls: [
      { number: 500, body: "Closes #407", head: { sha: testHead, ref: "issue-407" } },
      { number: 501, head: { sha: testHead, ref: "issue-409" } },
    ],
    tasks: [task("orphan", "vk#406 实现", "completed"), task("running", "vk#408 实现")],
    workers: [worker("closed", "orphan", { dispatchStatus: "completed", terminalState: "released" }), worker("live", "running")],
  });
  for (let rounds = 1; rounds <= 2; rounds++) {
    const { code, log, report, starts } = await runner.tick();
    assert.equal(code, 10);
    assert.deepEqual(report.needsCoordinator.map(({ body }) => body), ["#406 在 s:doing 但没人在做"]);
    assert.equal(log.match(/⚠ 需要协调器：#406 在 s:doing 但没人在做/g).length, rounds);
    assert.deepEqual(starts, []);
  }
  assert.deepEqual(runner.labelChanges, []);
});

test("不合并的原因并进同一行写进流程日志（ACC-harness-orca-16）", () => {
  const out = "✓ 合并 #1（PR #2 → abc1234）\n✗ 不合并 #395：\n    - CI 还没跑完：test\n    - verdict 的 head_sha 与 PR head 不一致\n↩ #7 已打回 s:changes\n· 无关的行";
  assert.deepEqual(transcribeAgentctl(out), [
    "✓ 合并 #1（PR #2 → abc1234）",
    "✗ 不合并 #395：CI 还没跑完：test；verdict 的 head_sha 与 PR head 不一致",
    "↩ #7 已打回 s:changes",
  ]);
  assert.deepEqual(transcribeAgentctl("✗ 不合并 #9："), ["✗ 不合并 #9："]);
  assert.deepEqual(transcribeAgentctl(""), []);
});

test("通用约束只禁改已有的 API、schema、命令，口径要的新增可以加（ACC-harness-orca-17）", () => {
  const src = readFileSync(new URL("../../../bin/orca-flow.mjs", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.startsWith("const commonConstraints"));
  assert.ok(line.includes("不改已有的 API 形状、数据库 schema 和 commands.mjs 里已有的命令定义"));
  assert.ok(line.includes("口径要求新增的命令、字段、表，可以向后兼容地加"));
  assert.ok(!line.includes("不改 api 形状"));
});

test("实现 / 返工 worker 还在跑的单不派验收（ACC-harness-orca-18）", () => {
  const state = {
    tasks: [
      { id: "t1", task_title: taskTitle("impl", 398) },
      { id: "t2", task_title: taskTitle("rework", 401, "r1") },
      { id: "t3", task_title: taskTitle("accept", 402, "abc1234") },
      { id: "t4", task_title: taskTitle("impl", 403) },
    ],
    workers: [
      { dispatchId: "d1", taskId: "t1", dispatchStatus: "dispatched", projection: { liveness: { verdict: "live" } } },
      { dispatchId: "d2", taskId: "t2", dispatchStatus: "dispatched", projection: { liveness: { verdict: "live" } } },
      { dispatchId: "d3", taskId: "t3", dispatchStatus: "dispatched", projection: { liveness: { verdict: "live" } } },
      { dispatchId: "d4", taskId: "t4", dispatchStatus: "completed", projection: { liveness: { verdict: "live" } } },
    ],
  };
  assert.deepEqual([...buildingIssues(state)].sort(), [398, 401]);
  const src = readFileSync(new URL("../../../bin/orca-flow.mjs", import.meta.url), "utf8");
  assert.match(src, /buildingIssues\(state\)\.has\(q\.number\)/);
});
