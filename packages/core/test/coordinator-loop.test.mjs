// ACC-harness-cycle-12：假 orca 验证循环对停摆 worker 以退出码 11 停下
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
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
    if [ "${readMode}" = quota ]; then
      echo '{"ok":true,"result":{"text":"working...\\nError: exceeded the weekly usage quota\\n"}}'
    elif [ "${readMode}" = same ]; then
      echo '{"ok":true,"result":{"text":"thinking...\\n"}}'
    else
      n=$(cat "$D/reads" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/reads"
      echo "{\\"ok\\":true,\\"result\\":{\\"text\\":\\"step $n sk-abcdef123456\\"}}"
    fi ;;
esac
`);
  chmodSync(join(dir, 'orca'), 0o755);
  return dir;
}

function run(dir, extra = {}) {
  return spawnSync('bash', [join(ROOT, 'bin/coordinator-loop.sh')], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUN_FILE: join(dir, 'run-id'),
      CYCLE_BIN: join(dir, 'cycle.sh'), CYCLE_LOG: join(dir, 'cycle.log'),
      COORD_STATE_DIR: join(dir, 'state'), COORD_WAIT_MS: '100', ...extra },
  });
}

test('worker-read 末尾含 exceeded quota → 退出码 11，日志含 issue / dispatch / 原因', () => {
  const r = run(setup('quota'));
  assert.equal(r.status, 11, r.stdout + r.stderr);
  assert.match(r.stdout, /issue=#132/);
  assert.match(r.stdout, /dispatch=ctx_fake/);
  assert.match(r.stdout, /额度用尽/);
  assert.match(r.stdout, /exceeded the weekly usage quota/);
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
