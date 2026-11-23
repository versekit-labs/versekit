// bin/orca-flow.mjs 的纯逻辑（ACC-harness-orca-03..07）：不碰 orca / GitHub。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskTitle, parseTaskTitle, isActive, planCompletion, countActive, reusableTerminal,
  hasAcceptTask, inboxVerdict, lastJson, implSpec, reworkSpec, acceptSpec,
  projectName, projectRules, hasLabel, flowConfig, coordinatorNotes, reasonText, settledReworks,
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
  assert.deepEqual(d, { hooks: { beforeTick: [], beforeMerge: [] }, release: true, inbox: "flow", ci: "npm run ci", settle: true });
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
