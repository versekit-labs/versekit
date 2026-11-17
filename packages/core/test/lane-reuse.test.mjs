// ported from market-research@78a1dec bin/test/lane-reuse.test.mjs
// ACC-harness-lane-02：旧 lane worktree 能复用就复用，不能就回收，不泄漏。离线：真 git + 假 orca。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unregisteredWorktrees } from "../../../bin/agentctl.mjs";

const SH = readFileSync(new URL("../../../bin/cycle.sh", import.meta.url), "utf8");
function fn(name) {
  const m = SH.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `cycle.sh 里找不到函数 ${name}`);
  return m[0];
}
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

// orcaMode: "ok" 新建成功并记录 rm 调用；"rmfail" 新建成功但 rm 失败；"createfail" 新建失败。
function scene(orcaMode = "ok") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-reuse-")));
  const wt = join(root, "old");
  const fresh = join(root, "fresh");
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  git(wt, "config", "user.email", "t@example.com");
  git(wt, "config", "user.name", "t");
  writeFileSync(join(wt, "a.txt"), "a\n");
  writeFileSync(join(wt, ".gitignore"), "ignored.log\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "init");
  const state = join(root, "state");
  mkdirSync(join(state, "lanes"), { recursive: true });
  writeFileSync(join(state, "lanes", "lane-1.worktree"), wt + "\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "orca-calls.log");
  writeFileSync(
    join(bin, "orca"),
    `#!/bin/sh
echo "$*" >> '${calls}'
case "$2" in
  create)
    ${orcaMode === "createfail" ? 'echo "orca boom" >&2; exit 1' : `mkdir -p '${fresh}'; echo '{"result":{"worktree":{"path":"${fresh}","branch":"refs/heads/cycle-issue-9"}}}'`} ;;
  rm)
    ${orcaMode === "rmfail" ? 'echo "rm boom" >&2; exit 1' : "exit 0"} ;;
esac
`,
    { mode: 0o755 },
  );
  return { root, wt, fresh, state, bin, calls };
}

function run(s, after = "") {
  const script = `
set -u
STATE_DIR='${s.state}'
LANE_DIR='${s.state}/lanes'
${fn("logerr")}
${fn("log")}
${fn("jfind")}
${fn("lane_read")}
${fn("lane_write")}
${fn("lane_worktree_state")}
${fn("lane_worktree_alert")}
${fn("reset_lane_worktree")}
${fn("reclaim_old_worktree")}
${fn("prepare_lane_worktree")}
${fn("keep_lane_worktree_alerts")}
${fn("reset_owner_failures")}
OWNER_FAIL_LOG='${s.state}/owner-failures.log'
RUN_ID=r
if wt=$(prepare_lane_worktree 1 9 t); then echo "RC=0 WT=$wt"; else echo "RC=1 WT=$wt"; fi
${after}
`;
  const r = spawnSync("/bin/bash", ["-c", script], {
    cwd: s.root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, LANG: "en_US.UTF-8" },
  });
  const orcaCalls = existsSync(s.calls) ? readFileSync(s.calls, "utf8") : "";
  const alertFile = join(s.state, "cycle-owner-alert.txt");
  return { out: r.stdout, err: r.stderr, orcaCalls, alert: existsSync(alertFile) ? readFileSync(alertFile, "utf8") : "" };
}

test("只有未跟踪的旧构建产物：git clean -fd 后复用，不新建、不回收", () => {
  const s = scene();
  mkdirSync(join(s.wt, "research-console/web/assets"), { recursive: true });
  writeFileSync(join(s.wt, "research-console/web/assets/app.js"), "x");
  writeFileSync(join(s.wt, "research-console/web/assets/app.css"), "x");
  const r = run(s);
  assert.equal(r.out.trim(), `RC=0 WT=${s.wt}`);
  assert.equal(git(s.wt, "status", "--porcelain"), "");
  assert.equal(git(s.wt, "branch", "--show-current"), "issue-9-lane-1");
  assert.equal(r.orcaCalls, "", "复用时不碰 orca");
  assert.match(r.err, /git clean -fd/);
  assert.equal(r.alert, "");
});

test("git clean 不带 -x：被忽略的文件保留", () => {
  const s = scene();
  writeFileSync(join(s.wt, "ignored.log"), "keep");
  writeFileSync(join(s.wt, "junk.txt"), "x");
  const r = run(s);
  assert.equal(r.out.trim(), `RC=0 WT=${s.wt}`);
  assert.ok(existsSync(join(s.wt, "ignored.log")));
  assert.ok(!existsSync(join(s.wt, "junk.txt")));
});

test("有已跟踪改动：不复用、不删，新建，写日志和 alert，旧的保留", () => {
  const s = scene();
  writeFileSync(join(s.wt, "a.txt"), "changed\n");
  const r = run(s);
  assert.equal(r.out.trim(), `RC=0 WT=${s.fresh}`);
  assert.match(r.err, /有已跟踪改动/);
  assert.match(r.alert, /\[lane-worktree\]/);
  assert.match(r.alert, /已跟踪改动/);
  assert.doesNotMatch(r.orcaCalls, /worktree rm/);
  assert.equal(readFileSync(join(s.wt, "a.txt"), "utf8"), "changed\n");
});

