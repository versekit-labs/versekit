// versekit 原型 v3 的演示数据与共用部件。
// 标题与封面取自所有者自己的真实作品；状态、时间、播放数全部是演示数据。
// 封面与视频放在 docs/design/demo/（不入库）；缺了就显示占位，页面不坏。
const VID = 'demo/videos/';
const CV = 'demo/covers/';
const TODAY = '2026-11-15';
const NOW = '2026-11-15T14:30'; // 演示里的「现在」
const LIM = { dy: { title: 55 } }; // 演示用的平台限制：抖音标题最多 55 字（数字是演示值）
// 第一项是徽章里的字：平台用官方标志（app.css 的 .pf），不写字；官网不是平台，保留一个字
const PF = { xhs: ['', '小红书'], dy: ['', '抖音'], sph: ['', '视频号'], bili: ['', 'B站'], tk: ['', 'TikTok'], yt: ['', 'YouTube'], web: ['官', '官网'], mp: ['', '公众号'] };
// 每个账号"平时"的 24 小时播放：最近 20 条的中位数。不同平台之间不相加、不比较。
const BASE = { xhs: 13000, dy: 14200, sph: 2100, bili: 3300, tk: 900, yt: 640, web: 120 };
const HASH = Object.fromEntries(location.hash.slice(1).split('&').filter(Boolean).map((kv) => kv.split('=')));
const BLANK = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#dcdcd8"/><path d="M290 200l80 40-80 40z" fill="#9a9a95"/></svg>');

const p = (pf, at, title, extra = {}) => ({ pf, at, title, state: 'pending', ...extra });
const d = (pf, at, title, n, extra = {}) => ({ pf, at, title, state: 'published', n, ...extra });
const short = (id, name, dur, slug, title, en, d1, d2) => ({
  id, name, dur, vert: true, poster: CV + `short-${slug}.jpg`,
  versions: [['中文', VID + `vertical/renders/short-${slug}.mp4`], ['English', VID + `en/renders/short-${slug}.mp4`]],
  pubs: [p('xhs', d1 + 'T20:00', title, { solo: true }), p('dy', d1 + 'T21:00', title), p('sph', d2 + 'T09:30', title),
    p('tk', d2 + 'T09:00', en, { lang: 'English' }), p('yt', d2 + 'T10:00', en, { lang: 'English', note: 'Shorts' })],
});
const oldCut = (id, name, dur, poster, pubs, vert) => ({ id, name, dur, poster: CV + poster, vert, versions: [], pubs });

