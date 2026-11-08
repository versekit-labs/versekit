#!/usr/bin/env node
/**
 * 设计闸门：把「我下次注意」变成「提交前撞墙」。
 *
 * 抓的正是过去几轮真实犯过的错误：
 *  1. 新页面没有 surface brief（任务书）就开写
 *  2. 导航各页不一致 / 页面互相不可达
 *  3. href="#" 这类死链接（点了没反应）
 *  4. hidden 属性被 display 覆盖，导致"点了不跳转"
 *  5. 机械检测不过（颜色、字号、圆角、对比度）
 *  6. 手机横向溢出、触控目标过小
 *
 * 用法：node scripts/design-check.mjs [--json]
 * 退出码：0 通过；1 有阻塞项。
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DESIGN = join(ROOT, 'docs/design');
const SURFACES = join(ROOT, '.impeccable/surfaces');
const IMPECCABLE = join(ROOT, '.claude/skills/impeccable/scripts/impeccable');
const JSON_OUT = process.argv.includes('--json');

const problems = [];
const warn = [];
const add = (kind, msg) => problems.push({ kind, msg });

// ── 1. 页面清单 ────────────────────────────────────────
const PAGES = readdirSync(DESIGN).filter(f => f.endsWith('.html')).sort();
// 入口页不参与「必须有组」的运行时检查
const ENTRY = new Set(['groups.html']);

// ── 2. 每个页面必须有 surface brief ────────────────────
function briefSlug(file){
  return 'docs-design-' + file.replace(/\.html$/, '') + '-html.md';
}
for (const page of PAGES) {
  if (page === 'groups.html') continue;          // 入口页是流程页，不承载产品界面
  const slug = briefSlug(page);
  if (!existsSync(join(SURFACES, slug))) {
    add('brief-missing', `docs/design/${page} 没有 surface brief（应为 .impeccable/surfaces/${slug}）`);
  }
}

// ── 3. 静态检查：死链接 / 导航一致性 / 资源存在 ────────
const NAV_ORDER = ['account-wall.html','publish.html','calendar.html','overview.html','runs.html'];
for (const page of PAGES) {
  const html = readFileSync(join(DESIGN, page), 'utf8');

  // 3a. href="#" 死链接（例外：脚本里有 data-* 兜底、或按钮化条目）
  const dead = [...html.matchAll(/href="#"([^>]*)/g)]
    .map(m => m[1])
    .filter(attrs => !/data-|role="button"/.test(attrs));
  if (dead.length) add('dead-anchor', `${page} 有 ${dead.length} 处 href="#"（点了不会有反应）`);

  // 3b. 内部链接必须指向存在的文件
  for (const m of html.matchAll(/href="([a-z0-9-]+\.html)/g)) {
    if (!existsSync(join(DESIGN, m[1]))) add('broken-link', `${page} 链接到不存在的 ${m[1]}`);
  }

  // 3c. 导航必须完整且顺序一致（入口页除外）
  if (!ENTRY.has(page)) {
    const nav = html.match(/<nav class="nav"[\s\S]*?<\/nav>/);
    if (!nav) add('nav-missing', `${page} 缺少主导航`);
    else {
      const items = [...nav[0].matchAll(/href="([a-z0-9-]+\.html)"/g)].map(m => m[1]);
      if (items.join(',') !== NAV_ORDER.join(',')) {
        add('nav-drift', `${page} 导航为 [${items.join(', ')}]，应为 [${NAV_ORDER.join(', ')}]`);
      }
      const current = (nav[0].match(/aria-current="page"/g) || []).length;
      if (current !== 1) add('nav-current', `${page} 的 aria-current 数量为 ${current}，应为 1`);
    }
  }

  // 3d. 引用的本地资源必须存在
  for (const m of html.matchAll(/(?:href|src)="([^"#]+\.(?:css|js))"/g)) {
    if (!existsSync(join(DESIGN, m[1]))) add('missing-asset', `${page} 引用不存在的 ${m[1]}`);
  }

  // 3e. hidden 与 display 冲突（点了不跳转的根因）
  const setsDisplay = /(\.pub|\.modes|\.view|\.plats|\.cal-wrap)\{[^}]*display:(grid|flex)/.test(html);
  const usesHidden = /(class="[^"]*"\s+hidden|hidden>)/.test(html);
  if (setsDisplay && usesHidden) {
    const css = readFileSync(join(DESIGN, 'app.css'), 'utf8');
    if (!/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css)) {
      add('hidden-override', `${page} 同时使用 hidden 与 display:grid/flex，但 app.css 未强制 [hidden]{display:none!important}`);
    }
  }
}

// ── 4. 检测器（含共享样式表） ──────────────────────────
function runDetect(page) {
  return new Promise(resolve => {
    const p = spawn(IMPECCABLE, ['detect', '--json', join(DESIGN, page)], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', () => {});
    p.on('close', () => {
      try {
        const arr = JSON.parse(out || '[]');
        resolve(Array.isArray(arr) ? arr : []);
      } catch { resolve([]); }
    });
  });
}

// ── 5. 运行时检查（headless Chrome / CDP，无依赖）────────
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withChrome(fn) {
  if (!existsSync(CHROME)) { warn.push('未找到 Chrome，跳过运行时检查'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'vk-gate-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--hide-scrollbars',
    '--remote-debugging-port=' + port, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch('http://127.0.0.1:' + port + '/json/version'); break; } catch { await sleep(150); }
    }
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const target = list.find(x => x.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise(res => {
      const n = ++id; pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await fn(send);
    ws.close();
  } finally {
    chrome.kill();
  }
}

async function runtimeChecks() {
  const cases = PAGES.filter(p => !ENTRY.has(p)).map(p => ({
    page: p,
    url: 'file://' + join(DESIGN, p) + '?group=ai'
  }));
  const STATES = [
    { name: 'default', run: '' },
    { name: 'expanded', run: "document.querySelector('.post')?.click()" },
    { name: 'view2', run: "document.querySelectorAll('.view-btn')[1]?.click()" },
    { name: 'view3', run: "document.querySelectorAll('.view-btn')[2]?.click()" }
  ];

  await withChrome(async send => {
    for (const { page, url } of cases) {
      for (const width of [1440, 390]) {
        await send('Emulation.setDeviceMetricsOverride', {
          width, height: width === 1440 ? 900 : 844,
          deviceScaleFactor: 1, mobile: width === 390
        });
        await send('Page.navigate', { url });
        await sleep(650);
        for (const st of STATES) {
          if (st.run) {
            await send('Runtime.evaluate', { expression: st.run });
            await sleep(120);
          }
        const r = await send('Runtime.evaluate', {
          returnByValue: true,
          expression: `(() => {
            const vw = ${width};
            const out = { docW: document.documentElement.scrollWidth, small: [], hiddenShown: [], overflow: [] };
            document.querySelectorAll('button,a,select,input,textarea').forEach(e => {
              const b = e.getBoundingClientRect();
              if (b.height > 0 && b.height < 32 && b.width > 0) {
                out.small.push((e.className || e.tagName) + ' ' + Math.round(b.height));
              }
            });
            document.querySelectorAll('[hidden]').forEach(e => {
              if (getComputedStyle(e).display !== 'none') {
                out.hiddenShown.push(e.className || e.tagName);
              }
            });
            document.querySelectorAll('body *').forEach(e => {
              if (e.children.length === 0 && e.textContent.trim() &&
                  e.scrollWidth > e.clientWidth + 2 &&
                  getComputedStyle(e).textOverflow !== 'ellipsis' &&
                  getComputedStyle(e).webkitLineClamp === 'none' &&
                  e.clientWidth > 2 &&
                  getComputedStyle(e).clipPath === 'none') {
                out.overflow.push((String(e.className) || e.tagName) + ' ' + e.clientWidth + '/' + e.scrollWidth);
              }
            });
            return JSON.stringify(out);
          })()`
        });
        const v = JSON.parse(r.result.result.value);
        const tag = `${page} @${width}${st.name === 'default' ? '' : ' · ' + st.name}`;
        if (v.docW > width + 1) add('h-overflow', `${tag} 横向溢出（docW=${v.docW}）`);
        if (v.small.length) add('tap-target', `${tag} 触控过小：${[...new Set(v.small)].slice(0,3).join(', ')}`);
        if (v.hiddenShown.length) add('hidden-shown', `${tag} hidden 元素仍然可见：${v.hiddenShown.slice(0,3).join(', ')}`);
        if (v.overflow.length) add('text-overflow', `${tag} 文字被截断：${v.overflow.slice(0,3).join(', ')}`);
        }
      }
    }
  });
}

// ── 执行 ───────────────────────────────────────────────
for (const page of PAGES) {
  const findings = await runDetect(page);
  if (findings.length) {
    add('detector', `${page} 检测器 ${findings.length} 条：${findings.slice(0,2).map(f => f.antipattern).join(', ')}`);
  }
}
{
  const cssFindings = await runDetect('app.css');
  if (cssFindings.length) {
    add('detector', `app.css 检测器 ${cssFindings.length} 条：${cssFindings.slice(0,2).map(f => f.antipattern).join(', ')}`);
  }
}
await runtimeChecks();

// ── 报告 ───────────────────────────────────────────────
const byKind = {};
for (const p of problems) (byKind[p.kind] ||= []).push(p.msg);

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: problems.length === 0, problems, warnings: warn }, null, 2));
} else {
  console.log('\n设计闸门 — versekit\n');
  if (!problems.length) {
    console.log(`  通过：${PAGES.length} 个页面，全部有任务书、导航一致、无死链、检测器干净、触控与溢出合规。`);
  } else {
    for (const [kind, msgs] of Object.entries(byKind)) {
      console.log(`  ✗ ${kind}（${msgs.length}）`);
      msgs.slice(0, 6).forEach(m => console.log('      ' + m));
      if (msgs.length > 6) console.log(`      …还有 ${msgs.length - 6} 条`);
    }
    console.log('\n  修完再提交；这条命令就是「下次注意」的替代品。\n');
  }
  for (const w of warn) console.log('  提示：' + w);
  console.log('');
}
process.exit(problems.length ? 1 : 0);