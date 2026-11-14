// harness 的判定规则必须被钉住：这些函数决定"能不能派工、能不能合并"，
// 一旦漂了，流水线会静默放行——比报错危险得多。
//
// 这里只测纯函数，不碰网络。agentctl 作为脚本执行时才跑 main()，import 无副作用。

import { test } from "node:test";
import assert from "node:assert/strict";

import { TRANSITIONS, canTransition, issueAccIds, parseVerdict, validateScope } from "../../../bin/agentctl.mjs";

test("迁移表：只放行定义过的边", () => {
  // 正常接力
  assert.equal(canTransition("triage", "ready"), true);
  assert.equal(canTransition("ready", "doing"), true);
  assert.equal(canTransition("doing", "review"), true);
  assert.equal(canTransition("review", "accept"), true);
  assert.equal(canTransition("accept", "done"), true);

  // 人工验收打回：已合并的 issue 也能回到 changes，不用新建 issue
  assert.equal(canTransition("accept", "changes"), true);
  assert.equal(canTransition("done", "changes"), true);
  assert.equal(canTransition("review", "changes"), true);

  // 派工失败回滚
  assert.equal(canTransition("doing", "ready"), true);

  // 跳步一律拒绝
  assert.equal(canTransition("ready", "done"), false);
  assert.equal(canTransition("review", "done"), false);
  assert.equal(canTransition("changes", "accept"), false);

  // 撞号不算迁移，避免误报
  assert.equal(canTransition("doing", "doing"), true);

  // 表覆盖了所有状态：漏一个状态会让那个 issue 永远无法迁移
  for (const from of Object.keys(TRANSITIONS)) {
    assert.ok(Array.isArray(TRANSITIONS[from]), `${from} 的迁移列表必须是数组`);
  }
});

test("issueAccIds：去重、保序、去掉尾随标点", () => {
  const body = "口径：ACC-account-01、ACC-account-02, 以及 ACC-account-01。另见 ACC-calendar-03";
  assert.deepEqual(issueAccIds(body), ["ACC-account-01", "ACC-account-02", "ACC-calendar-03"]);
  assert.deepEqual(issueAccIds("没有条目"), []);
  assert.deepEqual(issueAccIds(null), []);
});

test("parseVerdict：只认 yaml 块，不从散文里猜", () => {
  const pass = parseVerdict(
    "## 结论\n\n```yaml\nverdict: PASS\nround: 2\nhead_sha: \"abc1234\"\nacceptance:\n  - id: ACC-account-01\n    status: pass\n  - id: ACC-account-02\n    status: pass\n```\n",
  );
  assert.equal(pass.verdict, "PASS");
  assert.equal(pass.headSha, "abc1234");
  assert.equal(pass.round, 2);
  assert.deepEqual(pass.acceptance, [
    { id: "ACC-account-01", status: "pass" },
    { id: "ACC-account-02", status: "pass" },
  ]);

  const fail = parseVerdict("```yaml\nverdict: FAIL\nhead_sha: def5678\nfailed:\n  - item: ACC-x-01\n```");
  assert.equal(fail.verdict, "FAIL");
  assert.deepEqual(fail.acceptance, []);

  // 证据包 YAML 在前、判定 YAML 在后：必须找到带 verdict 的那块
  const mixed = parseVerdict(
    "```yaml\nissue: 42\ngates:\n  test: pass\n```\n\n```yaml\nverdict: PASS\nhead_sha: abc1234\nacceptance:\n  - id: ACC-x-01\n    status: pass\n```\n",
  );
  assert.equal(mixed?.verdict, "PASS");
  assert.deepEqual(mixed?.acceptance, [{ id: "ACC-x-01", status: "pass" }]);

  // 散文里写"全部通过"但没有机器可读块 = 没有判定
  assert.equal(parseVerdict("我检查过了，全部通过。"), null);
  assert.equal(parseVerdict("```yaml\nround: 1\n```"), null);
  assert.equal(parseVerdict(undefined), null);
});

test("validateScope：引用不到的 ACC 条目不算口径齐", () => {
  const ok = validateScope({ body: "口径：ACC-account-01" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ids, ["ACC-account-01"]);

  const missing = validateScope({ body: "口径：ACC-not-a-real-item-99" });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /不存在/);

  const empty = validateScope({ body: "把账号页做好" });
  assert.equal(empty.ok, false);
  assert.match(empty.why, /没有任何 ACC/);
});
test("作废的 FAIL：不再是最新判定，也不计返工轮次", async () => {
  const { latestVerdict, latestFail, effectiveFailCount, voidedCommentIds } = await import("../../../bin/agentctl.mjs");
  const fail = (id, round) => ({ id, body: "```yaml\nverdict: FAIL\nround: " + round + "\nhead_sha: abc1234\n```" });
  const voidOf = (id, target) => ({ id, body: "<!-- agent-verdict-void -->\n原因：账号掉线\n\nvoids: " + target });
  // listComments 的顺序：新的在前。
  const comments = [voidOf(40, 30), fail(30, 3), fail(20, 2), { id: 15, body: "随便聊聊" }, fail(10, 1)];

  assert.deepEqual([...voidedCommentIds(comments)], ["30"]);
  assert.equal(latestVerdict(comments).commentId, 20, "被作废的那条不能再当最新判定");
  assert.equal(latestFail(comments).commentId, 20);
  assert.equal(effectiveFailCount(comments), 2, "环境原因的 FAIL 不计轮次");

  // 没有作废评论时行为不变。
  const plain = [fail(30, 3), fail(20, 2), fail(10, 1)];
  assert.equal(latestVerdict(plain).commentId, 30);
  assert.equal(effectiveFailCount(plain), 3);

  // 只有带标记的评论才能作废：正文里随手写一行 voids: 不算。
  const fake = [{ id: 41, body: "voids: 30" }, fail(30, 3)];
  assert.equal(latestVerdict(fake).commentId, 30);

  // 全部作废 = 没有判定（等重新验收），而不是回退到更早的结论之外的猜测。
  assert.equal(latestVerdict([voidOf(11, 10), fail(10, 1)]), null);
});