const WORKS = [
  { id: 'iso27001', title: '有 ISO 27001，为什么还被罚 1400 万英镑？', cover: CV + 'iso27001-machine-4x3.jpg', inAt: '2026-11-14T21:40',
    cuts: [
      { id: 'long', name: '长片', dur: '3:04', poster: CV + 'iso27001-machine-4x3.jpg',
        versions: [['中文', VID + 'renders/iso27001-machine.mp4'], ['English', VID + 'en/renders/iso27001-machine-en-16x9.mp4']],
        pubs: [
          p('xhs', '2026-11-16T20:00', '警报响了 58 小时没人管：有 ISO 27001 也会被罚', { solo: true, note: '竖屏 · 封面 3:4', body: 'Capita 持有 ISO 27001，警报响了 58 小时没人处理，最后被罚 1400 万英镑。\n证书证明的是“有流程”，不是“流程被执行”。\n看完这条，你能知道审核时该盯哪三处。', tags: ['ISO27001', '信息安全', '合规', '出海'] }),
          p('dy', '2026-11-16T21:00', '有 ISO 27001，为什么还被罚 1400 万英镑？', { body: '证书不等于安全：Capita 的 58 小时警报事件，说明了什么。', tags: ['ISO27001', '信息安全'] }),
          p('sph', '2026-11-17T09:30', '有 ISO 27001 证书，为什么还会被罚？'),
          p('bili', '2026-11-17T12:00', '有 ISO 27001，为什么还被罚 1400 万英镑？一站一站看它说了什么、没说什么', { note: '发完归入合集「出海合规」', body: '0:00 事件经过\n1:10 证书到底证明什么\n2:20 审核时该盯哪三处', tags: ['ISO27001', '合规', '科普'] }),
          p('web', '2026-11-17T12:30', 'assurelane.ai 视频页'),
          p('tk', '2026-11-17T09:00', 'Certified to ISO 27001 and still fined £14m', { lang: 'English' }),
          p('yt', '2026-11-17T10:00', 'ISO 27001 certified, still fined £14 million: what the certificate says and what it doesn’t', { lang: 'English' }),
        ] },
      short('s1', '短片 1 · 58 小时', '1:08', 'capita-58h', '警报响了 58 小时没人管：持有 ISO 27001 的 Capita 被罚 1400 万英镑', 'The alert rang for 58 hours. Capita held ISO 27001.', '2026-11-18', '2026-11-19'),
      short('s2', '短片 2 · 93 项控制', '0:46', '93-controls', 'ISO 27001 的 93 项控制不用全做，但每一项都要写理由', 'You don’t need all 93 ISO 27001 controls. You do need a reason for each.', '2026-11-20', '2026-11-21'),
      short('s3', '短片 3 · 看证书', '0:57', 'check-cert', '拿到一张 ISO 27001，先看哪三处：范围、谁发的、有效期', 'Three things to check on any ISO 27001 certificate', '2026-11-22', '2026-11-23'),
    ] },
  { id: 'iso42001', title: 'ISO 42001 到底证明什么？', cover: CV + 'iso42001-machine-4x3.jpg', inAt: '2026-11-12T18:05',
    cuts: [oldCut('long', '长片', '3:12', 'iso42001-machine-4x3.jpg', [
      p('xhs', '2026-11-14T20:00', '一台 AI 走完 6 站：ISO 42001 到底证明什么', { solo: true, note: '竖屏 · 封面 3:4 · 今天还能发 1 条' }),
      p('dy', '2026-11-15T20:00', 'ISO 42001 到底证明什么？', { state: 'confirmed' }),
      p('sph', '2026-11-15T21:00', 'ISO 42001 到底证明什么？', { state: 'confirmed' }),
      p('tk', '2026-11-16T09:00', 'What does ISO 42001 actually prove?', { state: 'confirmed', lang: 'English' }),
      p('yt', '2026-11-16T10:00', 'What does ISO 42001 actually prove?', { state: 'confirmed', lang: 'English' }),
      p('bili', '2026-11-16T12:00', 'ISO 42001 到底证明什么？从加拿大航空客服机器人案讲起', { state: 'confirmed' }),
      p('web', '2026-11-16T12:30', 'assurelane.ai 视频页', { state: 'confirmed' }),
    ])] },
  { id: 'dpo-out', title: '出海要设 DPO 吗？', cover: CV + 'dpo-outsourcing-4x3.jpg', inAt: '2026-11-10T22:10',
    cuts: [
      oldCut('long', '长片', '2:51', 'dpo-outsourcing-4x3.jpg', [
        d('xhs', '2026-11-11T20:00', '出海公司要不要设 DPO？先看这三条', 11900), d('dy', '2026-11-11T21:00', '出海要设 DPO 吗？', 12100),
        d('sph', '2026-11-12T09:30', '出海要设 DPO 吗？', 1900),
        d('bili', '2026-11-12T12:00', '出海要设 DPO 吗？GDPR 第 37 条到底怎么说', 2800, { issue: { what: '视频已上线，但没归入合集', why: '11-12 12:04 归入合集「出海合规」时，合集列表没加载出来。视频本身正常，不用重发。' } }),
        d('web', '2026-11-12T12:30', 'assurelane.ai 视频页', 140), d('tk', '2026-11-12T09:00', 'Do you need a DPO to sell into Europe?', 760, { lang: 'English' }),
        d('yt', '2026-11-12T10:00', 'Do you need a DPO to sell into Europe?', 580, { lang: 'English' })]),
      oldCut('s1', '短片 1', '0:52', 'dpo-outsourcing-3x4.jpg', [
        d('xhs', '2026-11-13T20:00', 'DPO 不是谁都要设：三种情况必须有', 15100), d('dy', '2026-11-13T21:00', 'DPO 不是谁都要设：三种情况必须有', 16900),
        d('sph', '2026-11-14T09:30', 'DPO 不是谁都要设：三种情况必须有', 2600), d('tk', '2026-11-14T09:00', 'Three cases where a DPO is mandatory', 1400, { lang: 'English' })], true),
    ] },
  { id: 'dpo', title: 'DPO 是什么、能不能外包？', cover: CV + 'dpo-machine-4x3.jpg', inAt: '2026-11-07T20:30',
    cuts: [
      oldCut('long', '长片', '3:20', 'dpo-machine-4x3.jpg', [
        d('xhs', '2026-11-08T20:00', 'DPO 是什么？能不能外包给别人做', 11800), d('dy', '2026-11-08T21:00', 'DPO 是什么、能不能外包？', 15900),
        d('sph', '2026-11-09T09:30', 'DPO 是什么、能不能外包？', 2300), d('bili', '2026-11-09T12:00', 'DPO 是什么、能不能外包？一台机器讲清楚', 2900),
        d('tk', '2026-11-09T09:00', 'What a DPO is, and whether you can outsource one', 700, { lang: 'English' }), d('yt', '2026-11-09T10:00', 'What a DPO is, and whether you can outsource one', 810, { lang: 'English' })]),
      oldCut('s2', '短片 2', '0:49', 'dpo-machine-3x4.jpg', [
        d('xhs', '2026-11-10T20:00', '外包 DPO 要看的两件事', 12400), d('dy', '2026-11-10T21:00', '外包 DPO 要看的两件事', 5700), d('sph', '2026-11-11T09:30', '外包 DPO 要看的两件事', 1700)], true),
    ] },
  { id: 'accreditation', title: '出海做 ISO 27001，找谁来发？', cover: CV + 'accreditation-machine-4x3.jpg', inAt: '2026-11-05T19:45',
    insight: '小红书这条 62% 的播放来自搜索，这个账号平时约 30%。标题是一个问题句，里面有"找谁来发"。',
    cuts: [
      oldCut('long', '长片', '3:08', 'accreditation-machine-4x3.jpg', [
        d('xhs', '2026-11-06T20:00', '出海做 ISO 27001，证书找谁来发？', 31200), d('dy', '2026-11-06T21:00', '出海做 ISO 27001，找谁来发？', 13300),
        d('sph', '2026-11-07T09:30', '出海做 ISO 27001，找谁来发？', 2500), d('bili', '2026-11-07T12:00', '出海做 ISO 27001，找谁来发？认可机构和认证机构的区别', 4100),
        d('web', '2026-11-07T12:30', 'assurelane.ai 视频页', 110), d('tk', '2026-11-07T09:00', 'Who should issue your ISO 27001 certificate?', 1100, { lang: 'English' }),
        d('yt', '2026-11-07T10:00', 'Who should issue your ISO 27001 certificate?', 600, { lang: 'English' })]),
      oldCut('s1', '短片 1', '0:58', 'accreditation-machine-3x4.jpg', [
        d('xhs', '2026-11-08T12:00', '同样是 ISO 27001，证书上的这个标志差很多', 14900), d('dy', '2026-11-08T12:30', '同样是 ISO 27001，证书上的这个标志差很多', 30100)], true),
    ] },
];

