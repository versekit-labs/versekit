// ACC-harness-queue-01 ④⑤：cycle.sh 的排队放行段 + coordinator-loop 不因 s:triage 退出 13。
//
// 不起真 orca / GitHub：从 bin/cycle.sh 抽出放行函数原样执行，agentctl 走本地 mock API；
// coordinator-loop 用假 orca、假 cycle.sh、假 agentctl（见 coordinator-loop.test.mjs 的做法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

const body = (extra = '') => `## 验收口径\n- [ACC-harness-queue-01]\n\n## 涉及与不可动\n- 改：\`bin/cycle.sh\`\n${extra}`;
const issue = (number, labels, b = body()) => ({ number, title: `单 ${number}`, body: b, labels, updated_at: '2026-11-22T00:00:00Z' });

async function mockGithub(t, issues) {
  const puts = [];
  const server = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname.replace(/^\/repos\/example\/versekit\//, '');
    let data;
    if (req.method === 'GET' && p === 'issues') data = issues;
    else if (req.method === 'GET' && p === 'pulls') data = [];
    else if (req.method === 'GET' && /^issues\/\d+$/.test(p)) data = issues.find((i) => `issues/${i.number}` === p);
    else if (req.method === 'PUT' && /^issues\/\d+\/labels$/.test(p)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      puts.push({ issue: Number(p.split('/')[1]), labels: JSON.parse(Buffer.concat(chunks).toString()).labels });
      data = [];
    }
    res.writeHead(data === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data ?? {}));
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { puts, base: `http://127.0.0.1:${server.address().port}` };
}

// freeSlots：假 lane_available 说有几个 lane 空着（总 lane 数 = CYCLE_LANES）。
async function runRelease(t, issues, { lanes = 2, free = lanes, dry = 0, preAlert = '' } = {}) {
  const gh = await mockGithub(t, issues);
  const dir = mkdtempSync(path.join(tmpdir(), 'vk-queue-'));
  if (preAlert) writeFileSync(path.join(dir, 'cycle-owner-alert.txt'), preAlert);
  const script = [
    'set -uo pipefail',
    `STATE_DIR="${dir}"; DRY=${dry}; MAX=2; FAILED=0; CYCLE_LANES=${lanes}; LANES_USED=""`,
    'log() { printf "%s\\n" "$*"; }',
    `lane_available() { [ "$1" -le ${free} ]; }`,
    fnSource('count_free_lanes'),
    'QUEUE_SKIP_ALERTS=""',
    fnSource('queue_skip_alerts_load'),
    fnSource('release_from_queue'),
    fnSource('write_queue_skip_alerts'),
    'queue_skip_alerts_load',
    'release_from_queue || FAILED=1',
    'write_queue_skip_alerts',
    'echo "FAILED=$FAILED"',
  ].join('\n');
  const out = await new Promise((resolve) => {
    execFile('bash', ['-c', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url',
        GIT_CONFIG_VALUE_0: 'https://github.com/example/versekit.git',
        GH_TOKEN: 'fixture', AGENTCTL_API_BASE: gh.base,
      },
    }, (err, stdout, stderr) => resolve({ stdout, stderr }));
  });
  const alertFile = path.join(dir, 'cycle-owner-alert.txt');
  return { ...out, puts: gh.puts, alert: existsSync(alertFile) ? readFileSync(alertFile, 'utf8') : '' };
}

const scenario = () => [
  issue(1, ['s:doing']),
  issue(2, ['s:triage']),
  issue(5, ['s:queued'], body('\n**依赖**：#6\n')),
  issue(6, ['s:doing']),
  issue(7, ['s:queued'], '## 验收口径\n- [ACC-nope-99]\n'),
  issue(8, ['s:queued']),
  issue(9, ['s:queued', 'prio:high']),
];

