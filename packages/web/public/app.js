// versekit 本地控制台。零框架、零构建：浏览器的模块直接读 /api。
// 原则：所有动态文本都过 esc()；所有写操作都走同一组命令（与 CLI、卡片一致）。

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "—");
const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("zh-CN") : "—");

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${bad ? " bad" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 3200);
}

async function upload(file) {
  const name = encodeURIComponent(file.name);
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "x-vk-filename": name, "content-type": "application/octet-stream" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error?.message ?? "上传失败");
  return data;
}

const STATE_CLASS = (s) =>
  ({
    published: "published",
    published_limited: "published_limited",
    failed: "failed",
    blocked: "blocked",
    notify_pending: "notify_pending",
    draft_pending: "draft_pending",
  })[s] ?? "";

const METRIC_LABEL = { play: "播放", like: "点赞", fav: "收藏", comment: "评论", share: "分享", coin: "投币" };

// ---------------------------------------------------------------- 账号

async function viewAccounts() {
  const [{ accounts }, { platforms }, now, chStatus] = await Promise.all([
    api("/api/accounts"),
    api("/api/platforms"),
    api("/api/now"),
    api("/api/channels/feishu/status"),
  ]);
  const channel = now.channel;
  const usable = platforms.filter((p) => p.publish !== "none");

  const cards = accounts
    .map(
      (a) => `
      <div class="card" data-account="${esc(a.id)}">
        <div class="row" style="align-items:center">
          <h3 style="flex:1">${esc(a.platform)} <span class="meta">${esc(a.handle)}</span></h3>
          <span class="chip"><i class="dot ${a.state === "ok" ? "ok" : a.state === "expiring" ? "warn" : "bad"}"></i>${esc(a.state)}${a.is_manual ? " · 手动" : ""}</span>
        </div>
        <p class="meta">${a.last_checked_at ? `最近体检 ${fmtTime(a.last_checked_at)}` : "还没体检过"} · ${a.credential_ref ? "已有凭证文件" : "无凭证文件"}</p>
        <div class="row" style="margin-top:10px">
          <button class="small" data-check="${esc(a.id)}">验证登录</button>
          <button class="small" data-act="mode" data-id="${esc(a.id)}" data-mode="${a.is_manual ? "auto" : "manual"}">${a.is_manual ? "改为自动发布" : "改为手动"}</button>
          ${a.platform === "xiaohongshu" ? `<button class="small primary" data-qr="${esc(a.id)}">扫码登录</button><button class="small ghost" data-sms="${esc(a.id)}">手机号登录</button>` : ""}
          <button class="small ghost" data-act="reauth" data-id="${esc(a.id)}">登录 / 重新授权</button>
        </div>
        <div data-login-box="${esc(a.id)}"></div>
        <p class="meta" data-note="${esc(a.id)}"></p>
      </div>`,
    )
    .join("");

  $("#view").innerHTML = `
    <h1>账号墙</h1>
    <p class="hint">一个账号一份 Chrome profile，互不串号。状态由每 6 小时的体检和发布/采集失败共同驱动。</p>
    ${accounts.length ? `<div class="grid cols-2">${cards}</div>` : `<div class="empty">还没有账号。先在下面添加一个。</div>`}

    <h2>飞书通道</h2>
    <div class="card slim">
      <span class="chip"><i class="dot ${chStatus.bound ? "ok" : chStatus.configured ? "warn" : "bad"}"></i>飞书 ${chStatus.bound ? "已配对" : chStatus.configured ? "待授权" : "未配置"}</span>
      <span class="meta">${chStatus.bound ? "发布失败、登录失效会推卡片到手机" : "在「接入」页扫码配置自己的飞书应用"}</span>
      <a class="btn ghost mini" href="#setup">${chStatus.bound ? "管理" : "去配置"}</a>
    </div>

    <h2>添加账号</h2>
    <div class="card">
      <div class="row">
        <div><label>平台</label>
          <select id="acc-platform">${usable.map((p) => `<option value="${esc(p.platform)}" ${p.ready ? "disabled" : ""}>${esc(p.platform)}${p.ready ? `（不可用：${esc(p.ready)}）` : ""}</option>`).join("")}</select>
        </div>
        <div><label>昵称 / 主页 handle</label><input id="acc-handle" placeholder="@yourname" /></div>
        <div><label>凭证文件（B站：biliup 的 cookies.json）</label><input id="acc-credential" placeholder="/Users/you/cookies.json（可留空）" /></div>
        <div class="tight"><button class="primary" id="acc-add">添加</button></div>
      </div>
      <details class="meta" style="margin-top:10px">
        <summary style="cursor:pointer">B站要准备什么？</summary>
        <div style="margin-top:8px">
          <div class="row" style="align-items:center;gap:8px">
            <pre class="mono" style="flex:1;margin:0">biliup -u ~/cookies.json login</pre>
            <button class="small" data-copy="biliup -u ~/cookies.json login">复制</button>
          </div>
          <p class="meta">选择「浏览器登录」，在打开的窗口里登录 B站。完成后把 <span class="mono">~/cookies.json</span> 填到上面的「凭证文件」。</p>
        </div>
      </details>
      <details class="meta" style="margin-top:6px">
        <summary style="cursor:pointer">TikTok 要怎么登录？</summary>
        <p class="meta" style="margin-top:8px">在上面的平台里选 tiktok 并添加，然后在账号卡上点「登录 / 重新授权」——会在这个账号自己的浏览器里打开登录页。登录完点「验证登录」确认。</p>
      </details>
      <details class="meta" style="margin-top:6px">
        <summary style="cursor:pointer">小红书要怎么登录？</summary>
        <p class="meta" style="margin-top:8px">选 xiaohongshu 添加（不需要凭证文件）→ 在账号卡上点「登录 / 重新授权」→ 专用 Chrome 会打开创作服务平台登录页 → 用手机号收验证码登录 → 回来点「验证登录」。登录态会留在这个账号的 profile 里。</p>
      </details>
    </div>`;

  $("#acc-add").onclick = async () => {
    const platform = $("#acc-platform").value;
    const handle = $("#acc-handle").value.trim() || `@${platform}`;
    const credentialRef = $("#acc-credential").value.trim() || undefined;
    try {
      const r = await api("/api/accounts", { method: "POST", body: { platform, name: handle, handle, ...(credentialRef ? { credentialRef } : {}) } });
      toast(r.existed ? "这个账号已经在了" : "账号已添加");
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };

  for (const btn of document.querySelectorAll("[data-check]")) {
    btn.onclick = async () => {
      const id = btn.dataset.check;
      const note = document.querySelector(`[data-note="${id}"]`);
      if (note) note.textContent = "验证中…";
      try {
        const r = await api(`/api/accounts/${encodeURIComponent(id)}/check`, { method: "POST", body: { accountId: id } });
        toast(`验证完成：${r.state}`);
        // 状态变化会触发 SSE 重渲染，旧的节点会被替换掉；先渲染再写结果，才不会被冲掉。
        await render();
        const fresh = document.querySelector(`[data-note="${id}"]`);
        if (fresh) fresh.textContent = `验证结果：${r.state}${r.detail ? `（${r.detail}）` : ""}`;
      } catch (err) {
        toast(err.message, true);
        const fresh = document.querySelector(`[data-note="${id}"]`);
        if (fresh) fresh.textContent = `验证失败：${err.message}`;
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-copy]")) {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast("已复制");
      } catch {
        toast("复制失败，请手动选中那行命令", true);
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-qr]")) {
    btn.onclick = async () => {
      const id = btn.dataset.qr;
      const mount = () => document.querySelector(`[data-login-box="${id}"]`);
      const box0 = mount();
      if (!box0) return;
      loginPaused = true;
      box0.textContent = "正在生成二维码…";
      try {
        const r = await api(`/api/accounts/${encodeURIComponent(id)}/login/start`, { method: "POST", body: { accountId: id } });
        // 这段时间页面可能因为 SSE 重渲染换掉了节点，必须重新取。
        const box = mount();
        if (!box) return;
        box.innerHTML = `<div class="login-box qr-login">
          <p class="meta">用小红书 App 扫码登录；扫完这里会自动检测。</p>
          <img data-qr-img src="${esc(r.qr)}" alt="小红书登录二维码"/>
          <p class="meta" data-qr-state>等待扫码…</p>
          <button class="small ghost" data-cancel="${esc(id)}">取消</button>
        </div>`;
        const img = () => mount()?.querySelector("[data-qr-img]");
        const stateEl = () => mount()?.querySelector("[data-qr-state]");
        const timer = setInterval(async () => {
          try {
            const s = await api(`/api/accounts/${encodeURIComponent(id)}/login/status`, { method: "POST", body: { accountId: id } });
            const im = img();
            if (s.qr && im && s.qr !== im.src) im.src = s.qr;
            if (s.state === "ok") {
              clearInterval(timer);
              loginPaused = false;
              toast("扫码登录成功");
              render();
            } else {
              if (stateEl()) {
                stateEl().textContent =
                  s.state === "confirm_phone"
                    ? (s.note ?? "扫码成功，请在手机上点确认")
                    : s.state === "sms_required"
                      ? `${s.note ?? "需要短信验证"}${s.phone ? `（${s.phone}）` : ""}`
                      : "等待扫码…";
              }
              const box = mount();
              if (s.state === "sms_required" && box && !box.querySelector("[data-sms-send]") && !box.querySelector("[data-sms-code]")) {
                const rowEl = document.createElement("div");
                rowEl.className = "row";
                if (s.sent === false) {
                  rowEl.innerHTML = `<button class="small primary" data-sms-send>发送验证码</button>`;
                  rowEl.querySelector("[data-sms-send]").onclick = async () => {
                    try {
                      const r = await api(`/api/accounts/${encodeURIComponent(id)}/login/resend`, { method: "POST", body: { accountId: id } });
                      toast(r.next ?? "验证码已发送");
                      rowEl.remove();
                    } catch (err) {
                      toast(err.message, true);
                    }
                  };
                } else {
                  rowEl.innerHTML = `<input data-sms-code placeholder="最新短信验证码" inputmode="numeric"/><button class="small primary" data-sms-ok>验证</button><button class="small ghost" data-sms-resend>重新发送</button>`;
                  rowEl.querySelector("[data-sms-ok]").onclick = async () => {
                    const code = rowEl.querySelector("[data-sms-code]").value.trim();
                    try {
                      const v = await api(`/api/accounts/${encodeURIComponent(id)}/login/verify`, { method: "POST", body: { accountId: id, code } });
                      if (v.state === "ok") {
                        clearInterval(timer);
                        loginPaused = false;
                        toast("验证通过，登录成功");
                        render();
                      } else {
                        toast(v.next ?? "验证通过，等平台确认");
                      }
                    } catch (err) {
                      toast(err.message, true);
                      if (stateEl()) stateEl().textContent = err.message;
                    }
                  };
                  rowEl.querySelector("[data-sms-resend]").onclick = async () => {
                    try {
                      const r = await api(`/api/accounts/${encodeURIComponent(id)}/login/resend`, { method: "POST", body: { accountId: id } });
                      toast(r.next ?? "验证码已重新发送");
                    } catch (err) {
                      toast(err.message, true);
                    }
                  };
                }
                box.querySelector(".qr-login")?.append(rowEl);
              }
            }
          } catch (err) {
            clearInterval(timer);
            stateEl.textContent = err.message;
          }
        }, 2000);
        const cancel = mount()?.querySelector("[data-cancel]");
        if (cancel) {
          cancel.onclick = async () => {
            clearInterval(timer);
            loginPaused = false;
            await api(`/api/accounts/${encodeURIComponent(id)}/login/cancel`, { method: "POST", body: { accountId: id } }).catch(() => {});
            const b = mount();
            if (b) b.innerHTML = "";
          };
        }
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-sms]")) {
    btn.onclick = () => {
      const id = btn.dataset.sms;
      const box = document.querySelector(`[data-login-box="${id}"]`);
      if (!box) return;
      loginPaused = true;
      box.innerHTML = `<div class="login-box">
        <input data-phone="${esc(id)}" placeholder="手机号（11 位）" inputmode="numeric"/>
        <button class="small" data-send="${esc(id)}">发送验证码</button>
        <input data-code="${esc(id)}" placeholder="短信验证码" inputmode="numeric"/>
        <button class="small primary" data-verify="${esc(id)}">登录</button>
        <button class="small ghost" data-cancel="${esc(id)}">取消</button>
      </div>`;
      box.querySelector(`[data-send="${id}"]`).onclick = async () => {
        const phone = box.querySelector(`[data-phone="${id}"]`).value.trim();
        try {
          const r = await api(`/api/accounts/${encodeURIComponent(id)}/login/start`, { method: "POST", body: { accountId: id, phone } });
          toast(r.next ?? "验证码已发送");
          box.querySelector(`[data-send="${id}"]`).disabled = true;
        } catch (err) {
          toast(err.message, true);
        }
      };
      box.querySelector(`[data-verify="${id}"]`).onclick = async () => {
        const code = box.querySelector(`[data-code="${id}"]`).value.trim();
        try {
          const r = await api(`/api/accounts/${encodeURIComponent(id)}/login/verify`, { method: "POST", body: { accountId: id, code } });
          toast(r.next ?? "登录成功");
          loginPaused = false;
          render();
        } catch (err) {
          toast(err.message, true);
        }
      };
      box.querySelector(`[data-cancel="${id}"]`).onclick = async () => {
        try {
          await api(`/api/accounts/${encodeURIComponent(id)}/login/cancel`, { method: "POST", body: { accountId: id } });
          loginPaused = false;
          box.innerHTML = "";
        } catch (err) {
          toast(err.message, true);
        }
      };
    };
  }

  for (const btn of document.querySelectorAll("[data-act]")) {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      try {
        if (btn.dataset.act === "mode") {
          await api(`/api/accounts/${encodeURIComponent(id)}/mode`, { method: "POST", body: { accountId: id, mode: btn.dataset.mode } });
          toast("已切换");
          render();
        } else {
          const r = await api(`/api/accounts/${encodeURIComponent(id)}/reauth`, { method: "POST", body: { accountId: id } });
          const note = document.querySelector(`[data-note="${id}"]`);
          if (note) note.textContent = r.next ?? "已开始";
          toast(r.next ?? "已开始");
        }
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
}

// ---------------------------------------------------------------- 发布

let draft = { asset: "", uploading: false };

async function viewPublish() {
  const [{ platforms }, { accounts }] = await Promise.all([api("/api/platforms"), api("/api/accounts")]);
  const usable = platforms.filter((p) => p.publish !== "none");
  const hasAccount = (name) => accounts.some((a) => a.platform === name);
  // 「适配器能用」不等于「这个平台能发」：没有账号的平台勾了只会整单失败，所以直接禁掉并说明原因。
  const reasonOf = (p) => p.ready ?? (hasAccount(p.platform) ? null : "没有账号");
  const picked = new Set(usable.filter((p) => !reasonOf(p)).map((p) => p.platform));

  $("#view").innerHTML = `
    <h1>发布台</h1>
    <p class="hint">一条素材，多平台差异化字段。先用「彩排」看它会做什么，再发。</p>
    <div class="split">
      <div class="card">
        <label>素材</label>
        <input type="file" id="asset-file" accept="video/*,image/*" />
        <div class="row" style="margin-top:10px">
          <input id="asset-path" placeholder="或直接填本机路径 /Users/you/ep1.mp4" value="${esc(draft.asset)}" />
        </div>
        <p class="meta" id="upload-note">${draft.uploading ? "上传中…" : ""}</p>

        <label>标题（留空用文件名）</label>
        <input id="pub-title" placeholder="这一条的标题" />

        <div class="row">
          <div><label>可见性</label>
            <select id="pub-visibility">
              <option value="public">公开</option>
              <option value="private">仅自己</option>
              <option value="private_then_public">先私密，确认后放行</option>
            </select>
          </div>
          <div><label>定时（可留空）</label><input id="pub-schedule" type="datetime-local" /></div>
        </div>

        <label>平台</label>
        <div class="grid cols-3" style="gap:6px">
          ${usable
            .map((p) => {
              const reason = reasonOf(p);
              return `<label style="margin:0;color:var(--text);font-size:13px">
                <input type="checkbox" class="pub-platform" value="${esc(p.platform)}" ${reason ? "disabled" : ""} ${!reason && picked.has(p.platform) ? "checked" : ""}/>
                ${esc(p.platform)}${reason ? `<span class="meta">（${esc(reason)}）</span>` : ""}
              </label>`;
            })
            .join("")}
        </div>

        <div class="row" style="margin-top:16px">
          <div class="tight"><button id="pub-dry">彩排</button></div>
          <div class="tight"><button class="primary" id="pub-go">发布</button></div>
        </div>
        <p class="meta" style="margin-top:8px">彩排不写库、不联网；发布后每条平台各自入队，互不阻塞。</p>
      </div>

      <div class="card">
        <h3>结果</h3>
        <div id="pub-result" class="meta">还没有动作。</div>
      </div>
    </div>`;

  $("#asset-file").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    draft.uploading = true;
    $("#upload-note").textContent = `上传中：${file.name}（${(file.size / 1048576).toFixed(1)}MB）`;
    try {
      const r = await upload(file);
      draft.asset = r.path;
      $("#asset-path").value = r.path;
      $("#upload-note").textContent = `已接收：${file.name}（${(r.bytes / 1048576).toFixed(1)}MB）`;
    } catch (err) {
      $("#upload-note").textContent = "";
      toast(`上传失败：${err.message}`, true);
    } finally {
      draft.uploading = false;
    }
  };

  const collectArgs = () => {
    const asset = $("#asset-path").value.trim();
    const to = [...document.querySelectorAll(".pub-platform:checked")].map((c) => c.value);
    const title = $("#pub-title").value.trim();
    const visibility = $("#pub-visibility").value;
    const when = $("#pub-schedule").value;
    const schedule = when ? new Date(when).getTime() : undefined;
    if (!asset) throw new Error("先选素材或填本机路径");
    if (!to.length) throw new Error("至少勾一个平台");
    return { asset, to, ...(title ? { title } : {}), visibility, ...(schedule ? { schedule } : {}) };
  };

  const run = async (dryRun) => {
    const box = $("#pub-result");
    try {
      const args = collectArgs();
      if (draft.uploading) throw new Error("素材还在上传");
      const r = await api("/api/publishes", { method: "POST", body: { ...args, ...(dryRun ? { dryRun: true } : {}) } });
      if (r.dryRun) {
        box.innerHTML = `<p><b>彩排结果</b>：${r.publishes.length} 条将创建</p><pre class="mono">${esc(JSON.stringify(r.publishes, null, 2))}</pre>`;
      } else {
        box.innerHTML = `<p><b>已入队</b>：${r.publishes.length} 条</p><pre class="mono">${esc(JSON.stringify(r.publishes, null, 2))}</pre>
          <p><a href="#works">去看进度 →</a></p>`;
        toast(`已创建 ${r.publishes.length} 条发布`);
      }
    } catch (err) {
      box.textContent = err.message;
      toast(err.message, true);
    }
  };

  $("#pub-dry").onclick = () => run(true);
  $("#pub-go").onclick = () => run(false);
  $("#asset-path").oninput = (e) => (draft.asset = e.target.value);
}

// ---------------------------------------------------------------- 作品

const metricOf = (m) => Object.entries(m ?? {}).filter(([, v]) => typeof v === "number");

function chart(points, height = 180) {
  const series = points.filter((p) => p.metrics && typeof p.metrics.play === "number");
  if (series.length < 2) return `<div class="empty">快照还不够画曲线（至少 2 个点）。</div>`;
  const w = 640;
  const pad = 26;
  const xs = series.map((p) => p.at);
  const ys = series.map((p) => p.metrics.play);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys, 1);
  const px = (x) => pad + ((x - minX) / Math.max(1, maxX - minX)) * (w - pad * 2);
  const py = (y) => height - pad - (y / maxY) * (height - pad * 2);
  const line = series.map((p) => `${px(p.at).toFixed(1)},${py(p.metrics.play).toFixed(1)}`).join(" ");
  return `
    <svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none">
      <line x1="${pad}" y1="${height - pad}" x2="${w - pad}" y2="${height - pad}" stroke="#25313f" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#25313f" />
      <polyline fill="none" stroke="#35d0ba" stroke-width="2" points="${line}" />
      ${series.map((p) => `<circle cx="${px(p.at).toFixed(1)}" cy="${py(p.metrics.play).toFixed(1)}" r="2.5" fill="#35d0ba"><title>${esc(fmtTime(p.at))}：${fmtNum(p.metrics.play)}</title></circle>`).join("")}
      <text x="${pad}" y="${height - 8}">${esc(fmtTime(minX))}</text>
      <text x="${w - pad}" y="${height - 8}" text-anchor="end">${esc(fmtTime(maxX))}</text>
      <text x="${pad + 4}" y="${pad - 6}">播放 ${fmtNum(maxY)}</text>
    </svg>`;
}

async function viewWorks(selectedId = null) {
  const { rows } = await api("/api/publishes");
  const selected = selectedId ? rows.find((r) => r.id === selectedId) : rows[0];
  let detail = `<div class="empty">左边选一条，看它的快照。</div>`;
  if (selected) {
    const { points } = await api(`/api/stats/series?publishId=${encodeURIComponent(selected.id)}`);
    const latest = points.at(-1);
    detail = `
      <h3>${esc(selected.title)}</h3>
      <p class="meta">${esc(selected.platform)} ${esc(selected.handle)} · ${esc(selected.id)}</p>
      ${chart(points)}
      ${latest ? `<p class="meta">最近一次：${fmtTime(latest.at)} · 来源 ${esc(latest.source)} · 状态 ${esc(latest.status)}</p>
        <div class="grid cols-3">${metricOf(latest.metrics).map(([k, v]) => `<div><div class="kpi">${fmtNum(v)}<small>${esc(METRIC_LABEL[k] ?? k)}</small></div></div>`).join("")}</div>`
        : `<p class="meta">还没有快照。发布成功一小时后会自动抓第一次。</p>`}
      <div class="row" style="margin-top:12px">
        <div class="tight"><button class="small" data-collect="${esc(selected.id)}">立即抓一次</button></div>
        ${["failed", "blocked"].includes(selected.state) ? `<div class="tight"><button class="small" data-act="retry" data-id="${esc(selected.id)}">重试</button></div>` : ""}
        ${["notify_pending", "draft_pending"].includes(selected.state) ? `<div class="tight"><button class="small primary" data-act="confirm" data-id="${esc(selected.id)}">我已发布</button></div>` : ""}
        ${selected.state === "published_limited" ? `<div class="tight"><button class="small primary" data-act="release" data-id="${esc(selected.id)}">放行公开</button></div>` : ""}
      </div>
      ${selected.error_message ? `<p class="meta">失败原因：${esc(selected.error_message)}</p>` : ""}
      ${selected.external_url ? `<p><a href="${esc(selected.external_url)}" target="_blank" rel="noreferrer">打开平台页面 ↗</a></p>` : ""}`;
  }

  $("#view").innerHTML = `
    <h1>作品</h1>
    <p class="hint">每条指标都带来源和时间。看到的数字，能回答「什么时候、从哪儿抓的」。</p>
    <div class="split">
      <div class="card" style="padding:6px 10px">
        ${
          rows.length
            ? `<table><thead><tr><th>作品</th><th>平台</th><th>状态</th><th>最近数据</th></tr></thead><tbody>
              ${rows
                .map(
                  (r) => `<tr class="clickable" data-pid="${esc(r.id)}" style="${selected && r.id === selected.id ? "background:#131d29" : ""}">
                    <td>${esc(String(r.title).slice(0, 26))}</td>
                    <td>${esc(r.platform)}</td>
                    <td><span class="badge ${STATE_CLASS(r.state)}">${esc(r.state)}</span></td>
                    <td class="num">${r.external_url ? "有链接" : "—"}</td>
                  </tr>`,
                )
                .join("")}
            </tbody></table>`
            : `<div class="empty">还没有作品：去「发布」建一条。</div>`
        }
      </div>
      <div class="card">${detail}</div>
    </div>`;

  for (const tr of document.querySelectorAll("tr[data-pid]")) {
    tr.onclick = () => render(tr.dataset.pid);
  }
  const ACTIONS = {
    retry: (id) => api(`/api/publishes/${encodeURIComponent(id)}/retry`, { method: "POST", body: { publishId: id } }),
    confirm: (id) => api(`/api/publishes/${encodeURIComponent(id)}/confirm`, { method: "POST", body: { publishId: id } }),
    release: (id) => api(`/api/publishes/${encodeURIComponent(id)}/release`, { method: "POST", body: { publishId: id } }),
  };
  for (const btn of document.querySelectorAll("[data-check]")) {
    btn.onclick = async () => {
      const id = btn.dataset.check;
      const note = document.querySelector(`[data-note="${id}"]`);
      if (note) note.textContent = "验证中…";
      try {
        const r = await api(`/api/accounts/${encodeURIComponent(id)}/check`, { method: "POST", body: { accountId: id } });
        toast(`验证完成：${r.state}`);
        // 状态变化会触发 SSE 重渲染，旧的节点会被替换掉；先渲染再写结果，才不会被冲掉。
        await render();
        const fresh = document.querySelector(`[data-note="${id}"]`);
        if (fresh) fresh.textContent = `验证结果：${r.state}${r.detail ? `（${r.detail}）` : ""}`;
      } catch (err) {
        toast(err.message, true);
        const fresh = document.querySelector(`[data-note="${id}"]`);
        if (fresh) fresh.textContent = `验证失败：${err.message}`;
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-copy]")) {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast("已复制");
      } catch {
        toast("复制失败，请手动选中那行命令", true);
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-act]")) {
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await ACTIONS[btn.dataset.act](btn.dataset.id);
        toast("已提交");
        render(btn.dataset.id);
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-collect]")) {
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await api("/api/collect", { method: "POST", body: { publishId: btn.dataset.collect } });
        toast("已排一次采集，稍后刷新");
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
}

// ---------------------------------------------------------------- 总览

async function viewOverview() {
  const [{ rows }, { accounts }, { rows: runs }] = await Promise.all([
    api("/api/publishes"),
    api("/api/accounts"),
    api("/api/runs"),
  ]);
  const byState = (s) => rows.filter((r) => r.state === s).length;
  const done = byState("published") + byState("published_limited");
  const lost = byState("failed") + byState("blocked");
  const pending = byState("notify_pending") + byState("draft_pending");
  const rate = done + lost ? Math.round((done / (done + lost)) * 100) : 0;
  const failing = accounts.filter((a) => ["expired", "banned", "expiring"].includes(a.state));

  const platforms = [...new Set(rows.map((r) => r.platform))];
  const maxCount = Math.max(1, ...platforms.map((p) => rows.filter((r) => r.platform === p).length));

  $("#view").innerHTML = `
    <h1>总览</h1>
    <p class="hint">跨账号、跨平台的一屏。失败永远比成功更显眼——那才是需要你动手的地方。</p>
    <div class="grid cols-4">
      <div class="card"><div class="kpi">${done}<small>已发布</small></div></div>
      <div class="card"><div class="kpi">${rate}%<small>成功率</small></div></div>
      <div class="card"><div class="kpi">${pending}<small>待你处理</small></div></div>
      <div class="card"><div class="kpi" style="${failing.length ? "color:var(--bad)" : ""}">${failing.length}<small>账号需重登</small></div></div>
    </div>

    <h2>各平台产出</h2>
    <div class="card">
      ${
        platforms.length
          ? platforms
              .map((p) => {
                const n = rows.filter((r) => r.platform === p).length;
                return `<div style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><span>${esc(p)}</span><span class="meta">${n} 条</span></div>
                  <div class="bar"><i style="width:${(n / maxCount) * 100}%"></i></div></div>`;
              })
              .join("")
          : `<div class="empty">还没有发布记录。</div>`
      }
    </div>

    <h2>需要你动手</h2>
    <div class="card">
      ${
        failing.length || pending
          ? `<ul style="margin:0;padding-left:18px">
              ${failing.map((a) => `<li>${esc(a.platform)} ${esc(a.handle)} 登录态 ${esc(a.state)} —— 去「账号」重新授权</li>`).join("")}
              ${rows.filter((r) => ["notify_pending", "draft_pending"].includes(r.state)).slice(0, 5).map((r) => `<li>${esc(r.platform)}「${esc(r.title)}」${esc(r.state)} —— <a href="#works">看详情</a></li>`).join("")}
            </ul>`
          : `<p class="meta">没有卡住的东西。</p>`
      }
    </div>

    <h2>队列</h2>
    <div class="card"><div class="row">
      <div><div class="kpi">${runs.filter((r) => r.state === "queued").length}<small>排队</small></div></div>
      <div><div class="kpi">${runs.filter((r) => r.state === "running").length}<small>运行中</small></div></div>
      <div><div class="kpi" style="color:${runs.some((r) => r.state === "failed") ? "var(--bad)" : "inherit"}">${runs.filter((r) => r.state === "failed").length}<small>失败</small></div></div>
    </div></div>`;
}

// ---------------------------------------------------------------- 任务

async function viewTasks() {
  const [{ rows: runs }, { rows: events }, { rows: waiting }, { rows: failedPubs }] = await Promise.all([
    api("/api/runs"),
    api("/api/events?limit=12"),
    api("/api/publishes?state=notify_pending"),
    api("/api/publishes?state=failed"),
  ]);
  const waitingAll = [...waiting, ...failedPubs];
  $("#view").innerHTML = `
    <h1>任务与日志</h1>
    <p class="hint">队列是发布与采集的唯一通道。失败会带原因，重试不会丢掉原任务。</p>
    ${
      waitingAll.length
        ? `<h2>等你拍板</h2>
           <div class="card" style="padding:6px 10px"><table><thead><tr><th>平台</th><th>标题</th><th>状态</th><th>原因</th><th></th></tr></thead><tbody>
             ${waitingAll
               .map(
                 (p) => `<tr><td>${esc(p.platform)}</td><td>${esc(p.title ?? "")}</td><td><span class="badge ${STATE_CLASS(p.state)}">${esc(p.state)}</span></td><td class="meta">${esc(p.error_message ?? p.fallback_reason ?? "")}</td>
                   <td><button class="small" data-approve="${esc(p.id)}">手机审批</button></td></tr>`,
               )
               .join("")}
           </tbody></table></div>`
        : ""
    }

    <h2>队列</h2>
    <div class="card" style="padding:6px 10px">
      ${
        runs.length
          ? `<table><thead><tr><th>类型</th><th>目标</th><th>状态</th><th>尝试</th><th>原因</th><th></th></tr></thead><tbody>
            ${runs
              .map(
                (r) => `<tr>
                  <td>${esc(r.kind)}</td>
                  <td class="mono">${esc(r.target_id)}</td>
                  <td><span class="badge ${STATE_CLASS(r.state)}">${esc(r.state)}</span></td>
                  <td class="num">${r.attempts}</td>
                  <td class="meta">${esc(r.last_error ?? "")}</td>
                  <td>${r.kind === "publish" && r.state === "failed" ? `<button class="small" data-retry="${esc(r.target_id)}">重试</button>` : ""}</td>
                </tr>`,
              )
              .join("")}
          </tbody></table>`
          : `<div class="empty">队列是空的。</div>`
      }
    </div>

    <h2>最近事件</h2>
    <div class="card" style="padding:6px 10px">
      ${
        events.length
          ? `<table><thead><tr><th>时间</th><th>事件</th><th>级别</th><th>对象</th></tr></thead><tbody>
            ${events.map((e) => `<tr><td class="meta">${fmtTime(e.created_at)}</td><td class="mono">${esc(e.type)}</td><td>${esc(e.severity)}</td><td class="mono">${esc(e.publish_id ?? "—")}</td></tr>`).join("")}
          </tbody></table>`
          : `<div class="empty">还没有事件。</div>`
      }
    </div>`;

  for (const btn of document.querySelectorAll("[data-approve]")) {
    btn.onclick = async () => {
      try {
        const r = await api(`/api/approvals/link?publishId=${encodeURIComponent(btn.dataset.approve)}`);
        try {
          await navigator.clipboard.writeText(r.url);
          toast("审批链接已复制，可在手机上打开");
        } catch {
          toast(r.url);
        }
        window.open(r.path, "_blank");
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-retry]")) {
    btn.onclick = async () => {
      try {
        await api(`/api/publishes/${encodeURIComponent(btn.dataset.retry)}/retry`, { method: "POST", body: { publishId: btn.dataset.retry } });
        toast("已重新排队");
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
}

// ---------------------------------------------------------------- 自检

async function viewDoctor() {
  const report = await api("/api/doctor");
  const bad = report.checks.filter((c) => !c.ok);
  $("#view").innerHTML = `
    <h1>自检</h1>
    <p class="hint">回答一个问题：为什么发不出去。红灯都带「下一步该做什么」。</p>
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div class="kpi">${report.passed}/${report.total}<small>项通过</small></div>
        <span class="chip"><i class="dot ${bad.length ? "bad" : "ok"}"></i>${bad.length ? `${bad.length} 项需要处理` : "全部正常"}</span>
      </div>
    </div>
    <div class="card" style="padding:6px 10px;margin-top:14px">
      <table><thead><tr><th>检查</th><th>结果</th><th>下一步</th></tr></thead><tbody>
        ${report.checks
          .map(
            (c) => `<tr>
              <td class="mono">${esc(c.id)}</td>
              <td>${c.ok ? `<span class="chip"><i class="dot ok"></i>通过</span>` : `<span class="chip"><i class="dot bad"></i>${esc(c.detail)}</span>`}</td>
              <td class="meta">${esc(c.ok ? "—" : c.next ?? "")}</td>
            </tr>`,
          )
          .join("")}
      </tbody></table>
    </div>`;
}

// ---------------------------------------------------------------- 飞书通道（产品内配置）

// 授权中的 device_code 只放内存：它是短时凭据，不适合落库。
let pendingDevice = null;
let currentChannelStatus = null;

/**
 * 用户必须用自己的飞书应用。这里的三态是：
 *   未配置应用 → 填 app_id / app_secret（secret 只走一次 stdin）
 *   已配置未授权 → 设备码授权
 *   已授权未配对 / 已配对 → 绑定并测试
 */
function channelBlockHtml(st) {
  const create = st.create ?? {};
  const auth = st.auth ?? {};
  const configured = Boolean(st.configured);
  const authorized = Boolean(st.authorized);
  const bound = Boolean(st.bound);
  const sub = st.subscription;
  // 已配对但订阅没生效 = 卡片能收到、按钮点不动。这是最容易被误判成「已打通」的状态。
  const needSubscribe = bound && sub && !sub.subscribed;

  if (st.skipped && !bound) {
    return `
    <div class="channel-flow">
      <p class="meta">手机通道已跳过。发布、采集都不受影响；需要手机拍板时再开启。</p>
      <div class="row"><button class="mini" id="ch-unskip">开启手机通道</button></div>
      <details class="meta advanced"><summary>高级信息</summary>profile：${esc(st.profile)}</details>
    </div>`;
  }

  const step = (n, title, done, detail) => `
    <div class="step-line ${done ? "done" : ""}">
      <span class="step-dot">${done ? "✓" : n}</span>
      <div><b>${title}</b><div class="meta">${detail}</div></div>
    </div>`;

  const qrPane = (qr, url, hint) => `
    <div class="qr-wrap">
      ${qr ? `<img class="qr" src="${esc(qr)}" alt="扫码"/>` : `<div class="qr-missing">二维码没生成，请直接用链接</div>`}
      <a class="btn ghost" href="${esc(url ?? "")}" target="_blank" rel="noreferrer">在浏览器打开 ↗</a>
      <div class="meta">${esc(hint)}</div>
    </div>`;

  return `
  <div class="channel-flow">
    ${step(1, "创建飞书应用", configured, configured ? `已创建 · ${esc(st.appId ?? "")}` : "在你的飞书账号下创建一个专用应用")}
    ${
      !configured
        ? create.running
          ? `${qrPane(create.qr, create.url, "用手机扫码，在飞书里确认创建；完成后自动进入下一步。")}
             <p class="meta">等待你在飞书完成创建…</p>
             <button class="mini ghost" id="ch-cancel">取消</button>`
          : `<div class="row"><button class="primary" id="ch-create">扫码创建应用</button></div>
             <details class="meta"><summary>我已有应用，手动填写</summary>
               <label>App ID</label><input id="ch-appid" placeholder="cli_xxxxxxxxxxxx"/>
               <label>App Secret</label><input id="ch-secret" type="password" placeholder="只显示这一次"/>
               <button class="mini" id="ch-save">保存应用</button>
             </details>`
        : ""
    }

    ${
      configured
        ? step(2, "授权", authorized, authorized ? "已完成" : auth.running ? "等待你在飞书确认…（最长 10 分钟）" : auth.error ? "上次授权没完成" : "准备授权二维码")
        : ""
    }
    ${
      configured && !authorized
        ? auth.qr
          ? qrPane(auth.qr, auth.url, auth.running ? "扫码并在飞书里点确认；页面会自动检测，最长 10 分钟。" : "扫码并在飞书里点确认；完成后会自动配对。")
          : auth.error
            ? `<p class="meta">${esc((auth.error || "").slice(0, 180))}</p><button class="mini" id="ch-retry">重新扫码授权</button>`
            : `<p class="meta">正在准备授权二维码…</p>`
        : ""
    }

    ${authorized ? step(3, "配对", bound, bound ? "已配对，测试卡已发送" : "正在自动配对…") : ""}
    ${
      needSubscribe
        ? `<div class="need-line">
             <div><b>还差一步：让按钮能点</b>
               <div class="meta">飞书要在后台订阅一次 card.action.trigger，否则卡片收到、点按钮没反应。</div>
             </div>
             <div class="row" style="margin-top:8px">
               ${sub.url ? `<a class="btn" href="${esc(sub.url)}" target="_blank" rel="noreferrer">去订阅 ↗</a>` : ""}
               <button class="mini ghost" id="ch-recheck">我点完了，重新检测</button>
             </div>
           </div>`
        : ""
    }
    ${bound && sub?.subscribed ? `<div class="meta line">✓ 按钮已可用（卡片点击会回到这台电脑执行）</div>` : ""}

    ${
      bound
        ? `<div class="row" style="margin-top:8px">
             <div class="tight"><button class="ghost mini" id="ch-test">发测试卡</button></div>
             <div class="tight"><button class="ghost mini" id="ch-diag">诊断</button></div>
           </div>
           <div id="ch-diag-box" class="meta" style="margin-top:8px"></div>`
        : ""
    }

    ${!bound ? `<p class="meta skip-line">飞书应用要等管理员审核，或你暂时不想配？<button class="mini ghost" id="ch-skip">先跳过，直接发布</button></p>` : ""}
    <details class="meta advanced"><summary>高级信息</summary>
      <div>profile：${esc(st.profile)}${st.appId ? ` · appId：${esc(st.appId)}` : ""}</div>
      ${st.ready ? `<div>${esc(st.ready)}</div>` : ""}
    </details>
  </div>`;
}

// 自动推进：创建完成→自动出授权码；授权完成→自动配对。用户只扫码，不点按钮。
let autoAuthFor = null;
let autoBoundFor = null;

function wireChannelBlock(st = {}) {
  if (!st.bound) setTimeout(() => render(), 2000);

  const create = $("#ch-create");
  if (create) {
    create.onclick = async () => {
      try {
        await api("/api/channels/feishu/app/create", { method: "POST", body: {} });
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  const skip = $("#ch-skip");
  if (skip) {
    skip.onclick = async () => {
      try {
        await api("/api/channels/feishu/skip", { method: "POST", body: {} });
        toast("已跳过手机通道，可以直接发布");
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  const recheck = $("#ch-recheck");
  if (recheck) {
    recheck.onclick = async () => {
      try {
        const r = await api("/api/channels/feishu/subscription");
        toast(r.subscribed ? "订阅已生效，按钮可以点了" : r.detail ?? "还没检测到订阅", !r.subscribed);
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  const unskip = $("#ch-unskip");
  if (unskip) {
    unskip.onclick = async () => {
      try {
        await api("/api/channels/feishu/unskip", { method: "POST", body: {} });
        toast("已重新开启手机通道");
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  const cancel = $("#ch-cancel");
  if (cancel) {
    cancel.onclick = async () => {
      try {
        await api("/api/channels/feishu/app/create/cancel", { method: "POST", body: {} });
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  if (st.configured && !st.authorized && !st.auth?.running && !st.auth?.qr && !st.auth?.error && autoAuthFor !== st.appId) {
    autoAuthFor = st.appId;
    api("/api/channels/feishu/login/start", { method: "POST", body: {} })
      .then(() => render())
      .catch((err) => {
        autoAuthFor = null;
        toast(err.message, true);
      });
  }

  const retry = $("#ch-retry");
  if (retry) {
    retry.onclick = async () => {
      try {
        await api("/api/channels/feishu/login/start", { method: "POST", body: {} });
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  if (st.authorized && !st.bound && autoBoundFor !== st.appId) {
    autoBoundFor = st.appId;
    (async () => {
      await api("/api/channels/feishu/bind", { method: "POST", body: {} });
      await api("/api/channels/feishu/test", { method: "POST", body: {} });
      toast("已配对，测试卡已发送");
      render();
    })().catch((err) => {
      autoBoundFor = null;
      toast(err.message, true);
    });
  }

  const save = $("#ch-save");
  if (save) {
    save.onclick = async () => {
      const appId = $("#ch-appid").value.trim();
      const appSecret = $("#ch-secret").value;
      if (!appId || !appSecret) return toast("app_id 和 app_secret 都要填", true);
      try {
        await api("/api/channels/feishu/app", { method: "POST", body: { appId, appSecret } });
        $("#ch-secret").value = "";
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  const test = $("#ch-test");
  if (test) {
    test.onclick = async () => {
      try {
        await api("/api/channels/feishu/test", { method: "POST", body: {} });
        toast("测试卡已发送");
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  const diag = $("#ch-diag");
  if (diag) {
    diag.onclick = async () => {
      const box = $("#ch-diag-box");
      box.textContent = "诊断中…（约 10 秒）";
      try {
        await renderDiagnose(box);
      } catch (err) {
        box.textContent = err.message;
      }
    };
  }
}

// ---------------------------------------------------------------- 飞书诊断

async function renderDiagnose(el) {
  el.textContent = "诊断中…（约 10 秒，要等飞书事件总线就绪）";
  const d = await api("/api/channels/feishu/diagnose");
  el.innerHTML = `
    <div class="meta" style="margin-bottom:6px">${d.healthy ? "诊断结果：全部通过" : "诊断结果：有需要处理的地方"}</div>
    <div class="grid" style="gap:4px">
      ${d.checks.map((c) => `<div>${c.ok ? "✓" : "✗"} <span class="meta">${esc(c.id)}</span> ${esc(c.detail)}</div>`).join("")}
    </div>
    ${d.subscribeUrl ? `<p style="margin-top:8px"><a class="btn" href="${esc(d.subscribeUrl)}" target="_blank" rel="noreferrer">去后台订阅 card.action.trigger ↗</a></p>` : ""}`;
}

// ---------------------------------------------------------------- 接入

const COMMAND_ROUTES = {
  "account.reauth": (a) => `/api/accounts/${encodeURIComponent(a.accountId)}/reauth`,
  "account.mode": (a) => `/api/accounts/${encodeURIComponent(a.accountId)}/mode`,
  "publish.retry": (a) => `/api/publishes/${encodeURIComponent(a.publishId)}/retry`,
};

function fixHtml(fix) {
  if (!fix) return "";
  if (fix.kind === "page") return `<a class="btn" href="${esc(fix.href)}">${esc(fix.label)}</a>`;
  if (fix.kind === "link") return `<a class="btn" href="${esc(fix.url)}" target="_blank" rel="noreferrer">${esc(fix.label)} ↗</a>`;
  if (fix.kind === "copy") {
    return `<div class="row" style="align-items:center;gap:8px"><pre class="mono" style="flex:1;margin:0">${esc(fix.text)}</pre><button class="small" data-copy="${esc(fix.text)}">复制</button></div>`;
  }
  if (fix.kind === "command" && COMMAND_ROUTES[fix.command]) {
    return `<button class="primary" data-fix="${esc(fix.command)}" data-args="${esc(JSON.stringify(fix.args ?? {}))}">${esc(fix.label)}</button>`;
  }
  return "";
}

let expandedStep = null;

async function viewSetup() {
  const [setup, ch] = await Promise.all([api("/api/setup"), api("/api/channels/feishu/status")]);
  const current = setup.nextStep;
  // 飞书已经建好应用但还没配对时，优先把这一步打开：用户多半正卡在这里。
  const feishuPending = ch.configured && !ch.bound;
  const expanded = expandedStep ?? (feishuPending ? "channel" : current);
  const pct = Math.round((setup.done / setup.total) * 100);

  const steps = setup.steps
    .map((step, index) => {
      const done = step.status === "ok";
      const open = expanded === step.id;
      const failures = step.checks.filter((c) => !c.ok);
      const chip = done
        ? `<span class="chip"><i class="dot ok"></i>完成</span>`
        : step.id === "channel" && feishuPending
          ? `<span class="chip"><i class="dot warn"></i>${ch.authorized ? "待配对" : "待授权"}</span>`
          : step.id === current
            ? `<span class="chip"><i class="dot warn"></i>现在做</span>`
            : `<span class="meta">待做</span>`;

      const body = open
        ? `<div class="step-body">
            ${failures.map((c) => `<div class="meta line">✗ ${esc(c.detail)}${c.next ? ` — ${esc(c.next)}` : ""}</div>`).join("")}
            ${step.id === "channel" ? channelBlockHtml(ch) : ""}
            ${step.id !== "channel" && step.fix ? `<div class="row" style="margin-top:12px">${fixHtml(step.fix)}</div>` : ""}
          </div>`
        : "";

      return `<div class="step-block ${open ? "open" : ""} ${step.id === current ? "current-step" : ""}">
        <div class="step-row" data-step="${esc(step.id)}">
          <span class="step-dot ${done ? "done" : ""}">${done ? "✓" : index + 1}</span>
          <div class="step-title"><b>${esc(step.title)}</b><span class="meta">${
            step.id === "channel" && feishuPending ? (ch.authorized ? "应用已授权，点开自动配对" : "应用已创建，点开扫码授权") : esc(step.intent)
          }</span></div>
          <span class="step-side">${chip}<span class="chev">${open ? "▾" : "▸"}</span></span>
        </div>
        ${body}
      </div>`;
    })
    .join("");

  $("#view").innerHTML = `
    <h1>接入</h1>
    <p class="hint">按需展开每一步。第一个未完成的步骤默认展开。</p>
    <div class="progress-card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <span class="meta">${setup.done}/${setup.total} 完成</span>
        <span class="meta">${setup.nextStep ? "下一步在展开的那一步" : "全部就绪"}</span>
      </div>
      <div class="bar" style="margin-top:8px"><i style="width:${pct}%"></i></div>
    </div>
    ${steps}
    <p class="meta" style="margin-top:18px"><a href="#doctor">看完整自检</a></p>`;

  for (const row of document.querySelectorAll("[data-step]")) {
    row.onclick = () => {
      const id = row.dataset.step;
      expandedStep = expandedStep === id ? "" : id;
      render();
    };
  }

  for (const btn of document.querySelectorAll("[data-copy]")) {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast("已复制");
      } catch {
        toast("复制失败，请手动选中", true);
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-fix]")) {
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        const args = JSON.parse(btn.dataset.args ?? "{}");
        await api(COMMAND_ROUTES[btn.dataset.fix](args), { method: "POST", body: { ...args } });
        toast("已提交");
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  if (expanded === "channel") wireChannelBlock(ch);
}

// ---------------------------------------------------------------- 路由

const VIEWS = { setup: viewSetup, accounts: viewAccounts, publish: viewPublish, works: viewWorks, overview: viewOverview, tasks: viewTasks, doctor: viewDoctor };

function current() {
  const name = location.hash.replace("#", "") || "overview";
  return VIEWS[name] ? name : "overview";
}

async function render(arg) {
  const name = current();
  for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("active", a.dataset.view === name);
  try {
    await VIEWS[name](arg);
    ping();
  } catch (err) {
    $("#view").innerHTML = `<div class="card"><h3>读不到数据</h3><p class="meta">${esc(err.message)}</p>
      <p class="meta">守护进程在跑吗？终端执行 <span class="mono">vk serve</span>，或看 <span class="mono">vk doctor --human</span>。</p></div>`;
  }
}

let lastSignature = "";
let renderTimer = null;

function paintPill(status) {
  const pill = $("#pill");
  if (!pill || !status) return;
  const bad = status.accounts.by_state.expired + status.accounts.by_state.banned;
  pill.textContent = `${status.accounts.total} 个账号 · 队列 ${status.queue.queued}${status.queue.running ? `/${status.queue.running}` : ""} · ${bad ? `${bad} 个需重登` : "连接正常"}`;
  pill.className = `pill ${bad ? "bad" : "ok"}`;
}

async function ping() {
  try {
    paintPill(await api("/api/now"));
  } catch {
    $("#pill").textContent = "守护进程未连接";
    $("#pill").className = "pill bad";
  }
}

// 登录面板打开时暂停 SSE 重渲染：验证码输入框不能被整页刷新冲掉。
let loginPaused = false;

const signatureOf = (d) =>
  JSON.stringify([
    d.status.accounts,
    d.status.queue,
    d.status.publishes,
    d.status.channel,
    (d.publishes ?? []).map((p) => [p.id, p.state]),
    (d.runs ?? []).map((r) => [r.id, r.state, r.attempts]),
  ]);

/** 状态真的变了才重渲染；正在输入时不打扰。 */
function onStreamFrame(d) {
  paintPill(d.status);
  const sig = signatureOf(d);
  if (sig === lastSignature) return;
  lastSignature = sig;
  if (loginPaused) return;
  if (document.activeElement?.matches("input,select,textarea")) return;
  if (!["overview", "tasks", "accounts", "works"].includes(current())) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => render(), 400);
}

function connectStream() {
  if (!("EventSource" in window)) return null;
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => {
    let d;
    try {
      d = JSON.parse(e.data);
    } catch {
      return;
    }
    onStreamFrame(d);
  };
  // 断了就交给浏览器自动重连；这里是排障用的提示。
  es.onerror = () => {
    $("#pill").textContent = "实时流断开，自动重连中";
  };
  return es;
}

window.addEventListener("hashchange", () => render());
$("#refresh").onclick = () => {
  ping();
  render();
};

async function boot() {
  ping();
  connectStream();
  if (!location.hash) {
    try {
      const setup = await api("/api/setup");
      location.hash = setup.nextStep ? "#setup" : "#overview";
      return; // 改 hash 会触发 hashchange → render
    } catch {
      location.hash = "#overview";
      return;
    }
  }
  render();
}
boot();
