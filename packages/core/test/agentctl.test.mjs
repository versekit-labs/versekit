// harness 的判定规则必须被钉住：这些函数决定"能不能派工、能不能合并"，
// 一旦漂了，流水线会静默放行——比报错危险得多。
//
// 判定规则用纯函数测试，CLI 用本地 mock API。import agentctl 无副作用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { TRANSITIONS, canTransition, issueAccIds, parseVerdict, planQueueRelease, validateScope } from "../../../bin/agentctl.mjs";

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

test("parseVerdict：读结构化 YAML，不从散文里猜", () => {
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
  assert.deepEqual(fail.failed, [{ id: "ACC-x-01" }]);

  // 证据包 YAML 在前、判定 YAML 在后：必须找到带 verdict 的那块
  const mixed = parseVerdict(
    "```yaml\nissue: 42\ngates:\n  test: pass\n```\n\n```yaml\nverdict: PASS\nhead_sha: abc1234\nacceptance:\n  - id: ACC-x-01\n    status: pass\n```\n",
  );
  assert.equal(mixed?.verdict, "PASS");
  assert.deepEqual(mixed?.acceptance, [{ id: "ACC-x-01", status: "pass" }]);

  // 散文里写"全部通过"但没有机器可读块 = 没有判定
  assert.equal(parseVerdict("我检查过了，全部通过。"), null);
  assert.equal(parseVerdict("判定示例\n\nverdict: PASS\nhead_sha: abc1234"), null);
  assert.equal(parseVerdict("```yaml\nround: 1\n```"), null);
  assert.equal(parseVerdict(undefined), null);
});

const verdictHead = "abc12345".repeat(5);

// PR #320 评论 7065173194 的原始 YAML，协调器补上的围栏和说明未包含在内。
const bareFailVerdict = String.raw`verdict: FAIL
round: 2
head_sha: "c1dccb775674d9d0a39d702989bea83162f6c9a6"
acceptance:
  - id: ACC-v3-egress-01
    status: pass
  - id: ACC-v3-egress-02
    status: pass
  - id: ACC-v3-egress-03
    status: fail
  - id: ACC-v3-egress-04
    status: pass
  - id: ACC-v3-egress-05
    status: fail
  - id: ACC-v3-egress-06
    status: pass
  - id: ACC-v3-device-04
    status: pass
  - id: ACC-arch-09
    status: pass
  - id: ACC-harness-ci-01
    status: pass
failed:
  - id: ACC-v3-egress-03
    expected: "上次在 CN 登录成功后，第一次探测如果是 JP 代理出口，这个账号应暂停自动发布（队列不领取）"
    observed: "小红书扫码/短信/窗口登录成功时只把 account.state 写成 ok（store.setAccountState），从不调用 egress.recordLogin；account.check 在 state 已是 ok 且 last_ok_at 非空时也不会补记。首次探测把 JP 当成基线（source=first_probe），paused=[]，闸门不触发；即使稍后补一次 check，也是在 check 那一刻探测，代理开着时仍会记成 JP。实现方测试直接调用 recordLogin，绕过了真实登录路径。"
    repro:
      - "VK_HOME=$(mktemp -d) npm run vk -- demo seed"
      - "把演示小红书账号置 state='expired', last_ok_at=NULL，然后只执行 store.setAccountState(id,'ok')（vk.mjs 的 qrStatus/窗口登录成功时唯一的账号写操作）"
      - "在 $VK_HOME/.local/state/versekit/geo 放一个把 192.0.2.0/24 标成 JP 的小 mmdb；egress.setPageText 返回 {\"ip\":\"192.0.2.7\"}，再调 egress.probeNow()"
      - "实测 paused=[]，egress.baselines[id]={country:'JP',source:'first_probe'}；期望 paused 包含该账号、基线是登录时的 CN"
  - id: ACC-v3-egress-05
    expected: "暂停期间确认面板写明所有暂停平台；暂停行的确认提示是「其中 N 条等位置处理完再发」，不说「现在开始发」"
    observed: "批量底栏只写「TikTok、B站的出口位置变了」，漏掉同样暂停的小红书；小红书暂停时确认面板的块仍显示正常时间，点「现在发」的 toast 是「好，现在就发这一条」，随后块内显示「已确认，正在发」，没有「暂停中」，也没有「等位置处理完再发」。"
    repro:
      - "VK_HOME=$(mktemp -d) npm run vk -- demo seed"
      - "给长片补一条小红书 pending_confirm 平台稿；把 meta 的 egress.state 设成两条线路都在 JP，egress.baselines 设成 CN"
      - "VK_HOME=... npm run vk -- serve --offline --port 8788，打开 http://127.0.0.1:8788/today"
      - "点小红书那条的「现在发」：toast「好，现在就发这一条」，块内变「已确认，正在发」；底部只写「TikTok、B站的出口位置变了」"`;
