// harness 的判定规则必须被钉住：这些函数决定"能不能派工、能不能合并"，
// 一旦漂了，流水线会静默放行——比报错危险得多。
//
// 判定规则用纯函数测试，CLI 用本地 mock API。import agentctl 无副作用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

const verdictHead = "abc12345".repeat(5);
const verdictFormats = [
  ["id/status", "  - id: ACC-x\n    status: pass\n  - id: ACC-y\n    status: pass"],
  ["item/status", "  - item: ACC-x\n    status: pass\n  - item: ACC-y\n    status: pass"],
  ["id/result", "  - id: ACC-x\n    result: pass\n  - id: ACC-y\n    result: pass"],
  ["行内列表", "  - {id: ACC-x, status: pass}\n  - {id: ACC-y, status: pass}"],
  ["映射", "  ACC-x: pass\n  ACC-y: pass"],
];
const verdictComment = (yaml) => `\`\`\`yaml\nverdict: PASS\nhead_sha: ${verdictHead}\n${yaml}\n\`\`\``;

for (const [name, entries] of verdictFormats) {
  test(`parseVerdict：${name} 解析成相同的逐条结果`, () => {
    const parsed = parseVerdict(verdictComment(`acceptance:\n${entries}`));
    assert.deepEqual(parsed.acceptance, [
      { id: "ACC-x", status: "pass" },
      { id: "ACC-y", status: "pass" },
    ]);
  });
}

const uncoveredVerdicts = [
  ["failed 段", `acceptance:
  - id: ACC-y
    status: pass
failed:
  - item: ACC-x
    status: pass`],
  ["冲突", `acceptance:
  - id: ACC-x
    status: pass
  - item: ACC-x
    result: fail
  - {id: ACC-x, status: pass}
  - id: ACC-y
    status: pass`],
  ["非法状态", `acceptance:
  - id: ACC-x
    status: 待人工
  - id: ACC-y
    status: pass`],
];

test("parseVerdict：只读 acceptance，fail 优先，只认完整的 pass/fail", () => {
  const [outside, conflict, invalid] = uncoveredVerdicts.map(([, yaml]) => parseVerdict(verdictComment(yaml)).acceptance);
  assert.deepEqual(outside, [{ id: "ACC-y", status: "pass" }]);
  assert.deepEqual(conflict, [{ id: "ACC-x", status: "fail" }, { id: "ACC-y", status: "pass" }]);
  assert.deepEqual(invalid, [{ id: "ACC-x", status: null }, { id: "ACC-y", status: "pass" }]);

  const nearMisses = parseVerdict(verdictComment(`acceptance:
  - id: ACC-x
    status: pass-later
  - id: ACC-y
    note:
      status: pass
  - id: ACC-z
failed:
  - id: ACC-z
    status: pass`));
  assert.deepEqual(nearMisses.acceptance.map(({ status }) => status), [null, null, null]);
});

test("merge --pending --dry-run：五种写法都通过覆盖检查，缺项仍被拦下", async (t) => {
  const verdicts = [
    ...verdictFormats.map(([, entries]) => verdictComment(`acceptance:\n${entries}`)),
    ...uncoveredVerdicts.map(([, yaml]) => verdictComment(yaml)),
  ];
  const issues = verdicts.map((_, index) => ({ number: index + 1, labels: ["s:accept"], body: "ACC-x、ACC-y" }));
  const pulls = issues.map(({ number }) => ({
    number: number + 100,
    body: `Closes #${number}`,
    head: { sha: verdictHead },
    state: "open",
  }));
  const routes = new Map([
    ["issues", issues],
    ["pulls", pulls],
    [`commits/${verdictHead}/check-runs`, {
      check_runs: [
        "test / npm test",
        "parity / 命令表 = 路由 = 卡片 = CLI",
        "adapter-contract / 形状 + ready + dry-run 无副作用",
        "no-backdoor / web 与 channel 不得直连数据库",
        "design / 任务书 · 导航 · 死链 · 检测器 · 触控",
      ].map((name) => ({ name, status: "completed", conclusion: "success" })),
    }],
    ...pulls.map(({ number }, index) => [`issues/${number}/comments`, [{ id: number, body: verdicts[index] }]]),
    ["issues/1", issues[0]],
  ]);
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname.replace(/^\/repos\/example\/versekit\//, "");
    const data = req.method === "GET" && routes.get(path);
    res.writeHead(data ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(data || `${req.method} ${path}`));
  });
  t.after(() => server.close());
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));

  const script = fileURLToPath(new URL("../../../bin/agentctl.mjs", import.meta.url));
  const run = async (...args) => {
    const { stdout } = await promisify(execFile)(process.execPath, [script, ...args, "--dry-run", "--json"], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.url",
        GIT_CONFIG_VALUE_0: "https://github.com/example/versekit.git",
        GH_TOKEN: "fixture",
        AGENTCTL_API_BASE: `http://127.0.0.1:${server.address().port}`,
      },
      timeout: 10_000,
    });
    return JSON.parse(stdout);
  };
  const { results } = await run("merge", "--pending");
  assert.deepEqual(results, issues.map(({ number }, index) => index < verdictFormats.length
    ? { issue: number, merged: false, dryRun: true, pull: number + 100, head: verdictHead }
    : { issue: number, merged: false, problems: ["verdict 没有逐条覆盖：ACC-x"] }));

  const { body } = await run("reject", "--issue", "1", "--item", "ACC-harness-verdict-02",
    "--expected", "显示确认消息", "--observed", "没有提示", "--repro", "修改标题并保存");
  assert.match(body, /\nfailed:\n  - id: ACC-harness-verdict-02\n/);
  assert.equal(parseVerdict(body).verdict, "FAIL");
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
  const fail = (id, round) => ({ id, body: "```yaml\nverdict: FAIL\nround: " + round + "\nhead_sha: abc1234\nfailed:\n  - item: ACC-x\n```" });
  const voidOf = (id, target) => ({ id, body: "<!-- agent-verdict-void -->\n原因：账号掉线\n\nvoids: " + target });
  // listComments 的顺序：新的在前。
  const comments = [voidOf(40, 30), fail(30, 3), fail(20, 2), { id: 15, body: "随便聊聊" }, fail(10, 1)];

  assert.deepEqual([...voidedCommentIds(comments)], ["30"]);
  assert.equal(latestVerdict(comments).commentId, 20, "被作废的那条不能再当最新判定");
  assert.equal(latestFail(comments).commentId, 20);
  assert.equal(latestFail(comments).body, fail(20, 2).body, "返工任务书仍拿到旧 item 格式的 FAIL 原文");
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
