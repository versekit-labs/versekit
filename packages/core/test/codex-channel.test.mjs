// ACC-harness-codex-01/03/04：model:codex 通道。
// 全部离线：假 codex / 假 claude / 假 orca / 假 agentctl，不联网、不花 token、不碰 ~/.codex 与 ~/.claude。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const CYCLE_SH = join(ROOT, 'bin/cycle.sh');

function sandbox({ codex = 'ok' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codexch-'));
  for (const d of ['state', 'locks', 'home', 'bin']) mkdirSync(join(dir, d));
  const exe = (name, body) => { writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, 'bin', name), 0o755); };
  // 假 claude：被调用就留痕；codex 通道全程不该调用它。
  exe('claude', `echo "$*" >> "${dir}/claude.calls"; echo '{"is_error":false,"result":"ok"}'`);
  if (codex !== 'missing') {
    exe('codex', `echo "$*" >> "${dir}/codex.calls"
if [ "$1 $2" = "login status" ]; then
  ${codex === 'loggedout' ? 'echo "Not logged in"; exit 1' : 'echo "Logged in using ChatGPT"; exit 0'}
fi
exit 99`);
  }
  return dir;
}
const envFor = (dir, extra = {}) => ({
  ...process.env, HOME: join(dir, 'home'),
  // 只留系统基本目录 + 沙箱 bin：保证「PATH 里没有 codex」是真的。
  PATH: `${join(dir, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin:${dirname(process.execPath)}`,
  STATE_DIR: join(dir, 'state'), LOCK_DIR: join(dir, 'locks'),
  CLAUDE_PROBE: '0', ...extra,
});
const channel = (dir, args, extra) => spawnSync('bash', [join(ROOT, 'bin/worker-channel.sh'), ...args],
  { encoding: 'utf8', env: envFor(dir, extra) });