const bareFailHead = "c1dccb775674d9d0a39d702989bea83162f6c9a6";

test("ACC-harness-verdict-04：解析 PR #320 原始裸 YAML 判定及失败详情", () => {
  const { verdict, headSha, round, acceptance, failed } = parseVerdict(bareFailVerdict);
  assert.deepEqual({ verdict, headSha, round }, { verdict: "FAIL", headSha: bareFailHead, round: 2 });
  assert.equal(acceptance.length, 9);
  assert.deepEqual(acceptance.filter(({ status }) => status === "fail").map(({ id }) => id),
    ["ACC-v3-egress-03", "ACC-v3-egress-05"]);
  assert.deepEqual(failed.map(({ id }) => id), ["ACC-v3-egress-03", "ACC-v3-egress-05"]);
  assert.match(failed[0].expected, /第一次探测如果是 JP/);
  assert.match(failed[0].observed, /paused=\[\]/);
  assert.match(failed[0].repro[2], /返回 \{"ip":"192\.0\.2\.7"\}/);
  assert.equal(failed[1].repro.length, 4);
});

test("orca-flow：验收任务书含落后 main 的判定规则，两份判定样例都能被 parseVerdict 读出", async () => {
  const { acceptSpec } = await import("../../../bin/orca-flow.mjs");
  const stdout = acceptSpec({ number: 264, title: "验收样例", pull: 265, head: verdictHead, branch: "issue-264", acc: ["ACC-example-01", "ACC-example-02"], round: 1 });
  assert.equal(stdout.split("\n")[0], `目标：验收 issue #264 验收样例 的 PR #265（head ${verdictHead}）。`);
  assert.match(stdout, /PR head 落后 main 时，.*只在 head 上失败.*本 PR 没改过的文件.*main 上已修好.*CLEAN.*按合并 main 后的结果判定.*本 PR 改过的文件时按 head 判定/);
  const verdicts = [...stdout.matchAll(/```yaml\n[\s\S]*?\n```/g)].map(([block]) => parseVerdict(block));
  assert.deepEqual(verdicts.map(({ verdict, headSha }) => [verdict, headSha]), [
    ["PASS", verdictHead],
    ["FAIL", verdictHead],
  ]);
  assert.deepEqual(verdicts[0].acceptance.map((a) => a.id), ["ACC-example-01", "ACC-example-02"], "样例逐条列出本单口径");
});

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

const greenChecks = {
  check_runs: [
    "test / npm test",
    "parity / 命令表 = 路由 = 卡片 = CLI",
    "adapter-contract / 形状 + ready + dry-run 无副作用",
    "no-backdoor / web 与 channel 不得直连数据库",
    "design / 任务书 · 导航 · 死链 · 检测器 · 触控",
  ].map((name) => ({ name, status: "completed", conclusion: "success" })),
};

async function mockAgentctlEnv(t, routes, env = {}) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname.replace(/^\/repos\/example\/versekit\//, "");
    const route = routes.get(req.method === "GET" ? path : `${req.method} ${path}`);
    let data = route;
    if (typeof route === "function") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      data = route(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
    }
    res.writeHead(data === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(data ?? `${req.method} ${path}`));
  });
  t.after(() => server.close());
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));

  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.origin.url",
    GIT_CONFIG_VALUE_0: "https://github.com/example/versekit.git",
    GH_TOKEN: "fixture",
    AGENTCTL_API_BASE: `http://127.0.0.1:${server.address().port}`,
    GIT_ALLOW_PROTOCOL: "file",
    ...env,
  };
}