// 通用性示例：#demo=simple 换成"一条视频、一种语言、三个平台"的创作者（内容是虚构的）
const SIMPLE = HASH.g === 'camp' || HASH.demo === 'simple';
const MAIN_TODO = WORKS.filter((w) => w.cuts.some((c) => c.pubs.some((x) => x.state === 'pending'))).length + 1; // 另一个组里看得到的待办数
if (SIMPLE) {
  WORKS.length = 0;
  Object.assign(BASE, { xhs: 3900, dy: 2400, bili: 800 });
  WORKS.push(
    { id: 'w1', title: '周末露营，这 5 件小东西最不后悔', cover: BLANK, inAt: '2026-11-15T10:12',
      cuts: [{ id: 'main', name: '视频', dur: '1:42', poster: BLANK, vert: true, versions: [],
        pubs: [p('xhs', '2026-11-15T20:00', '露营 5 件不后悔的小东西｜新手照着买', { solo: true, note: '竖屏 · 今天还能发 1 条' }),
          p('dy', '2026-11-15T21:00', '周末露营，这 5 件小东西最不后悔'), p('bili', '2026-11-16T12:00', '【露营】5 件不后悔的小装备，新手照着买')] }] },
    { id: 'w0', title: '第一次露营踩的 3 个坑', cover: BLANK, inAt: '2026-11-08T09:30',
      cuts: [{ id: 'main', name: '视频', dur: '2:05', poster: BLANK, vert: true, versions: [],
        pubs: [d('xhs', '2026-11-08T20:00', '第一次露营踩的 3 个坑', 8600), d('dy', '2026-11-08T21:00', '第一次露营踩的 3 个坑', 2100), d('bili', '2026-11-09T12:00', '【露营】新手踩的 3 个坑', 700)] }] });
}
const Q = SIMPLE ? '#g=camp' : '';
// 文案两层：通用文案属于「这支成片的这个语言版本」；每条平台稿按字段要么跟通用，要么单独写（own）。
// 演示数据里每条写的是最终文案，这里反推出通用（同一语言里最常见的标题）和各平台单独写的字段。
const LANG0 = '中文';
const dayAdd = (day, n) => new Date(new Date(day).getTime() + n * 864e5).toISOString().slice(0, 10);
WORKS.forEach((w) => w.cuts.forEach((c) => {
  c.common = {};
  [...new Set(c.pubs.map((x) => x.lang || LANG0))].forEach((L) => {
    const xs = c.pubs.filter((x) => (x.lang || LANG0) === L); const cnt = {};
    xs.forEach((x) => (cnt[x.title] = (cnt[x.title] || 0) + 1));
    const base = xs.find((x) => x.pf === 'dy') || xs[0];
    const cm = (c.common[L] = { title: Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || (b === base.title) - (a === base.title))[0], body: base.body || '', tags: base.tags || [] });
    xs.forEach((x) => {
      const raw = { title: x.title, body: x.body, tags: x.tags }; x.L = L; x.cm = cm; x.own = {}; x.timing = 'at';
      if (raw.title !== cm.title) x.own.title = raw.title;
      if (raw.body != null && raw.body !== cm.body) x.own.body = raw.body;
      if (raw.tags && raw.tags.join() !== cm.tags.join()) x.own.tags = raw.tags;
      delete x.title; delete x.body; delete x.tags;
      ['title', 'body', 'tags'].forEach((f) => Object.defineProperty(x, f, { get() { return this.own[f] ?? this.cm[f]; }, enumerable: true, configurable: true }));
      // 建议时间过了还没确认：系统自己顺延到最近可用的时间，并记住原定是什么时候
      if (x.state === 'pending' && x.at < NOW) { x.was = x.at; const t = x.at.slice(10); x.at = (TODAY + t > NOW ? TODAY : dayAdd(TODAY, 1)) + t; }
    });
  });
}));
// 账号组：一个组 = 一套平台账号 + 它自己的作品、待办、数据、发布方案。第二个组是虚构的示例。
const GROUPS = [{ id: 'main', name: 'AssureLane', sub: '出海合规 · 7 个账号', q: '' }, { id: 'camp', name: '露营小记', sub: '示例 · 3 个账号', q: '#g=camp' }];
const GROUP = GROUPS[SIMPLE ? 1 : 0];

// ---------- 小工具
const $ = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pf = (k) => `<span class="pf ${k}" role="img" aria-label="${PF[k][1]}" title="${PF[k][1]}">${PF[k][0]}</span>`;
const pfn = (k) => `<span class="pfn">${pf(k)}${PF[k][1]}</span>`;
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function when(at) {
  const [day0, t] = at.split('T'); const days = Math.round((new Date(day0) - new Date(TODAY)) / 864e5);
  const day = days === 0 ? '今天' : days === 1 ? '明天' : days === -1 ? '昨天' : `${day0.slice(5)} ${WD[new Date(day0).getDay()]}`;
  return { day, t, days, text: `${day} ${t}` };
}
const ratio = (r) => { const x = r.n / BASE[r.pf]; return { x, txt: (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + ' 倍', cls: x >= 2 ? 'up' : x <= 0.5 ? 'dn' : '', word: x >= 2 ? '比平时好' : x <= 0.5 ? '比平时差' : '和平时差不多', w: Math.min(100, x * 40) }; };
const typ = (r) => { const q = ratio(r); return `<div class="typ ${q.cls}" role="img" aria-label="${q.txt}，${q.word}" title="竖线是这个账号最近 20 条的中位数"><i style="width:${q.w}%"></i><u></u></div>`; };
const fmt = (n) => n.toLocaleString('en-US');
function toast(msg) { let t = document.querySelector('.toast'); if (!t) { t = $('<div class="toast" role="status"></div>'); document.body.append(t); } t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); }
document.addEventListener('error', (e) => { const t = e.target; if (t.tagName === 'IMG' && t.src !== BLANK) t.src = BLANK; }, true);

// ---------- 派生
const allPubs = () => WORKS.flatMap((w) => w.cuts.flatMap((c) => c.pubs.map((x) => ({ x, w, c }))));
const pendingOf = (w) => w.cuts.flatMap((c) => c.pubs).filter((x) => x.state === 'pending');
const cutPending = (c) => c.pubs.filter((x) => x.state === 'pending');
const cutBatch = (c) => c.pubs.filter((x) => !x.solo && x.state === 'pending');
const upcoming = () => allPubs().filter((r) => r.x.state === 'confirmed' && r.x.timing !== 'now').sort((a, b) => a.x.at.localeCompare(b.x.at));
const issues = () => allPubs().filter((r) => r.x.issue && !r.x.issue.done);
const results = () => allPubs().filter((r) => r.x.state === 'published' && r.x.n != null);
const todoCount = () => WORKS.filter((w) => pendingOf(w).length).length + issues().length;
// 一个作品现在的状态，只取最要紧的一个
function workState(w) {
  const ps = w.cuts.flatMap((c) => c.pubs); const n = (s) => ps.filter((x) => x.state === s).length;
  if (ps.some((x) => x.issue && !x.issue.done)) return ['bad', '有 1 条出了问题'];
  if (n('pending')) return ['wait', `${n('pending')} 条等你确认`];
  if (n('confirmed')) return ['sched', `${n('confirmed')} 条已确认，等时间`];
  return ['pub', '都发完了'];
}
const listeners = []; const changed = () => listeners.forEach((f) => f());
// 发布机出口位置变了（#ip=moved）：国内平台先暂停，等人处理。处理完 IP_DONE = true
let IP_DONE = false;
const ipMoved = () => HASH.ip === 'moved' && !IP_DONE;
const paused = (k) => ipMoved() && ['xhs', 'dy', 'sph', 'bili'].includes(k);
// 改到一半要切走（切成片、切作品）时先问一句。成片面板进入编辑时接管它
let editBusy = () => false;

