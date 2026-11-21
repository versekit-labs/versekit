// 返工 / 验收 worktree 的 stdout 契约（ACC-harness-cycle-11）。
//
// `dispatch_rework` 用 `resolved=$(ensure_rework_worktree …)` 取 selector，同一行
// 再把 `path:<绝对路径>` 交给 worker-start。git 只要往 stdout 写一句
// `branch '…' set up to track '…'` 或 `HEAD is now at …`，selector 就坏了，worker-start
// 报 selector_not_found（2026-11-15 #101 返工三连败的根因）。
//
// 这里不 mock git：在临时仓库里真建裸 origin + 协调器 worktree，再把 bin/cycle.sh 里的
// 函数原样抽出来执行，断言 stdout **严格等于** `path:<绝对路径>`。
// 派工测试在同一临时仓库运行完整 cycle.sh，所有 Orca 和 GitHub 调用都走假命令。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CYCLE_SH = path.join(ROOT, 'bin/cycle.sh');
const ISSUE = '99999';
const BRANCH = `issue-${ISSUE}-lane-1`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'harness',
  GIT_AUTHOR_EMAIL: 'harness@example.test',
  GIT_COMMITTER_NAME: 'harness',
  GIT_COMMITTER_EMAIL: 'harness@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ALLOW_PROTOCOL: 'file',
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
    // 残留：本地分支停在 main，落后 origin 一个提交。
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

