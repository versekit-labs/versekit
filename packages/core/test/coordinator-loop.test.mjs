// ACC-harness-cycle-12：假 orca 验证循环对停摆 worker 以退出码 11 停下
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');

function setup(readMode) {
  const dir = mkdtempSync(join(tmpdir(), 'coordloop-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'run-id'), 'run_fake');
  writeFileSync(join(dir, 'cycle.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(dir, 'cycle.sh'), 0o755);
  writeFileSync(join(dir, 'orca'), `#!/usr/bin/env bash
D="${dir}"
case "$2" in
  check)
    n=$(cat "$D/checks" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/checks"
    sleep 0.4; if [ "$n" -gt 8 ]; then echo '{"ok":true,"result":{"cancelled":true}}'; exit 0; fi
    echo '{"ok":true,"result":{"messages":[]}}' ;;
  worker-list)
    echo '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_fake","terminalState":"active","resource":{"worktreeId":"x::/w/cycle-issue-132-1"},"projection":{}}]}}' ;;
  worker-read)
    META='"cursor":"c1","status":"active","projection":{"a":"agent_status","b":"fresh","c":"owned","d":"wtr_x","e":"ctx_x","f":"not_requested","g":"active","h":"none","i":"released","j":"root_completion","k":"unavailable","l":"x1","m":"x2","n":"x3","o":"x4","p":"x5","q":"x6","r":"x7","s":"x8","t":"x9","u":"y1","v":"y2","w":"y3"}'
    if [ "${readMode}" = quota ]; then
      echo "{\\"ok\\":true,\\"result\\":{\\"terminal\\":{\\"handle\\":\\"t\\",\\"tail\\":[\\"working...\\",\\"Error: exceeded the weekly usage quota\\"]},$META}}"
    elif [ "${readMode}" = tip ]; then
      echo "{\\"ok\\":true,\\"result\\":{\\"terminal\\":{\\"tail\\":[\\"working...\\",\\"Tip: When signed in with ChatGPT, use /usage to check your account usage and access available usage limit resets.\\"]},$META}}"
    elif [ "${readMode}" = codexquota ]; then
      echo "{\\"ok\\":true,\\"result\\":{\\"terminal\\":{\\"tail\\":[\\"working...\\",\\"You've hit your usage limit. Try again at 2099-01-01 10:00:00 +0800.\\"]},$META}}"
    elif [ "${readMode}" = same ]; then
      echo "{\\"ok\\":true,\\"result\\":{\\"terminal\\":{\\"tail\\":[\\"thinking...\\"]},$META}}"
    else
      n=$(cat "$D/reads" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/reads"
      echo "{\\"ok\\":true,\\"result\\":{\\"terminal\\":{\\"tail\\":[\\"step $n sk-abcdef123456\\"]},$META}}"
    fi ;;
esac
`);
  chmodSync(join(dir, 'orca'), 0o755);
  return dir;
}

function run(dir, extra = {}) {
  // 假 agentctl：永远不碰真实 GitHub；调用记录写进 agentctl-calls，供断言
  const fake = join(dir, 'fake-agentctl.mjs');
  writeFileSync(fake, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(dir, 'agentctl-calls'))}, process.argv.slice(2).join(' ') + '\\n');\n`);
  return spawnSync('bash', [join(ROOT, 'bin/coordinator-loop.sh')], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUN_FILE: join(dir, 'run-id'),
      CYCLE_BIN: join(dir, 'cycle.sh'), CYCLE_LOG: join(dir, 'cycle.log'),
      COORD_STATE_DIR: join(dir, 'state'), STATE_DIR: join(dir, 'vstate'), COORD_WAIT_MS: '100', AGENTCTL_BIN: fake, ...extra },
  });
}

function dispatchRecord(dir, rec) {
  mkdirSync(join(dir, 'vstate'), { recursive: true });
  writeFileSync(join(dir, 'vstate', 'dispatch-ctx_fake.json'), JSON.stringify(rec));
}

test('worker-read 末尾含 exceeded quota → 退出码 11，日志含 issue / dispatch / 原因', () => {
  const dir = setup('quota');
  dispatchRecord(dir, { issue: 132, role: 'engineer' });
  const r = run(dir);
  assert.equal(r.status, 11, r.stdout + r.stderr);
  assert.match(r.stdout, /issue=#132/);
  assert.match(r.stdout, /dispatch=ctx_fake/);
  assert.match(r.stdout, /额度用尽/);
  assert.match(r.stdout, /exceeded the weekly usage quota/);
  assert.doesNotMatch(r.stdout, /agent_status|root_completion/); // 末尾是终端输出，不是投影元数据
  assert.doesNotMatch(r.stdout, /无需处理/); // 默认阈值 1800s 下也在下一次检查就停
});

// ACC-harness-codex-07
test('只有 Codex 自带的 /usage 提示行 → 不报额度用尽、不写冷却', () => {
  const dir = setup('tip');
  dispatchRecord(dir, { issue: 999284, role: 'engineer', channel: 'codex' });
  const r = run(dir);
  assert.notEqual(r.status, 11, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /额度用尽|额度用完/);
  assert.ok(!existsSync(join(dir, 'vstate', 'codex-exhausted')));
});

test('Codex 真用量上限 → 仍判额度用完并写冷却，issue 取自派工记录而非目录名', () => {
  const dir = setup('codexquota');
  dispatchRecord(dir, { issue: 999284, role: 'engineer', channel: 'codex' });
  const r = run(dir);
  assert.match(r.stdout, /Codex 额度用完（#999284/, r.stdout + r.stderr);
  assert.ok(existsSync(join(dir, 'vstate', 'codex-exhausted')));
  assert.match(readFileSync(join(dir, 'agentctl-calls'), 'utf8'), /set --issue 999284 --to ready --force/); // 走的是假脚本
});

test('没有派工记录 → 报「issue 未知」，不从 worktree 目录名猜', () => {
  const r = run(setup('quota'));
  assert.equal(r.status, 11, r.stdout + r.stderr);
  assert.match(r.stdout, /issue 未知/);
  assert.doesNotMatch(r.stdout, /#132/);
});

test('输出超过阈值不变 → 退出码 11（疑似卡住）', () => {
  const r = run(setup('same'), { COORD_STALL_SECS: '1' });
  assert.equal(r.status, 11, r.stdout + r.stderr);
  assert.match(r.stdout, /疑似卡住/);
});

test('正常变化的输出 → 继续等，不以 11 退出；日志不泄露密钥形态', () => {
  const dir = setup('change');
  const r = run(dir, { COORD_STALL_SECS: '1' });
  assert.equal(r.status, 12, r.stdout + r.stderr); // 假 check 第 9 次返回 cancelled
  assert.doesNotMatch(r.stdout, /停摆/);
  assert.ok(existsSync(join(dir, 'state', 'worker-watch', 'ctx_fake.json')));
});

// ACC-harness-loop-01 / 02：循环锁与带项目名的进程名
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROJECT = 'proj-x';
function lockSetup() {
  const dir = setup('change');
  // 假 orca / cycle 一旦被调用就留痕，用来证明「已有循环在跑」时什么都没调
  writeFileSync(join(dir, 'cycle.sh'), `#!/usr/bin/env bash\ntouch "${dir}/cycle-called"\nexit 0\n`);
  const orca = readFileSync(join(dir, 'orca'), 'utf8').replace('D="', `touch "${dir}/orca-called"\nD="`);
  writeFileSync(join(dir, 'orca'), orca);
  mkdirSync(join(dir, 'state'));
  return dir;
}
const lockPath = (dir) => join(dir, 'state', 'coordinator-loop.lock');
const runP = (dir, extra = {}) => run(dir, { COORD_PROJECT: PROJECT, ...extra });
function fakeLoop(name) {
  const p = spawn('bash', ['-c', `exec -a "${name}" sleep 30`], { stdio: 'ignore' });
  return p;
}

test('已有本项目循环在跑 → 退出码 14，stderr 写 pid，不调 orca / cycle.sh，不删别人的锁', () => {
  const dir = lockSetup();
  const other = fakeLoop(`coordinator-loop[${PROJECT}]`);
  try {
    writeFileSync(lockPath(dir), `${other.pid}\n`);
    const r = runP(dir);
    assert.equal(r.status, 14, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`已有循环在跑：pid=${other.pid}`));
    assert.ok(!existsSync(join(dir, 'orca-called')) && !existsSync(join(dir, 'cycle-called')));
    assert.equal(readFileSync(lockPath(dir), 'utf8').trim(), String(other.pid));
  } finally { other.kill('SIGKILL'); }
});

test('陈旧锁（pid 已死 / pid 不是本项目的循环）→ 接管并写日志，退出后锁被删', () => {
  for (const kind of ['dead', 'foreign']) {
    const dir = lockSetup();
    // dead：spawnSync 已回收的子进程，pid 确实不存在；foreign：活着但进程名是别的项目
    const proc = kind === 'dead' ? { kill() {} } : fakeLoop('coordinator-loop[other-project]');
    const pid = kind === 'dead' ? Number(spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout) : proc.pid;
    try {
      writeFileSync(lockPath(dir), `${pid}\n`);
      const r = runP(dir, { COORD_STALL_SECS: '1' });
      assert.equal(r.status, 12, `${kind}: ${r.stdout}${r.stderr}`); // 走到了正常主循环（假 check 第 9 次 cancelled）
      assert.match(r.stdout, /接管陈旧的循环锁/);
      assert.ok(!existsSync(lockPath(dir)), '退出后锁应被删除');
    } finally { proc.kill('SIGKILL'); }
  }
});

test('正常退出（任何退出码）删掉自己的锁；进程名带项目名且不写死项目', () => {
  const dir = lockSetup();
  rmSyncSafe(join(dir, 'run-id')); // 没 Run id → 退出码 12，锁也要删
  const r = runP(dir);
  assert.equal(r.status, 12, r.stdout + r.stderr);
  assert.ok(!existsSync(lockPath(dir)));

  // 进程名：运行期间 ps 里能按项目名 pgrep 到，别的项目名命中不到
  const dir2 = lockSetup();
  const child = spawn('bash', [join(ROOT, 'bin/coordinator-loop.sh')], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PATH: `${dir2}:${process.env.PATH}`, RUN_FILE: join(dir2, 'run-id'), CYCLE_BIN: join(dir2, 'cycle.sh'),
      CYCLE_LOG: join(dir2, 'cycle.log'), COORD_STATE_DIR: join(dir2, 'state'), COORD_WAIT_MS: '100', COORD_PROJECT: 'proj-y' },
  });
  try {
    spawnSync('bash', ['-c', 'sleep 1']);
    const hit = spawnSync('pgrep', ['-f', 'coordinator-loop\\[proj-y\\]'], { encoding: 'utf8' });
    const miss = spawnSync('pgrep', ['-f', 'coordinator-loop\\[versekit\\]'], { encoding: 'utf8' });
    assert.ok(hit.stdout.split('\n').includes(String(child.pid)), hit.stdout);
    assert.ok(!miss.stdout.split('\n').includes(String(child.pid)));
  } finally { child.kill('SIGKILL'); }
});

function rmSyncSafe(p) { try { unlinkSync(p); } catch {} }
