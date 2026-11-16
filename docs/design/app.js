// versekit 原型 v2 的演示数据与共用部件。
// 标题与封面取自所有者自己的真实作品；状态、时间、播放数全部是演示数据。
// 封面与视频放在 docs/design/demo/（不入库）；缺了就显示占位，页面不坏。
const VID = 'demo/videos/';
const CV = 'demo/covers/';
const TODAY = '2026-11-15';
const PF = { xhs: ['小', '小红书'], dy: ['抖', '抖音'], sph: ['视', '视频号'], bili: ['B', 'B站'], tk: ['T', 'TikTok'], yt: ['Y', 'YouTube'], web: ['官', '官网'], mp: ['公', '公众号'] };
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
      p('xhs', '2026-11-15T20:00', '一台 AI 走完 6 站：ISO 42001 到底证明什么', { solo: true, note: '竖屏 · 封面 3:4 · 今天还能发 1 条' }),
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
// 账号组：一个组 = 一套平台账号 + 它自己的作品、待办、数据、发布方案。第二个组是虚构的示例。
const GROUPS = [{ id: 'main', name: 'AssureLane', sub: '出海合规 · 7 个账号', q: '' }, { id: 'camp', name: '露营小记', sub: '示例 · 3 个账号', q: '#g=camp' }];
const GROUP = GROUPS[SIMPLE ? 1 : 0];

// ---------- 小工具
const $ = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pf = (k) => `<span class="pf ${k}" title="${PF[k][1]}">${PF[k][0]}</span>`;
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
const upcoming = () => allPubs().filter((r) => r.x.state === 'confirmed').sort((a, b) => a.x.at.localeCompare(b.x.at));
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

// ---------- 外壳：导航写在每个页面的 HTML 里，这里只填待办数和底部的状态
function initShell() {
  const nav = document.querySelector('nav.nav');
  if (SIMPLE) nav.querySelectorAll('a.nv').forEach((a) => (a.href += Q));
  const page = location.pathname.split('/').pop() === 'work.html' ? 'works.html' : location.pathname.split('/').pop();
  const otherTodo = (g) => (g.id === 'main' ? MAIN_TODO : 1);
  const grp = $(`<details class="grp"><summary aria-label="账号组：${GROUP.name}，点开切换"><span><b>${GROUP.name}</b><small>${GROUP.sub}</small></span></summary><div class="menu">
    ${GROUPS.map((g) => `<a href="${page}${g.q}" data-g="${g.id}" ${g === GROUP ? 'aria-current="true"' : ''}><span><b>${g.name}</b><small>${g.sub}</small></span>${g === GROUP ? '<i class="tick">当前</i>' : `<b class="cnt" title="这个组里有 ${otherTodo(g)} 件事等你">${otherTodo(g)}</b>`}</a>`).join('')}
    <button class="btn" data-newg>新建账号组</button></div></details>`);
  grp.addEventListener('click', (e) => { const a = e.target.closest('a[data-g]'); if (a) { e.preventDefault(); location.href = a.getAttribute('href'); if (a.dataset.g !== GROUP.id) location.reload(); grp.open = false; } else if (e.target.closest('[data-newg]')) { toast('原型里不能建；实现后在这里建，或用 vk group add'); grp.open = false; } });
  document.addEventListener('click', (e) => { if (!grp.contains(e.target)) grp.open = false; });
  nav.querySelector('.brand').after(grp);
  const acc = new Set(allPubs().map((r) => r.x.pf)).size;
  nav.append($(`<div class="health"><div><span class="dot"></span>${acc} 个账号登录正常</div><div><span class="dot"></span>发布机在线</div><div><span class="dot"></span>今天还能发：小红书 1 条</div></div>`));
  const upd = () => { const b = nav.querySelector('[data-todo]'); const n = todoCount(); b.textContent = n; b.hidden = !n; };
  listeners.push(upd); upd();
}