// 侧栏底部：有问题只说有几个要处理，全正常才说几个正常（一行说完，不折行）
const HEALTH = {}; let drawHealth = () => {};
function setAccHealth(total, bad) { drawHealth({ total, bad }); }
// ---------- 外壳：导航写在每个页面的 HTML 里，这里只填待办数和底部的状态
function initShell() {
  const nav = document.querySelector('nav.nav');
  if (SIMPLE) nav.querySelectorAll('a.nv').forEach((a) => (a.href += Q));
  const page = location.pathname.split('/').pop() === 'work.html' ? 'works.html' : location.pathname.split('/').pop();
  const otherTodo = (g) => (g.id === 'main' ? MAIN_TODO : 1);
  const grp = $(`<details class="grp"><summary aria-label="账号组：${GROUP.name}，点开切换"><span><b>${GROUP.name}</b><small>${GROUP.sub}</small></span></summary><div class="menu">
    ${GROUPS.map((g) => `<a href="${page}${g.q}" data-g="${g.id}" ${g === GROUP ? 'aria-current="true"' : ''}><span><b>${g.name}</b><small>${g.sub}</small></span>${g === GROUP ? '<i class="tick">当前</i>' : `<b class="cnt" title="这个组里有 ${otherTodo(g)} 件事等你">${otherTodo(g)}</b>`}</a>`).join('')}
    <button class="btn" data-newg>新建账号组</button></div></details>`);
  grp.addEventListener('click', (e) => { const a = e.target.closest('a[data-g]'); if (a) { e.preventDefault(); location.href = a.getAttribute('href'); if (a.dataset.g !== GROUP.id) location.reload(); grp.open = false; } else if (e.target.closest('[data-newg]')) { toast('原型里不能建；实现后在这里填名字就建好'); grp.open = false; } });
  document.addEventListener('click', (e) => { if (!grp.contains(e.target)) grp.open = false; });
  nav.querySelector('.brand').after(grp);
  const acc = new Set(allPubs().map((r) => r.x.pf)).size;
  // 发布机在哪：每一页都看得到。#ip=moved 演示出口位置变了（比如开了代理）；NO_MACH 是一台发布机都没有
  nav.append($('<div class="health"></div>'));
  drawHealth = (o = {}) => { Object.assign(HEALTH, o); const mv = ipMoved(); const h = HEALTH;
    nav.querySelector('.health').innerHTML = `<div>${h.bad ? `<span class="dot bad"></span>${h.bad} 个账号要处理` : mv ? '<span class="dot wait"></span>4 个账号暂停发布' : `<span class="dot"></span>${h.total ?? acc} 个账号登录正常`}</div>
    <a class="mach" href="system.html#${[SIMPLE && 'g=camp', HASH.ip && 'ip=' + HASH.ip, 'tab=devices'].filter(Boolean).join('&')}" title="发布机现在的出口位置，平台看到的就是这里。点开看设备">${h.none ? '<span class="dot bad"></span>没有发布机<span class="loc">接一台才能发</span>' : `${mv ? '<span class="dot wait"></span>出口位置变了' : '<span class="dot"></span>发布机在线'}<span class="loc">${mv ? '日本 东京' : '美国 洛杉矶'} <span class="mono">${mv ? '198.51.100.7' : '203.0.113.24'}</span></span>`}</a>
    <div><span class="dot"></span>今天还能发：小红书 1 条</div>`; };
  drawHealth();
  const me = $(`<details class="me"><summary aria-label="陈默，点开看我的资料和退出登录"><span><b>陈默</b><small>chenmo@example.com</small></span></summary><div class="menu"><button data-me="我的资料和密码">我的资料和密码</button><button data-me="导出我的数据">导出我的数据</button><button data-me="退出登录">退出登录</button></div></details>`);
  me.addEventListener('click', (e) => { const b = e.target.closest('[data-me]'); if (b) { me.open = false; if (b.dataset.me === '退出登录') location.href = 'login.html'; else toast(`原型里没画「${b.dataset.me}」`); } });
  document.addEventListener('click', (e) => { if (!me.contains(e.target)) me.open = false; });
  nav.append(me);
  const upd = () => { const b = nav.querySelector('[data-todo]'); const n = todoCount(); b.textContent = n; b.hidden = !n; };
  listeners.push(upd); upd();
}

