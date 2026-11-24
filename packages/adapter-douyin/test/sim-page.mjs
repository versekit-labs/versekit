// 离线模拟站 + stub driver：不开 Chrome、不联网，按页面函数的名字接管 `tab.eval / point / waitFor`。
//
// 页面函数（src/page.mjs）是顶层具名函数，真跑时被序列化送进 Chrome；这里不序列化，而是用 `fn.name`
// 找到对应的模拟行为。模拟的页面结构、文案与 fixtures/*.html 一致（test 里另有一条静态检查钉住两边没有跑偏）。
// 时间是假的：sleep 只推进 clock，视频「上传」在 clock 到点后才算完成，所以测试瞬间跑完、结果可复现。
//
// faults 是故意造的故障，每一种对应一条验收口径里的失败路径。

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as page from "../src/page.mjs";

const PATH = {
  upload: "/creator-micro/content/upload",
  publish: "/creator-micro/content/post/video",
  manage: "/creator-micro/content/manage",
  home: "/creator-micro/home",
  login: "/login",
};

export function createSim({ clockStart = Date.now(), evidenceDir, faults = {} } = {}) {
  const clock = { t: clockStart };
  const site = {
    path: "/",
    drafts: [],
    draftsOpen: false,
    form: { title: "", desc: "", coverSrc: "", selected: false, focus: null },
    modal: null,
    uploadedAt: null,
    uploadedFile: null,
    coverTip: false,
    published: false,
    log: [],
    opened: 0,
    closed: 0,
    faults: { ...faults },
    shots: [],
  };
  const log = (s) => site.log.push(s);
  const mode = () => site.faults.mode ?? "ok";

  const sleep = async (ms) => {
    clock.t += ms;
  };
  const now = () => clock.t;

  const goto = (url) => {
    const u = new URL(url);
    log(`goto ${u.pathname}`);
    site.path = mode() === "login" && u.pathname !== PATH.login ? PATH.login : u.pathname;
    if (site.path === PATH.manage) site.draftsOpen = false;
    if (site.path === PATH.upload) site.form = { title: "", desc: "", coverSrc: "", selected: false, focus: null };
  };

  const riskHere = () => {
    const f = site.faults;
    if (site.path === PATH.upload && f.riskOn === "upload") return true;
    if (site.path === PATH.manage && f.riskOn === "manage") return true;
    if (site.path === PATH.home && mode() === "risk") return true;
    if (site.path === PATH.publish && f.riskOn === "save" && site.faults._saveClicked) return true;
    if (site.path === PATH.publish && f.riskOn === "publish-page") return true;
    return false;
  };

  const uploadDone = () => site.uploadedAt != null && clock.t >= site.uploadedAt + (site.faults.uploadMs ?? 30e3);

  // 每个页面函数一个模拟实现；键 = 函数名。
  const evalTable = {
    loginShown: () => site.path === PATH.login,
    riskText: () => (riskHere() ? "滑块" : ""),
    pageText: () => `作品管理 ${site.path === PATH.manage && site.draftsOpen ? site.drafts.map((d) => d.title).join("\n") : ""}`,
    uploadInputReady: () => site.path === PATH.upload && site.faults.noUploadInput !== true,
    onPublishPage: () => site.path === PATH.publish,
    uploadState: () => (site.path !== PATH.publish ? "" : site.faults.uploadFail ? "failed" : uploadDone() ? "done" : ""),
    titleInputReady: () => site.path === PATH.publish && site.faults.noTitleInput !== true,
    titleValue: () => (site.path === PATH.publish ? site.form.title : null),
    titleEmpty: () => site.form.title === "",
    descEditorReady: () => site.path === PATH.publish,
    descText: () => site.form.desc,
    descEmpty: () => site.form.desc.trim() === "",
    removeOverlays: () => 0,
    coverImageSrc: () => site.form.coverSrc,
    coverModalOpen: () => Boolean(site.modal),
    coverModalGone: () => !site.modal,
    coverDoneReady: () => Boolean(site.modal) && site.modal.file != null && clock.t >= site.modal.readyAt,
    textVisible: () => site.coverTip,
    countOnPage: (needle) => (site.path === PATH.manage && site.draftsOpen ? site.drafts.filter((d) => d.title.includes(needle)).length : 0),
    countExceeds: (needle, min) => site.path === PATH.manage && site.draftsOpen && site.drafts.filter((d) => d.title.includes(needle)).length > min,
    firstDraftHref: (needle) => (site.drafts.find((d) => d.title.includes(needle)) ? `https://sim.local/draft/${site.drafts.length}` : ""),
    saveOutcome: () => (site.path === PATH.manage ? "manage" : site.coverTip ? "cover" : ""),
    homeState: () => (site.path === PATH.login ? "login" : mode() === "limited" ? "limited" : mode() === "risk" ? "risk" : site.faults.homeBlank ? "" : "ready"),
  };

  // point() 返回元素的「身份」，click() 按身份执行点击。找不到返回 null。
  const pointTable = {
    findLeaf: (texts) => {
      if (page.T.draftsTab.includes(texts[0])) return site.path === PATH.manage && site.faults.noDraftsTab !== true ? "draftsTab" : null;
      if (page.T.coverEdit.includes(texts[0])) return site.path === PATH.publish && site.faults.noCoverEntry !== true ? "coverEdit" : null;
      if (page.T.coverPortrait.includes(texts[0])) return site.modal ? "portraitTab" : null;
      return null;
    },
    findTitleInput: () => (site.path === PATH.publish ? "title" : null),
    findDescEditor: () => (site.path === PATH.publish ? "desc" : null),
    findCoverArea: () => (site.path === PATH.publish && site.faults.noCoverEntry !== true ? "coverArea" : null),
    findCoverDone: () => (site.modal ? "coverDone" : null),
    findModalButton: () => (site.modal || site.coverTip ? "confirm" : null),
    findRecommendCover: () => (site.coverTip ? "recommend" : null),
    findButton: (texts) => {
      if (site.path !== PATH.publish) return null;
      if (texts.includes("暂存离开")) return site.faults.noSaveButton ? null : "save";
      if (texts.includes("发布")) return "publish";
      return null;
    },
  };

  const clickTable = {
    draftsTab: () => {
      site.draftsOpen = true;
      log("open drafts");
    },
    coverEdit: () => {
      site.modal = { file: null, readyAt: Infinity };
      log("open cover modal");
    },
    coverArea: () => clickTable.coverEdit(),
    portraitTab: () => {},
    title: () => {
      site.form.focus = "title";
    },
    desc: () => {
      site.form.focus = "desc";
    },
    coverDone: () => {
      if (!site.modal || site.modal.file == null || clock.t < site.modal.readyAt) return;
      log("cover done");
      if (site.faults.coverNeverCloses) return;
      site.form.coverSrc = `file:${site.modal.file}`;
      site.modal = null;
    },
    confirm: () => {
      log("confirm");
      if (site.faults.coverNeverCloses) site.modal = null;
    },
    recommend: () => {
      log("recommend cover");
      site.form.coverSrc = "data:recommended";
      site.coverTip = false;
    },
    save: () => {
      log("click save-draft");
      site.faults._saveClicked = true;
      if (site.faults.coverRequired && !site.form.coverSrc) {
        site.coverTip = true;
        return;
      }
      if (site.faults.coverAlwaysRequired) {
        site.coverTip = true;
        return;
      }
      if (site.faults.riskOn === "save") return;
      if (site.faults.dropDraft !== true) site.drafts.push({ title: site.form.title, body: site.form.desc });
      if (site.faults.stayOnPage !== true) site.path = PATH.manage;
      site.draftsOpen = false;
    },
    publish: () => {
      site.published = true;
      log("click PUBLISH");
    },
  };

  function makeTab({ count = true } = {}) {
    if (count) site.opened += 1;
    const tab = {
      send: async (method) => {
        log(`cdp ${method}`);
      },
      goto: async (url) => goto(url),
      url: async () => `https://sim.local${site.path}`,
      eval: async (fn, ...args) => {
        const impl = evalTable[fn.name];
        if (!impl) throw new Error(`模拟页没有实现页面函数 ${fn.name}`);
        return impl(...args);
      },
      waitFor: async (fn, args = [], options = {}) => {
        if (!Array.isArray(args)) {
          options = args ?? {};
          args = [];
        }
        const { timeout = 30e3, every = 500, what = "页面元素" } = options;
        const end = clock.t + timeout;
        for (;;) {
          const v = await tab.eval(fn, ...args).catch(() => false);
          if (v) return v;
          if (clock.t > end) throw new Error(`等不到${what}`);
          clock.t += every;
        }
      },
      point: async (find, arg) => {
        const impl = pointTable[find.name];
        if (!impl) throw new Error(`模拟页没有实现查找函数 ${find.name}`);
        const id = impl(arg);
        return id ? { id } : null;
      },
      click: async (p) => {
        if (!p?.id) throw new TypeError("click 需要 point() 的结果");
        clickTable[p.id]();
      },
      type: async (text) => {
        const f = site.form.focus;
        if (f === "title") site.form.title += String(text).slice(0, site.faults.titleMax ?? Infinity);
        else if (f === "desc") {
          if (site.faults.dropTopics && /^#/.test(text)) return;
          site.form.desc += text;
        }
        log(`type ${f}`);
      },
      key: async (key) => {
        if (key === "Enter" && site.form.focus === "desc") site.form.desc += "\n";
        if (key === "Backspace" && site.form.selected) {
          if (site.form.focus === "title") site.form.title = "";
          if (site.form.focus === "desc") site.form.desc = "";
          site.form.selected = false;
        }
      },
      selectAll: async () => {
        site.form.selected = true;
      },
      clear: async (assertEmpty) => {
        await tab.selectAll();
        await tab.key("Backspace");
        if (assertEmpty && !(await tab.eval(assertEmpty))) throw new Error("清空失败");
      },
      upload: async (expr, files) => {
        if (expr === page.UPLOAD_INPUT_EXPR) {
          site.uploadedFile = files[0];
          site.uploadedAt = clock.t;
          log("upload video");
          goto(`https://sim.local${PATH.publish}`);
        } else if (expr === page.COVER_INPUT_EXPR) {
          site.modal.file = files[0];
          site.modal.readyAt = clock.t + 3000;
          log("upload cover");
        } else throw new Error("未知的上传控件表达式");
      },
      screenshot: async () => Buffer.from("simulated-screenshot"),
      close: async () => {
        site.closed += 1;
      },
    };
    return tab;
  }

  const driver = {
    sleep,
    openAccount: async ({ accountId }) => {
      if (site.faults.openFails) throw new Error("Chrome 起不来");
      log(`openAccount ${accountId}`);
      return makeTab();
    },
    /** 只查找、不新建：模拟「用户已经打开的登录窗口」。windowOpen=false 就是窗口不在。不计入 site.opened。 */
    findOpenTab: async () => (site.windowOpen === false ? null : makeTab({ count: false })),
    evidencePath: (accountId, tag) => {
      const dir = join(evidenceDir, accountId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${tag}-${site.shots.length + 1}.png`);
      site.shots.push(path);
      return path;
    },
    browserReady: () => null,
  };

  return { site, driver, clock, sleep, now, goto };
}