async function mockAgentctl(t, routes, overrides) {
  const env = await mockAgentctlEnv(t, routes, overrides);
  const script = fileURLToPath(new URL("../../../bin/agentctl.mjs", import.meta.url));
  return async (...args) => {
    const { stdout } = await promisify(execFile)(process.execPath, [script, ...args, "--json"], {
      env,
      timeout: 10_000,
    });
    return JSON.parse(stdout);
  };
}

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
  const run = await mockAgentctl(t, new Map([
    ["issues", issues],
    ["pulls", pulls],
    [`commits/${verdictHead}/check-runs`, greenChecks],
    ...pulls.map((pull) => [`pulls/${pull.number}`, { ...pull, mergeable: true }]),
    ...pulls.map(({ number }, index) => [`issues/${number}/comments`, [{ id: number, body: verdicts[index] }]]),
    ["issues/1", issues[0]],
  ]));
  const { results } = await run("merge", "--pending", "--dry-run");
  assert.deepEqual(results, issues.map(({ number }, index) => index < verdictFormats.length
    ? { issue: number, merged: false, dryRun: true, pull: number + 100, head: verdictHead }
    : { issue: number, merged: false, problems: ["verdict 没有逐条覆盖：ACC-x"] }));

  const { body } = await run("reject", "--issue", "1", "--item", "ACC-harness-verdict-02",
    "--expected", "显示确认消息", "--observed", "没有提示", "--repro", "修改标题并保存", "--dry-run");
  assert.match(body, /\nfailed:\n  - id: ACC-harness-verdict-02\n/);
  assert.equal(parseVerdict(body).verdict, "FAIL");
});

async function mergeFixture(t, { head = verdictHead, base, mergeable, env } = {}) {
  const issue = { number: 1, labels: ["s:accept", "model:codex"], body: "ACC-harness-merge-01", state: "open" };
  const pull = {
    number: 101, state: "open", body: "Closes #1",
    base: { ref: "main", sha: base }, head: { ref: "issue-1", sha: head },
  };
  const detail = { ...pull, mergeable };
  const comments = [{ id: 1, created_at: "2026-01-02", body: verdictComment("acceptance:\n  ACC-harness-merge-01: pass").replace(verdictHead, head) }];
  const writes = [];
  const record = (action, fn) => (body) => {
    writes.push({ action, body });
    return fn(body);
  };
  const routes = new Map([
    ["issues", [issue]],
    ["issues/1", issue],
    ["pulls", [pull]],
    ["pulls/101", detail],
    [`commits/${head}/check-runs`, greenChecks],
    ["issues/101/comments", comments],
    ["POST issues/101/comments", record("comment", ({ body }) => {
      const comment = { id: 2, created_at: "2026-01-03", html_url: "https://example.test/comment/2", body };
      comments.push(comment);
      return comment;
    })],
    ["POST issues/1/labels", record("addLabels", ({ labels }) => {
      issue.labels.push(...labels);
      return issue.labels;
    })],
    ["PUT issues/1/labels", record("setLabels", ({ labels }) => {
      issue.labels = labels;
      return labels;
    })],
    ["PUT pulls/101/merge", record("merge", () => {
      detail.merge_commit_sha = "1234567";
      return { merged: true };
    })],
    ["PATCH issues/1", record("close", (body) => Object.assign(issue, body))],
  ]);
  for (const label of ["s:review", "s:accept", "s:changes"]) {
    routes.set(`DELETE issues/1/labels/${encodeURIComponent(label)}`, record("removeLabel", () => {
      issue.labels = issue.labels.filter((name) => name !== label);
      return {};
    }));
  }
  const run = await mockAgentctl(t, routes, env);
  return { run, issue, detail, comments, writes };
}

