/* versekit 全站工作区：当前账号组、切换入口、跨页保持。
   规则：日常页面只服务一个账号组；跨组矩阵与汇总走独立入口。 */
(function(){
  const VK = window.VK;
  const file = location.pathname.split('/').pop() || 'account-wall.html';
  const page = document.body.dataset.page || file.replace('.html','');
  const params = new URLSearchParams(location.search);

  if(page==='groups'){ VK.current = ()=>null; return; }

  const isMatrix = page==='matrix';
  let group = params.get('group') || VK.storage.raw('vk-current-group');

  if(!group && isMatrix) group = 'matrix';
  if(!group){ location.replace('groups.html'); return; }
  if(group==='matrix' && !isMatrix){ location.replace('matrix.html'); return; }
  if(group==='all' && page!=='overview'){ location.replace('matrix.html'); return; }
  if(!isMatrix && group!=='all' && group!=='matrix'){
    VK.storage.rawSet('vk-current-group', group);
  }

  function withGroup(target,id){
    const u = new URL(target,location.href);
    if(id && id!=='all' && id!=='matrix') u.searchParams.set('group',id);
    else if(id==='all') u.searchParams.set('group','all');
    return u.pathname.split('/').pop() + u.search + u.hash;
  }

  VK.current = ()=>isMatrix ? 'matrix' : group;
  VK.isMatrix = ()=>isMatrix;
  VK.isRollup = ()=>group==='all';
  VK.groupLabel = ()=> isMatrix ? '全部账号组' : group==='all' ? '全部账号组' : VK.group(group).label;
  VK.url = withGroup;
  VK.go = function(target,id){
    const g = id || group;
    if(g==='matrix') location.href = 'matrix.html';
    else if(g==='all') location.href = 'overview.html?group=all';
    else location.href = withGroup(target,g);
  };

  function buildSwitcher(){
    const sidebar = document.querySelector('.sidebar');
    if(!sidebar) return;
    const publish = sidebar.querySelector('.publish');
    const box = document.createElement('div');
    box.className = 'workspace';

    const label = document.createElement('label');
    label.className = 'workspace-label';
    label.htmlFor = 'workspace-select';
    label.textContent = isMatrix ? '跨组总览 · 只读' : group==='all' ? '跨组汇总 · 只读' : '当前账号组';

    const select = document.createElement('select');
    select.id = 'workspace-select';
    select.className = 'workspace-select';
    select.setAttribute('aria-label','切换账号组');

    const cur = isMatrix ? '__matrix__' : group==='all' ? '__overview__' : group;
    Object.values(VK.groups()).forEach(g=>{
      const o = document.createElement('option');
      o.value = g.id; o.textContent = g.label;
      select.appendChild(o);
    });
    const mo = document.createElement('option');
    mo.value='__matrix__'; mo.textContent='全部账号组 · 矩阵总览';
    const oo = document.createElement('option');
    oo.value='__overview__'; oo.textContent='全部账号组 · 数据汇总';
    select.append(mo,oo);
    select.value = cur;
    select.addEventListener('change',()=>{
      const v = select.value;
      if(v==='__matrix__') location.href='matrix.html';
      else if(v==='__overview__') location.href='overview.html?group=all';
      else location.href = withGroup('account-wall.html', v);
    });

    const manage = document.createElement('a');
    manage.className = 'workspace-manage';
    manage.href = 'groups.html';
    manage.textContent = '管理账号组';

    box.append(label, select, manage);
    publish.insertAdjacentElement('afterend', box);
  }

  function decorateLinks(){
    if(isMatrix) return;
    document.querySelectorAll('a[href]').forEach(a=>{
      const href = a.getAttribute('href');
      if(!href || href.startsWith('#') || /^(https?:|mailto:)/.test(href)) return;
      if(a.dataset.noGroup!==undefined) return;
      try{
        const u = new URL(href, location.href);
        if(!u.pathname.endsWith('.html')) return;
        if(/(groups|matrix)\.html$/.test(u.pathname)) return;
        if(u.searchParams.has('group')) return;
        if(group==='all'){ u.searchParams.set('group','all'); }
        else { u.searchParams.set('group',group); }
        a.setAttribute('href', u.pathname.split('/').pop()+u.search+u.hash);
      }catch(e){}
    });
  }

  function labels(){
    document.querySelectorAll('[data-group-label]').forEach(el=>el.textContent = VK.groupLabel());
    const n = VK.accounts(isMatrix ? null : group).length;
    document.querySelectorAll('[data-group-count]').forEach(el=>el.textContent = n);
  }

  buildSwitcher();
  decorateLinks();
  labels();
})();