// 正文与话题：展开看；为空就明说「没有正文」「没有话题」，不阻止确认。
const tagList = (text) => [...new Set(String(text || '').split(/[,，、\s]+/).map((t) => t.trim().replace(/^#+/, '')).filter(Boolean))];
const detHtml = (x) => `<div class="pdet"><div class="dl"><span class="k">正文</span><div class="bd">${x.body ? esc(x.body) : '<span class="none">没有正文</span>'}</div></div><div class="dl"><span class="k">话题</span>${(x.tags || []).length ? `<div class="tags">${x.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : '<div class="bd"><span class="none">没有话题</span></div>'}</div></div>`;
const editFields = (x, i, name) => `<div class="ef"><label class="lab" for="b${i}">正文</label><textarea id="b${i}" data-body="${i}" aria-label="${name} 正文">${esc(x.body || '')}</textarea><label class="lab" for="t${i}">话题（用逗号或空格分开）</label><input type="text" id="t${i}" value="${esc((x.tags || []).map((t) => '#' + t).join(' '))}" data-tags="${i}" aria-label="${name} 话题"></div>`;

// ---------- 成片面板：视频 + 各平台一行 + 小红书单独一块 + 一个确认按钮。发过的成片也用它，只是每行换成结果。
function confirmPanel(work, cut, opts = {}) {
  const el = $(`<section class="cp ${cut.vert ? 'vert' : ''}" aria-label="${esc(cut.name)}"></section>`);
  let ver = 0; const editing = new Set(); const opened = new Set(); const one = work.cuts.length === 1;
  const render = () => {
    const batch = cutBatch(cut); const solo = cut.pubs.filter((x) => x.solo && x.state !== 'published'); const rest = cut.pubs.filter((x) => !solo.includes(x));
    const media = cut.versions.length
      ? `<video controls preload="none" poster="${cut.poster}" src="${cut.versions[ver][1]}"></video>`
      : `<img class="poster" src="${cut.poster}" alt="${esc(cut.name)}的封面">`;
    const anyOpen = cut.pubs.some((x) => x.state === 'pending');
    el.innerHTML = `
      <div class="cph"><h3>${esc(cut.name)}</h3><span class="sub">${cut.dur}</span>
        <span class="vers">${(cut.versions.length > 1 ? cut.versions : []).map((v, i) => `<button class="btn" data-ver="${i}" aria-pressed="${i === ver}">${v[0]}</button>`).join('')}</span></div>
      ${media}
      <div class="ai">${anyOpen ? 'AI 生成的内容，每个平台都会按它的要求标注。标题、正文、话题和时间是建议，想改再改。' : 'AI 生成的内容，每个平台都按它的要求标注了。'}</div>
      <div class="rows">${rest.map((x) => {
        const i = cut.pubs.indexOf(x); const w = when(x.at); const name = PF[x.pf][1];
        if (editing.has(i)) return `<div class="prow ed">${pf(x.pf)}<span class="nm">${name}</span><input type="text" value="${esc(x.title)}" data-title="${i}" aria-label="${name} 标题"><input type="datetime-local" value="${x.at}" data-at="${i}" aria-label="${name} 发布时间"><button class="btn" data-save="${i}">好了</button>${editFields(x, i, name)}</div>`;
        let st;
        if (x.state === 'pending') st = `<button class="link" data-edit="${i}" aria-label="改${name}的标题、正文、话题或时间">改</button>`;
        else if (x.state === 'confirmed') st = '<span class="st sched">已确认</span>';
        else if (x.state === 'skip') st = '<span class="st">不发</span>';
        else if (x.issue && !x.issue.done) st = '<span class="st bad">出了问题</span>';
        else st = x.n != null ? `<span class="x ${ratio(x).cls}" title="24 小时 ${fmt(x.n)} 播放，平时 ${fmt(BASE[x.pf])}">${ratio(x).txt}</span>` : '<span class="st pub">已发布</span>';
        return `<div class="prow ${x.state === 'skip' ? 'off' : ''} ${x.issue && !x.issue.done ? 'bad' : ''}">${pf(x.pf)}<span class="nm">${name}</span><button class="ti tog" type="button" data-more="${i}" aria-expanded="${opened.has(i)}" title="${esc(x.title)}">${esc(x.title)}${x.note ? `<span class="sub"> · ${esc(x.note)}</span>` : ''}</button><span class="tm">${w.text}</span>${st}${opened.has(i) ? detHtml(x) : ''}</div>`;
      }).join('')}</div>
      ${solo.map((x) => {
        const i = cut.pubs.indexOf(x); const w = when(x.at);
        const body = x.state === 'pending'
          ? `<div class="acts"><button class="btn pri" data-solo="confirmed" data-i="${i}">${w.text} 发</button><button class="btn" data-solo="now" data-i="${i}">现在发</button><button class="btn" data-solo="manual" data-i="${i}">我自己发</button></div>`
          : `<div class="acts"><span class="st ${x.state === 'skip' ? '' : 'done'}">${{ confirmed: `已确认，${w.text} 发`, now: '已确认，正在发', manual: '你自己发，发完告诉我', skip: '先不发' }[x.state]}</span></div>`;
        const ed = editing.has(i);
        const head = ed
          ? `<div class="ef"><label class="lab" for="st${i}">标题</label><input type="text" id="st${i}" value="${esc(x.title)}" data-title="${i}" aria-label="小红书 标题"><label class="lab" for="sa${i}">发布时间</label><input type="datetime-local" id="sa${i}" value="${x.at}" data-at="${i}" aria-label="小红书 发布时间"></div>${editFields(x, i, '小红书')}<div class="acts"><button class="btn" data-save="${i}">好了</button></div>`
          : `<div class="ti">${esc(x.title)}</div><div class="sub">${esc(x.note || '竖屏 · 封面 3:4')}</div><button class="tog" type="button" data-more="${i}" aria-expanded="${opened.has(i)}">${opened.has(i) ? '收起正文和话题' : '看正文和话题'}</button>${opened.has(i) ? detHtml(x) : ''}`;
        return `<div class="solo"><div class="sh">${pf('xhs')}小红书 · 每条都要你单独确认${x.state === 'pending' && !ed ? '<button class="link" style="margin-left:auto" data-edit="' + i + '" aria-label="改小红书的标题、正文、话题或时间">改</button>' : ''}</div>${head}${ed ? '' : body}</div>`;
      }).join('')}
      ${batch.length
        ? `<div class="cfoot"><span class="hint">确认之后才会排进发布；没确认的到时间也不会发。</span><button class="link" data-skipcut>${one ? '先不发' : '这支先不发'}</button><button class="btn pri lg" data-confirm>确认这 ${batch.length} 条，按时间发</button></div>`
        : cut.skipped ? '<div class="cfoot"><div class="done-note">这支先不发。以后可以在作品里再确认。</div></div>'
        : rest.some((x) => x.state === 'confirmed') ? `<div class="cfoot"><div class="done-note">${one ? '' : esc(cut.name) + '的 '}${rest.filter((x) => x.state === 'confirmed').length} 条已确认，会按时间发。</div></div>` : ''}`;
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const ds = b.dataset;
    if (ds.ver) ver = +ds.ver;
    else if (ds.edit) editing.add(+ds.edit);
    else if (ds.more) { const i = +ds.more; opened.has(i) ? opened.delete(i) : opened.add(i); }
    else if (ds.save) { const i = +ds.save; const x = cut.pubs[i]; x.title = el.querySelector(`[data-title="${i}"]`).value; x.at = el.querySelector(`[data-at="${i}"]`).value || x.at; x.body = el.querySelector(`[data-body="${i}"]`).value.trim(); x.tags = tagList(el.querySelector(`[data-tags="${i}"]`).value); editing.delete(i); opened.add(i); }
    else if (ds.solo) { cut.pubs[+ds.i].state = ds.solo; toast(ds.solo === 'manual' ? '好，这条你自己发' : '小红书这条已确认'); changed(); }
    else if (ds.retry) { cut.pubs[+ds.retry].issue.done = true; toast('正在重试'); changed(); }
    else if ('skipcut' in ds) { cutPending(cut).forEach((x) => (x.state = 'skip')); cut.skipped = true; opts.onDone && opts.onDone(); changed(); }
    else if ('confirm' in ds) { const n = cutBatch(cut).length; cutBatch(cut).forEach((x) => (x.state = 'confirmed')); toast(`已确认 ${n} 条，会按时间发`); opts.onDone && opts.onDone(); changed(); }
    render();
  });
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