test('cycle.sh ①②③：有空 lane、ready 为空 → 放行 prio:high 的 #9；被跳过的写进 alert 并说原因', async (t) => {
  const r = await runRelease(t, scenario());
  assert.match(r.stdout, /从排队里放行 #9（排第 1）/, r.stdout + r.stderr);
  assert.deepEqual(r.puts, [{ issue: 9, labels: ['s:ready', 'prio:high'] }]);
  assert.match(r.alert, /\[排队跳过\] #5：依赖 #6 未完成/);
  assert.match(r.alert, /\[排队跳过\] #7：引用了 ACCEPTANCE\.md 里不存在的条目：ACC-nope-99/);
  assert.doesNotMatch(r.alert, /#8|#2/); // #8 能派、#2 是 s:triage，循环不碰
  assert.match(r.stdout, /FAILED=0/);
});

test('cycle.sh ②：没有 prio:high 时按 issue 号；前面跳过的写进日志', async (t) => {
  const issues = scenario().filter((i) => i.number !== 9);
  const r = await runRelease(t, issues);
  assert.match(r.stdout, /从排队里放行 #8（排第 1，前面跳过 #5：依赖 #6 未完成，前面跳过 #7：/, r.stdout);
  assert.deepEqual(r.puts, [{ issue: 8, labels: ['s:ready'] }]);
});

test('cycle.sh ④：两条 lane 都占满 → 不放行', async (t) => {
  const r = await runRelease(t, scenario(), { free: 0 });
  assert.match(r.stdout, /lane 已占满/);
  assert.deepEqual(r.puts, []);
});

test('cycle.sh ④：已有一张 s:ready → 不放行', async (t) => {
  const r = await runRelease(t, [...scenario(), issue(3, ['s:ready'])]);
  assert.match(r.stdout, /已有 s:ready/);
  assert.deepEqual(r.puts, []);
});

test('cycle.sh：lane 只空一条也放行；没评估队列的轮次保留上一轮的跳过告警', async (t) => {
  const pre = '[排队跳过] #5：依赖 #6 未完成 （旧）\n';
  const r = await runRelease(t, scenario(), { free: 1, lanes: 2, preAlert: pre });
  assert.deepEqual(r.puts, [{ issue: 9, labels: ['s:ready', 'prio:high'] }]);
  const full = await runRelease(t, scenario(), { free: 0, preAlert: pre });
  assert.match(full.alert, /依赖 #6 未完成 （旧）/);
});

test('cycle.sh --dry-run：只报会放行谁，不写 label', async (t) => {
  const r = await runRelease(t, scenario(), { dry: 1 });
  assert.match(r.stdout, /\[dry-run\] 会从排队里放行 #9/);
  assert.deepEqual(r.puts, []);
});

test('cycle.sh 的主流程里放行在派工之前、s:triage 不被放行命令引用', () => {
  const src = readFileSync(CYCLE_SH, 'utf8');
  assert.ok(src.indexOf('release_from_queue || FAILED=1') < src.indexOf('dispatch_engineer_lane "$lane"'));
  assert.doesNotMatch(fnSource('release_from_queue'), /triage/);
});

// ---------------------------------------------------------------- coordinator-loop ⑤
function loopRun(tickRows, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'coordloop-q-'));
  writeFileSync(path.join(dir, 'run-id'), 'run_fake');
  writeFileSync(path.join(dir, 'cycle.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'orca'), `#!/usr/bin/env bash
case "$2" in
  check) sleep 0.05; echo '{"ok":true,"result":{"messages":[]}}' ;;
  worker-list) echo '{"ok":true,"result":{"workers":[]}}' ;;
esac
`);
  writeFileSync(path.join(dir, 'fake-agentctl.mjs'), `if (process.argv[2] === 'tick') process.stdout.write(${JSON.stringify(JSON.stringify({ rows: tickRows }))});\n`);
  chmodSync(path.join(dir, 'cycle.sh'), 0o755);
  chmodSync(path.join(dir, 'orca'), 0o755);
  return new Promise((resolve) => {
    const p = spawn('bash', [path.join(ROOT, 'bin/coordinator-loop.sh')], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUN_FILE: path.join(dir, 'run-id'),
        CYCLE_BIN: path.join(dir, 'cycle.sh'), CYCLE_LOG: path.join(dir, 'cycle.log'),
        COORD_STATE_DIR: path.join(dir, 'state'), STATE_DIR: path.join(dir, 'vstate'),
        COORD_WAIT_MS: '50', COORD_IDLE_ROUNDS: '2', AGENTCTL_BIN: path.join(dir, 'fake-agentctl.mjs'), ...extra },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (status) => resolve({ status, out }));
  });
}

test('coordinator-loop ⑤：s:triage 里还有但 s:queued 有可放的 → 不退出 13，等几轮后才按原规则退', async () => {
  const rows = [
    { number: 1, state: 'triage', labels: ['s:triage'] },
    { number: 2, state: 'queued', labels: ['s:queued'], blocked: undefined },
  ];
  const r = await loopRun(rows, { COORD_QUEUE_WAITS: '2' });
  assert.match(r.out, /s:queued 里有 1 张可放行，等循环放行（1\/2）/);
  assert.match(r.out, /（2\/2）/);
  assert.equal(r.status, 13, r.out); // 放行一直没发生：不能无限空转，用尽等待后仍按 s:triage 退 13
});

test('coordinator-loop ⑤：只有 s:triage → 照旧退出 13，提示转 s:queued', async () => {
  const r = await loopRun([{ number: 1, state: 'triage', labels: ['s:triage'] }]);
  assert.equal(r.status, 13, r.out);
  assert.match(r.out, /转 s:queued/);
  assert.doesNotMatch(r.out, /等循环放行/);
});

test('coordinator-loop ⑤：排队的都被跳过（blocked）→ 不算可放，照旧退出', async () => {
  const r = await loopRun([{ number: 2, state: 'queued', labels: ['s:queued'], blocked: true }]);
  assert.equal(r.status, 0, r.out);
});