const calls = (dir, f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');

test('codex-01：model:codex → codex|gpt-6.2-sol，不调用 claude、不跑 codex exec', () => {
  const dir = sandbox();
  const r = channel(dir, ['--role', 'engineer', '--labels', 'model:codex,s:ready']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^codex\|gpt-6\.2-sol\|issue 带 model:codex label → Codex$/);
  assert.equal(calls(dir, 'claude.calls'), '');
  assert.equal(calls(dir, 'codex.calls').trim(), 'login status'); // 只有登录状态，没有 exec
});

test('codex-01：CODEX_MODEL 可改；不带 label 照旧 Sonnet，验收不走 codex', () => {
  const dir = sandbox();
  let r = channel(dir, ['--role', 'engineer', '--labels', 'model:codex'], { CODEX_MODEL: 'gpt-x' });
  assert.match(r.stdout, /^codex\|gpt-x\|/);
  r = channel(dir, ['--role', 'engineer', '--labels', 's:ready']);
  assert.match(r.stdout, /^claude\|sonnet\|/);
  assert.doesNotMatch(calls(dir, 'codex.calls'), /exec/);
  r = channel(dir, ['--role', 'acceptance', '--labels', 'model:codex'], { ARKCLI_CODING_PLAN_API_KEY: '' });
  assert.doesNotMatch(r.stdout, /^codex\|/);
});

test('codex-03：返工 round 1 仍 Codex，round 2 升 Sonnet 且写明原因；Opus 优先', () => {
  const dir = sandbox();
  let r = channel(dir, ['--role', 'rework', '--labels', 'model:codex', '--round', '1']);
  assert.match(r.stdout, /^codex\|gpt-6\.2-sol\|/);
  r = channel(dir, ['--role', 'rework', '--labels', 'model:codex', '--round', '2']);
  assert.match(r.stdout, /^claude\|sonnet\|.*Codex 第 2 轮仍未过 → 升 Sonnet/);
  r = channel(dir, ['--role', 'rework', '--labels', 'model:codex', '--round', '3']);
  assert.match(r.stdout, /^claude\|sonnet\|/); // 不自动升 Opus
  r = channel(dir, ['--role', 'engineer', '--labels', 'model:codex,model:opus']);
  assert.match(r.stdout, /^claude\|opus\|/);
  assert.doesNotMatch(calls(dir, 'codex.calls'), /exec/);
});

test('codex-04：没有 codex 命令 → 改派 Sonnet，日志写原因', () => {
  const dir = sandbox({ codex: 'missing' });
  const r = channel(dir, ['--role', 'engineer', '--labels', 'model:codex']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^claude\|sonnet\|.*Codex 不可用（找不到 codex 命令）→ 改派 Sonnet/);
});

test('codex-04：codex login status 未登录 → 改派 Sonnet；不打印凭据', () => {
  const dir = sandbox({ codex: 'loggedout' });
  const r = channel(dir, ['--role', 'engineer', '--labels', 'model:codex']);
  assert.match(r.stdout, /^claude\|sonnet\|.*Codex 不可用（Codex 未登录）→ 改派 Sonnet/);
  assert.equal(calls(dir, 'codex.calls').trim(), 'login status');
});

test('codex-04：冷却期内改派 Sonnet，到点自动恢复 Codex', () => {
  const dir = sandbox();
  const f = join(dir, 'state', 'codex-exhausted');
  writeFileSync(f, `${Math.floor(Date.now() / 1000) + 3600}\t2099-01-01 00:00:00 +0800\n`);
  let r = channel(dir, ['--role', 'engineer', '--labels', 'model:codex']);
  assert.match(r.stdout, /^claude\|sonnet\|.*Codex 额度用完，到 2099-01-01 00:00:00 \+0800 为止/);
  assert.equal(calls(dir, 'codex.calls'), ''); // 冷却期内连 login status 都不问
  writeFileSync(f, `${Math.floor(Date.now() / 1000) - 5}\t过去\n`);
  r = channel(dir, ['--role', 'engineer', '--labels', 'model:codex']);
  assert.match(r.stdout, /^codex\|gpt-6\.2-sol\|/);
});

// ---- cycle.sh：原生启动把 codex 展开成 --agent codex --model <CODEX_MODEL> ----
function fnSource(name) {
  const lines = readFileSync(CYCLE_SH, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `bin/cycle.sh 里找不到 ${name}()`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
}

function dispatchWith(dir, labels, round = '', extra = {}) {
  writeFileSync(join(dir, 'bin', 'orca'), `#!/usr/bin/env bash
echo "$*" >> "${dir}/orca.calls"
echo '{"ok":true,"result":{"dispatchId":"ctx_fake"}}'
`);
  chmodSync(join(dir, 'bin', 'orca'), 0o755);
  const script = [
    'set -uo pipefail',
    `cd "${ROOT}"`,
    `STATE_DIR="${join(dir, 'state')}"; NATIVE_AGENTS=1; WORKER_AGENT=""; WORKER_RETRIES=0; RUN_ID=run_fake; SENDER=term_fake`,
    'log() { printf "%s\\n" "$*"; }',
    ...['logerr', 'role_label', 'jpick', 'receipt_fields', 'retry_backoff', 'choose_worker_channel', 'terminal_field', 'ensure_terminal', 'worker_start_with_retry'].map(fnSource),
    `handle=$(ensure_terminal engineer /wt "worker: #1" "" lane-1 "${labels}" "${round}") || { echo "ENSURE_FAIL"; exit 3; }`,
    'echo "HANDLE=$handle"',
    'echo "REASON=$(terminal_field lane-1 reason)"',
    'worker_start_with_retry task_1 "$handle" /wt',
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: envFor(dir, extra) });
}

// ---- coordinator-loop：Codex worker 屏幕出现用量上限 ----
function loopSandbox(limitText, channelName = 'codex') {
  const dir = sandbox();
  const { state } = { state: join(dir, 'state') };
  writeFileSync(join(dir, 'run-id'), 'run_fake');
  writeFileSync(join(dir, 'cycle.sh'), `#!/usr/bin/env bash\necho called >> "${dir}/cycle.calls"\nexit 0\n`);
  chmodSync(join(dir, 'cycle.sh'), 0o755);
  writeFileSync(join(dir, 'agentctl.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(dir, 'agentctl.calls'))}, process.argv.slice(2).join(' ') + '\\n');\n`);
  writeFileSync(join(dir, 'bin', 'orca'), `#!/usr/bin/env bash
D="${dir}"
case "$2" in
  check)
    n=$(cat "$D/checks" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/checks"
    sleep 0.2; if [ "$n" -gt 3 ]; then echo '{"ok":true,"result":{"cancelled":true}}'; exit 0; fi
    echo '{"ok":true,"result":{"messages":[]}}' ;;
  worker-list)
    if [ -f "$D/stop.calls" ]; then echo '{"ok":true,"result":{"workers":[]}}'; exit 0; fi
    echo '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_cdx","terminalState":"active","resource":{"worktreeId":"x::/w/cycle-issue-259-1"},"projection":{}}]}}' ;;
  worker-stop) echo "$*" >> "$D/stop.calls"; echo '{"ok":true}' ;;
  worker-read)
    cat "$D/read.json" ;;
esac
`);
  chmodSync(join(dir, 'bin', 'orca'), 0o755);
  writeFileSync(join(dir, 'read.json'), JSON.stringify({ ok: true, result: { terminal: { tail: ['working...', limitText] }, cursor: 'c' } }));
  writeFileSync(join(state, 'dispatch-ctx_cdx.json'), JSON.stringify({ issue: 259, role: 'engineer', pull: '', files: [], channel: channelName }));
  return dir;
}
const loop = (dir) => spawnSync('bash', [join(ROOT, 'bin/coordinator-loop.sh')], {
  cwd: ROOT, encoding: 'utf8', timeout: 60000,
  env: envFor(dir, { RUN_FILE: join(dir, 'run-id'), CYCLE_BIN: join(dir, 'cycle.sh'), AGENTCTL_BIN: join(dir, 'agentctl.mjs'),
    CYCLE_LOG: join(dir, 'cycle.log'), COORD_STATE_DIR: join(dir, 'coord'), COORD_WAIT_MS: '100' }),
});

// ---- ACC-harness-codex-06：Codex 任务书写明 GitHub 交付物允许执行 ----
function renderSpecs(channel) {
  const script = [
    'set -uo pipefail',
    ...['claude_task_constraints', 'codex_github_note', 'engineer_spec', 'rework_spec'].map(fnSource),
    `engineer_spec 1 t /wt 1 br body ${channel}`,
    'echo "=====REWORK====="',
    `rework_spec 1 t 5 br 2 http://c cbody /wt body ${channel}`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
