// ACC-harness-cycle-13：取 issue label 失败不得静默退回 Sonnet。
//
// 不起真 orca / gh：从 bin/cycle.sh 抽出 issue_labels 与 dispatch_engineer_lane 原样执行，
// 用假 bin/ghx（按计数文件决定第几次失败）和桩函数代替外部依赖，
// 断言：首次失败重试后照常按 model:opus 派；两次都失败有日志、不起终端、退回 s:ready。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CYCLE_SH = path.join(ROOT, 'bin/cycle.sh');

function fnSource(name) {
  const lines = readFileSync(CYCLE_SH, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `bin/cycle.sh 里找不到 ${name}()`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
}

// failures = 前几次 `issue view` 失败。
function run(failures) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vk-labels-'));
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(path.join(dir, 'bin/ghx'), `#!/usr/bin/env bash
n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"
if [ "$n" -le ${failures} ]; then echo "HTTP 502 bad gateway" >&2; exit 1; fi
printf 'model:opus\\ns:ready\\n'
`);
  chmodSync(path.join(dir, 'bin/ghx'), 0o755);
  const script = [
    'set -uo pipefail',
    'export CYCLE_LABEL_RETRY_SLEEP=0',
    'log() { printf "%s\\n" "$*"; }',
    'logerr() { printf "%s\\n" "$*" >&2; }',
    'jget() { python3 -c \'import json,sys;d=json.load(sys.stdin)\nfor k in sys.argv[1].split("."): d=d.get(k) if isinstance(d,dict) else None\nprint("" if d is None else d)\' "$1"; }',
    'print_claim_skipped() { :; }',
    'prepare_lane_worktree() { printf "%s" "/wt"; }',
    'lane_selector() { printf "path:%s" "$1"; }',
    'lane_read() { printf "issue-155-lane-1"; }',
    `node() { printf '{"claimed":{"number":155,"title":"t","body":"b","acc":["ACC-x"],"files":[]}}'; }`,
    'set_issue_state() { echo "STATE $1 $2"; }',
    // 到这里说明标签已拿到：把收到的 labels 打出来，再让流程在起终端处停下。
    'ensure_terminal() { echo "TERMINAL labels=$6" >&2; return 1; }',
    fnSource('issue_labels'),
    fnSource('dispatch_engineer_lane'),
    'dispatch_engineer_lane 1; echo "RC=$?"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' });
  const calls = Number(existsSync(path.join(dir, 'n')) ? readFileSync(path.join(dir, 'n'), 'utf8') : 0);
  return { out: r.stdout, err: r.stderr, calls };
}

test('首次取 label 失败：重试一次后照常带 model:opus 往下派', () => {
  const r = run(1);
  assert.equal(r.calls, 2);
  assert.match(r.err, /TERMINAL labels=model:opus,s:ready/);
  assert.doesNotMatch(r.out + r.err, /取 #155 的 label 失败/);
});

test('两次都失败：有日志、不起终端、退回 s:ready、不退回 Sonnet', () => {
  const r = run(2);
  assert.equal(r.calls, 2);
  assert.match(r.err, /✗ 取 #155 的 label 失败：.*HTTP 502 bad gateway/);
  assert.doesNotMatch(r.out + r.err, /TERMINAL/);
  assert.match(r.out, /STATE 155 ready/);
  assert.match(r.out, /RC=3/);
});