test("有未推送提交：不复用、不删，新建，写 alert", () => {
  const s = scene();
  git(s.wt, "checkout", "-q", "-b", "feature");
  writeFileSync(join(s.wt, "b.txt"), "b\n");
  git(s.wt, "add", ".");
  git(s.wt, "commit", "-qm", "wip");
  const r = run(s);
  assert.equal(r.out.trim(), `RC=0 WT=${s.fresh}`);
  assert.match(r.err, /有未推送提交/);
  assert.match(r.alert, /未推送提交/);
  assert.doesNotMatch(r.orcaCalls, /worktree rm/);
  assert.equal(git(s.wt, "branch", "--show-current"), "feature");
});

test("alert 同一路径只写一次", () => {
  const s = scene();
  writeFileSync(join(s.wt, "a.txt"), "changed\n");
  run(s);
  writeFileSync(join(s.state, "lanes", "lane-1.worktree"), s.wt + "\n");
  const r = run(s);
  assert.equal((r.alert.match(/\[lane-worktree\]/g) ?? []).length, 1);
});

test("干净但切分支失败（不能复用）：新建成功后用 orca worktree rm --force 回收旧的", () => {
  const s = scene();
  // 让 checkout -b 失败：index.lock 占着
  writeFileSync(join(s.wt, ".git/index.lock"), "");
  const r = run(s);
  assert.equal(r.out.trim(), `RC=0 WT=${s.fresh}`);
  assert.match(r.orcaCalls, new RegExp(`worktree rm --worktree path:${s.wt} --force`));
  assert.match(r.err, /已回收/);
});

test("回收失败只告警，prepare 仍成功返回新路径", () => {
  const s = scene("rmfail");
  writeFileSync(join(s.wt, ".git/index.lock"), "");
  const r = run(s);
  assert.equal(r.out.trim(), `RC=0 WT=${s.fresh}`);
  assert.match(r.err, /回收失败/);
});

test("新建失败：旧的不回收", () => {
  const s = scene("createfail");
  writeFileSync(join(s.wt, "a.txt"), "changed\n");
  const r = run(s);
  assert.match(r.out, /^RC=1/m);
  assert.doesNotMatch(r.orcaCalls, /worktree rm/);
});

test("agentctl 对账：列出未登记的 worktree，不含主 worktree、自己和已登记的", () => {
  const mk = (path, extra = {}) => ({ path, repoId: "r1", branch: "refs/heads/x", displayName: path, ...extra });
  const list = [
    mk("/p/main", { isMainWorktree: true }),
    mk("/p/self"),
    mk("/p/lane1"),
    mk("/p/engineer"),
    mk("/p/design-v2"),
    mk("/p/gone", { isArchived: true }),
    mk("/other/x", { repoId: "r2" }),
  ];
  const stray = unregisteredWorktrees(list, { registered: ["/p/lane1/"], selfPath: "/p/self" });
  assert.deepEqual(stray.map((w) => w.path), ["/p/engineer", "/p/design-v2"]);
  assert.equal(stray[0].branch, "x");
});

test("agentctl 对账：不论从哪个 worktree 跑，都排除验收 worktree 和协调器 worktree", () => {
  const mk = (path, branch, extra = {}) => ({ path, repoId: "r1", branch: `refs/heads/${branch}`, displayName: path, ...extra });
  const list = [
    mk("/p/main", "main", { isMainWorktree: true }),
    mk("/p/lane1", "cycle-issue-1"),
    mk("/p/acceptance", "cycle-issue-2"),
    mk("/p/coord", "coord/market-research"),
    mk("/p/engineer", "old"),
  ];
  for (const selfPath of ["/p/acceptance", "/p/coord", "/p/lane1"]) {
    const stray = unregisteredWorktrees(list, { registered: ["/p/lane1"], selfPath, acceptancePath: "/p/acceptance/" });
    assert.deepEqual(stray.map((w) => w.path), ["/p/engineer"], `self=${selfPath}`);
  }
});

test("告警写入后同一轮 reset_owner_failures 不清掉（真实执行顺序：写告警→reset→读）", () => {
  const s = scene();
  writeFileSync(join(s.wt, "a.txt"), "changed\n");
  const r = run(s, "reset_owner_failures");
  assert.match(r.alert, /\[lane-worktree\] /);
  assert.ok(r.alert.includes(s.wt));
  assert.match(r.alert, /已跟踪改动/);
});

test("reset_owner_failures 清掉其他所有权 alert，只留 lane-worktree 条目", () => {
  const s = scene();
  writeFileSync(join(s.wt, "a.txt"), "changed\n");
  const after = `printf 'Run 所有权探测连续失败 2 次\\n最后错误：x\\n' >> '${s.state}/cycle-owner-alert.txt'; reset_owner_failures`;
  const r = run(s, after);
  assert.doesNotMatch(r.alert, /所有权探测/);
  assert.match(r.alert, /\[lane-worktree\] /);
});

test("对应 worktree 已干净或已不存在：reset_owner_failures 清除告警", () => {
  const s = scene();
  writeFileSync(join(s.wt, "a.txt"), "changed\n");
  let r = run(s, `git -C '${s.wt}' checkout -q -- a.txt; reset_owner_failures`);
  assert.equal(r.alert, "");
  const s2 = scene();
  writeFileSync(join(s2.wt, "a.txt"), "changed\n");
  r = run(s2, `rm -rf '${s2.wt}'; reset_owner_failures`);
  assert.equal(r.alert, "");
});
