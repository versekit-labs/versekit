#!/usr/bin/env node
/**
 * 设计验收：对着真实跑起来的服务，检查实现是否照设计做。
 *
 * 只做"能判定"的检查；主观项留给 ACCEPTANCE.md 的逐页清单。
 *   node scripts/design-accept.mjs --url http://127.0.0.1:8787
 *
 * 退出码：0 通过；1 打回。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DESIGN = join(ROOT, 'docs/design');
const SURFACES = join(ROOT, '.impeccable/surfaces');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const BASE = (arg('--url') || 'http://127.0.0.1:8787').replace(/\/$/, '');

// 设计页 → 线上路径。实现方若改了路径，改这里并在 PR 说明。
const PAGES = [
  ['groups.html',      '/groups'],
  ['account-wall.html','/accounts'],
  ['matrix.html',      '/matrix'],
  ['publish.html',     '/publish'],
  ['calendar.html',    '/plan'],
  ['work.html',        '/works'],
  ['overview.html',    '/overview'],
  ['runs.html',        '/tasks'],
  ['add.html',         '/accounts/add']
];

const fails = [];
const notes = [];
const pass = (m) => notes.push('  ✓ ' + m);
const fail = (m) => fails.push(m);

async function fetchPage(path) {
  try {
    const res = await fetch(BASE + path, { redirect: 'follow' });
    const body = res.status === 200 ? await res.text() : '';
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: '', error: err.message };
  }
}

console.log(`\n设计验收 — ${BASE}\n`);

for (const [file, path] of PAGES) {
  // 1. 任务书（设计侧资产，不在服务上）
  const slug = 'docs-design-' + file.replace(/\.html$/, '') + '-html.md';
  if (!existsSync(join(SURFACES, slug))) fail(`${file} 缺任务书 ${slug}`);

  // 2. 页面存在
  const { status, body, error } = await fetchPage(path + '?group=ai');
  if (status !== 200) {
    fail(`${path} 返回 ${status || error}（设计页 ${file}）`);
    continue;
  }

  // 3. 不能再引用原型假数据
  if (/src=["']store\.js["']/.test(body)) {
    fail(`${path} 仍在引用 store.js（原型假数据），没有接真实 API`);
  }

  // 4. 必须真的调 API
  const callsApi = /src=["'][^"']*api\.js["']/.test(body) || /fetch\(\s*['"`]\/api\//.test(body);
  if (!callsApi) fail(`${path} 没有引用 api.js，也没有 fetch('/api/…')，疑似硬编码`);

  if (status === 200) pass(`${path} 存活`);
}

// 5. 设计闸门跑一遍真实服务
console.log('  … 对真实服务跑设计闸门\n');
const gate = spawnSync('node', [join(ROOT, 'scripts/design-check.mjs'), '--url', BASE], {
  cwd: ROOT, encoding: 'utf8'
});
const gateOut = (gate.stdout || '') + (gate.stderr || '');
if (gate.status !== 0) {
  const lines = gateOut.split('\n').filter(l => /✗|@\d+|缺|溢出|触控|死链|检测器/.test(l));
  fail('design-check 未通过：\n' + lines.slice(0, 12).map(l => '      ' + l.trim()).join('\n'));
} else {
  pass('design-check --url 通过');
}

// 6. 汇总
console.log(notes.join('\n'));
if (fails.length) {
  console.log('\n打回（' + fails.length + ' 项）：');
  fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log('\n口径见 docs/design/ACCEPTANCE.md；逐条修完再跑这条命令。\n');
  process.exit(1);
}
console.log('\n通过：九页可访问、数据来自 API、设计闸门全绿。\n');
console.log('下一步：按 ACCEPTANCE.md 第二节逐页人工验收（动作 ↔ 命令、空/错/权限三态、数字一致性）。\n');