/* 成片面板（今天页与作品详情页共用，只有这一份）。
 *
 * 从 today.html 原样搬来（#149）：确认这支成片的平台稿、改标题/时间、小红书单独确认、语言版本切换、
 * 成片步骤条。页面自己持有 state（editing: Set、ver: Map）并处理点击；这里只负责把 HTML 画出来。
 * 依赖 api.js（window.VK）。
 */
window.VKPanel = function createPanel(state) {
  const VK = window.VK;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // 封面不入库，占位图与设计稿一致（docs/design/app.js 的 BLANK）：页面不因为缺图坏掉。
  const BLANK = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#dcdcd8"/><path d="M290 200l80 40-80 40z" fill="#9a9a95"/></svg>');
  /**
   * 封面（ACC-v3-fid-03）：用这支成片的第一个语言版本。入库不生成缩略图，所以视频直接取第一帧
   * （video + #t=0.1，只读元数据），图片素材退到 <img>，都读不到才用占位。没有版本 id 就是占位。
   */
  // 入库封面优先（ACC-v3-fid-10）：先试 /media/<id>?cover=1；没有封面（404）再退回首帧。
  const cover = (versionId, w, h) => versionId
    ? `<img class="cv" src="${esc(VK.media(versionId))}?cover=1" width="${w}" height="${h}" alt="" data-cover-try="${esc(versionId)}">`
    : `<img class="cv" src="${BLANK}" width="${w}" height="${h}" alt="">`;
  const frameCover = (versionId, w, h) => `<video class="cv" src="${esc(VK.media(versionId))}#t=0.1" muted playsinline preload="metadata" tabindex="-1" aria-hidden="true" width="${w}" height="${h}" data-cover="${esc(versionId)}"></video>`;
  // 没有入库封面（/media?cover=1 回 404）：退回首帧。
  const toFrame = (img) => {
    const tpl = document.createElement("template");
    tpl.innerHTML = frameCover(img.dataset.coverTry, img.width, img.height);
    const v = tpl.content.firstElementChild;
    v.className = img.className;
    img.replaceWith(v);
  };
  if (!window.__vkCover) {
    window.__vkCover = true;
    // error 不冒泡，用捕获：视频读不了 → 试图片 → 再不行才占位。
    document.addEventListener("error", (e) => {
      const t = e.target;
      if (t?.matches?.("img[data-cover-try]")) toFrame(t);
      else if (t?.matches?.("video[data-cover]")) {
        const img = document.createElement("img");
        img.className = t.className; img.width = t.width; img.height = t.height; img.alt = "";
        img.dataset.coverImg = t.dataset.cover; img.src = t.currentSrc.split("#")[0] || t.src.split("#")[0];
        t.replaceWith(img);
      } else if (t?.matches?.("img[data-cover-img]")) {
        t.removeAttribute("data-cover-img");
        t.src = BLANK;
      }
    }, true);
    // 成片视频读到元数据后：标题旁写时长，竖版的视频框高 360（ACC-v3-fid-06）。
    document.addEventListener("loadedmetadata", (e) => {
      const v = e.target;
      if (!v?.matches?.("video[data-media]")) return;
      const box = v.closest(".cp");
      if (!box) return;
      if (v.videoHeight > v.videoWidth) box.classList.add("vert");
      const dur = box.querySelector("[data-dur]");
      if (dur && Number.isFinite(v.duration)) {
        const sec = Math.round(v.duration);
        dur.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
      }
    }, true);
  }
  const PF = {
    xiaohongshu: ["小", "小红书", "xhs"], douyin: ["抖", "抖音", "dy"], shipinhao: ["视", "视频号", "sph"],
    bilibili: ["B", "B站", "bili"], tiktok: ["T", "TikTok", "tk"], "tiktok-api": ["T", "TikTok", "tk"], youtube: ["Y", "YouTube", "yt"],
    web: ["官", "官网", "web"], gongzhonghao: ["公", "公众号", "mp"],
  };
  const pfOf = (key) => PF[key] ?? [String(key ?? "?").slice(0, 1), String(key ?? ""), "web"];
  // 官方标志文件：logos/<file>.svg。文件在才用标志，不在就回落字母徽章（ACC-v3-fid-09；素材清单见 logos/README.md）。
  const LOGO_FILE = { xiaohongshu: "xiaohongshu", douyin: "douyin", shipinhao: "shipinhao", bilibili: "bilibili", tiktok: "tiktok", "tiktok-api": "tiktok", youtube: "youtube", web: "web", gongzhonghao: "gongzhonghao" };
  const logoUrl = (f) => `/logos/${f}.svg`;
  const LOGOS = new Set();
  const upgradeLogos = (root = document) => root.querySelectorAll?.(".pf[data-logo]:not(.lg)").forEach((n) => {
    if (!LOGOS.has(n.dataset.logo)) return;
    n.style.setProperty("--logo", `url(${logoUrl(n.dataset.logo)})`);
    n.classList.add("lg");
  });
  // logos/index.json 列出已放进来的文件名（没放的不去请求，免得控制台一串 404）。
  if (typeof fetch !== "undefined" && typeof Image !== "undefined") {
    fetch("/logos/index.json").then((r) => (r.ok ? r.json() : [])).catch(() => []).then((list) => {
      for (const f of Array.isArray(list) ? list : []) {
        const im = new Image();
        im.onload = () => { LOGOS.add(f); upgradeLogos(); };
        im.src = logoUrl(f);
      }
    });
    if (typeof MutationObserver !== "undefined" && document.body) new MutationObserver(() => upgradeLogos()).observe(document.body, { childList: true, subtree: true });
  }
  // state：""=已发布/默认（品牌色），"off"=还没发（灰色标志），"err"=出了问题（红底白标志）；tip 给读屏和悬停。
  const pfBadge = (key, state = "", tip = "") => {
    const [ch, name, cls] = pfOf(key);
    const f = LOGO_FILE[key];
    const lg = f && LOGOS.has(f);
    const label = tip ? `${name}：${tip}` : name;
    const a11y = tip ? ` role="img" aria-label="${esc(label)}"` : "";
    return `<span class="pf ${cls} ${state}${lg ? " lg" : ""}"${f ? ` data-logo="${f}"` : ""}${lg ? ` style="--logo:url(${logoUrl(f)})"` : ""} title="${esc(label)}"${a11y}>${esc(ch)}</span>`;
  };
  const pfName = (key) => pfOf(key)[1];
  // tiktok-api（官方接口）也逐条确认：隐私级别要人亲手选，不能跟着整支成片一起批量确认（#173）。
  const PER_ITEM = new Set(["xiaohongshu", "tiktok-api"]);
  // 平台行的顺序与设计稿一致；不在表里的平台排在后面。
  const ORDER = ["xiaohongshu", "douyin", "shipinhao", "bilibili", "tiktok", "tiktok-api", "youtube", "web", "gongzhonghao"];
  const orderOf = (platform) => {
    const i = ORDER.indexOf(platform);
    return i === -1 ? ORDER.length : i;
  };

  const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const pad2 = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  /** 时间只说人话：今天 / 明天 / 昨天 / 11-17 周二，再带时分。 */
  function when(ms) {
    if (ms == null) return { day: "—", t: "", text: "还没定时间" };
    const d = new Date(Number(ms));
    const today0 = new Date();
    const days = Math.round((new Date(dayKey(d)) - new Date(dayKey(today0))) / 864e5);
    const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const day = days === 0 ? "今天" : days === 1 ? "明天" : days === -1 ? "昨天"
      : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WD[d.getDay()]}`;
    return { day, t, text: `${day} ${t}` };
  }

  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const ratioText = (x) => (x == null ? "—" : `${x >= 10 ? Number(x).toFixed(0) : Number(x).toFixed(1)} 倍`);
  const ratioCls = (x) => (x == null ? "" : x >= 2 ? "up" : x <= 0.5 ? "dn" : "");


  // 正文与话题：展开看；为空就明说「没有正文」「没有话题」，不阻止确认（ACC-v2-copy-04）。
  // 状态词与 docs/design/app.js 的 detHtml / editFields 逐句一致。
  const detHtml = (p) =>
    `<div class="pdet"><div class="dl"><span class="k">正文</span><div class="bd">${p.body ? esc(p.body) : '<span class="none">没有正文</span>'}</div></div>` +
    `<div class="dl"><span class="k">话题</span>${(p.tags ?? []).length
      ? `<div class="tags">${p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>`
      : '<div class="bd"><span class="none">没有话题</span></div>'}</div></div>`;
  const isOpen = (id) => Boolean(state.opened?.has(id));

  const pending = (cut) => (cut?.publishes ?? []).filter((p) => p.state === "pending_confirm");
  const batchOf = (cut) => pending(cut).filter((p) => !PER_ITEM.has(p.platform));
  const soloOf = (cut) => (cut?.publishes ?? []).filter((p) => PER_ITEM.has(p.platform) && !["published", "published_limited"].includes(p.state));
  const cutHasPending = (cut) => pending(cut).length > 0;

  function mediaBox(cut) {
    const versions = cut.versions ?? [];
    const chosen = versions.find((v) => v.id === state.ver.get(cut.id)) ?? versions[0] ?? null;
    if (!chosen) return fallback(cut.title, "这支成片还没有可播放的语言版本");
    // #t=0.1：先解出一帧当封面用，否则 video 在用户点播放前是一块黑。
    const src = `${VK.media(chosen.id)}#t=0.1`;
    return `<video controls preload="metadata" src="${src}" data-media="1" data-label="${esc(cut.title)}"></video>`;
  }

  function fallback(label, why) {
    return `<div class="media-fallback"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><div class="m1">${esc(label)}</div><div class="m2">${esc(why)}</div></div>`;
  }

  // 现在发的平台稿确认后，开始时间就是确认那一刻：已经到点的 queued 说「正在发」（ACC-v3-time-07）。
  const sendingNow = (p) => p.state === "queued" && p.scheduledAt != null && p.scheduledAt <= Date.now();

  function rowState(p) {
    if (isEditable(p)) return `<button class="link" type="button" data-ed="start" data-arg="${esc(p.id)}" aria-label="改${esc(pfName(p.platform))}的内容或时间">改</button>`;
    if (p.state === "queued") return `<span class="st sched">${sendingNow(p) ? "正在发" : "已确认"}</span>`;
    if (p.state === "auto_running" || p.state === "draft_running") return '<span class="st sched">发布中</span>';
    if (p.state === "notify_pending") return '<span class="st wait">待人工确认</span>';
    if (p.state === "draft_pending") return '<span class="st wait">待确认草稿</span>';
    if (p.state === "skipped") return '<span class="st">不发</span>';
    if (["failed", "blocked", "expired"].includes(p.state)) return '<span class="st bad">出了问题</span>';
    // 已发布的行自己写结果：和这个账号平时比的倍数；满 24 小时但基线不足写「还没法比」。
    const q = p.multiple;
    if (q != null) return `<span class="st pub res"><span class="x ${ratioCls(q)}">${ratioText(q)}</span></span>`;
    if ("multiple" in p) return `<span class="st pub res" title="${esc(p.reason ?? "")}">还没法比</span>`;
    return '<span class="st pub">已发布</span>';
  }

  // ── 改内容（ACC-v3-edit-03/04/05/08、ACC-v3-time-04）──────────────────────────────
  // 面板的一个状态：上面通用文案，下面每个平台一行、点开单独写；底栏取消 / 保存。
  // 状态在 state.ed 里（页面重画不丢）；打字只更新会变的地方（sync），不重画，免得输入框丢焦点。
  // 一次提交走 cut.edit（带 rev）；这里不自己判平台规则，后端说了算，只把原因和最近能排的时间原地写出来。
  const FIELDS = [["title", "标题"], ["body", "正文"], ["tags", "话题"]];
  const tagList = (text) => VK.parseTags(text);
  const tagStr = (tags) => (tags ?? []).map((t) => "#" + t).join(" ");
  const sameField = (f, a, b) => (f === "tags" ? tagList(a).join() === tagList(b).join() : String(a ?? "") === String(b ?? ""));
  const nChars = (t) => [...String(t ?? "")].length;
  // 按时间发的、还没发的才能改：待确认，或已确认且还没到点（现在发的已经到点，不能改）。TikTok 官方接口有自己的设置面板。
  const isEditable = (p) => p.platform !== "tiktok-api" && (p.state === "pending_confirm" || (p.state === "queued" && p.scheduledAt != null && p.scheduledAt > Date.now()));
  const editableOf = (cut) => (cut?.publishes ?? []).filter(isEditable);
  let ctx = null;

  /** 一份文案放进某平台超限吗：规则同后端 copyViolations，数字只来自 work.show 给的 copyLimit。 */
  function violationsOf(limit, c) {
    if (!limit) return [];
    const out = [];
    const title = String(c.title ?? "");
    const body = String(c.body ?? "");
    const tags = c.tags ?? [];
    if (limit.title != null && nChars(title) > limit.title) out.push({ field: "title", text: `${limit.label}的标题最多 ${limit.title} 字，现在 ${nChars(title)} 字。` });
    if (limit.body != null && nChars(body) > limit.body) out.push({ field: "body", text: `${limit.label}的正文最多 ${limit.body} 字，现在 ${nChars(body)} 字。` });
    if (limit.tags?.max != null && tags.length > limit.tags.max) out.push({ field: "tags", text: `${limit.label}的话题最多 ${limit.tags.max} 个，现在 ${tags.length} 个。` });
    if (limit.tags?.each != null) {
      const long = tags.filter((t) => nChars(t) > limit.tags.each);
      if (long.length) out.push({ field: "tags", text: `${limit.label}每个话题最多 ${limit.tags.each} 字，超限的有：${long.join("、")}。` });
    }
    if (limit.combined != null) {
      const total = nChars([title, body, tags.length ? tags.map((t) => "#" + t).join(" ") : ""].filter(Boolean).join("\n"));
      if (total > limit.combined) out.push({ field: "body", text: `${limit.label}的文案（标题、正文、话题合计）最多 ${limit.combined} 字，现在 ${total} 字。` });
    }
    return out;
  }

  function startEdit(work, cut, focusId) {
    const rows = editableOf(cut);
    if (!rows.length) return;
    const versions = cut.versions ?? [];
    const focus = focusId ? rows.find((p) => p.id === focusId) : null;
    const chosen = state.ver.get(cut.id) ?? versions[0]?.id;
    const vid = focus?.versionId ?? (rows.some((p) => p.versionId === chosen) ? chosen : rows[0].versionId);
    const common = {};
    for (const v of versions) {
      if (!rows.some((p) => p.versionId === v.id)) continue;
      const g = v.generic ?? {};
      common[v.id] = { title: g.title || cut.title, body: g.body ?? "", tags: tagStr(g.tags) };
    }
    const pubs = new Map(rows.map((p) => {
      const own = {};
      for (const f of p.ownFields ?? []) own[f] = f === "tags" ? tagStr(p.tags) : p[f] ?? "";
      return [p.id, { p, own, ownWas: new Set(p.ownFields ?? []), at: p.scheduledAt ?? null, atText: p.scheduledAt == null ? "" : VK.toLocalStamp(p.scheduledAt) }];
    }));
    state.ed = {
      cutId: cut.id, workId: work.id, rev: cut.rev ?? 0, vid, open: new Set(focus ? [focus.id] : []), ask: false, busy: false,
      common, base: JSON.parse(JSON.stringify(common)), versions, pubs, srv: new Map(), timeErr: new Map(), note: null,
    };
  }

  const edOf = (cutId) => (state.ed && state.ed.cutId === cutId ? state.ed : null);
  const val = (ed, id, f) => ed.pubs.get(id).own[f] ?? ed.common[ed.pubs.get(id).p.versionId]?.[f] ?? "";
  const verOf = (ed, vid) => ed.versions.find((v) => v.id === vid);
  const langOf = (ed, vid) => verOf(ed, vid)?.language ?? "";

  /** 这次动了几处：通用文案的字段、各平台单独写的字段（含改回跟通用）、时间。 */
  function dirtyCount(ed) {
    let n = 0;
    for (const [vid, c] of Object.entries(ed.common)) for (const [f] of FIELDS) if (!sameField(f, c[f], ed.base[vid][f])) n++;
    for (const d of ed.pubs.values()) {
      for (const [f] of FIELDS) {
        const was = d.ownWas.has(f);
        const now = d.own[f] != null;
        if (was !== now) n++;
        else if (now) {
          const orig = f === "tags" ? tagStr(d.p.tags) : d.p[f] ?? "";
          if (!sameField(f, d.own[f], orig)) n++;
        }
      }
      if (d.at !== (d.p.scheduledAt ?? null)) n++;
    }
    return n;
  }

  /**
   * 当场能判的问题，只看这次动过的字段：入库时就有的问题不拦无关的保存（ACC-v3-edit-08）。
   * 平台规则（每日上限、最小间隔、时间已过）只有后端知道：保存被拒时写进 srv / timeErr，在原地显示。
   */
  function errorsOf(ed) {
    const out = [];
    for (const [vid, c] of Object.entries(ed.common)) if (!c.title.trim()) out.push({ kind: "empty", vid });
    for (const [id, d] of ed.pubs) {
      const p = d.p;
      const vid = p.versionId;
      const name = pfName(p.platform);
      if (d.own.title != null && !d.own.title.trim()) out.push({ kind: "own", id, vid, field: "title", text: `${name}的标题不能是空的。` });
      const limit = verOf(ed, vid)?.copyLimit?.[p.platform];
      const copy = { title: val(ed, id, "title").trim(), body: val(ed, id, "body").trim(), tags: tagList(val(ed, id, "tags")) };
      const had = violationsOf(limit, { title: p.title, body: p.body, tags: p.tags }).map((v) => v.text);
      for (const v of violationsOf(limit, copy)) {
        if (had.includes(v.text)) continue;
        if (d.own[v.field] != null) out.push({ kind: "own", id, vid, field: v.field, text: v.text });
        else out.push({ kind: "generic", id, vid, field: v.field, text: v.text });
      }
      if (ed.timeErr.has(id)) out.push({ kind: "time", id, vid, ...ed.timeErr.get(id) });
      for (const text of ed.srv.get(id) ?? []) out.push({ kind: "srv", id, vid, text });
    }
    return out;
  }

  const sumOf = (d) => {
    const own = FIELDS.filter(([f]) => d.own[f] != null).map(([, n]) => n);
    return own.length ? `${own.join("、")}是单独写的` : "和通用一样";
  };

  function editHtml(work, cut) {
    const ed = state.ed;
    const one = work.cuts.length === 1;
    const langs = ed.versions.filter((v) => ed.common[v.id]);
    const cm = ed.common[ed.vid];
    const ids = [...ed.pubs.keys()].filter((id) => ed.pubs.get(id).p.versionId === ed.vid).sort((a, b) => orderOf(ed.pubs.get(a).p.platform) - orderOf(ed.pubs.get(b).p.platform));
    const field = (id, f, areaAttr) => (f === "body"
      ? `<textarea ${areaAttr}>${esc(val(ed, id, f))}</textarea>`
      : `<input type="text" ${areaAttr} value="${esc(val(ed, id, f))}">`);
    const rows = ids.map((id) => {
      const d = ed.pubs.get(id);
      const p = d.p;
      const name = pfName(p.platform);
      const open = ed.open.has(id);
      const body = open
        ? `<div class="eb">${FIELDS.map(([f, n]) => `<div class="fl"><label class="lab" for="p-${esc(id)}-${f}">${n}</label><span class="fs" data-fs="${esc(id)}:${f}"></span>` +
            `<button class="link" type="button" data-ed="follow" data-arg="${esc(id)}:${f}">改回跟通用</button></div>` +
            field(id, f, `id="p-${esc(id)}-${f}" data-edf="p" data-id="${esc(id)}" data-f="${f}" aria-label="${esc(name)} ${n}"`) +
            `<div data-perr="${esc(id)}:${f}"></div>`).join("")}` +
          `<div class="fl"><label class="lab" for="p-${esc(id)}-at">按时间发的话，什么时候发</label></div>` +
          `<div class="tmr"><input type="datetime-local" id="p-${esc(id)}-at" data-edf="at" data-id="${esc(id)}" value="${esc(d.atText)}"><span class="sub" data-trel="${esc(id)}"></span></div>` +
          `<div data-terr="${esc(id)}"></div></div>`
        : "";
      return `<div class="erow"><button class="eh" type="button" data-ed="open" data-arg="${esc(id)}" aria-expanded="${open}">${pfBadge(p.platform)}<span class="nm">${esc(name)}</span>` +
        `<span class="sm" data-sum="${esc(id)}"></span><span class="tm" data-tsum="${esc(id)}"></span></button>${body}</div>`;
    }).join("");
    const hasSolo = (cut.publishes ?? []).some((p) => PER_ITEM.has(p.platform) && p.state === "pending_confirm");
    return `<section class="cp" aria-label="改内容" data-ed-root>` +
      `<div class="cph"><h3>改内容</h3><span class="sub">${one ? "" : esc(cut.title) + " · "}<span data-dur></span></span>` +
      (langs.length > 1 ? `<span class="seg" role="group" aria-label="改哪个语言版本的文案">${langs.map((v) => `<button type="button" data-ed="lang" data-arg="${esc(v.id)}" aria-pressed="${v.id === ed.vid}">${esc(v.language)}</button>`).join("")}</span>` : "") + `</div>` +
      `<div class="edc"><div class="edt"><h2>通用文案${langs.length > 1 ? " · " + esc(langOf(ed, ed.vid)) : ""}</h2><span class="sub" data-folnote></span></div>` +
      FIELDS.map(([f, n]) => `<label class="lab" for="c-${f}">${n}${f === "tags" ? "（用空格分开）" : ""}</label>` +
        (f === "body" ? `<textarea id="c-${f}" data-edf="c" data-f="${f}">${esc(cm[f])}</textarea>` : `<input type="text" id="c-${f}" data-edf="c" data-f="${f}" value="${esc(cm[f])}">`) +
        `<div data-cerr="${f}"></div>`).join("") + `</div>` +
      `<h2 class="edh2">各平台 · 想让某个平台不一样，点开单独写</h2><div class="rows">${rows}</div>` +
      `<p class="sub" style="margin:8px 0 0">现在发还是按时间发，在确认时选${hasSolo ? "（小红书逐条单独选）" : ""}；这里只改时间。</p>` +
      `<div class="cfoot" data-efoot></div></section>`;
  }

  /** 打字时只更新会变的地方，不重画。 */
  function sync() {
    const ed = state.ed;
    const root = document.querySelector("[data-ed-root]");
    if (!ed || !root) return;
    const q = (sel) => root.querySelector(sel);
    const ids = [...ed.pubs.keys()].filter((id) => ed.pubs.get(id).p.versionId === ed.vid);
    const names = (xs) => xs.map((id) => pfName(ed.pubs.get(id).p.platform)).join("、");
    const errs = errorsOf(ed);
    const followAll = ids.filter((id) => !FIELDS.some(([f]) => ed.pubs.get(id).own[f] != null));
    const someOwn = ids.filter((id) => !followAll.includes(id));
    q("[data-folnote]").textContent = [followAll.length && `${names(followAll)}跟通用走，改这里会一起变`, someOwn.length && `${names(someOwn)}有单独写的，那部分不会变`].filter(Boolean).join("；");
    // 通用字段下面：标题不能空；超过某个跟通用的平台的限制时，说是哪个平台、限多少、现在多少，并给「给<平台>单独写一个」。
    for (const [f] of FIELDS) {
      const box = q(`[data-cerr="${f}"]`);
      const mine = errs.filter((e) => e.vid === ed.vid && ((e.kind === "empty" && f === "title") || (e.kind === "generic" && e.field === f)));
      box.innerHTML = mine.map((e) => e.kind === "empty"
        ? '<div class="err">通用标题不能是空的。</div>'
        : `<div class="err">${esc(e.text)}<button class="link" type="button" data-ed="own" data-arg="${esc(e.id)}:${f}">给${esc(pfName(ed.pubs.get(e.id).p.platform))}单独写一个</button></div>`).join("");
    }
    for (const id of ids) {
      const d = ed.pubs.get(id);
      const mine = errs.filter((e) => e.id === id);
      const sm = q(`[data-sum="${CSS.escape(id)}"]`);
      sm.textContent = sumOf(d);
      sm.classList.toggle("own", FIELDS.some(([f]) => d.own[f] != null));
      const ts = q(`[data-tsum="${CSS.escape(id)}"]`);
      ts.textContent = mine.length ? "有要处理的" : d.at == null ? "还没定时间" : when(d.at).text;
      ts.classList.toggle("bad", mine.length > 0);
      ts.classList.toggle("unset", !mine.length && d.at == null);
      if (!ed.open.has(id)) continue;
      for (const [f] of FIELDS) {
        const own = d.own[f] != null;
        const fs = q(`[data-fs="${CSS.escape(id)}:${f}"]`);
        fs.textContent = own ? "单独写的" : "跟通用";
        fs.classList.toggle("own", own);
        q(`[data-ed="follow"][data-arg="${CSS.escape(id)}:${f}"]`).hidden = !own;
        const inp = q(`[data-edf="p"][data-id="${CSS.escape(id)}"][data-f="${f}"]`);
        inp.classList.toggle("fol", !own);
        if (!own && document.activeElement !== inp) inp.value = val(ed, id, f);
        q(`[data-perr="${CSS.escape(id)}:${f}"]`).innerHTML = mine.filter((e) => (e.kind === "own" && e.field === f)).map((e) => `<div class="err">${esc(e.text)}</div>`).join("");
      }
      const rel = q(`[data-trel="${CSS.escape(id)}"]`);
      if (rel) rel.textContent = d.at != null ? when(d.at).text : "";
      q(`[data-terr="${CSS.escape(id)}"]`).innerHTML = mine.filter((e) => e.kind === "time" || e.kind === "srv").map((e) => e.kind === "time"
        ? `<div class="err">${esc(e.text)}${e.use != null ? `<button class="link" type="button" data-ed="use" data-arg="${esc(id)}">用这个时间</button>` : ""}</div>`
        : `<div class="err">${esc(e.text)}</div>`).join("");
    }
    for (const b of root.querySelectorAll('[data-ed="lang"]')) {
      const k = errs.filter((e) => e.vid === b.dataset.arg).length;
      const v = verOf(ed, b.dataset.arg);
      b.textContent = v.language + (k ? ` · ${k} 处要处理` : "");
    }
    const n = dirtyCount(ed);
    const conf = [...ed.pubs.values()].some((d) => d.p.state === "queued");
    const foot = q("[data-efoot]");
    foot.innerHTML = ed.ask
      ? `<span class="ask">放弃这 ${n} 处改动？</span><button class="btn" type="button" data-ed="keep">接着改</button><button class="btn" type="button" data-ed="drop">放弃改动</button>`
      : `<span class="hint">${errs.length ? `<span class="err">还有 ${errs.length} 处要先处理。<button class="link" type="button" data-ed="goerr">带我去</button></span>` : n ? `改了 ${n} 处。${conf ? "已确认的仍按原来的时间发。" : "保存后还要你确认才会发。"}` : "还没有改动。"}</span>` +
        `<button class="link" type="button" data-ed="cancel">取消</button><button class="btn pri lg" type="button" data-ed="save" ${!n || errs.length || ed.busy ? "disabled" : ""}>${ed.busy ? "正在保存…" : "保存改动"}</button>`;
  }

  /** 要退出编辑：没改过直接退；改过了在底栏就地问（接着改 / 放弃改动）。 */
  function cancelEdit() {
    const ed = state.ed;
    if (!ed || ed.busy) return;
    if (dirtyCount(ed)) { ed.ask = true; sync(); root()?.querySelector("[data-efoot]")?.scrollIntoView({ block: "nearest" }); }
    else { state.ed = null; ctx?.render(); }
  }
  const root = () => document.querySelector("[data-ed-root]");

  /** 改到一半要去别处（点别的成片）：先问，不静默丢。返回 true 表示已拦下。 */
  function guard() {
    const ed = state.ed;
    if (!ed || !dirtyCount(ed)) { state.ed = null; return false; }
    ed.ask = true;
    ctx?.render();
    root()?.querySelector("[data-efoot]")?.scrollIntoView({ block: "nearest" });
    return true;
  }

  /** 把这次的改动整理成 cut.edit 的参数：只传动过的字段；通用文案按语言版本分开（后端一次改一个语言版本）。 */
  function payloadOf(ed) {
    const platforms = {};
    for (const [id, d] of ed.pubs) {
      const spec = {};
      for (const [f] of FIELDS) {
        const was = d.ownWas.has(f);
        const own = d.own[f] != null;
        const orig = f === "tags" ? tagStr(d.p.tags) : d.p[f] ?? "";
        if (own && (!was || !sameField(f, d.own[f], orig))) spec[f] = f === "tags" ? tagList(d.own[f]) : d.own[f];
        else if (!own && was) spec[f] = null;
      }
      if (d.at !== (d.p.scheduledAt ?? null) && d.at != null) spec.at = d.at;
      if (Object.keys(spec).length) platforms[id] = spec;
    }
    const generics = [];
    for (const [vid, c] of Object.entries(ed.common)) {
      const g = {};
      for (const [f] of FIELDS) if (!sameField(f, c[f], ed.base[vid][f])) g[f] = f === "tags" ? tagList(c[f]) : c[f];
      if (Object.keys(g).length) generics.push({ vid, language: langOf(ed, vid), generic: g });
    }
    return { platforms, generics };
  }

  async function saveEdit() {
    const ed = state.ed;
    if (!ed || ed.busy || errorsOf(ed).length || !dirtyCount(ed)) return;
    const n = dirtyCount(ed);
    const { platforms, generics } = payloadOf(ed);
    ed.busy = true; ed.srv.clear(); sync();
    let rev = ed.rev;
    let saved = 0;
    try {
      // 第一次带平台稿的改动和第一个语言版本的通用文案；还有别的语言版本的通用文案就接着按新的 rev 再提交。
      const first = generics[0] ?? null;
      let res = await VK.editCut(ed.cutId, { rev, language: first?.language ?? null, generic: first?.generic ?? null, platforms });
      saved++; rev = res.rev;
      for (const g of generics.slice(1)) {
        res = await VK.editCut(ed.cutId, { rev, language: g.language, generic: g.generic });
        saved++; rev = res.rev;
      }
      const kept = generics.length
        ? [...ed.pubs.values()].filter((d) => generics.some((g) => g.vid === d.p.versionId) && (d.ownWas.size || FIELDS.some(([f]) => d.own[f] != null))).map((d) => pfName(d.p.platform))
        : [];
      state.ed = null;
      window.VKShell?.toast(kept.length ? `改好了。${[...new Set(kept)].join("、")}有单独写的，那部分没变` : `改好了 ${n} 处`);
      await ctx?.reload();
    } catch (err) {
      ed.busy = false;
      if (saved) {
        // 前面已经存上的不回滚：重新读一遍，让页面显示真实状态，并把没存上的原因说清楚。
        state.ed = null;
        window.VKShell?.toast(`只存上了一部分：${err.message}`);
        try { await ctx?.reload(); } catch { /* 页面上已有提示 */ }
        return;
      }
      if (err.code === "E_REV_CONFLICT") ed.note = { text: err.message, reopen: true };
      else if ((err.code === "E_TIME_PAST" || err.code === "plan_daily_cap" || err.code === "plan_min_gap") && err.publishId && ed.pubs.has(err.publishId)) {
        ed.timeErr.set(err.publishId, { text: err.message, use: err.suggestedAt ?? null });
        ed.open.add(err.publishId);
        ed.vid = ed.pubs.get(err.publishId).p.versionId;
      } else if (Array.isArray(err.problems) && err.problems.length) {
        for (const pr of err.problems) {
          if (!ed.pubs.has(pr.publishId)) continue;
          ed.srv.set(pr.publishId, [...(ed.srv.get(pr.publishId) ?? []), pr.message]);
          ed.open.add(pr.publishId);
        }
        ed.vid = ed.pubs.get(err.problems[0].publishId)?.p.versionId ?? ed.vid;
      } else window.VKShell?.toast(err.message || "没保存成功");
      ctx?.render();
    }
  }

  function editClick(el) {
    const ed = state.ed;
    const d = el.dataset;
    const redraw = () => ctx?.render();
    if (d.ed === "start") {
      const cur = ctx?.current();
      if (!cur?.cut) return;
      if (state.ed && dirtyCount(state.ed) && state.ed.cutId !== cur.cut.id) return void guard();
      startEdit(cur.work, cur.cut, d.arg || null);
      redraw();
      document.querySelector(d.arg ? `[data-ed="open"][data-arg="${CSS.escape(d.arg)}"]` : '[data-edf="c"][data-f="title"]')?.focus();
      return;
    }
    if (d.ed === "mode") {
      const cur = ctx?.current();
      if (cur?.cut) { state.mode.set(cur.cut.id, d.arg === "now" ? "now" : "at"); redraw(); }
      return;
    }
    if (d.ed === "confirm") {
      const cur = ctx?.current();
      if (!cur?.cut) return;
      const mode = state.mode.get(cur.cut.id) === "now" ? "now" : "scheduled";
      ctx.act(async () => {
        const res = await VK.approveCut(cur.cut.id, mode);
        const held = res.held ?? [];
        if (held.length) window.VKShell?.toast(held.map((h) => `${pfName(h.platform)} 现在发不了：${h.reason}`).join("；"));
        else if (mode === "now") window.VKShell?.toast("已确认，现在开始发");
        else window.VKShell?.toast("已确认，会按时间发");
      }, null, { advance: true });
      return;
    }
    if (!ed) return;
    switch (d.ed) {
      case "lang": ed.vid = d.arg; break;
      case "open": ed.open.has(d.arg) ? ed.open.delete(d.arg) : ed.open.add(d.arg); break;
      case "follow": { const [id, f] = d.arg.split(":"); delete ed.pubs.get(id).own[f]; ed.srv.delete(id); break; }
      case "own": {
        const [id, f] = d.arg.split(":");
        ed.pubs.get(id).own[f] = ed.common[ed.pubs.get(id).p.versionId][f];
        ed.open.add(id);
        redraw();
        document.querySelector(`[data-edf="p"][data-id="${CSS.escape(id)}"][data-f="${f}"]`)?.focus();
        sync();
        return;
      }
      case "use": { const e = ed.timeErr.get(d.arg); if (e?.use != null) { const x = ed.pubs.get(d.arg); x.at = e.use; x.atText = VK.toLocalStamp(e.use); ed.timeErr.delete(d.arg); } break; }
      case "goerr": {
        const e = errorsOf(ed)[0];
        if (!e) return;
        ed.vid = e.vid;
        if (e.id) ed.open.add(e.id);
        redraw();
        const target = e.kind === "empty" || e.kind === "generic" ? document.querySelector(`[data-edf="c"][data-f="${e.field ?? "title"}"]`) : document.querySelector(`[data-ed="open"][data-arg="${CSS.escape(e.id)}"]`);
        target?.scrollIntoView({ block: "center" });
        target?.focus();
        return;
      }
      case "cancel": return void cancelEdit();
      case "keep": ed.ask = false; break;
      case "drop": state.ed = null; window.VKShell?.toast("没有保存，内容没变"); break;
      case "save": return void saveEdit();
      case "reopen": state.ed = null; return void ctx?.reload();
      default: return;
    }
    redraw();
  }

  function bindEdit() {
    document.addEventListener("click", (e) => {
      const el = e.target.closest?.("[data-ed]");
      if (el) editClick(el);
    });
    document.addEventListener("input", (e) => {
      const ed = state.ed;
      const t = e.target;
      const kind = t?.dataset?.edf;
      if (!ed || !kind) return;
      if (kind === "c") ed.common[ed.vid][t.dataset.f] = t.value;
      else if (kind === "p") { ed.pubs.get(t.dataset.id).own[t.dataset.f] = t.value; ed.srv.delete(t.dataset.id); }
      else if (kind === "at") {
        const x = ed.pubs.get(t.dataset.id);
        const ms = t.value ? VK.fromLocalStamp(t.value) : null;
        x.atText = t.value;
        x.at = Number.isFinite(ms) ? ms : null;
        ed.timeErr.delete(t.dataset.id);
      }
      ed.ask = false;
      sync();
    });
    // Esc 等于取消，焦点在哪都有效。
    document.addEventListener("keydown", (e) => {
      if (state.ed && e.key === "Escape" && root()) { e.preventDefault(); cancelEdit(); }
    });
    // 关页面或跳走前浏览器拦一下。
    window.addEventListener("beforeunload", (e) => {
      if (state.ed && dirtyCount(state.ed)) { e.preventDefault(); e.returnValue = ""; }
    });
    // 页面重画后把底栏和各处提示补上（重画只出骨架）。
    new MutationObserver(() => { if (state.ed && root() && !root().dataset.synced) { root().dataset.synced = "1"; sync(); } }).observe(document.documentElement, { childList: true, subtree: true });
  }
  state.mode = state.mode ?? new Map();
  state.ed = state.ed ?? null;
  bindEdit();

  function confirmPanel(work, cut) {
    if (!cut) return "";
    if (edOf(cut.id)) return editHtml(work, cut);
    const versions = cut.versions ?? [];
    const showVers = versions.length > 1;
    const solo = soloOf(cut).sort((a, b) => orderOf(a.platform) - orderOf(b.platform));
    const rest = cut.publishes.filter((p) => !solo.includes(p)).sort((a, b) => orderOf(a.platform) - orderOf(b.platform));
    const batch = batchOf(cut);
    const one = work.cuts.length === 1;
    const allSkipped = rest.filter((p) => p.state === "skipped").length > 0 && pending(cut).length === 0;
    const confirmed = cut.publishes.filter((p) => p.state === "queued").length;
    const confirmedAt = cut.publishes.filter((p) => p.state === "queued" && !sendingNow(p)).length;
    const anyOpen = pending(cut).length > 0;
    // 现在发还是预约发：只在这里整批选（ACC-v3-time-08），所以不存在一批里有的现在发、有的按时间发。
    const mode = state.mode.get(cut.id) === "now" ? "now" : "at";
    const editable = editableOf(cut);

    const rows = rest.map((p) => {
      const isPub = ["published", "published_limited"].includes(p.state);
      const w = when(isPub && p.publishedAt != null ? p.publishedAt : p.scheduledAt);
      const name = pfName(p.platform);
      const bad = ["failed", "blocked", "expired"].includes(p.state);
      const late = p.shifted && p.state === "pending_confirm" ? `<span class="sub"> · 原定${esc(when(p.originalAt).text)}，已顺延</span>` : "";
      const tm = sendingNow(p) ? "现在发" : w.text;
      return `<div class="prow ${p.state === "skipped" ? "off" : ""} ${bad ? "bad" : ""}">${pfBadge(p.platform, bad ? "err" : ["published", "published_limited"].includes(p.state) ? "" : "off")}` +
        `<span class="nm">${esc(name)}</span>` +
        `<button class="ti tog" type="button" data-more="${esc(p.id)}" aria-expanded="${isOpen(p.id)}" title="${esc(p.title)}">${esc(p.title)}${late}</button>` +
        `<span class="tm${!sendingNow(p) && p.scheduledAt == null && !isPub ? " unset" : ""}">${esc(tm)}</span>${rowState(p)}${isOpen(p.id) ? detHtml(p) : ""}</div>`;
    }).join("");

    const soloBlocks = solo.map((p) => {
      if (p.platform === "tiktok-api") return tkHtml(p, work.id);
      const w = when(p.scheduledAt);
      const acts = p.state === "pending_confirm"
        ? `<div class="acts"><button class="btn" type="button" data-solo="approve" data-pub="${esc(p.id)}">${p.scheduledAt == null ? "按建议时间发" : esc(w.text) + " 发"}</button>` +
          `<button class="btn" type="button" data-solo="now" data-pub="${esc(p.id)}">现在发</button>` +
          `<button class="btn" type="button" data-solo="manual" data-pub="${esc(p.id)}">我自己发</button></div>`
        : `<div class="acts"><span class="st ${p.state === "skipped" ? "" : "done"}">${
            { queued: sendingNow(p) ? "已确认，正在发" : `已确认，${w.text} 发`, notify_pending: "你自己发，发完告诉我", skipped: "先不发" }[p.state] ?? "已处理"
          }</span></div>`;
      const editBtn = isEditable(p)
        ? `<button class="link" type="button" style="margin-left:auto" data-ed="start" data-arg="${esc(p.id)}" aria-label="改小红书的内容或时间">改</button>` : "";
      const late = p.shifted && p.state === "pending_confirm" ? ` · 原定${esc(when(p.originalAt).text)}，已顺延` : "";
      const head = `<div class="ti">${esc(p.title)}</div><div class="sub${p.scheduledAt == null ? " unset" : ""}">${p.scheduledAt == null ? "还没定时间" : esc(w.text) + " 发"}${late}</div>` +
        `<button class="tog" type="button" data-more="${esc(p.id)}" aria-expanded="${isOpen(p.id)}">${isOpen(p.id) ? "收起正文和话题" : "看正文和话题"}</button>${isOpen(p.id) ? detHtml(p) : ""}`;
      return `<div class="solo"><div class="sh">${pfBadge("xiaohongshu")}小红书 · 每条都要你单独确认${editBtn}</div>${head}${acts}</div>`;
    }).join("");

    const foot = batch.length
      ? `<div class="cfoot"><span class="hint">${mode === "now" ? "确认后马上开始发。" : "确认之后才会排进发布；没确认的到时间也不会发。"}</span>` +
        `<button class="link" type="button" data-skip="${esc(cut.id)}">${one ? "先不发" : "这支先不发"}</button>` +
        `<span class="seg" role="group" aria-label="什么时候发"><button type="button" data-ed="mode" data-arg="at" aria-pressed="${mode === "at"}">预约发</button>` +
        `<button type="button" data-ed="mode" data-arg="now" aria-pressed="${mode === "now"}">现在发</button></span>` +
        `<button class="btn pri lg" type="button" data-ed="confirm">确认这 ${batch.length} 条，${mode === "now" ? "现在发" : "按时间发"}</button></div>`
      : allSkipped
        ? `<div class="cfoot"><div class="done-note">这支先不发。以后可以在作品里再确认。</div></div>`
        : confirmed
          ? `<div class="cfoot"><div class="done-note">${one ? "" : esc(cut.title) + "的 "}${confirmed} 条已确认，${confirmedAt ? "会按时间发" : "正在发"}。</div></div>`
          : "";

    return `<section class="cp" aria-label="${esc(cut.title)}">` +
      `<div class="cph"><h3>${esc(cut.title)}</h3><span class="sub" data-dur></span>` +
      `<span class="vers">${showVers ? versions.map((v) => `<button class="btn" type="button" data-ver="${esc(cut.id)}:${esc(v.id)}" aria-pressed="${(state.ver.get(cut.id) ?? versions[0].id) === v.id}">${esc(v.language)}</button>`).join("") : ""}` +
      `${editable.length ? '<button class="btn edit" type="button" data-ed="start" data-arg="">改内容</button>' : ""}</span></div>` +
      mediaBox(cut) +
      `<div class="ai">${anyOpen ? "AI 生成的内容，每个平台都会按它的要求标注。标题、正文、话题和时间是建议，想改再改。" : "AI 生成的内容，每个平台都按它的要求标注了。"}</div>` +
      `<div class="rows">${rows}</div>${soloBlocks}${foot}</section>`;
  }

  // ── TikTok 官方接口：发布设置面板（审核演示，#173）─────────────────────────────
  // 和提交给 TikTok 审核的说明逐句一致：隐私级别来自 creator_info、不预选、没选不能发；
  // 评论 / 合拍 / 拼接默认全关，creator_info 不允许的置灰；文案可改；AI 生成标记可见；
  // 两个按钮 Post / Send to TikTok drafts；发完显示进度与结果；不加水印。
  // 设置存在这条平台稿上（publish.edit），页面刷新也不丢；这里的 store 只存还没提交的草稿输入。
  const TK = (window.__vkTk = window.__vkTk || { pubs: new Map(), accounts: null, creators: new Map(), bound: false });
  const PRIVACY_LABEL = {
    SELF_ONLY: "仅自己可见", PUBLIC_TO_EVERYONE: "所有人可见",
    MUTUAL_FOLLOW_FRIENDS: "互相关注的朋友", FOLLOWER_OF_CREATOR: "我的粉丝",
  };
  const TK_RUNNING = new Set(["queued", "auto_running", "draft_running"]);
  const TK_DONE = new Set(["published", "published_limited", "draft_pending", "failed", "blocked", "expired", "notify_pending", "skipped"]);
  const tkOf = (id) => {
    if (!TK.pubs.has(id)) TK.pubs.set(id, { privacy: "", comment: false, duet: false, stitch: false, caption: null, busy: false, live: null, error: null, msg: "", workId: null, polling: false });
    return TK.pubs.get(id);
  };

  async function tkAccountOf(p) {
    if (!TK.accounts) TK.accounts = (await VK.request("/api/accounts")).accounts ?? [];
    return TK.accounts.find((a) => a.platform === "tiktok-api" && a.handle === p.handle) ?? null;
  }

  function tkStatus(p, t) {
    const state = t.live?.state ?? p.state;
    const err = t.live?.error ?? p.error;
    if (state === "published" || state === "published_limited") {
      const url = t.live?.url ?? p.url;
      return ["done", "已发布到 TikTok。", url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">打开这条视频</a>` : ""];
    }
    if (state === "draft_pending") return ["done", "已送到 TikTok 草稿箱。", "打开 TikTok App → 收件箱，在 App 里编辑并发布；这还不算已发布。"];
    if (state === "queued") return ["run", "已确认，排队中，马上开始上传…", ""];
    if (state === "auto_running") return ["run", "正在上传视频，TikTok 处理完就会发布…", ""];
    if (state === "draft_running") return ["run", "正在把视频送到 TikTok 草稿箱…", ""];
    if (["failed", "blocked", "expired"].includes(state)) return ["bad", "没发出去。", esc(err?.message ?? "原因还没记下来；在「任务与日志」里能看到经过")];
    if (state === "notify_pending") return ["bad", "需要你处理，没有自动发。", esc(err?.message ?? "")];
    if (state === "skipped") return ["", "先不发。", ""];
    return null;
  }

  function tkHtml(p, workId) {
    const t = tkOf(p.id);
    t.workId = workId;
    if (t.caption == null) t.caption = p.title ?? "";
    const status = tkStatus(p, t);
    const head = `<div class="sh">${pfBadge("tiktok")}TikTok · @${esc(String(p.handle ?? "").replace(/^@/, ""))}</div>`;
    if (status) {
      const [cls, line, more] = status;
      return `<div class="solo tkset ${cls}" data-tk="${esc(p.id)}" data-handle="${esc(p.handle)}">${head}` +
        `<div class="tk-res ${cls}" role="status" aria-live="polite"><b>${line}</b>${more ? `<div class="tk-more">${more}</div>` : ""}` +
        `${cls === "run" ? '<div class="tk-bar" aria-hidden="true"><i></i></div>' : ""}</div></div>`;
    }
    const c = TK.creators.get(p.id) ?? null;
    return `<div class="solo tkset" data-tk="${esc(p.id)}" data-handle="${esc(p.handle)}">${head}` +
      `<div class="tk-note">发之前由你来选：隐私级别、谁能互动、文案。没选隐私级别不能 Post。</div>` +
      `<div class="tk-grid" data-tk-form>${tkForm(p, t, c)}</div>` +
      `<div class="tk-ai"><b>AI 生成</b><span>这支视频是 AI 生成的，发布时会带 TikTok 的 AI 生成标记（is_aigc）。</span></div>` +
      `<div class="tk-wm">不加水印。</div>` +
      `<div class="acts"><button class="btn" type="button" data-tk-post="${esc(p.id)}">Post</button>` +
      `<button class="btn" type="button" data-tk-draft="${esc(p.id)}">Send to TikTok drafts</button>` +
      `<span class="tk-why" data-tk-why></span></div>` +
      `<div class="tk-res" data-tk-msg role="status" aria-live="polite">${esc(t.msg)}</div></div>`;
  }

  /** 表单：选项与开关是否允许只来自 creator_info；还没拿到时显示读取中，按钮不可用。 */
  function tkForm(p, t, c) {
    if (!c) return `<div class="tk-load">正在向 TikTok 读取这个账号现在能选的设置…</div>`;
    if (c.error) return `<div class="tk-load bad">读不到 TikTok 的发布设置：${esc(c.error)}${/重新登录|授权|connect/i.test(c.error) ? ' <a class="link" href="/system.html">去系统页重新连接</a>' : ""}</div>`;
    const opts = (c.privacyLevelOptions ?? []).map((v) =>
      `<option value="${esc(v)}"${t.privacy === v ? " selected" : ""}>${esc(v)}${PRIVACY_LABEL[v] ? " · " + esc(PRIVACY_LABEL[v]) : ""}</option>`).join("");
    const tog = (key, label, off) =>
      `<label class="tk-tg${off ? " off" : ""}"><input type="checkbox" data-tk-tg="${key}"${t[key] && !off ? " checked" : ""}${off ? " disabled" : ""}>` +
      `<span>${label}${off ? '<em>TikTok 对这个账号不允许</em>' : ""}</span></label>`;
    return `<label class="tk-f"><span class="tk-l">隐私级别</span>` +
      `<select class="tk-sel" data-tk-privacy aria-label="隐私级别"><option value=""${t.privacy ? "" : " selected"}>请选择…</option>${opts}</select></label>` +
      `<fieldset class="tk-f"><legend class="tk-l">允许其他人</legend><div class="tk-tgs">` +
      tog("comment", "评论", c.commentDisabled) + tog("duet", "合拍（Duet）", c.duetDisabled) + tog("stitch", "拼接（Stitch）", c.stitchDisabled) +
      `</div></fieldset>` +
      `<label class="tk-f wide"><span class="tk-l">文案</span><textarea class="tk-ta" data-tk-caption rows="2" maxlength="2200" aria-label="文案">${esc(t.caption)}</textarea></label>` +
      (c.maxVideoPostDurationSec ? `<div class="tk-meta wide">这个账号一条最长 ${esc(c.maxVideoPostDurationSec)} 秒。</div>` : "");
  }

  function tkSync(box) {
    const id = box.dataset.tk;
    const t = tkOf(id);
    const post = box.querySelector("[data-tk-post]");
    const draft = box.querySelector("[data-tk-draft]");
    const why = box.querySelector("[data-tk-why]");
    if (!post) return;
    const c = TK.creators.get(id);
    const ready = Boolean(c && !c.error);
    post.disabled = t.busy || !ready || !t.privacy;
    draft.disabled = t.busy || !ready;
    if (why) why.textContent = t.busy ? "" : !ready ? "" : !t.privacy ? "先选隐私级别，没选不能 Post" : "";
  }

  async function tkLoadCreator(box) {
    const id = box.dataset.tk;
    if (TK.creators.has(id)) return;
    try {
      const acc = await tkAccountOf({ handle: box.dataset.handle });
      if (!acc) throw new Error("没找到这个 TikTok 账号，先在系统页 Connect TikTok");
      const c = await VK.request(`/api/accounts/${encodeURIComponent(acc.id)}/creator`);
      TK.creators.set(id, { ...c, accountId: acc.id });
    } catch (err) {
      TK.creators.set(id, { error: err.message || "没成功" });
    }
    // 等待期间页面可能已重画：按 id 重新找当前的盒子。
    const now = document.querySelector(`[data-tk="${CSS.escape(id)}"]`);
    const form = now?.querySelector("[data-tk-form]");
    if (form) form.innerHTML = tkForm({ id }, tkOf(id), TK.creators.get(id));
    if (now) tkSync(now);
  }

  async function tkPoll(id) {
    const t = tkOf(id);
    if (t.polling || !t.workId) return;
    t.polling = true;
    try {
      for (let i = 0; i < 200; i++) {
        const work = await VK.request(`/api/works/${encodeURIComponent(t.workId)}`);
        const row = (work.work ?? work).cuts?.flatMap((c) => c.publishes).find((x) => x.id === id);
        if (row) {
          t.live = { state: row.state, error: row.error, url: row.url };
          tkRedraw(id);
          if (TK_DONE.has(row.state)) return;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (err) {
      t.live = { state: "failed", error: { message: err.message || "读不到发布进度" } };
      tkRedraw(id);
    } finally {
      t.polling = false;
    }
  }

  function tkRedraw(id) {
    const box = document.querySelector(`[data-tk="${CSS.escape(id)}"]`);
    if (!box) return;
    const t = tkOf(id);
    const pub = { id, handle: box.dataset.handle, state: "pending_confirm", title: t.caption, error: null };
    const status = tkStatus(pub, t);
    if (!status) return;
    const [cls, line, more] = status;
    box.className = `solo tkset ${cls}`;
    box.querySelectorAll(":scope > :not(.sh)").forEach((n) => n.remove());
    box.insertAdjacentHTML("beforeend",
      `<div class="tk-res ${cls}" role="status" aria-live="polite"><b>${line}</b>${more ? `<div class="tk-more">${more}</div>` : ""}` +
      `${cls === "run" ? '<div class="tk-bar" aria-hidden="true"><i></i></div>' : ""}</div>`);
  }

  async function tkSubmit(id, { draft }) {
    const box = document.querySelector(`[data-tk="${CSS.escape(id)}"]`);
    const t = tkOf(id);
    if (!box || t.busy) return;
    const msg = box.querySelector("[data-tk-msg]");
    const say = (text) => { t.msg = text; if (msg) msg.textContent = text; };
    if (!draft && !t.privacy) { say("先选隐私级别，没选不能 Post。"); return; }
    t.busy = true; tkSync(box); say(draft ? "正在送到 TikTok 草稿箱…" : "正在提交…");
    try {
      const body = { publishId: id, comment: t.comment, duet: t.duet, stitch: t.stitch, caption: t.caption, draft };
      if (!draft) body.privacy = t.privacy;
      await VK.request(`/api/publishes/${encodeURIComponent(id)}/edit`, { method: "POST", body });
      await VK.request(`/api/publishes/${encodeURIComponent(id)}/now`, { method: "POST", body: { publishId: id } });
      t.live = { state: "queued", error: null, url: null };
      tkRedraw(id);
      tkPoll(id);
    } catch (err) {
      say(`没成功：${err.message}`);
    } finally {
      t.busy = false;
      const b = document.querySelector(`[data-tk="${CSS.escape(id)}"]`);
      if (b) tkSync(b);
    }
  }

  function tkHydrate(root) {
    for (const box of root.querySelectorAll?.("[data-tk]:not([data-tk-ready])") ?? []) {
      box.dataset.tkReady = "1";
      const t = tkOf(box.dataset.tk);
      if (box.querySelector("[data-tk-form]")) { tkLoadCreator(box); tkSync(box); }
      else if (t.live && TK_RUNNING.has(t.live.state)) tkPoll(box.dataset.tk);
    }
  }

  if (!TK.bound) {
    TK.bound = true;
    document.addEventListener("click", (e) => {
      const post = e.target.closest("[data-tk-post]");
      if (post) return void tkSubmit(post.dataset.tkPost, { draft: false });
      const draft = e.target.closest("[data-tk-draft]");
      if (draft) tkSubmit(draft.dataset.tkDraft, { draft: true });
    });
    document.addEventListener("change", (e) => {
      const box = e.target.closest?.("[data-tk]");
      if (!box) return;
      const t = tkOf(box.dataset.tk);
      if (e.target.matches("[data-tk-privacy]")) t.privacy = e.target.value;
      else if (e.target.matches("[data-tk-tg]")) t[e.target.dataset.tkTg] = e.target.checked;
      tkSync(box);
    });
    document.addEventListener("input", (e) => {
      if (e.target.matches?.("[data-tk-caption]")) tkOf(e.target.closest("[data-tk]").dataset.tk).caption = e.target.value;
    });
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) { if (n.matches?.("[data-tk]")) tkHydrate(n.parentNode); else tkHydrate(n); }
    }).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => tkHydrate(document));
  }

  function cutSteps(work, curId) {
    if (work.cuts.length < 2) return "";
    return `<div class="steps">${work.cuts.map((c) => {
      const n = pending(c).length;
      const conf = c.publishes.filter((p) => p.state === "queued").length;
      const bad = c.publishes.some((p) => ["failed", "blocked", "expired"].includes(p.state));
      const skipped = c.publishes.some((p) => p.state === "skipped") && !n;
      const [cls, txt] = bad ? ["bad", "有 1 条出了问题"] : n ? ["wait", n + " 条等你确认"] : skipped ? ["", "先不发"] : conf ? ["sched", "已确认，等时间"] : ["pub", "已发布"];
      return `<button class="step" type="button" data-cut="${esc(c.id)}" aria-current="${c.id === curId}">${cover((c.versions?.find((v) => v.cover) ?? c.versions?.[0])?.id, 44, 44)}<span><b>${esc(c.title)}</b><span class="st ${cls}">${txt}</span></span></button>`;
    }).join("")}</div>`;
  }

  return {
    bind: (c) => { ctx = c; }, guard, startEdit,
    esc, BLANK, cover, pfOf, ORDER, pfBadge, pfName, when, fmt, ratioText, ratioCls, WD,
    pending, batchOf, soloOf, cutHasPending, fallback, confirmPanel, cutSteps,
  };
};
