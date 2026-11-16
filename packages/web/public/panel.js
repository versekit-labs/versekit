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
  const PF = {
    xiaohongshu: ["小", "小红书", "xhs"], douyin: ["抖", "抖音", "dy"], shipinhao: ["视", "视频号", "sph"],
    bilibili: ["B", "B站", "bili"], tiktok: ["T", "TikTok", "tk"], youtube: ["Y", "YouTube", "yt"],
    web: ["官", "官网", "web"], gongzhonghao: ["公", "公众号", "mp"],
  };
  const pfOf = (key) => PF[key] ?? [String(key ?? "?").slice(0, 1), String(key ?? ""), "web"];
  const pfBadge = (key) => { const [ch, name, cls] = pfOf(key); return `<span class="pf ${cls}" title="${esc(name)}">${esc(ch)}</span>`; };
  const pfName = (key) => pfOf(key)[1];
  const PER_ITEM = new Set(["xiaohongshu"]);
  // 平台行的顺序与设计稿一致；不在表里的平台排在后面。
  const ORDER = ["xiaohongshu", "douyin", "shipinhao", "bilibili", "tiktok", "youtube", "web", "gongzhonghao"];
  const orderOf = (platform) => {
    const i = ORDER.indexOf(platform);
    return i === -1 ? ORDER.length : i;
  };

  const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const pad2 = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  /** 时间只说人话：今天 / 明天 / 昨天 / 11-17 周二，再带时分。 */
  function when(ms) {
    if (ms == null) return { day: "—", t: "", text: "没有建议时间" };
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

  function rowState(p) {
    if (p.state === "pending_confirm") return `<button class="link" type="button" data-edit="${esc(p.id)}" aria-label="改${esc(pfName(p.platform))}的标题或时间">改</button>`;
    if (p.state === "queued") return '<span class="st sched">已确认</span>';
    if (p.state === "auto_running" || p.state === "draft_running") return '<span class="st sched">发布中</span>';
    if (p.state === "notify_pending") return '<span class="st wait">待人工确认</span>';
    if (p.state === "draft_pending") return '<span class="st wait">待确认草稿</span>';
    if (p.state === "skipped") return '<span class="st">不发</span>';
    if (["failed", "blocked", "expired"].includes(p.state)) return '<span class="st bad">出了问题</span>';
    return '<span class="st pub">已发布</span>';
  }

  function confirmPanel(work, cut) {
    if (!cut) return "";
    const versions = cut.versions ?? [];
    const showVers = versions.length > 1;
    const solo = soloOf(cut).sort((a, b) => orderOf(a.platform) - orderOf(b.platform));
    const rest = cut.publishes.filter((p) => !solo.includes(p)).sort((a, b) => orderOf(a.platform) - orderOf(b.platform));
    const batch = batchOf(cut);
    const one = work.cuts.length === 1;
    const allSkipped = rest.filter((p) => p.state === "skipped").length > 0 && pending(cut).length === 0;
    const confirmed = cut.publishes.filter((p) => p.state === "queued").length;
    const anyOpen = pending(cut).length > 0;

    const rows = rest.map((p) => {
      const w = when(p.scheduledAt);
      const name = pfName(p.platform);
      const bad = ["failed", "blocked", "expired"].includes(p.state);
      if (state.editing.has(p.id)) {
        const local = p.scheduledAt == null ? "" : VK.toLocalStamp(p.scheduledAt);
        return `<div class="prow ed">${pfBadge(p.platform)}<span class="nm">${esc(name)}</span>` +
          `<input type="text" value="${esc(p.title)}" data-title="${esc(p.id)}" aria-label="${esc(name)} 标题">` +
          `<input type="datetime-local" value="${esc(local)}" data-at="${esc(p.id)}" aria-label="${esc(name)} 发布时间">` +
          `<button class="btn" type="button" data-save="${esc(p.id)}">好了</button></div>`;
      }
      return `<div class="prow ${p.state === "skipped" ? "off" : ""} ${bad ? "bad" : ""}">${pfBadge(p.platform)}` +
        `<span class="nm">${esc(name)}</span>` +
        `<span class="ti" title="${esc(p.title)}">${esc(p.title)}</span>` +
        `<span class="tm">${esc(w.text)}</span>${rowState(p)}</div>`;
    }).join("");

    const soloBlocks = solo.map((p) => {
      const w = when(p.scheduledAt);
      const acts = p.state === "pending_confirm"
        ? `<div class="acts"><button class="btn pri" type="button" data-solo="approve" data-pub="${esc(p.id)}">${esc(w.text)} 发</button>` +
          `<button class="btn" type="button" data-solo="now" data-pub="${esc(p.id)}">现在发</button>` +
          `<button class="btn" type="button" data-solo="manual" data-pub="${esc(p.id)}">我自己发</button></div>`
        : `<div class="acts"><span class="st ${p.state === "skipped" ? "" : "done"}">${
            { queued: `已确认，${w.text} 发`, notify_pending: "你自己发，发完告诉我", skipped: "先不发" }[p.state] ?? "已处理"
          }</span></div>`;
      return `<div class="solo"><div class="sh">${pfBadge("xiaohongshu")}小红书 · 每条都要你单独确认</div>` +
        `<div class="ti">${esc(p.title)}</div><div class="sub">${esc(w.text)} 发</div>${acts}</div>`;
    }).join("");

    const foot = batch.length
      ? `<div class="cfoot"><span class="hint">确认之后才会排进发布；没确认的到时间也不会发。</span>` +
        `<button class="link" type="button" data-skip="${esc(cut.id)}">${one ? "先不发" : "这支先不发"}</button>` +
        `<button class="btn pri lg" type="button" data-confirm="${esc(cut.id)}">确认这 ${batch.length} 条，按时间发</button></div>`
      : allSkipped
        ? `<div class="cfoot"><div class="done-note">这支先不发。以后可以在作品里再确认。</div></div>`
        : confirmed
          ? `<div class="cfoot"><div class="done-note">${one ? "" : esc(cut.title) + "的 "}${confirmed} 条已确认，会按时间发。</div></div>`
          : "";

    return `<section class="cp" aria-label="${esc(cut.title)}">` +
      `<div class="cph"><h3>${esc(cut.title)}</h3>` +
      `<span class="vers">${showVers ? versions.map((v) => `<button class="btn" type="button" data-ver="${esc(cut.id)}:${esc(v.id)}" aria-pressed="${(state.ver.get(cut.id) ?? versions[0].id) === v.id}">${esc(v.language)}</button>`).join("") : ""}</span></div>` +
      mediaBox(cut) +
      `<div class="ai">${anyOpen ? "AI 生成的内容，每个平台都会按它的要求标注。标题和时间是建议，想改再改。" : "AI 生成的内容，每个平台都按它的要求标注了。"}</div>` +
      `<div class="rows">${rows}</div>${soloBlocks}${foot}</section>`;
  }

  function cutSteps(work, curId) {
    if (work.cuts.length < 2) return "";
    return `<div class="steps">${work.cuts.map((c) => {
      const n = pending(c).length;
      const conf = c.publishes.filter((p) => p.state === "queued").length;
      const bad = c.publishes.some((p) => ["failed", "blocked", "expired"].includes(p.state));
      const skipped = c.publishes.some((p) => p.state === "skipped") && !n;
      const [cls, txt] = bad ? ["bad", "有 1 条出了问题"] : n ? ["wait", n + " 条等你确认"] : skipped ? ["", "先不发"] : conf ? ["sched", "已确认，等时间"] : ["pub", "已发布"];
      return `<button class="step" type="button" data-cut="${esc(c.id)}" aria-current="${c.id === curId}"><img src="${BLANK}" alt=""><span><b>${esc(c.title)}</b><span class="st ${cls}">${txt}</span></span></button>`;
    }).join("")}</div>`;
  }

  return {
    esc, BLANK, pfOf, ORDER, pfBadge, pfName, when, fmt, ratioText, ratioCls, WD,
    pending, batchOf, soloOf, cutHasPending, fallback, confirmPanel, cutSteps,
  };
};
