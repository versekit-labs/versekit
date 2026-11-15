// 返工 / 验收 worktree 的 stdout 契约（ACC-harness-cycle-11）。
//
// `dispatch_rework` 用 `resolved=$(ensure_rework_worktree …)` 取 selector，同一行
// 再拼成 `branch:<分支>@path:<路径>` 交给 worker-start。git 只要往 stdout 写一句
// `branch '…' set up to track '…'` 或 `HEAD is now at …`，selector 就坏了，worker-start
// 报 selector_not_found（2026-11-15 #101 返工三连败的根因）。
//
// 这里不 mock git：在临时仓库里真建裸 origin + 协调器 worktree，再把 bin/cycle.sh 里的
// 函数原样抽出来执行，断言 stdout **严格等于** `path:<绝对路径>`。
// 覆盖：本地无该分支、本地有残留分支、目录已存在（重复调用）、验收 worktree。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CYCLE_SH = path.join(ROOT, 'bin/cycle.sh');
const BRANCH = 'issue-7-lane-1';
const ISSUE = '7';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'harness',
  GIT_AUTHOR_EMAIL: 'harness@example.test',
  GIT_COMMITTER_NAME: 'harness',
  GIT_COMMITTER_EMAIL: 'harness@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

// 从 bin/cycle.sh 抽出单个函数定义（函数体以顶格的 `}` 结束）。
// 直接复制文件会让测试和实现漂移，所以这里每次读真文件。
function fnSource(name) {
  const lines = readFileSync(CYCLE_SH, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `bin/cycle.sh 里找不到 ${name}()`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.notEqual(end, -1, `${name}() 的函数体没有闭合`);
  return lines.slice(start, end + 1).join('\n');
}

const SCRIPT = [
  'set -euo pipefail',
  fnSource('wt_parent'),
  fnSource('logerr'),
  fnSource('ensure_rework_worktree'),
  fnSource('ensure_acceptance_worktree'),
  'fn="$1"; shift; "$fn" "$@"',
].join('\n');

// 真跑函数，返回 stdout / stderr / 退出码，让"混进 stdout"这类问题自己现形。
function runFn(cwd, fn, ...args) {
  const r = spawnSync('bash', ['-c', SCRIPT, 'bash', fn, ...args], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

// 临时仓库：origin.git（裸）+ seed（造远端分支）+ coord（模拟协调器 worktree）。
// coord 的同级目录就是各 worktree 的落点，和 wt_parent 的口径一致。
function makeFixture() {
  // macOS 的 $TMPDIR 在 /var（软链到 /private/var），先取真实路径，
  // 否则 git 返回的绝对路径和 mkdtemp 给的对不上。
  const tmp = mkdtempSync(path.join(realpathSync(tmpdir()), 'vk-rework-'));
  const origin = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  const coord = path.join(tmp, 'coord');

  git(tmp, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(tmp, ['clone', '-q', origin, seed]);
  writeFileSync(path.join(seed, 'f.txt'), 'main\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'init']);
  git(seed, ['push', '-q', '-u', 'origin', 'main']);

  git(seed, ['checkout', '-q', '-b', BRANCH]);
  writeFileSync(path.join(seed, 'f.txt'), 'wip\n');
  git(seed, ['commit', '-qam', 'wip']);
  git(seed, ['push', '-q', 'origin', BRANCH]);
  const remoteHead = git(seed, ['rev-parse', 'HEAD']);

  git(tmp, ['clone', '-q', origin, coord]);
  return {
    tmp,
    coord,
    remoteHead,
    reworkDir: path.join(tmp, `rework-${ISSUE}`),
    acceptanceDir: path.join(tmp, 'acceptance'),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

test('本地无该分支：stdout 只有 path:，重跑同样干净（目录已存在）', () => {
  const fx = makeFixture();
  try {
    // 前置：本地确实没有这条分支，否则测不到 `worktree add -b` 那条路。
    assert.throws(() => git(fx.coord, ['rev-parse', '--verify', `refs/heads/${BRANCH}`]));

    const first = runFn(fx.coord, 'ensure_rework_worktree', ISSUE, BRANCH);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, `path:${fx.reworkDir}`, `git 输出混进了 stdout：${JSON.stringify(first.stdout)}`);
    assert.equal(git(fx.coord, ['rev-parse', BRANCH]), fx.remoteHead, '本地分支应指向 origin 的最新提交');
    assert.ok(git(fx.coord, ['worktree', 'list', '--porcelain']).includes(`worktree ${fx.reworkDir}`));

    // 第二次：目录已存在，走 switch + reset 分支——仍然只能有一行 path:。
    const second = runFn(fx.coord, 'ensure_rework_worktree', ISSUE, BRANCH);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, `path:${fx.reworkDir}`, `重复调用时 stdout 不干净：${JSON.stringify(second.stdout)}`);

    // 有未提交改动时函数拒绝复用：此时 stdout 也必须为空，不能给半个 selector。
    writeFileSync(path.join(fx.reworkDir, 'f.txt'), 'dirty\n');
    const dirty = runFn(fx.coord, 'ensure_rework_worktree', ISSUE, BRANCH);
    assert.equal(dirty.code, 1);
    assert.equal(dirty.stdout, '', `失败路径不该输出 selector：${JSON.stringify(dirty.stdout)}`);
    assert.match(dirty.stderr, /有未提交改动/);
  } finally {
    fx.cleanup();
  }
});

test('本地有残留分支：强制对齐 origin 后 stdout 仍只有 path:', () => {
  const fx = makeFixture();
  try {
    // 残留：本地 issue-7-lane-1 停在 main，落后 origin 一个提交。
    const stale = git(fx.coord, ['rev-parse', 'HEAD']);
    git(fx.coord, ['branch', BRANCH, stale]);
    assert.notEqual(stale, fx.remoteHead);

    const out = runFn(fx.coord, 'ensure_rework_worktree', ISSUE, BRANCH);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, `path:${fx.reworkDir}`, `git 输出混进了 stdout：${JSON.stringify(out.stdout)}`);
    assert.equal(git(fx.coord, ['rev-parse', BRANCH]), fx.remoteHead, '残留分支应被强制对齐到 origin');
  } finally {
    fx.cleanup();
  }
});

test('验收 worktree：首次与重复调用 stdout 都只有 path:', () => {
  const fx = makeFixture();
  try {
    const first = runFn(fx.coord, 'ensure_acceptance_worktree');
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, `path:${fx.acceptanceDir}`, `git 输出混进了 stdout：${JSON.stringify(first.stdout)}`);

    const second = runFn(fx.coord, 'ensure_acceptance_worktree');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, `path:${fx.acceptanceDir}`, `重复调用时 stdout 不干净：${JSON.stringify(second.stdout)}`);
    assert.ok(git(fx.acceptanceDir, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD', '验收 worktree 应是 detached');
  } finally {
    fx.cleanup();
  }
});