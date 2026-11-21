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

test("cycle.sh：dry-run 在 UTF-8 Bash 中渲染验收任务书、落后 main 的判定规则和判定样例", async () => {
  const script = await readFile(new URL("../../../bin/cycle.sh", import.meta.url), "utf8");
  const template = /^acceptance_spec\(\) \{\n[\s\S]*?^\}$/m.exec(script)?.[0];
  const dispatch = /^dispatch_acceptance\(\) \{\n[\s\S]*?^\}$/m.exec(script)?.[0];
  assert.ok(template, "找不到验收任务书函数");
  assert.ok(dispatch, "找不到验收派工函数");

  const { stdout } = await promisify(execFile)("/bin/bash", ["-euo", "pipefail", "-c", `
    ${template}
    ${dispatch}
    node() { printf '%s\\n' "$QUEUE"; }
    log() { printf '%s\\n' "$*"; }
    choose_worker_channel() { CHOSEN_CHANNEL=volc; CHOSEN_MODEL=deepseek-v4.1-flash; }
    dispatch_acceptance
  `], {
    env: {
      ...process.env,
      LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
      DRY: "1",
      LOCK_DIR: "/dev/null",
      STATE_DIR: "/dev/null",
      ACCEPTANCE_WT: "/acceptance",
      QUEUE: JSON.stringify({ queue: [{
        number: 264,
        pull: 265,
        head: verdictHead,
        acc: ["ACC-example-01", "ACC-example-02"],
        title: "验收样例",
      }] }),
    },
  });
  // 新版 Bash 可能正常展开，仍禁止会破坏 Bash 3.2 的相邻写法。
  assert.doesNotMatch(template, /\$[A-Za-z_]\w*[^\x00-\x7F]/);
  assert.equal(stdout.split("\n")[1], `目标：验收 issue #264 的 PR #265（head ${verdictHead}）。`);
  assert.match(
    stdout,
    /PR head 落后 main 时，.*只在 head 上失败.*本 PR 没改过的文件.*main 上已修好.*CLEAN.*按合并 main 后的结果判定.*note.*head 上的现象、合并后的现象和两边各自的复现命令.*本 PR 改过的文件.*按 head 上的结果判定.*无需发 question/,
  );

  const verdicts = [...stdout.matchAll(/```yaml\n[\s\S]*?\n```/g)].map(([block]) => parseVerdict(block));
  assert.deepEqual(verdicts.map(({ verdict, headSha }) => [verdict, headSha]), [
    ["PASS", verdictHead],
    ["FAIL", verdictHead],
  ]);
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

async function mockAgentctl(t, routes, env = {}) {
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

  const script = fileURLToPath(new URL("../../../bin/agentctl.mjs", import.meta.url));
  return async (...args) => {
    const { stdout } = await promisify(execFile)(process.execPath, [script, ...args, "--json"], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.url",
        GIT_CONFIG_VALUE_0: "https://github.com/example/versekit.git",
        GH_TOKEN: "fixture",
        AGENTCTL_API_BASE: `http://127.0.0.1:${server.address().port}`,
        GIT_ALLOW_PROTOCOL: "file",
        ...env,
      },
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

  const cycle = await readFile(new URL("../../../bin/cycle.sh", import.meta.url), "utf8");
  const spec = /^rework_spec\(\) \{\n[\s\S]*?^\}/m.exec(cycle)?.[0];
  assert.ok(spec);
  const { stdout } = await promisify(execFile)("/bin/bash", [
    "-eu", "-c", `${spec}\nrework_spec "$@"`, "fixture",
    "1", "example", "101", "issue-1", "1", comment.html_url, comment.body, dir, issue.body, "",
  ]);
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
