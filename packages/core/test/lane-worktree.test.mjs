// ported from market-research@78a1dec bin/test/lane-worktree.test.mjs
// ACC-harness-lane-01：prepare_lane_worktree / reset_lane_worktree 被 $(...) 调用，
// 说明性日志必须走 stderr（否则失败原因被当返回值吞掉）；不能复用时写明原因。离线：真 git + 假 orca。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SH = readFileSync(new URL("../../../bin/cycle.sh", import.meta.url), "utf8");
function fn(name) {
  const m = SH.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `cycle.sh 里找不到函数 ${name}`);
  return m[0];
}
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function scene(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-wt-")));
  const wt = join(root, "lane1");
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  git(wt, "config", "user.email", "t@example.com");
  git(wt, "config", "user.name", "t");
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "init");
  for (const f of files) {
    mkdirSync(join(wt, f, ".."), { recursive: true });
    writeFileSync(join(wt, f), "x");
  }
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "lane-1.worktree"), wt + "\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "orca"), `#!/bin/sh\necho "orca boom" >&2\nexit 1\n`, { mode: 0o755 });
  return { root, wt, state, bin };
}

function run(s) {
  const script = `
set -u
LANE_DIR='${s.state}'
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
if wt=$(prepare_lane_worktree 1 40 t); then echo "RC=0 WT=$wt"; else echo "RC=1 WT=$wt"; fi
`;
  const r = spawnSync("/bin/bash", ["-c", script], {
    cwd: s.root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, LANG: "en_US.UTF-8" },
  });
  return { out: r.stdout, err: r.stderr };
}

test("旧 worktree 不干净：原因（前 5 个路径）走 stderr，stdout 不被日志污染", () => {
  const files = [".playwright-mcp/1.png", ".playwright-mcp/2.png", "n1.txt", "n2.txt", "n3.txt", "n4.txt", "n5.txt"];
  const s = scene(files);
  writeFileSync(join(s.wt, "a.txt"), "changed\n"); // 已跟踪改动才会拒绝复用（纯未跟踪文件见 lane-reuse.test）
  const r = run(s);
  assert.match(r.out, /^RC=1 WT=$/m, `stdout 应只有返回值：${r.out}`);
  assert.doesNotMatch(r.out, /不能安全复用|已跟踪改动/);
  assert.match(r.err, /已跟踪改动/);
  assert.match(r.err, /不能安全复用/);
  assert.match(r.err, /orca worktree create 失败：orca boom/);
  const listed = r.err.split("\n").filter((l) => /^ {8,9}\S/.test(l));
  assert.equal(listed.length, 5, "最多列前 5 个");
});

test("干净的旧 worktree：复用，stdout 只有路径", () => {
  const s = scene([]);
  const r = run(s);
  assert.equal(r.out.trim(), `RC=0 WT=${s.wt}`);
  assert.equal(git(s.wt, "branch", "--show-current"), "issue-40-lane-1");
});
