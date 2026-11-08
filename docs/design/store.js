/* versekit 原型数据层：账号组、平台账号与本地演示状态。
   只存浏览器 localStorage，不代表真实平台授权或真实后端。 */
(function(){
  const VK = window.VK = window.VK || {};
  const PLATFORMS = {
    xhs:    {name:'小红书', logo:'pl-xhs',       auth:'扫码登录'},
    douyin: {name:'抖音',   logo:'pl-douyin',    auth:'扫码登录'},
    bili:   {name:'B站',    logo:'pl-bili',      auth:'授权登录'},
    youtube:{name:'YouTube',logo:'pl-youtube',   auth:'Google 授权'},
    tiktok: {name:'TikTok', logo:'pl-tiktok',    auth:'TikTok 授权'}
  };
  const GROUPS = {
    ai:  {id:'ai',  label:'AI 工具研究所'},
    cut: {id:'cut', label:'剪辑日记'}
  };
  const ACCOUNTS = [
    {id:'ai-xhs',group:'ai',platform:'xhs',handle:'@AI工具研究所',level:'bad',issue:'登录已失效 · 发布与采集暂停 · 最近成功采集 10-24 09:12',publish:'10-31 20:10',publishMeta:'《AI 剪辑 30 天》 · 发布失败：风控拦截，重试 2 次',collect:'3 天前',collectMeta:'创作中心 · 连续失败 2 次',pubShort:'失败 · 10-31',collectShort:'失败 · 3 天前',action:'重新登录',cmd:'vk account reauth ai-xhs',primary:true},
    {id:'ai-dy',group:'ai',platform:'douyin',handle:'@AI工具研究所',level:'warn',issue:'登录 71 小时后过期 · 到期将自动暂停发布与采集',publish:'今天 17:20',publishMeta:'《AI 剪辑 30 天》 · 已发布',collect:'12 分钟前',collectMeta:'创作中心 · 成功',pubShort:'今天 17:20',collectShort:'12 分钟前',action:'续期',cmd:'vk account renew ai-dy',primary:true},
    {id:'ai-bili',group:'ai',platform:'bili',handle:'AI工具研究所',level:'',issue:'登录正常 · 发布与采集运行中',publish:'昨天 20:00',publishMeta:'《AI 剪辑 30 天》 · 已发布',collect:'12 分钟前',collectMeta:'公开接口 · 成功',pubShort:'昨天 20:00',collectShort:'12 分钟前',action:'账号详情',cmd:'vk account show ai-bili',primary:false},
    {id:'ai-yt',group:'ai',platform:'youtube',handle:'@ai-tools-lab',level:'',issue:'登录正常 · 发布与采集运行中',publish:'昨天 20:00',publishMeta:'《AI 剪辑 30 天》 · 已发布',collect:'12 分钟前',collectMeta:'官方 API · 成功',pubShort:'昨天 20:00',collectShort:'12 分钟前',action:'账号详情',cmd:'vk account show ai-yt',primary:false},
    {id:'ai-tt',group:'ai',platform:'tiktok',handle:'@ai-tools-lab',level:'',issue:'登录正常 · 1 条发布待放行（仅自己可见）',publish:'11-04 21:30',publishMeta:'《AI 剪辑 30 天》 · 仅自己可见 · 待放行',collect:'12 分钟前',collectMeta:'官方 API · 成功',pubShort:'待放行 11-04',collectShort:'12 分钟前',action:'去放行',cmd:'vk publish release p_1d',primary:true},
    {id:'cut-dy',group:'cut',platform:'douyin',handle:'剪辑日记',level:'',issue:'登录正常 · 发布与采集运行中',publish:'10-29 19:00',publishMeta:'《3 个封面实验》 · 已发布',collect:'12 分钟前',collectMeta:'创作中心 · 成功',pubShort:'10-29 19:00',collectShort:'12 分钟前',action:'账号详情',cmd:'vk account show cut-dy',primary:false},
    {id:'cut-bili',group:'cut',platform:'bili',handle:'剪辑日记',level:'',issue:'登录正常 · 发布与采集运行中',publish:'11-03 12:00',publishMeta:'《一周的剪辑练习》 · 已发布',collect:'12 分钟前',collectMeta:'公开接口 · 成功',pubShort:'11-03 12:00',collectShort:'12 分钟前',action:'账号详情',cmd:'vk account show cut-bili',primary:false},
    {id:'cut-yt',group:'cut',platform:'youtube',handle:'@cutdiary',level:'',issue:'登录正常 · 发布与采集运行中',publish:'10-27 20:00',publishMeta:'Editing diary, ep. 8 · 已发布',collect:'12 分钟前',collectMeta:'官方 API · 成功',pubShort:'10-27 20:00',collectShort:'12 分钟前',action:'账号详情',cmd:'vk account show cut-yt',primary:false}
  ];

  const mem = new Map();
  let persistent = true;
  try { localStorage.setItem('vk-probe','1'); localStorage.removeItem('vk-probe'); }
  catch { persistent = false; }

  function raw(key){
    if(persistent){ try { return localStorage.getItem(key); } catch(e){ persistent = false; } }
    return mem.has(key) ? mem.get(key) : null;
  }
  function rawSet(key,value){
    mem.set(key,value);
    if(persistent){ try { localStorage.setItem(key,value); } catch(e){ persistent = false; } }
  }
  // 排期以「作品」为单位；每个作品携带逐平台状态，因为同一作品在不同平台结果不同
  const P = (id,state)=>({id,state});
  const SCHEDULED = [
    {id:'s01',group:'ai',title:'《AI 剪辑 30 天》',at:'2026-11-03T20:00',platforms:[P('bili','published'),P('youtube','published')]},
    {id:'s02',group:'ai',title:'《AI 剪辑 30 天》',at:'2026-11-04T21:30',platforms:[P('douyin','published'),P('tiktok','limited')]},
    {id:'s03',group:'ai',title:'《我用了 30 天 AI 剪辑，发现 3 个反常识结论》',at:'2026-11-07T20:00',platforms:[P('bili','scheduled'),P('youtube','scheduled'),P('douyin','scheduled')]},
    {id:'s04',group:'ai',title:'《3 个封面实验》',at:'2026-11-09T12:00',platforms:[P('douyin','scheduled')]},
    {id:'s05',group:'ai',title:'《一周的剪辑练习》',at:'2026-11-10T19:00',platforms:[P('bili','scheduled'),P('tiktok','scheduled')]},
    {id:'s06',group:'ai',title:'《AI 剪辑 30 天》',at:'2026-11-12T20:00',platforms:[P('youtube','scheduled')]},
    {id:'s07',group:'ai',title:'《封面 AB 测试》',at:'2026-11-14T20:00',platforms:[P('douyin','scheduled'),P('bili','scheduled'),P('youtube','scheduled')]},
    {id:'s08',group:'ai',title:'《废镜头救回来》',at:'2026-11-10T19:20',platforms:[P('bili','scheduled')]},
    {id:'s10',group:'cut',title:'《一周的剪辑练习》',at:'2026-11-03T12:00',platforms:[P('bili','published')]},
    {id:'s11',group:'cut',title:'《3 个封面实验》',at:'2026-11-06T19:00',platforms:[P('douyin','scheduled')]},
    {id:'s12',group:'cut',title:'Editing diary, ep. 8',at:'2026-11-09T21:00',platforms:[P('youtube','scheduled')]},
    {id:'s13',group:'cut',title:'《废镜头救回来》',at:'2026-11-11T20:00',platforms:[P('bili','scheduled'),P('douyin','scheduled')]}
  ];

  function read(key,fallback){
    try { const v = JSON.parse(raw(key)); return v ?? fallback; }
    catch { return fallback; }
  }
  function write(key,value){ rawSet(key,JSON.stringify(value)); }

  VK.storage = {persistent:()=>persistent, raw, rawSet};

  VK.platforms = PLATFORMS;
  VK.groups = function(){
    const custom = read('vk-custom-groups',[]);
    return Object.assign({}, GROUPS, Object.fromEntries(custom.map(g=>[g.id,g])));
  };
  VK.group = function(id){ return VK.groups()[id] || {id,label:id}; };
  VK.accounts = function(group){
    const added = read('vk-added-accounts',[]);
    const map = new Map();
    ACCOUNTS.forEach(a=>map.set(a.id,a));
    added.forEach(a=>map.set(a.id,a));
    return [...map.values()].filter(a=>!group || a.group===group);
  };
  VK.account = function(id){ return VK.accounts().find(a=>a.id===id); };
  function allScheduled(){
    const extra = read('vk-scheduled',[]);
    const removed = read('vk-scheduled-removed',[]);
    const moves = read('vk-schedule-moves',{});
    return SCHEDULED.concat(extra)
      .filter(x=>!removed.includes(x.id))
      .map(x=>moves[x.id] ? Object.assign({},x,{at:moves[x.id]}) : x)
      .sort((a,b)=>a.at.localeCompare(b.at));
  }

  const RANK = {failed:0, limited:1, scheduled:2, published:3};
  function platsOf(it){
    return (it.platforms||[]).map(p=> typeof p==='string' ? {id:p,state:it.state||'scheduled'} : p);
  }
  function aggregate(it){
    const list = platsOf(it);
    if(!list.length) return it.state||'scheduled';
    return list.slice().sort((a,b)=>(RANK[a.state]??9)-(RANK[b.state]??9))[0].state;
  }
  VK.platsOf = platsOf;
  VK.aggregate = aggregate;
  VK.counts = function(list){
    const works = list.length;
    const publishes = list.reduce((n,it)=>n+platsOf(it).length,0);
    return {works,publishes};
  };

  VK.scheduled = function(group){
    return allScheduled().filter(x=>!group || x.group===group)
      .map(it=>Object.assign({},it,{state:aggregate(it)}));
  };

  VK.scheduledBetween = function(group,from,to){
    return VK.scheduled(group).filter(x=>{
      const d = x.at.slice(0,10);
      return d>=from && d<=to;
    });
  };

  VK.scheduleAdd = function({group,title,at,platforms}){
    const extra = read('vk-scheduled',[]);
    const list = (platforms && platforms.length ? platforms : ['bili'])
      .map(p=> typeof p==='string' ? {id:p,state:'scheduled'} : p);
    const item = {
      id:'s'+Date.now().toString(36),
      group, title, at, platforms:list, custom:true
    };
    extra.push(item); write('vk-scheduled',extra);
    return item;
  };

  VK.scheduleMove = function(id,at){
    const extra = read('vk-scheduled',[]);
    const hit = extra.find(x=>x.id===id);
    if(hit){ hit.at = at; write('vk-scheduled',extra); return hit; }
    const overrides = read('vk-schedule-moves',{});
    overrides[id] = at; write('vk-schedule-moves',overrides);
    return null;
  };

  VK.scheduleRestore = function(id){
    const removed = read('vk-scheduled-removed',[]);
    const next = removed.filter(x=>x!==id);
    write('vk-scheduled-removed',next);
  };

  VK.scheduleRemove = function(id){
    const removed = read('vk-scheduled-removed',[]);
    if(!removed.includes(id)){ removed.push(id); write('vk-scheduled-removed',removed); }
  };

  // 同组同平台、时间相近就算撞车：同一账号不可能同时发两条
  const CONFLICT_WINDOW_MIN = 30;
  VK.conflicts = function(group){
    const list = VK.scheduled(group);
    const byPf = new Map();
    list.forEach(it=>{
      platsOf(it).forEach(pf=>{
        if(!byPf.has(pf.id)) byPf.set(pf.id,[]);
        byPf.get(pf.id).push(it);
      });
    });
    const out = [];
    byPf.forEach((items,pf)=>{
      items.sort((a,b)=>a.at.localeCompare(b.at));
      for(let i=1;i<items.length;i++){
        const prev = items[i-1], cur = items[i];
        const gap = Math.abs(new Date(cur.at) - new Date(prev.at)) / 60000;
        if(gap <= CONFLICT_WINDOW_MIN){
          out.push({platform:pf, at:cur.at, a:prev.id, b:cur.id});
        }
      }
    });
    return out;
  };
  VK.conflictIds = function(group){
    const ids = new Set();
    VK.conflicts(group).forEach(c=>{ ids.add(c.a); ids.add(c.b); });
    return ids;
  };

  VK.hasPlatform = function(group,platform){
    return VK.accounts(group).some(a=>a.platform===platform);
  };
  VK.addGroup = function(label){
    const name = String(label||'').trim();
    if(!name) throw new Error('请填写账号组名称');
    const custom = read('vk-custom-groups',[]);
    const id = 'g' + Date.now().toString(36);
    const group = {id,label:name,custom:true};
    custom.push(group); write('vk-custom-groups',custom);
    return group;
  };
  VK.addAccount = function({group,platform,handle,reauth}){
    const name = String(handle||'').trim();
    if(!name) throw new Error('请填写平台账号名');
    if(reauth){
      const existing = VK.account(reauth);
      if(existing){
        const added = read('vk-added-accounts',[]);
        const updated = Object.assign({}, existing, {
          handle:name, level:'', issue:'登录正常 · 刚刚完成重新授权',
          action:'账号详情', primary:false
        });
        added.push(updated); write('vk-added-accounts',added);
        return updated;
      }
    }
    if(VK.hasPlatform(group,platform)) throw new Error('这个平台在当前账号组已接入');
    const account = {
      id: group+'-'+platform+'-'+Date.now().toString(36),
      group,platform,handle:name,level:'',
      issue:'登录正常 · 刚刚完成授权（演示账号）',
      publish:'还没有发布',publishMeta:'可以从发布台发出第一条作品',
      collect:'等待首次采集',collectMeta:'授权成功后自动排队',
      pubShort:'还没有发布',collectShort:'等待首次采集',
      action:'账号详情',cmd:'vk account show '+group+'-'+platform,
      primary:false,custom:true
    };
    const added = read('vk-added-accounts',[]);
    added.push(account); write('vk-added-accounts',added);
    return account;
  };
})();