function makeCycleFixture(t) {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const bin = path.join(fx.coord, 'bin');
  mkdirSync(bin);
  copyFileSync(CYCLE_SH, path.join(bin, 'cycle.sh'));
  const runFile = path.join(fx.tmp, 'run-id');
  const calls = path.join(fx.tmp, 'calls');
  const state = path.join(fx.tmp, 'state');
  writeFileSync(runFile, 'run_fake');
  writeFileSync(calls, '');
  const claim = {
    number: Number(ISSUE), title: 'fixture', pull: Number(ISSUE) + 1,
    branch: BRANCH, head: fx.remoteHead, round: 1,
  };

  writeFileSync(path.join(bin, 'agentctl.mjs'), String.raw`
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CYCLE_TEST_CALLS, 'agentctl ' + args.join(' ') + '\n');
if (args[0] === 'claim' && args[2] === 'rework') {
  const claim = ${JSON.stringify(claim)};
  console.log(JSON.stringify(args.includes('--dry-run') ? { wouldClaim: [claim] } : { claimed: claim }));
} else {
  console.log('{}');
}
`);
  writeFileSync(path.join(bin, 'ghx'), String.raw`#!/usr/bin/env bash
printf 'ghx %s\n' "$*" >> "$CYCLE_TEST_CALLS"
printf 'model:codex\n'
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'worker-channel.sh'), String.raw`#!/usr/bin/env bash
printf 'codex|gpt-fake|fixture\n'
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'orca'), String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const [group, command, ...args] = process.argv.slice(2);
const { CYCLE_TEST_CALLS: calls, REWORK_PATH: dir, REWORK_VISIBILITY: visibility } = process.env;
const past = readFileSync(calls, 'utf8').split('\n');
const log = (event) => appendFileSync(calls, event + '\n');
const reply = (result) => console.log(JSON.stringify({ ok: true, result }));
switch (group + ' ' + command) {
  case 'orchestration run-show': reply({ run: { coordinator_handle: 'term_fake' } }); break;
  case 'orchestration worker-list': reply({ workers: [] }); break;
  case 'worktree show':
    log('worktree show');
    if (!process.env.REWORK_EXISTING) process.exit(1);
    reply({});
    break;
  case 'worktree list': {
    if (!existsSync(dir + '/.git')) throw new Error('list ran before git worktree add');
    const probe = past.filter((line) => line.startsWith('list ')).length;
    const steps = visibility.split(',');
    const visible = steps[Math.min(probe, steps.length - 1)];
    log('list ' + visible);
    reply({ worktrees: [{ path: visible === 'visible' ? dir : dir + '-other' }] });
    break;
  }
  case 'orchestration task-create': log('task-create'); reply({ task: { id: 'task_fake' } }); break;
  case 'orchestration worker-start': {
    const task = args[args.indexOf('--task') + 1];
    const worktree = args[args.indexOf('--worktree') + 1];
    const listed = past.filter((line) => line.startsWith('list ')).at(-1) === 'list visible';
    const first = !past.some((line) => line.startsWith('worker-start '));
    log('worker-start ' + task + ' ' + worktree);
    if (worktree !== 'branch:${BRANCH}' &&
        (worktree !== 'path:' + dir || !listed || (first && process.env.REWORK_SELECTOR_RACE))) {
      console.error(JSON.stringify({ ok: false, error: { code: 'selector_not_found' } }));
      process.exit(1);
    }
    reply({ dispatchId: 'ctx_fake' });
    break;
  }
  default: log('unexpected orca ' + group + ' ' + command); process.exit(1);
}
`, { mode: 0o755 });

  return {
    ...fx,
    pending: path.join(state, `rework-${ISSUE}.pending-task`),
    dispatch: path.join(state, 'dispatch-ctx_fake.json'),
    run({ visibility = 'visible', race = false, existing = false, wait = '10', dry = false } = {}) {
      const { ORCA_TERMINAL_HANDLE, ...env } = GIT_ENV;
      const result = spawnSync('bash', ['bin/cycle.sh', '--no-consume', ...(dry ? ['--dry-run'] : ['--max', '0'])], {
        cwd: fx.coord,
        encoding: 'utf8',
        timeout: 60000,
        env: {
          ...env,
          PATH: `${bin}:${process.env.PATH}`,
          CYCLE_TEST_CALLS: calls,
          REWORK_PATH: fx.reworkDir,
          REWORK_VISIBILITY: visibility,
          REWORK_SELECTOR_RACE: race ? '1' : '',
          REWORK_EXISTING: existing ? '1' : '',
          CYCLE_REWORK_WAIT_SECONDS: wait,
          CYCLE_WORKER_RETRIES: '2',
          CYCLE_RETRY_BACKOFF_1: '0',
          CYCLE_RETRY_BACKOFF_2: '0',
          CYCLE_NATIVE_AGENTS: '1',
          WORKER_AGENT: '',
          RUN_FILE: runFile,
          STATE_DIR: state,
          LOCK_DIR: path.join(fx.tmp, 'locks'),
        },
      });
      const events = readFileSync(calls, 'utf8').trimEnd().split('\n');
      assert.equal(result.status, 0, [result.error, result.stdout, result.stderr, ...events].filter(Boolean).join('\n'));
      assert.ok(events.every((event) => !event.startsWith('unexpected orca')), events.join('\n'));
      return { ...result, events };
    },
  };
}

const dispatchEvents = (events) => events.filter((event) => /^(list |task-create|worker-start )/.test(event));
const rollback = `agentctl set --issue ${ISSUE} --to changes --force`;
const pathStart = (fx) => `worker-start task_fake path:${fx.reworkDir}`;

function assertOnlyHiddenProbes(events) {
  assert.ok(events.length > 0 && events.every((event) => event === 'list hidden'), events.join('\n'));
}

test('ACC-harness-cycle-14：新建 worktree 等 Orca 认出后首次派工成功', (t) => {
  const fx = makeCycleFixture(t);
  const result = fx.run({ visibility: 'hidden,hidden,visible' });
  assert.deepEqual(dispatchEvents(result.events), ['list hidden', 'list hidden', 'list visible', 'task-create', pathStart(fx)]);
  assert.equal(JSON.parse(readFileSync(fx.dispatch, 'utf8')).issue, Number(ISSUE));
});

test('ACC-harness-cycle-14：一直未识别时不建 task，退回 s:changes 后下一轮可派', (t) => {
  const fx = makeCycleFixture(t);
  const timedOut = fx.run({ visibility: 'hidden', wait: '2' });
  assertOnlyHiddenProbes(dispatchEvents(timedOut.events));
  assert.equal(timedOut.events.filter((event) => event === rollback).length, 1);
  assert.deepEqual(timedOut.stderr.split('\n').filter((line) => line.includes('Orca 还没认出新建的 worktree')),
    [`    · Orca 还没认出新建的 worktree ${fx.reworkDir}（等了 2 秒，下轮再派）`]);
  assert.equal(existsSync(fx.dispatch), false);

  const resumed = fx.run();
  assert.deepEqual(dispatchEvents(resumed.events).slice(-3), ['list visible', 'task-create', pathStart(fx)]);
  assert.ok(existsSync(fx.dispatch));
});

test('ACC-harness-cycle-14：selector_not_found 之后等路径回到列表才重试原 task', (t) => {
  const fx = makeCycleFixture(t);
  const result = fx.run({ visibility: 'visible,hidden,visible', race: true });
  assert.deepEqual(dispatchEvents(result.events), [
    'list visible', 'task-create', pathStart(fx), 'list hidden', 'list visible', pathStart(fx),
  ]);
  assert.ok(existsSync(fx.dispatch));
});

test('ACC-harness-cycle-14：重试前等到超时，下一轮沿用 task', (t) => {
  const fx = makeCycleFixture(t);
  const timedOut = fx.run({ visibility: 'visible,hidden', race: true, wait: '2' });
  const dispatchCalls = dispatchEvents(timedOut.events);
  assert.deepEqual(dispatchCalls.slice(0, 3), ['list visible', 'task-create', pathStart(fx)]);
  assertOnlyHiddenProbes(dispatchCalls.slice(3));
  assert.equal(timedOut.events.filter((event) => event === rollback).length, 1);
  assert.ok(existsSync(fx.pending));
  assert.equal(existsSync(fx.dispatch), false);

  const resumed = fx.run({ existing: true });
  assert.deepEqual(dispatchEvents(resumed.events.slice(timedOut.events.length)), [`worker-start task_fake branch:${BRANCH}`]);
  assert.ok(existsSync(fx.dispatch));
  assert.equal(existsSync(fx.pending), false);
});

test('已有 worktree 的返工仍用 branch selector，不查询列表', (t) => {
  const fx = makeCycleFixture(t);
  const dir = path.join(fx.tmp, 'existing');
  git(fx.coord, ['worktree', 'add', '-q', '--track', '-b', BRANCH, dir, `origin/${BRANCH}`]);
  const result = fx.run({ existing: true });
  assert.deepEqual(dispatchEvents(result.events), ['task-create', `worker-start task_fake branch:${BRANCH}`]);
  assert.equal(existsSync(fx.reworkDir), false);
});

test('ACC-harness-model-05：cycle.sh --dry-run --no-consume 不改 issue 状态', (t) => {
  const fx = makeCycleFixture(t);
  const result = fx.run({ dry: true });
  assert.ok(result.stdout.includes(`[dry-run] 会派返工 #${ISSUE}`));
  assert.deepEqual(result.events.filter((event) => event.startsWith('agentctl ')), [
    'agentctl tick', 'agentctl merge --pending --dry-run', 'agentctl claim --role engineer --dry-run --json',
    'agentctl claim --role rework --dry-run --json', 'agentctl claim --role acceptance --json',
  ]);
  assert.deepEqual(dispatchEvents(result.events), []);
  assert.equal(existsSync(fx.reworkDir), false);
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
