// bin/orca-flow.mjs 的纯逻辑（ACC-harness-orca-03..07）：不碰 orca / GitHub。
import { test } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  taskTitle, parseTaskTitle, isActive, planCompletion, countActive, reusableTerminal,
  hasAcceptTask, inboxVerdict, lastJson, implSpec, reworkSpec, acceptSpec,
  projectName, projectRules, hasLabel, flowConfig, coordinatorNotes, reasonText, settledReworks,
  linkedIssueOf, cleanupCandidates, dirtyReason, isActiveIssue, reworkPlacement,
  codexExhaustion, codexCooldown, rerouteExhaustedCodex, chooseChannel,
} from "../../../bin/orca-flow.mjs";

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
  assert.match(block, /catch \(err\) \{[\s\S]*?worker-release[\s\S]*?\}\s*\}\s*\}\s*if \(!started\)/);
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