test("ACC-harness-verdict-04：merge --pending 读裸 FAIL 并打回 s:changes", async (t) => {
  const { run, issue, comments, writes } = await mergeFixture(t, { head: bareFailHead });
  issue.labels[0] = "s:review";
  comments[0].body = bareFailVerdict;

  const { results: dryRun } = await run("merge", "--pending", "--dry-run");
  assert.deepEqual(dryRun, [{ issue: 1, merged: false, problems: ["[dry-run] 会打回 s:changes"] }]);
  assert.deepEqual(writes, []);

  const { results } = await run("merge", "--pending");
  assert.deepEqual(results, [{ issue: 1, merged: false, handback: true, pull: 101 }]);
  assert.deepEqual(writes.map(({ action }) => action), ["removeLabel", "addLabels"]);
  assert.deepEqual(issue.labels, ["model:codex", "s:changes"]);
});

test("ACC-harness-verdict-04：已判定的 head 不复派，坏判定告警，旧 head 和作废判定可重验", async (t) => {
  const invalidVerdict = bareFailVerdict.replace("verdict: FAIL", "verdict: BLOCKED");
  const missingHead = bareFailVerdict.replace(/^head_sha:.*\n/m, "");
  const cases = [
    { body: bareFailVerdict },
    { body: `\`\`\`yml\n${bareFailVerdict}\n\`\`\``, newer: bareFailVerdict.replace(bareFailHead, verdictHead) },
    { body: invalidVerdict, problem: /判定 YAML 无法解析/ },
    { body: missingHead, problem: /判定评论缺 head_sha/ },
    { body: bareFailVerdict.replace(bareFailHead, "invalid"), problem: /判定评论缺 head_sha/ },
    { body: bareFailVerdict.replace(bareFailHead, verdictHead), eligible: true },
    { body: invalidVerdict.replace(bareFailHead, verdictHead), eligible: true },
    { body: `意见：等验收结果。\nhead_sha: ${bareFailHead}`, eligible: true },
    { body: missingHead, voided: true, eligible: true },
  ];
  const issues = cases.map((_, i) => ({ number: 99990 + i, title: "验收回归", labels: ["s:review"], body: "ACC-harness-verdict-04" }));
  const pulls = issues.map(({ number }) => ({ number: number + 100, body: `Closes #${number}`, head: { sha: bareFailHead } }));
  const commentUrl = (i) => `https://example.test/comment/${99990 + i}`;
  const comments = cases.map(({ body, newer, voided }, i) => [
    { id: 99990 + i, body, html_url: commentUrl(i), created_at: "2026-01-01" },
    ...(newer ? [{ id: 99980, body: newer, created_at: "2026-01-02" }] : []),
    ...(voided ? [{ id: 99981, body: `<!-- agent-verdict-void -->\nvoids: ${99990 + i}` }] : []),
  ]);
  const env = await mockAgentctlEnv(t, new Map([
    ["issues", issues], ["pulls", pulls],
    ...pulls.map(({ number }, i) => [`issues/${number}/comments`, comments[i]]),
  ]));
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  const exec = promisify(execFile);
  const args = ["bin/agentctl.mjs", "claim", "--role", "acceptance", "--dry-run", "--json"];
  const { stdout } = await exec(process.execPath, args, { env, cwd, timeout: 10_000 });
  const eligible = issues.filter((_, i) => cases[i].eligible).map(({ number }) => number);
  assert.deepEqual(JSON.parse(stdout).queue.map(({ number }) => number), eligible);
});

