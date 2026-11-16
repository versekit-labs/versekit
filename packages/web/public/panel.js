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
    bilibili: ["B", "B站", "bili"], tiktok: ["T", "TikTok", "tk"], "tiktok-api": ["T", "TikTok", "tk"], youtube: ["Y", "YouTube", "yt"],
    web: ["官", "官网", "web"], gongzhonghao: ["公", "公众号", "mp"],
  };
  const pfOf = (key) => PF[key] ?? [String(key ?? "?").slice(0, 1), String(key ?? ""), "web"];
  const pfBadge = (key) => { const [ch, name, cls] = pfOf(key); return `<span class="pf ${cls}" title="${esc(name)}">${esc(ch)}</span>`; };
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


  // 正文与话题：展开看；为空就明说「没有正文」「没有话题」，不阻止确认（ACC-v2-copy-04）。
  // 状态词与 docs/design/app.js 的 detHtml / editFields 逐句一致。
  const detHtml = (p) =>
    `<div class="pdet"><div class="dl"><span class="k">正文</span><div class="bd">${p.body ? esc(p.body) : '<span class="none">没有正文</span>'}</div></div>` +
    `<div class="dl"><span class="k">话题</span>${(p.tags ?? []).length
      ? `<div class="tags">${p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>`
      : '<div class="bd"><span class="none">没有话题</span></div>'}</div></div>`;
  const editFields = (p, name) =>
    `<div class="ef"><label class="lab" for="b-${esc(p.id)}">正文</label>` +
    `<textarea id="b-${esc(p.id)}" data-body="${esc(p.id)}" aria-label="${esc(name)} 正文">${esc(p.body ?? "")}</textarea>` +
    `<label class="lab" for="t-${esc(p.id)}">话题（用逗号或空格分开）</label>` +
    `<input type="text" id="t-${esc(p.id)}" value="${esc((p.tags ?? []).map((t) => "#" + t).join(" "))}" data-tags="${esc(p.id)}" aria-label="${esc(name)} 话题"></div>`;
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

  function rowState(p) {
    if (p.state === "pending_confirm") return `<button class="link" type="button" data-edit="${esc(p.id)}" aria-label="改${esc(pfName(p.platform))}的标题、正文、话题或时间">改</button>`;
    if (p.state === "queued") return '<span class="st sched">已确认</span>';
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
          `<button class="btn" type="button" data-save="${esc(p.id)}">好了</button>${editFields(p, name)}</div>`;
      }
      return `<div class="prow ${p.state === "skipped" ? "off" : ""} ${bad ? "bad" : ""}">${pfBadge(p.platform)}` +
        `<span class="nm">${esc(name)}</span>` +
        `<button class="ti tog" type="button" data-more="${esc(p.id)}" aria-expanded="${isOpen(p.id)}" title="${esc(p.title)}">${esc(p.title)}</button>` +
        `<span class="tm">${esc(w.text)}</span>${rowState(p)}${isOpen(p.id) ? detHtml(p) : ""}</div>`;
    }).join("");

    const soloBlocks = solo.map((p) => {
      if (p.platform === "tiktok-api") return tkHtml(p, work.id);
      const w = when(p.scheduledAt);
      const acts = p.state === "pending_confirm"
        ? `<div class="acts"><button class="btn pri" type="button" data-solo="approve" data-pub="${esc(p.id)}">${esc(w.text)} 发</button>` +
          `<button class="btn" type="button" data-solo="now" data-pub="${esc(p.id)}">现在发</button>` +
          `<button class="btn" type="button" data-solo="manual" data-pub="${esc(p.id)}">我自己发</button></div>`
        : `<div class="acts"><span class="st ${p.state === "skipped" ? "" : "done"}">${
            { queued: `已确认，${w.text} 发`, notify_pending: "你自己发，发完告诉我", skipped: "先不发" }[p.state] ?? "已处理"
          }</span></div>`;
      const ed = state.editing.has(p.id);
      const editBtn = p.state === "pending_confirm" && !ed
        ? `<button class="link" type="button" style="margin-left:auto" data-edit="${esc(p.id)}" aria-label="改小红书的标题、正文、话题或时间">改</button>` : "";
      const head = ed
        ? `<div class="ef"><label class="lab" for="st-${esc(p.id)}">标题</label>` +
          `<input type="text" id="st-${esc(p.id)}" value="${esc(p.title)}" data-title="${esc(p.id)}" aria-label="小红书 标题">` +
          `<label class="lab" for="sa-${esc(p.id)}">发布时间</label>` +
          `<input type="datetime-local" id="sa-${esc(p.id)}" value="${esc(p.scheduledAt == null ? "" : VK.toLocalStamp(p.scheduledAt))}" data-at="${esc(p.id)}" aria-label="小红书 发布时间"></div>` +
          `${editFields(p, "小红书")}<div class="acts"><button class="btn" type="button" data-save="${esc(p.id)}">好了</button></div>`
        : `<div class="ti">${esc(p.title)}</div><div class="sub">${esc(w.text)} 发</div>` +
          `<button class="tog" type="button" data-more="${esc(p.id)}" aria-expanded="${isOpen(p.id)}">${isOpen(p.id) ? "收起正文和话题" : "看正文和话题"}</button>${isOpen(p.id) ? detHtml(p) : ""}`;
      return `<div class="solo"><div class="sh">${pfBadge("xiaohongshu")}小红书 · 每条都要你单独确认${editBtn}</div>${head}${ed ? "" : acts}</div>`;
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
      `<div class="acts"><button class="btn pri" type="button" data-tk-post="${esc(p.id)}">Post</button>` +
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
      return `<button class="step" type="button" data-cut="${esc(c.id)}" aria-current="${c.id === curId}"><img src="${BLANK}" alt=""><span><b>${esc(c.title)}</b><span class="st ${cls}">${txt}</span></span></button>`;
    }).join("")}</div>`;
  }

  return {
    esc, BLANK, pfOf, ORDER, pfBadge, pfName, when, fmt, ratioText, ratioCls, WD,
    pending, batchOf, soloOf, cutHasPending, fallback, confirmPanel, cutSteps,
  };
};
