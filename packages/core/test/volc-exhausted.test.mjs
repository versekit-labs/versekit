// ACC-harness-model-07：火山额度用尽 → 记录、worker-stop、清验收锁、改用千问；到期自动恢复。
// 全部用假 orca / 假 curl / 假密钥，不联网、不碰真实密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const KEY = 'sk-fake-secret-0123456789';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'volcx-'));
  for (const d of ['state', 'locks', 'home']) mkdirSync(join(dir, d));
  // 假 curl：任何探测都返回 200（模拟 2026-11-16 实况：额度用尽但探测仍 200）。
  writeFileSync(join(dir, 'curl'), '#!/usr/bin/env bash\necho 200\n');
  chmodSync(join(dir, 'curl'), 0o755);
  return dir;
}
const envFor = (dir, extra = {}) => ({
  ...process.env, HOME: join(dir, 'home'), PATH: `${dir}:${process.env.PATH}`,
  STATE_DIR: join(dir, 'state'), LOCK_DIR: join(dir, 'locks'),
  ARKCLI_CODING_PLAN_API_KEY: KEY, QWEN_TOKEN_PLAN_CN_API_KEY: KEY, ...extra,
});
const model = (dir, extra) => spawnSync('bash', [join(ROOT, 'bin/dsh-model.sh'), '--force'],
  { encoding: 'utf8', env: envFor(dir, extra) });

test('dsh-model：未到期 → 不选 volc、直接 qwen，stderr 写原因；到期 → 自动恢复 volc', () => {
  const dir = sandbox();
  const f = join(dir, 'state', 'volc-exhausted');
  writeFileSync(f, `${Math.floor(Date.now() / 1000) + 3600}\t2099-01-01 00:00:00 +0800\n`);
  let r = model(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'qwen');
  assert.match(r.stderr, /火山额度用尽.*2099-01-01/);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  // 不带 --force 也不能读到旧缓存里的 volc
  writeFileSync(join(dir, 'state', 'dsh-model.choice'), 'volc\n');
  r = spawnSync('bash', [join(ROOT, 'bin/dsh-model.sh')], { encoding: 'utf8', env: envFor(dir) });
  assert.equal(r.stdout.trim(), 'qwen');
  // 到期：记录被删，恢复 volc
  writeFileSync(f, `${Math.floor(Date.now() / 1000) - 5}\t过去\n`);
  r = model(dir);
  assert.equal(r.stdout.trim(), 'volc');
  assert.ok(!existsSync(f));
});

test('dsh-model：用尽期间千问也不可用 → 退出码 1', () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'state', 'volc-exhausted'), `${Math.floor(Date.now() / 1000) + 3600}\tx\n`);
  const r = model(dir, { QWEN_TOKEN_PLAN_CN_API_KEY: '', HOME: join(dir, 'home') });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), '');
});

function loopSandbox(resetText) {
  const dir = sandbox();
  const { state, locks } = { state: join(dir, 'state'), locks: join(dir, 'locks') };
  writeFileSync(join(dir, 'run-id'), 'run_fake');
  writeFileSync(join(dir, 'cycle.sh'), `#!/usr/bin/env bash\necho "cycle-called" >> "${dir}/cycle.calls"\nexit 0\n`);
  chmodSync(join(dir, 'cycle.sh'), 0o755);
  writeFileSync(join(dir, 'orca'), `#!/usr/bin/env bash
D="${dir}"
case "$2" in
  check)
    n=$(cat "$D/checks" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/checks"
    sleep 0.2; if [ "$n" -gt 3 ]; then echo '{"ok":true,"result":{"cancelled":true}}'; exit 0; fi
    echo '{"ok":true,"result":{"messages":[]}}' ;;
  worker-list)
    # worker-stop 之后这个 dispatch 不再 active（和真实 orca 一致）
    if [ -f "$D/stop.calls" ]; then echo '{"ok":true,"result":{"workers":[]}}'; exit 0; fi
    echo '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_acc","terminalState":"active","resource":{"worktreeId":"x::/w/cycle-issue-132-1"},"projection":{}}]}}' ;;
  worker-stop)
    echo "$*" >> "$D/stop.calls"; echo '{"ok":true}' ;;
  worker-read)
    echo '{"ok":true,"result":{"terminal":{"tail":["working...","You have exceeded the 5-hour usage quota. ${resetText} Bearer ${KEY}"]},"cursor":"c"}}' ;;
esac
`);
  chmodSync(join(dir, 'orca'), 0o755);
  // 验收 worker 的派工记录：issue 77，通道 volc，且有验收锁。
  writeFileSync(join(state, 'dispatch-ctx_acc.json'), JSON.stringify({ issue: 77, role: 'acceptance', pull: '9', files: [] }));
  writeFileSync(join(state, 'acceptance.channel'), 'volc');
  writeFileSync(join(state, 'acceptance.dispatch'), 'ctx_acc');
  mkdirSync(join(locks, 'accept-77-abcdef12.lock'));
  mkdirSync(join(locks, 'accept-78-abcdef12.lock')); // 别的 issue 的锁不能动
  return dir;
}
const loop = (dir) => spawnSync('bash', [join(ROOT, 'bin/coordinator-loop.sh')], {
  cwd: ROOT, encoding: 'utf8', timeout: 60000,
  env: envFor(dir, { RUN_FILE: join(dir, 'run-id'), CYCLE_BIN: join(dir, 'cycle.sh'),
    CYCLE_LOG: join(dir, 'cycle.log'), COORD_STATE_DIR: join(dir, 'coord'), COORD_WAIT_MS: '100' }),
});