// 正文与话题：展开看；为空就明说「没有正文」「没有话题」，不阻止确认。
const tagList = (text) => [...new Set(String(text || '').split(/[,，、\s]+/).map((t) => t.trim().replace(/^#+/, '')).filter(Boolean))];
const tagStr = (tags) => (tags || []).map((t) => '#' + t).join(' ');
const detHtml = (x) => `<div class="pdet"><div class="dl"><span class="k">正文</span><div class="bd">${x.body ? esc(x.body) : '<span class="none">没有正文</span>'}</div></div><div class="dl"><span class="k">话题</span>${(x.tags || []).length ? `<div class="tags">${x.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : '<div class="bd"><span class="none">没有话题</span></div>'}</div></div>`;
// 什么时候发：现在发没有时间；预约发才有时间
const tmText = (timing, at) => (timing === 'now' ? '现在发' : when(at).text);
const nextSlot = (at) => { const t = (at || 'T20:00').slice(10); return (TODAY + t > NOW ? TODAY : dayAdd(TODAY, 1)) + t; };
const FIELDS = [['title', '标题'], ['body', '正文'], ['tags', '话题']];

// ---------- 成片面板：视频 + 各平台一行 + 小红书单独一块 + 一个确认按钮。发过的成片也用它，只是每行换成结果。
// 「改内容」是面板的一个状态：上面通用文案，下面每个平台一行、点开单独写；能取消，一次保存。
function confirmPanel(work, cut, opts = {}) {
  const el = $(`<section class="cp ${cut.vert ? 'vert' : ''}" aria-label="${esc(cut.name)}"></section>`);
  let ver = 0; let ed = null; const opened = new Set(); const one = work.cuts.length === 1;
  const editable = () => cut.pubs.filter((x) => x.state === 'pending' || (x.state === 'confirmed' && x.timing !== 'now'));

  // ----- 看
  const renderView = () => {
    const batch = cutBatch(cut); const solo = cut.pubs.filter((x) => x.solo && x.state !== 'published'); const rest = cut.pubs.filter((x) => !solo.includes(x));
    const media = cut.versions.length
      ? `<video controls preload="none" poster="${cut.poster}" src="${cut.versions[ver][1]}"></video>`
      : `<img class="poster" src="${cut.poster}" alt="${esc(cut.name)}的封面">`;
    const anyOpen = cut.pubs.some((x) => x.state === 'pending');
    // 现在发还是预约发只在这里整批选（所有者 2026-11-18 定），编辑里只改时间，所以没有混合状态
    const mode = batch.length && batch.every((x) => x.timing === 'now') ? 'now' : 'at';
    const held = cut.pubs.filter((x) => paused(x.pf) && (x.state === 'pending' || x.state === 'confirmed'));
    const late = (x) => (x.was && x.timing === 'at' && x.state === 'pending' ? `<span class="sub"> · 原定${when(x.was).text}，已顺延</span>` : '');
    el.innerHTML = `
      <div class="cph"><h3>${esc(cut.name)}</h3><span class="sub">${cut.dur}</span>
        <span class="vers">${(cut.versions.length > 1 ? cut.versions : []).map((v, i) => `<button class="btn" data-ver="${i}" aria-pressed="${i === ver}">${v[0]}</button>`).join('')}${editable().length ? '<button class="btn edit" data-edit="">改内容</button>' : ''}</span></div>
      ${media}
      <div class="ai">${anyOpen ? 'AI 生成的内容，每个平台都会按它的要求标注。文案和时间是建议，想改再改。' : 'AI 生成的内容，每个平台都按它的要求标注了。'}</div>
      ${held.length ? `<div class="note wait"><b>发布机的出口位置变了，${[...new Set(held.map((x) => PF[x.pf][1]))].join('、')}先暂停。</b><div>现在可以照常确认，但这几个平台要等位置处理完才会发。<a class="link" href="system.html#ip=moved&tab=devices">去处理</a></div></div>` : ''}
      <div class="rows">${rest.map((x) => {
        const i = cut.pubs.indexOf(x); const name = PF[x.pf][1];
        let st;
        if (x.state === 'pending') st = `<button class="link" data-edit="${i}" aria-label="改${name}的内容或时间">改</button>`;
        else if (x.state === 'confirmed') st = `<span class="st sched">${x.timing === 'now' ? '正在发' : '已确认'}</span>`;
        else if (x.state === 'skip') st = '<span class="st">不发</span>';
        else if (x.issue && !x.issue.done) st = '<span class="st bad">出了问题</span>';
        else st = x.n != null ? `<span class="x ${ratio(x).cls}" title="24 小时 ${fmt(x.n)} 播放，平时 ${fmt(BASE[x.pf])}">${ratio(x).txt}</span>` : '<span class="st pub">已发布</span>';
        return `<div class="prow ${x.state === 'skip' ? 'off' : ''} ${x.issue && !x.issue.done ? 'bad' : ''}">${pf(x.pf)}<span class="nm">${name}</span><button class="ti tog" type="button" data-more="${i}" aria-expanded="${opened.has(i)}" title="${esc(x.title)}">${esc(x.title)}${x.note ? `<span class="sub"> · ${esc(x.note)}</span>` : ''}${late(x)}</button><span class="tm">${paused(x.pf) && x.state !== 'skip' ? '<span class="st wait">暂停中</span>' : tmText(x.timing, x.at)}</span>${st}${opened.has(i) ? detHtml(x) : ''}</div>`;
      }).join('')}</div>
      ${solo.map((x) => {
        const i = cut.pubs.indexOf(x); const w = when(x.at);
        const body = x.state === 'pending'
          ? `<div class="acts"><button class="btn" data-solo="confirmed" data-i="${i}">${w.text} 发</button><button class="btn" data-solo="now" data-i="${i}">现在发</button><button class="btn" data-solo="manual" data-i="${i}">我自己发</button></div>`
          : `<div class="acts"><span class="st ${x.state === 'skip' ? '' : 'done'}">${{ confirmed: `已确认，${w.text} 发`, now: '已确认，正在发', manual: '你自己发，发完告诉我', skip: '先不发' }[x.state]}</span></div>`;
        return `<div class="solo"><div class="sh">${pf('xhs')}小红书 · 每条都要你单独确认${x.state === 'pending' ? '<button class="link" style="margin-left:auto" data-edit="' + i + '" aria-label="改小红书的内容或时间">改</button>' : ''}</div><div class="ti">${esc(x.title)}</div><div class="sub">${esc(x.note || '竖屏 · 封面 3:4')}${x.was && x.state === 'pending' ? ` · 原定${when(x.was).text}，已过，顺延到${w.text}` : ''}</div><button class="tog" type="button" data-more="${i}" aria-expanded="${opened.has(i)}">${opened.has(i) ? '收起正文和话题' : '看正文和话题'}</button>${opened.has(i) ? detHtml(x) : ''}${body}</div>`;
      }).join('')}
      ${batch.length
        ? `<div class="cfoot"><span class="hint">${held.length ? '暂停的平台要等位置处理完才会发。' : mode === 'now' ? '确认后马上开始发。' : '没确认的到时间也不会发。'}</span><button class="link" data-skipcut>${one ? '先不发' : '这支先不发'}</button><span class="seg" role="group" aria-label="什么时候发"><button data-mode="at" aria-pressed="${mode === 'at'}">预约发</button><button data-mode="now" aria-pressed="${mode === 'now'}">现在发</button></span><button class="btn pri lg" data-confirm>确认这 ${batch.length} 条，${mode === 'now' ? '现在发' : '按时间发'}</button></div>`
        : cut.skipped ? '<div class="cfoot"><div class="done-note">这支先不发。以后可以在作品里再确认。</div></div>'
        : rest.some((x) => x.state === 'confirmed') ? `<div class="cfoot"><div class="done-note">${one ? '' : esc(cut.name) + '的 '}${rest.filter((x) => x.state === 'confirmed').length} 条已确认，${rest.some((x) => x.state === 'confirmed' && x.timing === 'at') ? '会按时间发' : '正在发'}。</div></div>` : ''}`;
  };

  // ----- 改
  const startEdit = (i) => {
    const xs = editable(); const focus = i == null ? null : cut.pubs[i]; const vL = cut.versions[ver] && cut.versions[ver][0];
    ed = { L: focus ? focus.L : xs.some((x) => x.L === vL) ? vL : xs[0].L, open: new Set(focus ? [i] : []), ask: false,
      common: Object.fromEntries(Object.entries(cut.common).map(([L, v]) => [L, { title: v.title, body: v.body, tags: tagStr(v.tags) }])),
      pubs: new Map(xs.map((x) => [cut.pubs.indexOf(x), { own: { ...x.own, ...(x.own.tags ? { tags: tagStr(x.own.tags) } : {}) }, timing: x.timing, at: x.at }])) };
  };
  const val = (i, f) => ed.pubs.get(i).own[f] ?? ed.common[cut.pubs[i].L][f];
  const same = (f, a, b) => (f === 'tags' ? tagList(a).join() === tagList(b).join() : a === b);
  const dirty = () => {
    let n = 0;
    Object.entries(ed.common).forEach(([L, v]) => FIELDS.forEach(([f]) => { if (!same(f, v[f], f === 'tags' ? tagStr(cut.common[L].tags) : cut.common[L][f])) n++; }));
    ed.pubs.forEach((d, i) => { const x = cut.pubs[i];
      FIELDS.forEach(([f]) => { const was = x.own[f] == null ? null : f === 'tags' ? tagStr(x.own[f]) : x.own[f]; const now = d.own[f] ?? null; if ((was == null) !== (now == null) || (was != null && !same(f, was, now))) n++; });
      if (d.at !== x.at) n++; });
    return n;
  };
  // 超过平台限制、时间过了、碰到平台规则：当场说，不等到保存
  // 只校验这次动过的：入库时就有的问题不拦无关的保存
  const titleErr = (i) => { const x = cut.pubs[i]; const v = val(i, 'title'); if (v === x.title) return ''; const lim = LIM[x.pf]?.title; const n = [...v].length;
    return !v.trim() ? (ed.pubs.get(i).own.title != null ? `${PF[x.pf][1]}的标题不能是空的。` : '') : lim && n > lim ? `${PF[x.pf][1]}的标题最多 ${lim} 字，现在 ${n} 字。` : ''; };
  const timeErr = (i) => {
    const d = ed.pubs.get(i); const x = cut.pubs[i]; if (d.at === x.at) return null;
    if (!d.at || d.at < NOW) return { msg: '这个时间已经过了。', use: nextSlot(d.at) };
    if (x.pf === 'xhs' && allPubs().some((r) => r.x !== x && r.x.pf === 'xhs' && r.x.state !== 'published' && r.x.state !== 'skip' && r.x.at.slice(0, 10) === d.at.slice(0, 10))) {
      let day = d.at.slice(0, 10); do day = dayAdd(day, 1); while (allPubs().some((r) => r.x !== x && r.x.pf === 'xhs' && r.x.at.slice(0, 10) === day));
      return { msg: `小红书每天最多 1 条，${when(d.at).day}已经排了 1 条。`, use: day + d.at.slice(10) };
    }
    return null;
  };
  const errAt = () => [...ed.pubs.keys()].filter((i) => titleErr(i) || timeErr(i));
  const errCount = () => errAt().reduce((n, i) => n + (titleErr(i) ? 1 : 0) + (timeErr(i) ? 1 : 0), 0) + Object.values(ed.common).filter((v) => !v.title.trim()).length;

  const sumOf = (i) => { const own = FIELDS.filter(([f]) => ed.pubs.get(i).own[f] != null).map(([, n]) => n); return own.length ? `${own.join('、')}是单独写的` : '和通用一样'; };

  const renderEdit = () => {
    const keys = [...ed.pubs.keys()]; const langs = [...new Set(keys.map((i) => cut.pubs[i].L))]; const g = keys.filter((i) => cut.pubs[i].L === ed.L); const cm = ed.common[ed.L];
    el.innerHTML = `
      <div class="cph"><h3>改内容</h3><span class="sub">${one ? '' : esc(cut.name) + ' · '}${cut.dur}</span>
        ${langs.length > 1 ? `<span class="seg" role="group" aria-label="改哪个语言版本的文案">${langs.map((L) => `<button data-lang="${L}" aria-pressed="${L === ed.L}">${L}</button>`).join('')}</span>` : ''}</div>
      <div class="edc"><div class="edt"><h2>通用文案${langs.length > 1 ? ' · ' + ed.L : ''}</h2><span class="sub" data-folnote></span></div>
        ${FIELDS.map(([f, n]) => `<label class="lab" for="c-${f}">${n}${f === 'tags' ? '（用空格分开）' : ''}</label>${f === 'body' ? `<textarea id="c-${f}" data-cf="${f}">${esc(cm[f])}</textarea>` : `<input type="text" id="c-${f}" data-cf="${f}" value="${esc(cm[f])}">`}${f === 'title' ? '<div data-cerr></div>' : ''}`).join('')}</div>
      <h2 class="edh2">各平台 · 想让某个平台不一样，点开单独写</h2>
      <div class="rows">${g.map((i) => { const x = cut.pubs[i]; const d = ed.pubs.get(i); const name = PF[x.pf][1]; const open = ed.open.has(i);
        return `<div class="erow"><button class="eh" type="button" data-open="${i}" aria-expanded="${open}">${pf(x.pf)}<span class="nm">${name}</span><span class="sm" data-sum="${i}"></span><span class="tm" data-tsum="${i}"></span></button>
          ${open ? `<div class="eb">${FIELDS.map(([f, n]) => `<div class="fl"><label class="lab" for="p${i}-${f}">${n}</label><span class="fs" data-fs="${i}:${f}"></span><button class="link" type="button" data-follow="${i}:${f}">改回跟通用</button></div>${f === 'body' ? `<textarea id="p${i}-${f}" data-pf="${i}:${f}">${esc(val(i, f))}</textarea>` : `<input type="text" id="p${i}-${f}" data-pf="${i}:${f}" value="${esc(val(i, f))}">`}${f === 'title' ? `<div data-perr="${i}"></div>` : ''}`).join('')}
            <div class="fl"><label class="lab" for="p${i}-at">按时间发的话，什么时候发</label></div>
            <div class="tmr"><input type="datetime-local" id="p${i}-at" data-at="${i}" min="${NOW}" value="${d.at}"><span class="sub" data-trel="${i}">${when(d.at).text}</span></div><div data-terr="${i}"></div></div>` : ''}</div>`; }).join('')}</div>
      <p class="sub" style="margin:8px 0 0">现在发还是按时间发，在确认时选${cut.pubs.some((x) => x.solo && x.state === 'pending') ? '（小红书逐条单独选）' : ''}；这里只改时间。</p>
      <div class="cfoot" data-efoot></div>`;
    sync();
  };
  // 打字时只更新会变的地方，不重画，免得输入框丢焦点
  const sync = () => {
    const keys = [...ed.pubs.keys()].filter((i) => cut.pubs[i].L === ed.L);
    const names = (xs) => xs.map((i) => PF[cut.pubs[i].pf][1]).join('、');
    const all = keys.filter((i) => !FIELDS.some(([f]) => ed.pubs.get(i).own[f] != null)); const some = keys.filter((i) => !all.includes(i));
    el.querySelector('[data-folnote]').textContent = [all.length && `${names(all)}跟通用走，改这里会一起变`, some.length && `${names(some)}有单独写的，那部分不会变`].filter(Boolean).join('；');
    const over = keys.filter((i) => ed.pubs.get(i).own.title == null && titleErr(i));
    el.querySelector('[data-cerr]').innerHTML = (ed.common[ed.L].title.trim() ? '' : '<div class="err">通用标题不能是空的。</div>') + over.map((i) => `<div class="err">${titleErr(i)}<button class="link" type="button" data-own="${i}:title">给${PF[cut.pubs[i].pf][1]}单独写一个</button></div>`).join('');
    keys.forEach((i) => { const d = ed.pubs.get(i); const sm = el.querySelector(`[data-sum="${i}"]`); sm.textContent = sumOf(i); sm.classList.toggle('own', FIELDS.some(([f]) => d.own[f] != null));
      const ts = el.querySelector(`[data-tsum="${i}"]`); ts.textContent = titleErr(i) || timeErr(i) ? '有要处理的' : tmText(d.timing, d.at); ts.classList.toggle('bad', !!(titleErr(i) || timeErr(i))); const tr = el.querySelector(`[data-trel="${i}"]`); if (tr) tr.textContent = d.at ? when(d.at).text : '';
      if (!ed.open.has(i)) return;
      FIELDS.forEach(([f]) => { const own = d.own[f] != null; const fs = el.querySelector(`[data-fs="${i}:${f}"]`); fs.textContent = own ? '单独写的' : '跟通用'; fs.classList.toggle('own', own);
        el.querySelector(`[data-follow="${i}:${f}"]`).hidden = !own;
        const inp = el.querySelector(`[data-pf="${i}:${f}"]`); inp.classList.toggle('fol', !own); if (!own && document.activeElement !== inp) inp.value = val(i, f); });
      const te = titleErr(i); el.querySelector(`[data-perr="${i}"]`).innerHTML = te && d.own.title != null ? `<div class="err">${te}</div>` : '';
      const tm = timeErr(i); el.querySelector(`[data-terr="${i}"]`).innerHTML = tm ? `<div class="err">${tm.msg}最近能排 ${when(tm.use).text}。<button class="link" type="button" data-use="${i}:${tm.use}">用这个时间</button></div>` : ''; });
    const n = dirty(); const bad = errCount(); const conf = [...ed.pubs.keys()].some((i) => cut.pubs[i].state === 'confirmed');
    el.querySelectorAll('[data-lang]').forEach((b) => { const k = errAt().filter((i) => cut.pubs[i].L === b.dataset.lang).length; b.textContent = b.dataset.lang + (k ? ` · ${k} 处要处理` : ''); });
    el.querySelector('[data-efoot]').innerHTML = ed.ask
      ? `<span class="ask">放弃这 ${n} 处改动？</span><button class="btn" data-keep>接着改</button><button class="btn" data-drop>放弃改动</button>`
      : `<span class="hint">${bad ? `<span class="err">还有 ${bad} 处要先处理。<button class="link" type="button" data-goerr>带我去</button></span>` : n ? `改了 ${n} 处。${conf ? '已确认的仍按原来的时间发。' : '保存后还要你确认才会发。'}` : '还没有改动。'}</span><button class="link" data-cancel>取消</button><button class="btn pri lg" data-savee ${!n || bad ? 'disabled' : ''}>保存改动</button>`;
  };
  const save = () => {
    const changed0 = Object.entries(ed.common).filter(([L, v]) => FIELDS.some(([f]) => !same(f, v[f], f === 'tags' ? tagStr(cut.common[L].tags) : cut.common[L][f]))).map(([L]) => L);
    const kept = [...ed.pubs.keys()].filter((i) => changed0.includes(cut.pubs[i].L) && FIELDS.some(([f]) => ed.pubs.get(i).own[f] != null));
    const n = dirty();
    Object.entries(ed.common).forEach(([L, v]) => Object.assign(cut.common[L], { title: v.title, body: v.body.trim(), tags: tagList(v.tags) }));
    ed.pubs.forEach((d, i) => { const x = cut.pubs[i]; x.own = { ...d.own, ...(d.own.tags != null ? { tags: tagList(d.own.tags) } : {}) }; if (d.at !== x.at) { delete x.was; x.at = d.at; } });
    toast(changed0.length && kept.length ? `改好了。${kept.map((i) => PF[cut.pubs[i].pf][1]).join('、')}有单独写的，那部分没变` : `改好了 ${n} 处`);
    ed = null; changed();
  };
  const render = () => (ed ? renderEdit() : renderView());
  const cancel = () => { if (dirty()) { ed.ask = true; sync(); } else { ed = null; render(); } };

  el.addEventListener('input', (e) => { if (!ed) return; const ds = e.target.dataset;
    if (ds.cf) ed.common[ed.L][ds.cf] = e.target.value;
    else if (ds.pf) { const [i, f] = ds.pf.split(':'); ed.pubs.get(+i).own[f] = e.target.value; }
    else if (ds.at) ed.pubs.get(+ds.at).at = e.target.value;
    ed.ask = false; sync(); });
  document.addEventListener('keydown', (e) => { if (ed && el.isConnected && e.key === 'Escape') { e.preventDefault(); cancel(); } });
  editBusy = () => { if (!(ed && el.isConnected && dirty())) return false; ed.ask = true; sync(); el.querySelector('[data-efoot]').scrollIntoView({ block: 'nearest' }); return true; };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const ds = b.dataset;
    if (ed) {
      if (ds.lang) ed.L = ds.lang;
      else if (ds.open) { const i = +ds.open; ed.open.has(i) ? ed.open.delete(i) : ed.open.add(i); }
      else if (ds.follow) { const [i, f] = ds.follow.split(':'); delete ed.pubs.get(+i).own[f]; }
      else if (ds.own) { const [i, f] = ds.own.split(':'); ed.pubs.get(+i).own[f] = ed.common[ed.L][f]; ed.open.add(+i); renderEdit(); el.querySelector(`[data-pf="${i}:${f}"]`).focus(); return; }
      else if (ds.use) { const [i, ...at] = ds.use.split(':'); ed.pubs.get(+i).at = at.join(':'); }
      else if ('goerr' in ds) { const i = errAt()[0]; if (i == null) { ed.L = Object.keys(ed.common).find((L) => !ed.common[L].title.trim()); renderEdit(); el.querySelector('[data-cf=title]').focus(); return; } ed.L = cut.pubs[i].L; ed.open.add(i); renderEdit(); el.querySelector(`[data-open="${i}"]`).scrollIntoView({ block: 'center' }); return; }
      else if ('cancel' in ds) return cancel();
      else if ('keep' in ds) { ed.ask = false; return sync(); }
      else if ('drop' in ds) { ed = null; toast('没有保存，内容没变'); }
      else if ('savee' in ds) return save();
      else return;
      return render();
    }
    if (ds.ver) ver = +ds.ver;
    else if ('edit' in ds) { startEdit(ds.edit === '' ? null : +ds.edit); renderEdit(); if (ds.edit === '') el.querySelector('[data-cf=title]').focus(); return; }
    else if (ds.more) { const i = +ds.more; opened.has(i) ? opened.delete(i) : opened.add(i); }
    else if (ds.mode) cutBatch(cut).forEach((x) => { x.timing = ds.mode; if (ds.mode === 'at' && x.at < NOW) x.at = nextSlot(x.at); });
    else if (ds.solo) { const x = cut.pubs[+ds.i]; x.state = ds.solo; if (ds.solo === 'now') x.timing = 'now'; toast(ds.solo === 'manual' ? '好，这条你自己发' : ds.solo === 'now' ? '小红书这条已确认，现在发' : '小红书这条已确认'); changed(); }
    else if (ds.retry) { cut.pubs[+ds.retry].issue.done = true; toast('正在重试'); changed(); }
    else if ('skipcut' in ds) { cutPending(cut).forEach((x) => (x.state = 'skip')); cut.skipped = true; opts.onDone && opts.onDone(); changed(); }
    else if ('confirm' in ds) { const xs = cutBatch(cut); const now = xs.every((x) => x.timing === 'now'); xs.forEach((x) => (x.state = 'confirmed')); const hold = xs.filter((x) => paused(x.pf)).length; toast(`已确认 ${xs.length} 条，${hold ? `其中 ${hold} 条等位置处理完再发` : now ? '现在开始发' : '会按时间发'}`); opts.onDone && opts.onDone(); changed(); }
    render();
  });
  // 改到一半要离开页面，拦一下
  window.addEventListener('beforeunload', (e) => { if (ed && el.isConnected && dirty()) e.preventDefault(); });
  render();
  return el;
}

// 成片列表（右栏）。只有一支成片时不出现。
function cutSteps(work, curId) {
  if (work.cuts.length < 2) return '';
  return `<div class="steps">${work.cuts.map((c) => {
    const n = cutPending(c).length; const conf = c.pubs.filter((x) => x.state === 'confirmed').length; const bad = c.pubs.some((x) => x.issue && !x.issue.done);
    const [cls, txt] = bad ? ['bad', '有 1 条出了问题'] : n ? ['wait', n + ' 条等你确认'] : c.skipped ? ['', '先不发'] : conf ? ['sched', '已确认，等时间'] : ['pub', '已发布'];
    return `<button class="step" data-c="${c.id}" aria-current="${c.id === curId}"><img src="${c.poster}" alt=""><span><b>${esc(c.name)}</b><span class="st ${cls}">${txt}</span></span></button>`;
  }).join('')}</div>`;
}

// 截图用：#done=long,s1 把第一个作品的这些成片标成已确认
(HASH.done || '').split(',').filter(Boolean).forEach((id) => { const c = WORKS[0].cuts.find((x) => x.id === id); c && c.pubs.forEach((x) => (x.state = 'confirmed')); });
