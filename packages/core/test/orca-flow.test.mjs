// bin/orca-flow.mjs 的纯逻辑（ACC-harness-orca-03..07）：不碰 orca / GitHub。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskTitle, parseTaskTitle, isActive, planCompletion, countActive, reusableTerminal,
  hasAcceptTask, inboxVerdict, lastJson, implSpec, reworkSpec, acceptSpec,
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

test("同一 issue 同一 head 建过验收 Task 就不重复建；失败的可以重建；换了 head 要重验", () => {
  const s = base({ tasks: [task("a", "vk#9 验收 1111111", "completed"), task("b", "vk#9 验收 2222222", "failed")] });
  assert.equal(hasAcceptTask(s, 9, "1111111"), true);
  assert.equal(hasAcceptTask(s, 9, "2222222"), false);
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