test("ACC-harness-merge-01：冲突转 s:changes，列出冲突文件且不增加质量返工轮次", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agentctl-conflict-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = async (...args) => (await promisify(execFile)("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd: dir })).stdout.trim();
  const file = join(dir, "shared file.txt");
  await git("init", "-b", "main");
  await writeFile(file, "common\n");
  await git("add", ".");
  await git("commit", "-m", "common");
  await git("switch", "-c", "issue-1");
  await writeFile(file, "head\n");
  await writeFile(join(dir, "head-only.txt"), "no conflict\n");
  await git("add", ".");
  await git("commit", "-m", "head");
  const head = await git("rev-parse", "HEAD");
  await git("switch", "main");
  await writeFile(file, "base\n");
  await git("commit", "-am", "base");
  const base = await git("rev-parse", "HEAD");
  const cache = join(dir, ".coordinator.git");
  await git("init", "--bare", cache);
  const { run, issue, comments, writes } = await mergeFixture(t, {
    head, base, mergeable: false,
    env: {
      GIT_DIR: cache,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: `url.${pathToFileURL(dir).href}.insteadOf`,
      GIT_CONFIG_VALUE_1: "https://github.com/example/versekit.git",
    },
  });

  issue.labels[0] = "s:review";
  const dry = await run("merge", "--pending", "--dry-run");
  assert.match(dry.results[0].problems[0], /跟 main 冲突，会打回 s:changes/);
  assert.deepEqual(writes, []);
  issue.labels[0] = "s:accept";
  const { results } = await run("merge", "--pending");
  assert.deepEqual(results, [{ issue: 1, merged: false, handback: true, pull: 101 }]);
  assert.deepEqual(writes.map(({ action }) => action), ["comment", "setLabels"]);
  assert.deepEqual(issue.labels.sort(), ["model:codex", "s:changes"]);
  const comment = comments.at(-1);
  assert.equal(parseVerdict(comment.body).verdict, "FAIL");
  assert.equal(parseVerdict(comment.body).headSha, head);
  assert.match(comment.body, /跟 main 冲突，合并 main 解决冲突后重验/);
  assert.match(comment.body, /冲突文件\n\n    "shared file\.txt"/);
  assert.doesNotMatch(comment.body, /head-only/);
  assert.deepEqual((await run("merge", "--pending")).results, []);
  assert.equal(comments.length, 2, "再次巡检不会重复发表评论");
  issue.labels = ["s:accept", "model:codex"]; // 评论已经写入，但上次状态迁移未落地。
  assert.deepEqual((await run("merge", "--pending")).results, results);
  assert.deepEqual(writes.map(({ action }) => action), ["comment", "setLabels", "setLabels"]);

  const firstClaim = (await run("claim", "--role", "rework", "--dry-run")).wouldClaim[0];
  assert.equal(firstClaim.round, 0);
  assert.equal(firstClaim.commentBody, comment.body);
  comments.unshift({ id: 3, created_at: "2026-01-01", body: " ```yaml\nverdict: FAIL\nhead_sha: abc1234\n```" });
  const nextClaim = (await run("claim", "--role", "rework", "--dry-run")).wouldClaim[0];
  assert.equal(nextClaim.round, 1, "一次历史质量 FAIL 加一次合并冲突仍为第一轮，不触发升模型");
  assert.equal(nextClaim.commentBody, comment.body);

  // ACC-harness-orca-08：协调器自己实现的单打回后不派返工 agent。
  const saved = issue.labels;
  issue.labels = [...saved, "by:coordinator"];
  assert.deepEqual((await run("claim", "--role", "rework", "--dry-run")).wouldClaim, []);
  issue.labels = saved;

  const { reworkSpec } = await import("../../../bin/orca-flow.mjs");
  const stdout = reworkSpec({ number: 1, title: "example", pull: 101, branch: "issue-1", round: 1, commentUrl: comment.html_url, commentBody: comment.body, body: issue.body });
  assert.match(stdout, /在原分支拉取并合并 PR 的目标分支.*推送新 head 供重新验收/);
  assert.doesNotMatch(stdout, /按最近验收意见/);
});

test("ACC-harness-merge-01：mergeable 为 null 时跳过，下轮为 true 时用已验收的 SHA 合并", async (t) => {
  const { run, issue, detail, writes } = await mergeFixture(t, { mergeable: null });

  const waiting = await run("merge", "--pending");
  assert.match(waiting.results[0].problems[0], /正在计算.*下轮再检查/);
  assert.deepEqual(writes, []);
  assert.equal(issue.state, "open");

  detail.mergeable = true;
  detail.head = { ...detail.head, sha: "def12345".repeat(5) };
  const stale = await run("merge", "--pending");
  assert.match(stale.results[0].problems[0], /head 已变更/);
  assert.deepEqual(writes, []);

  detail.head = { ...detail.head, sha: verdictHead };
  const { results } = await run("merge", "--pending");
  assert.deepEqual(results, [{ issue: 1, merged: true, pull: 101, head: verdictHead, mergeSha: "1234567" }]);
  assert.deepEqual(writes[0], { action: "merge", body: { merge_method: "squash", sha: verdictHead } });
  assert.deepEqual(issue.labels.sort(), ["model:codex", "s:done"]);
  assert.equal(issue.state, "closed");
});

const coreIssue = (path, acceptance = "- [ACC-arch-09]") =>
  `## 验收口径\n- [ACC-account-01]\n${acceptance}\n\n## 涉及与不可动\n- 改：\`${path}\``;

test("validateScope：核心文件需要在验收口径内列出 ACC-arch-09", () => {
  for (const path of [
    "packages/core/src/commands.mjs", "schema.sql", "store.mjs", "handlers.mjs", "daemon.mjs",
    "packages/relay/", "packages/relay/src/index.mjs",
  ]) {
    assert.equal(validateScope({ body: coreIssue(path) }).ok, true, path);
    assert.match(validateScope({ body: coreIssue(path, "") }).why, /缺 ACC-arch-09/, path);
  }
  assert.match(validateScope({ body: "口径：ACC-account-01\n\n## 涉及\n- 文件/模块：packages/core/src/schema.sql" }).why, /缺 ACC-arch-09/);
  assert.match(validateScope({ body: `${coreIssue("store.mjs", "")}\n\n## 完成定义\n见 ACC-arch-09` }).why, /缺 ACC-arch-09/);
  assert.equal(validateScope({ body: "涉及：`packages/core/src/store.mjs`\n口径：ACC-arch-09" }).ok, true);
  assert.equal(validateScope({ body: `${coreIssue("packages/cli/src/handlers.mjs", "")}\n- 不动：\`packages/core/src/commands.mjs\`` }).ok, true);
});

test("ACC-harness-arch-01：tick 和 claim 都挡住口径缺六问的核心工单", async (t) => {
  const issues = [
    coreIssue("packages/core/src/commands.mjs", ""),
    coreIssue("packages/core/src/commands.mjs"),
    coreIssue("bin/agentctl.mjs", ""),
  ].map((body, index) => ({ number: index + 1, labels: ["s:ready"], body }));
  const run = await mockAgentctl(t, new Map([["issues", issues], ["pulls", []]]));

  const { rows } = await run("tick");
  assert.deepEqual(rows.map(({ actor, action, blocked }) => [actor, action, blocked]), [
    ["human", "补口径", true], ["engineer", "派工实现", false], ["engineer", "派工实现", false],
  ]);
  assert.match(rows[0].why, /缺 ACC-arch-09/);

  const { wouldClaim, skipped } = await run("claim", "--role", "engineer", "--dry-run");
  assert.deepEqual(wouldClaim.map(({ number }) => number), [2, 3]);
  assert.deepEqual(skipped.map(({ number }) => number), [1]);
  assert.match(skipped[0].why, /缺 ACC-arch-09/);
});

test("ACC-harness-arch-01：merge 只认 PR 正文六问小节内的全部六个答案", async (t) => {
  const answers = Array.from({ length: 6 }, (_, index) => `${index + 1}. 这项保持原状。`);
  const complete = answers.join("\n");
  const section = `### ADR-0005 §13 六问\n\n${complete}`;
  const cases = [
    { description: "" },
    { description: `## 实现步骤\n\n${complete}` },
    { description: `## 六问\n\n${answers.slice(0, 5).join("\n")}\n\n## 证据\n\n${answers[5]}` },
    { description: `## 六问\n\n${answers.slice(0, 5).join("\n")}\n6.   ` },
    { description: `## 六问\n\n\`\`\`markdown\n${complete}\n\`\`\`` },
    { description: section, mergeable: true },
    { description: "", ordinary: true, mergeable: true },
  ];
  const issues = cases.map(({ ordinary }, index) => ({
    number: index + 1,
    labels: ["s:accept"],
    body: ordinary ? coreIssue("bin/agentctl.mjs", "") : coreIssue("packages/relay/"),
  }));
  const pulls = issues.map(({ number }, index) => ({
    number: number + 100,
    body: `Closes #${number}\n\n${cases[index].description}`,
    head: { sha: verdictHead },
    state: "open",
  }));
  const run = await mockAgentctl(t, new Map([
    ["issues", issues],
    ["pulls", pulls],
    [`commits/${verdictHead}/check-runs`, greenChecks],
    ...pulls.map((pull) => [`pulls/${pull.number}`, { ...pull, mergeable: true }]),
    ...pulls.map(({ number }, index) => [`issues/${number}/comments`, [{
      id: number,
      body: verdictComment(`acceptance:\n  ACC-account-01: pass${cases[index].ordinary ? "" : "\n  ACC-arch-09: pass"}`),
    }]]),
  ]));

  const { results } = await run("merge", "--pending", "--dry-run");
  assert.equal(results.length, cases.length);
  for (const [index, result] of results.entries()) {
    const { description, mergeable } = cases[index];
    assert.equal(result.issue, issues[index].number);
    if (mergeable) {
      assert.equal(result.dryRun, true, description);
      assert.equal(result.pull, pulls[index].number);
    } else {
      assert.equal(result.merged, false, description);
      assert.equal(result.problems.length, 1);
      assert.match(result.problems[0], /缺 ADR-0005 §13 六问/);
    }
  }
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

// ---------------------------------------------------------------- ACC-harness-queue-01：s:queued 排队放行
//
// 假 GitHub（本地 http mock），不碰真实 GitHub / orca（ACC-harness-codex-07）。

const okBody = (extra = "") => `## 验收口径\n- [ACC-harness-queue-01]\n\n## 涉及与不可动\n- 改：\`bin/cycle.sh\`\n${extra}`;
const queuedIssue = (number, { body = okBody(), labels = [] } = {}) => ({
  number, title: `单 ${number}`, body, labels: ["s:queued", ...labels], updated_at: "2026-11-22T00:00:00Z",
});

test("迁移表：triage → queued → ready，ready 不能直接回到 queued 以外的乱边", () => {
  assert.equal(canTransition("triage", "queued"), true);
  assert.equal(canTransition("queued", "ready"), true);
  assert.equal(canTransition("queued", "doing"), false);
  assert.equal(canTransition("queued", "review"), false);
});

test("planQueueRelease：prio:high 在前，其余按 issue 号；依赖/口径/ARCH-09 缺失跳过且不卡后面", () => {
  const issues = [
    queuedIssue(300, { body: okBody("\n**依赖**：#299\n") }), // #299 还没 done
    { number: 299, title: "依赖单", body: "x", labels: ["s:doing"] },
    queuedIssue(301, { body: "## 验收口径\n- [ACC-nope-99]\n" }),
    queuedIssue(302, { body: `## 验收口径\n- [ACC-harness-queue-01]\n\n## 涉及与不可动\n- 改：\`packages/core/src/store.mjs\`\n` }),
    queuedIssue(310),
    queuedIssue(305, { labels: ["prio:high"] }),
    queuedIssue(304, { labels: ["hold:human"] }), // hold:human 不碰
  ];
  const { released, skipped } = planQueueRelease(issues);
  assert.equal(released.number, 305); // prio:high 先于更小的 #310
  assert.deepEqual(skipped.map((s) => s.number), [300, 301, 302]);
  assert.match(skipped.find((s) => s.number === 300).why, /依赖 #299 未完成/);
  assert.match(skipped.find((s) => s.number === 301).why, /ACC-nope-99/);
  assert.match(skipped.find((s) => s.number === 302).why, /ACC-arch-09/);
  // 前面跳过的标 before：它们排在被放行的 #305 之后（high 在前），所以都不是「前面」
  assert.ok(skipped.every((s) => s.before === false));
});

test("planQueueRelease：依赖已完成（已关闭或 s:done）就能放；自己不算依赖", () => {
  const body = okBody("\n**依赖**：#10、#11\n");
  const issues = [queuedIssue(20, { body }), { number: 11, title: "d", body: "", labels: ["s:done"] }];
  assert.equal(planQueueRelease(issues).released?.number, 20); // #10 不在 open 列表 = 已关闭
});

async function queueRun(t, issues, args, { env } = {}) {
  const calls = [];
  const routes = new Map([["issues", issues], ["pulls", []]]);
  for (const i of issues) {
    routes.set(`issues/${i.number}`, i);
    routes.set(`PUT issues/${i.number}/labels`, (body) => { calls.push({ number: i.number, labels: body }); return body; });
  }
  const run = await mockAgentctl(t, routes, env);
  return { result: await run("release-queued", ...args), calls };
}

test("release-queued：ready 空、lane 有空 → 放行排第一的，日志写前面跳过了谁", async (t) => {
  const issues = [
    { number: 1, title: "在做", body: "x", labels: ["s:doing"] },
    queuedIssue(5, { body: okBody("\n**依赖**：#6\n") }),
    { number: 6, title: "未完成依赖", body: "x", labels: ["s:triage"] },
    queuedIssue(7),
    queuedIssue(8),
  ];
  const { result, calls } = await queueRun(t, issues, ["--free-lanes", "1"]);
  assert.equal(result.released.number, 7);
  assert.equal(result.message, "从排队里放行 #7（排第 1，前面跳过 #5：依赖 #6 未完成）");
  assert.deepEqual(result.skipped.map((s) => s.number), [5]);
  assert.deepEqual(calls, [{ number: 7, labels: { labels: ["s:ready"] } }]); // 只放 1 张，且是 s:queued → s:ready
});

test("release-queued：lane 占满或已有 s:ready 时不放行，也不改任何 label", async (t) => {
  const queued = [queuedIssue(7)];
  const full = await queueRun(t, queued, ["--free-lanes", "0"]);
  assert.equal(full.result.released, null);
  assert.equal(full.result.reason, "lanes-full");
  assert.deepEqual(full.calls, []);

  const withReady = await queueRun(t, [...queued, { number: 9, title: "r", body: "x", labels: ["s:ready"] }], ["--free-lanes", "2"]);
  assert.equal(withReady.result.reason, "ready-exists");
  assert.deepEqual(withReady.calls, []);
});

test("release-queued：全部跳过 → 不放行，原因逐条列出；s:triage 不被碰", async (t) => {
  const issues = [
    queuedIssue(7, { body: "## 验收口径\n- [ACC-nope-99]\n" }),
    { number: 8, title: "还没口径", body: okBody(), labels: ["s:triage"] },
  ];
  const { result, calls } = await queueRun(t, issues, ["--free-lanes", "2"]);
  assert.equal(result.reason, "none-viable");
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(calls, []); // #8 是 s:triage，虽然口径齐也不放行
});

test("release-queued --dry-run 不写 label；缺 --free-lanes 报错", async (t) => {
  const { result, calls } = await queueRun(t, [queuedIssue(7)], ["--free-lanes", "1", "--dry-run"]);
  assert.equal(result.released.number, 7);
  assert.match(result.message, /^\[dry-run\] 会从排队里放行 #7/);
  assert.deepEqual(calls, []);
  const run = await mockAgentctl(t, new Map([["issues", []], ["pulls", []]]));
  await assert.rejects(run("release-queued"), /free-lanes/);
});

test("tick：s:queued 口径/依赖不合格会标「补口径」，合格的等循环放行", async (t) => {
  const issues = [
    queuedIssue(7),
    queuedIssue(8, { body: okBody("\n**依赖**：#7\n") }),
    queuedIssue(9, { body: "没有口径" }),
  ];
  const run = await mockAgentctl(t, new Map([["issues", issues], ["pulls", []]]));
  const { rows } = await run("tick");
  const by = Object.fromEntries(rows.map((r) => [r.number, r]));
  assert.equal(by[7].blocked, undefined);
  assert.equal(by[7].action, "排队等放行");
  assert.equal(by[8].blocked, true); // #7 还没完成
  assert.match(by[8].why, /依赖 #7 未完成/);
  assert.equal(by[9].blocked, true);
});
