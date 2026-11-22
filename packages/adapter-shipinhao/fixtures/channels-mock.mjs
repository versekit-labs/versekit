// 离线模拟页：手搭一份视频号助手的页面（wujie 微前端的 shadow root 结构 + 真实文案），
// 再配一个假 tab，让适配器里真正发给浏览器的那些 JS 表达式在这份页面上跑。
// 本机不打开 channels.weixin.qq.com，也不碰任何真实账号；真机上的选择器以所有者的核对为准。
import vm from "node:vm";

// ---------------------------------------------------------------- 迷你 DOM：只实现适配器用到的那部分
let uid = 0;

function parseSelector(sel) {
  const m = /^([a-z*][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
  if (!m) throw new Error(`迷你 DOM 不认识选择器：${sel}`);
  const attrs = [...m[3].matchAll(/\[([\w-]+)(\*?=)([^\]]*)\]/g)].map((a) => ({ name: a[1], op: a[2], value: a[3].replace(/^["']|["']$/g, "") }));
  return { tag: m[1] && m[1] !== "*" ? m[1].toLowerCase() : null, classes: m[2].split(".").filter(Boolean), attrs };
}

export class El {
  constructor(tag, attrs = {}, kids = [], text = "") {
    this.tag = tag;
    this.attrs = { ...attrs };
    this.className = attrs.class ?? "";
    this.id = ++uid;
    this.parent = null;
    this.children = [];
    this.text = text;
    this.hidden = false;
    this.value = attrs.value ?? "";
    this.onclick = null;
    this.files = [];
    for (const k of kids) this.add(k);
  }
  add(k) { k.parent = this; this.children.push(k); return k; }
  get shown() { return !this.hidden && (!this.parent || this.parent.shown); }
  get offsetParent() { return this.shown ? (this.parent ?? this) : null; }
  get innerText() {
    if (this.tag === "input") return "";
    if (!this.children.length) return this.text;
    return this.children.filter((c) => !c.hidden).map((c) => c.innerText).filter((t) => t !== "").join("\n");
  }
  getBoundingClientRect() { return { x: 20, y: 20 + this.id * 40, width: 60, height: 20 }; }
  scrollIntoView() {}
  matches(sel) {
    const s = parseSelector(sel);
    if (s.tag && this.tag !== s.tag) return false;
    const cls = this.className.split(/\s+/);
    if (!s.classes.every((c) => cls.includes(c))) return false;
    return s.attrs.every((a) => {
      const v = this.attrs[a.name];
      if (v == null) return false;
      return a.op === "=" ? v === a.value : String(v).includes(a.value);
    });
  }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) {
    if (sel === "*") return this.all();
    const parts = sel.split(",");
    return this.all().filter((e) => parts.some((p) => e.matches(p)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

const el = (tag, attrs, kids, text) => new El(tag, attrs, kids, text);
const leaf = (cls, text, tag = "div") => el(tag, { class: cls }, [], text);

// ---------------------------------------------------------------- 模拟页

export const HOME_PATH = "/platform";
export const CREATE_PATH = "/platform/post/create";
export const LIST_PATH = "/platform/post/list";
export const LOGIN_PATH = "/login.html";

/**
 * options:
 *   loggedIn            false = 一打开就落到二维码页
 *   ratio               "9:16"（一张封面卡片）| "16:9"（两张）
 *   processingPolls     上传后页面要被读多少次才处理完（期间显示「上传中 45%」「生成中」）
 *   stuckProcessing     true = 一直卡在「生成中」（测 20 分钟超时）
 *   ignoreEditClicks    前几次点「编辑」没反应（测最多点三次）
 *   expireAfterUpload   上传完成后登录掉了，页面变成二维码页
 *   eatDescription      描述编辑器吞掉后面的字（测回读）
 *   dropDraft           点了保存草稿，草稿列表里却没有这一条（测核对）
 */
export class ChannelsMock {
  constructor(options = {}) {
    this.o = { loggedIn: true, ratio: "9:16", processingPolls: 2, ignoreEditClicks: 0, ...options };
    this.path = this.o.loggedIn ? CREATE_PATH : LOGIN_PATH;
    this.log = [];            // 点过什么：["click:编辑", "upload:video", ...]
    this.drafts = [];
    this.uploaded = false;
    this.polls = 0;
    this.covers = [];         // 每张卡片传了什么
    this.dialogFor = null;
    this.editClicks = 0;
    this.ai = null;
    this.qrSerial = 1;
    this.loginPhase = "waiting";
    this.active = null;
    this.build();
  }

  get location() { return { pathname: this.path }; }
  get document() {
    const self = this;
    return {
      querySelector: (sel) => (sel === "wujie-app" ? self.host : self.top.querySelector(sel)),
      querySelectorAll: (sel) => self.top.querySelectorAll(sel),
      get body() { return self.top; },
      get activeElement() { return self.active; },
    };
  }

  build() {
    this.registry = new Map();
    if (this.path === LOGIN_PATH) return this.buildLogin();
    this.top = el("body", {}, []);
    const body = el("body", {}, []);
    this.host = el("wujie-app", {}, []);
    this.host.shadowRoot = el("root", {}, [body]);
    this.body = body;
    if (this.path === HOME_PATH) {
      body.add(leaf("account", "视频号ID：sph_test"));
      return;
    }
    if (this.path === LIST_PATH) {
      body.add(leaf("tabs", "视频管理 草稿箱"));
      for (const d of this.drafts) body.add(leaf("draft-row", `${d.shortTitle} 草稿`));
      return;
    }
    const file = el("input", { type: "file", accept: "video/mp4,video/*" });
    file.onchange = () => this.onVideo();
    body.add(file);
    body.add(leaf("tip", "发表视频"));
    if (this.uploaded) this.buildProcessed(body);
    const editor = leaf("input-editor", this.descriptionText ?? "");
    editor.attrs.contenteditable = "true";
    const short = el("input", { placeholder: "请填写短标题，字数建议6-16个字符", class: "short-title", value: this.shortTitle ?? "" });
    short.value = this.shortTitle ?? "";
    const pos = leaf("position-display-wrap", this.place ?? "不显示位置");
    pos.onclick = () => { this.positionOpen = !this.positionOpen; this.rebuild(); };
    body.add(editor); body.add(short); body.add(leaf("lbl", "短标题")); body.add(pos);
    if (this.positionOpen) {
      const opts = el("div", { class: "options" }, ["不显示位置", "深圳市 · 某某大厦"].map((t) => {
        const o = leaf("option-item", t);
        o.onclick = () => { this.place = t; this.positionOpen = false; this.log.push(`place:${t}`); this.rebuild(); };
        return o;
      }));
      body.add(opts);
    }
    const mark = leaf("mark-entry", "选择视频标注");
    mark.onclick = () => { this.markOpen = !this.markOpen; this.rebuild(); };
    body.add(mark);
    if (this.markOpen) {
      body.add(el("div", { class: "mark-list" }, ["含AI生成内容", "含虚构内容"].map((t) => {
        const o = leaf("mark-tag-option", t);
        o.onclick = () => { this.ai = t; this.markOpen = false; this.log.push(`mark:${t}`); this.rebuild(); };
        return o;
      })));
    }
    if (this.ai) body.add(leaf("mark-chosen", `已标注：${this.ai}`));
    const save = leaf("btn", "保存草稿", "button");
    save.onclick = () => this.onSave();
    const publish = leaf("btn", "发表", "button");
    publish.onclick = () => this.log.push("click:发表");
    body.add(save); body.add(publish);
    this.buildDialog(body);
    this.editor = editor; this.short = short;
  }

  buildProcessed(body) {
    const shown = this.o.ratio === "16:9" ? 2 : 1;
    for (let i = 0; i < 2; i++) {
      const card = el("div", { class: "cover-card" }, []);
      const edit = el("div", { class: "edit-btn" }, [leaf("lbl", "编辑", "span")]);
      edit.onclick = () => this.onEdit(i);
      card.add(edit);
      if (this.covers[i]) card.add(leaf("cover-done", "已设置封面"));
      card.hidden = i >= shown; // 9:16 的成片只有一张卡片；另一张留在 DOM 里，看不见
      body.add(card);
    }
  }

  buildDialog(body) {
    const dlg = el("div", { class: "weui-desktop-dialog__bd" }, []);
    const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/*" });
    input.onchange = () => this.onCover(input.files[0]);
    dlg.add(input);
    // 上传中「确认」变成转圈（没有文字）并吞掉点击。
    const ok = leaf("btn", this.coverBusy > 0 ? "" : "确认", "button");
    ok.onclick = () => { if (this.coverBusy > 0) return; this.log.push("click:确认"); this.dialogFor = null; this.rebuild(); };
    dlg.add(ok);
    dlg.hidden = this.dialogFor == null;
    body.add(dlg);
    if (this.popover) {
      const b = leaf("btn", "直接编辑", "button");
      b.onclick = () => { this.popover = false; this.dialogFor = this.popoverFor; this.log.push("click:直接编辑"); this.rebuild(); };
      body.add(b);
    }
  }

  buildLogin() {
    this.host = null;
    const kids = [];
    if (this.loginPhase === "expired") kids.push(leaf("tip", "二维码已失效，点击刷新"));
    else if (this.loginPhase === "scanned") kids.push(leaf("tip", "已扫码，请在手机上确认"));
    else kids.push(leaf("tip", "微信扫码登录视频号助手"));
    const img = el("img", { class: "qrcode", src: `data:image/png;base64,QR${this.qrSerial}` });
    img.naturalWidth = 200; img.naturalHeight = 200; img.src = img.attrs.src;
    kids.push(img);
    this.top = el("body", {}, kids);
    this.host = null;
  }

  rebuild() { this.build(); }

  // ---- 页面行为
  onVideo() {
    this.uploaded = true;
    this.polls = 0;
    this.log.push("upload:video");
    this.rebuild();
  }
  onEdit(i) {
    this.editClicks += 1;
    this.log.push(`click:编辑#${i}`);
    if (this.editClicks <= this.o.ignoreEditClicks) return;
    // 另一张卡片已经有图时，先弹「直接编辑」。
    if (i === 1 && this.covers[0]) { this.popover = true; this.popoverFor = i; } else this.dialogFor = i;
    this.rebuild();
  }
  onCover(file) {
    this.covers[this.dialogFor] = file;
    this.log.push(`cover:${this.dialogFor}:${String(file).split("/").pop()}`);
    this.coverBusy = 2;
    this.rebuild();
  }
  onSave() {
    this.log.push("click:保存草稿");
    this.path = LIST_PATH;
    if (!this.o.dropDraft) this.drafts.push({ shortTitle: this.short.value, description: this.editor.innerText });
    this.rebuild();
  }

  /** 每读一次页面（求值）推进一步：上传处理、封面上传中的转圈都靠读的次数前进，不靠真实时间。 */
  tick() {
    if (this.uploaded && this.path === CREATE_PATH) {
      this.polls += 1;
      if (this.o.expireAfterUpload && this.polls > 1) { this.path = LOGIN_PATH; this.rebuild(); return; }
      if (this.polls === this.o.processingPolls + 1 && !this.o.stuckProcessing) this.rebuild();
    }
    if (this.coverBusy > 0 && --this.coverBusy === 0) this.rebuild();
  }
  processing() { return this.uploaded && (this.o.stuckProcessing || this.polls <= this.o.processingPolls); }

  // ---- 登录页：测试里用这几个动作模拟手机上的操作
  scan() { this.loginPhase = "scanned"; this.rebuild(); }
  confirm() { this.path = HOME_PATH; this.loginPhase = "ok"; this.rebuild(); }
  expireQr() { this.loginPhase = "expired"; this.rebuild(); }
  refreshQr() { this.qrSerial += 1; this.loginPhase = "waiting"; this.rebuild(); }

  // ---- 键盘
  typeText(text) {
    const a = this.active;
    if (!a) throw new Error("没有焦点：先点一下输入框");
    if (a === this.editor || a.className.includes("input-editor")) {
      this.descriptionText = (this.descriptionText ?? "") + (this.o.eatDescription ? text.slice(0, Math.max(1, text.length - 3)) : text);
      this.editor.text = this.descriptionText;
    } else if (a.tag === "input") {
      this.shortTitle = (this.shortTitle ?? "") + text;
      a.value = this.shortTitle;
    }
  }
  clickAt([x, y]) {
    const hit = [this.body, this.top].filter(Boolean).flatMap((r) => [r, ...r.all()]).find((e) => Math.abs(e.getBoundingClientRect().y + 10 - y) < 1 && Math.abs(e.getBoundingClientRect().x + 30 - x) < 1);
    if (!hit) return;
    let e = hit;
    const focusable = (n) => n.tag === "input" || n.className.includes("input-editor");
    if (focusable(hit)) this.active = hit;
    while (e && !e.onclick) e = e.parent;
    e?.onclick?.();
  }
}

/** 假 tab：接口和驱动的 tab 一致（eval / waitFor / click / type / upload / screenshot / url / goto / close）。 */
export function fakeTab(page, { hooks = {} } = {}) {
  const run = (expr) => {
    page.tick();
    const ctx = vm.createContext({ document: page.document, location: page.location, fetch: async () => { throw new Error("离线"); }, FileReader: class {} });
    return vm.runInContext(expr, ctx);
  };
  const plain = async (v) => { const x = await v; return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); };
  const tab = {
    closed: false,
    async eval(fn, ...args) {
      const call = `(${fn})(...${JSON.stringify(args)})`;
      const expr = typeof fn === "string" && args.length === 0 ? fn : call;
      // 页面上「处理中」的字样跟着读的次数走：把它织进 body 的文字里。
      return plain(run(withProgress(page, expr)));
    },
    async waitFor(fn, args = [], options = {}) {
      if (!Array.isArray(args)) { options = args ?? {}; args = []; }
      const { timeout = 30e3, what = "页面元素" } = options;
      // 上限按「轮询次数」算而不是墙钟：机器忙（多份全量测试并发）时每轮变慢，墙钟上限会把「还在处理」误判成超时。
      // 调用方明确给了更短的 timeout（要测超时路径）时才按墙钟。
      const cap = hooks.maxWait ?? 400;
      const end = Date.now() + timeout;
      const maxRounds = Math.ceil(cap / 2);
      let rounds = 0;
      for (;;) {
        const v = await tab.eval(fn, ...args).catch(() => null);
        if (v) return v;
        rounds++;
        if (timeout < cap ? Date.now() > end : rounds > maxRounds) throw new Error(`等不到${what}`);
        await new Promise((r) => setTimeout(r, 2));
      }
    },
    async click(p) { page.clickAt(p); },
    async type(text) { page.typeText(text); },
    async key() {},
    async upload(expr, files) {
      const input = run(expr);
      if (!input) throw new Error("找不到上传控件");
      input.files = files;
      page.log.push(`files:${files.map((f) => f.split("/").pop()).join(",")}`);
      input.onchange?.();
    },
    async screenshot() { return Buffer.from("png"); },
    async url() { return `https://channels.weixin.qq.com${page.path}`; },
    async goto(url) {
      const path = new URL(url).pathname;
      page.log.push(`goto:${path}`);
      if (path === HOME_PATH) page.path = page.o.loggedIn && page.loginPhase !== "expired" ? HOME_PATH : LOGIN_PATH;
      else if (path === LOGIN_PATH) page.path = page.loginPhase === "ok" ? HOME_PATH : LOGIN_PATH;
      else page.path = page.o.loggedIn ? path : LOGIN_PATH;
      page.rebuild();
    },
    async close() { tab.closed = true; },
  };
  return tab;
}

function withProgress(page, expr) {
  if (!page.processing()) return expr;
  return expr.replace(/R\.querySelector\('body'\)\.innerText/g, `(R.querySelector('body').innerText + '\\n上传中 45%\\n生成中')`);
}
