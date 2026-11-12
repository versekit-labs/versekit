// Chrome CDP 驱动：共享基础设施，不是某个适配器的内部实现。
//
// ported from trustbridge/videos/factory/publishers/browser.mjs（生产验证过的版本）。
// 它固化的规则不是风格问题，见 docs/adapter-contract.md §3：
//   · 复用持久化 profile（登录态、代理、扩展、语言都在里面）
//   · 后台窗口的定时器不许被节流，否则上传/发布会卡死
//   · 点击必须用真实鼠标事件（有些站点忽略 element.click()）
//   · 量坐标之前先 scrollIntoView({behavior:'instant'})（平滑滚动会让坐标错位）
//
// 与最初单例版本的区别（D3/D8）：矩阵运营不能串号，所以一个账号 = 一个 Chrome 实例 =
// 一个 profile = 一个端口；池上限默认 4，超出的排队。同账号的串行由 core 的 lane 负责，
// 驱动只保证「绝不为同一账号开第二个实例」，不做业务加锁。
// 兼容壳 PROFILE / PORT / openTab() 固定走 default 账号，旧调用方一行都不用改。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export const DEFAULT_ACCOUNT = "default";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_CDP_PORT = 9333;
const PORT_TOP = 65000;

/** 旧的固定端口仍是默认账号的端口；其余账号从它后面按摘要分配。 */
function resolveBasePort() {
  const raw = Number(process.env.VK_CDP_PORT ?? DEFAULT_CDP_PORT);
  return Number.isInteger(raw) && raw >= 1024 && raw <= 64000 ? raw : DEFAULT_CDP_PORT;
}

const BASE_PORT = resolveBasePort();

/** 同时最多几个 Chrome 实例。产品上限 4（BLUEPRINT §2.10），环境变量只能调小。 */
export const MAX_POOL = 4;

/**
 * 池上限解析成纯函数，方便单测；非法值（0、负数、小数、非数字）回落到 4 而不是抛错——
 * 配置坏了也不该让守护进程起不来。超过产品上限时按上限截断。
 */
export function poolLimit(raw = process.env.VK_BROWSER_POOL) {
  if (raw === undefined || raw === null || raw === "") return MAX_POOL;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return MAX_POOL;
  return Math.min(n, MAX_POOL);
}

export const POOL_LIMIT = poolLimit();

// ------------------------------------------------------------------ 路径与端口

function stateRoot() {
  // 与 core.paths() 的 state 目录保持一致；驱动不 import core，避免基础包反向依赖。
  return join(process.env.VK_HOME ?? homedir(), ".local", "state", "versekit");
}

function browserRoot() {
  return join(stateRoot(), "browser");
}

function evidenceRoot() {
  return join(stateRoot(), "evidence");
}

/**
 * accountId 会变成目录名，所以必须是「单个路径片段」：路径分隔符、穿越、NUL 一律拒绝。
 * 不做 trim：'acc' 与 ' acc' 是两个账号，静默改名会把两个账号的登录态混在一起。
 */
function requireAccountId(accountId) {
  if (typeof accountId !== "string") throw new TypeError("accountId 必须是字符串（账号 id）");
  if (!accountId.trim()) throw new TypeError("accountId 不能为空");
  if (accountId.length > 128) throw new TypeError("accountId 太长（最多 128 字符）");
  if (accountId === "." || accountId === ".." || /[/\\\0]/.test(accountId)) {
    throw new TypeError(`accountId 里不能有路径分隔符或 ..：${accountId}`);
  }
  return accountId;
}

/** state/browser/<accountId>/：每个账号一份 profile，绝不复用别的账号。 */
export function accountProfile(accountId) {
  const id = requireAccountId(accountId);
  if (id === DEFAULT_ACCOUNT && process.env.VK_CHROME_PROFILE) {
    // 兼容旧配置：单例时代指向哪，default 账号就继续用哪。
    return resolve(process.env.VK_CHROME_PROFILE);
  }
  const root = browserRoot();
  const profile = resolve(join(root, id));
  if (!profile.startsWith(resolve(root) + sep)) throw new TypeError(`accountId 越出了 profile 目录：${accountId}`);
  return profile;
}

/**
 * 端口由 accountId 的 SHA-256 摘要决定：同账号每次相同，不依赖启动顺序或进程内状态。
 * 哈希理论上可能撞车，所以真正启动时还会用 profile 里的标记文件核对归属；被别的账号占了
 * 就顺延探测，宁可用另一个端口，也绝不连到别人的实例上（串号比端口漂移严重得多）。
 */
export function accountPort(accountId) {
  const id = requireAccountId(accountId);
  if (id === DEFAULT_ACCOUNT) return BASE_PORT;
  const digest = createHash("sha256").update(id).digest();
  const offset = digest.readUInt32BE(0) % (PORT_TOP - BASE_PORT);
  return BASE_PORT + 1 + offset;
}

/** 兼容单例时代的导出：现在指向 default 账号。 */
export const PROFILE = accountProfile(DEFAULT_ACCOUNT);
export const PORT = accountPort(DEFAULT_ACCOUNT);

// ------------------------------------------------------------------ Chrome 进程

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** null = 可用；否则一句人能照着做的话（这句会直接出现在 UI 上）。 */
export function browserReady() {
  const chrome = findChrome();
  if (!chrome) return "没有找到 Chrome/Chromium：装一个，或设置 VK_CHROME_BIN 指向它";
  if (process.env.VK_CHROME_BIN && !existsSync(process.env.VK_CHROME_BIN)) return `VK_CHROME_BIN 不存在：${process.env.VK_CHROME_BIN}`;
  return null;
}

const base = (port) => `http://127.0.0.1:${port}`;

async function up(port) {
  try {
    const r = await fetch(`${base(port)}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

const MARKER = ".vk-driver.json";

/** profile 里的归属标记：重启后靠它确认「这个端口上的 Chrome 是这个账号的」。 */
function readMarker(profile) {
  try {
    return JSON.parse(readFileSync(join(profile, MARKER), "utf8"));
  } catch {
    return null;
  }
}

function writeMarker(profile, data) {
  try {
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, MARKER), JSON.stringify(data), { mode: 0o600 });
  } catch {
    /* 标记写不进去不影响启动；只是下次重启不会自动接管，宁可不接管也不能串号 */
  }
}

function removeMarker(profile) {
  try {
    rmSync(join(profile, MARKER), { force: true });
  } catch {
    /* best effort */
  }
}

// 账号 → 实例；端口 → 账号；正在启动的账号 → Promise（同账号并发只起一次）。
const instances = new Map();
const claimedPorts = new Map();
const starting = new Map();

let activeInstances = 0;
const slotWaiters = [];

/** 池满时在这里排号；接到下一个空位才继续，不抛「池满」错误。 */
function acquireSlot() {
  if (activeInstances < POOL_LIMIT) {
    activeInstances += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => slotWaiters.push(resolve));
}

function releaseSlot() {
  const next = slotWaiters.shift();
  if (next) {
    // 空位直接交给排队者，activeInstances 保持不变（名额已转移）。
    next();
    return;
  }
  activeInstances = Math.max(0, activeInstances - 1);
}

function forget(accountId) {
  const instance = instances.get(accountId);
  if (!instance) return null;
  instances.delete(accountId);
  if (instance.port && claimedPorts.get(instance.port) === accountId) claimedPorts.delete(instance.port);
  for (const tab of [...instance.tabs]) {
    try {
      tab.__dispose();
    } catch {
      /* 已经断开的 socket 不用再管 */
    }
  }
  clearTimeout(instance.idleTimer);
  instance.tabs.clear();
  if (instance.slotHeld) {
    instance.slotHeld = false;
    releaseSlot();
  }
  return instance;
}

async function pickPort(accountId, profile) {
  const preferred = accountPort(accountId);
  const span = PORT_TOP - BASE_PORT;
  for (let i = 0; i < 64; i++) {
    const port = BASE_PORT + ((preferred - BASE_PORT + i) % span);
    if (claimedPorts.has(port) && claimedPorts.get(port) !== accountId) continue;
    if (await up(port)) {
      const marker = readMarker(profile);
      // 只接管「标记对得上」的实例；端口上如果住着别人，顺延，绝不借用。
      if (marker?.accountId === accountId && Number(marker.port) === port) {
        return { port, adopted: true, pid: marker.pid ?? null };
      }
      continue;
    }
    return { port, adopted: false, pid: null };
  }
  throw new Error(`账号 ${accountId} 没有可用端口（从 ${preferred} 起探测了 64 个）`);
}

async function startInstance(accountId, { headless = false } = {}) {
  const profile = accountProfile(accountId);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  try {
    chmodSync(profile, 0o700);
  } catch {
    /* 非 POSIX 文件系统上尽力而为 */
  }

  await acquireSlot();
  const instance = { accountId, profile, port: null, pid: null, tabs: new Set(), slotHeld: true, headless };

  try {
    const { port, adopted, pid } = await pickPort(accountId, profile);
    instance.port = port;
    instance.pid = pid;

    if (!adopted) {
      const chrome = process.env.VK_CHROME_BIN ?? findChrome();
      if (!chrome) throw new Error(browserReady() ?? "没有可用的 Chrome");
      if (process.env.VK_CHROME_BIN && !existsSync(chrome)) throw new Error(`VK_CHROME_BIN 不存在：${chrome}`);

      const child = spawn(
        chrome,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          "--no-first-run",
          "--no-default-browser-check",
          ...(headless
            ? [
                "--headless=new",
                "--disable-gpu",
                "--window-size=1600,1000",
                // 小红书会拦 HeadlessChrome UA；伪装成同版本普通 Chrome。
                "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "--disable-blink-features=AutomationControlled",
              ]
            : []),
          // 后台窗口会被节流；不关掉这三个开关，上传到一半会停在原地。
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      instance.pid = child.pid ?? null;
      // 先写标记再等端口：否则另一个进程可能在这段窗口里误以为 profile 空闲。
      writeMarker(profile, { accountId, port, pid: instance.pid, startedAt: Date.now() });

      let spawnError = null;
      child.once("error", (err) => {
        spawnError = err;
      });
      child.once("exit", () => {
        const live = instances.get(accountId);
        if (live?.pid === child.pid) forget(accountId);
      });

      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        if (spawnError) throw new Error(`Chrome 启动失败：${spawnError.message}`);
        if (child.exitCode !== null) throw new Error(`Chrome 启动即退出（退出码 ${child.exitCode}），profile: ${profile}`);
        await sleep(500);
        ready = await up(port);
      }
      if (!ready) throw new Error(`Chrome 没有在端口 ${port} 上启动（profile: ${profile}）`);

      // Chrome 启动时会自带一个 about:blank 标签页；不清掉的话，每次自动化都会
      // 在用户屏幕上留一个空白窗口。
      try {
        const targets = await (await fetch(`${base(port)}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
        for (const t of targets) {
          if (t.type === "page" && /about:blank|^$|chrome:\/\/newtab/.test(t.url)) {
            await fetch(`${base(port)}/json/close/${t.id}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
          }
        }
      } catch {
        /* 清不掉也不影响后续开 tab */
      }
    }

    claimedPorts.set(port, accountId);
    instances.set(accountId, instance);
    return instance;
  } catch (err) {
    if (instance.slotHeld) {
      instance.slotHeld = false;
      releaseSlot();
    }
    if (instance.port && claimedPorts.get(instance.port) === accountId) claimedPorts.delete(instance.port);
    if (instances.get(accountId) !== instance) removeMarker(profile);
    throw err;
  }
}

async function ensureInstance(accountId, opts = {}) {
  const live = instances.get(accountId);
  if (live) {
    // 想看得见（headless:false）却只有一个无头实例时，必须换：否则用户点了
    // 「打开登录窗口」，屏幕上什么都不会出现。
    const wantsVisible = opts.headless === false;
    if (wantsVisible && live.headless) {
      await closeAccount(accountId).catch(() => {});
    } else if (await up(live.port)) {
      return live;
    }
    forget(accountId); // Chrome 已经挂了，重新起
  }
  const pending = starting.get(accountId);
  if (pending) return pending;
  const task = startInstance(accountId, opts).finally(() => starting.delete(accountId));
  starting.set(accountId, task);
  return task;
}

async function closeBrowser(port) {
  const res = await fetch(`${base(port)}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`读取 Chrome 版本失败：HTTP ${res.status}`);
  const { webSocketDebuggerUrl } = await res.json();
  if (!webSocketDebuggerUrl) throw new Error("Chrome 没有返回浏览器级调试地址");
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("连不上 Chrome 浏览器目标")), 5000);
    timer.unref?.();
    ws.onopen = () => {
      clearTimeout(timer);
      resolveOpen();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      rejectOpen(new Error("连不上 Chrome 浏览器目标"));
    };
  });
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  // 等它真的退出：Chrome 是在退出流程里把 cookie 刷到磁盘的，
  // 400ms 就返回会让后面的读取（和下次启动）看不到刚登录的会话。
  await sleep(400);
  await waitDown(port, 8e3);
  try {
    ws.close();
  } catch {
    /* 浏览器先断了也无所谓 */
  }
}

async function waitDown(port, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!(await up(port))) return true;
    await sleep(200);
  }
  return !(await up(port));
}

function killByPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return;
  try {
    process.kill(n, "SIGTERM");
  } catch {
    /* 已经退了 */
  }
}

/**
 * Chrome 通过 Browser.close 退出后，SingletonLock 偶尔会留在 profile 里（Chrome 157 实测）。
 * 下一次用同一个 profile 启动会直接以退出码 21（PROFILE_IN_USE）死掉——账号看起来「第二次登录
 * 必失败」。只在进程确实退出后清，别在它还活着时把锁拆了。
 */
async function waitPidGone(pid, timeout = 3e3) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return true;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      process.kill(n, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function clearStaleSingleton(profile, pid) {
  if (!(Number.isInteger(Number(pid)) && Number(pid) > 1)) return;
  try {
    process.kill(Number(pid), 0);
    return; // 进程还在，锁不能动
  } catch {
    /* 已经退出，可以清理 */
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(profile, name), { force: true });
  }
}

// ------------------------------------------------------------------ tab

/**
 * 没有标签页时不要立刻关浏览器：登录态要复用，适配器也可能马上再开一个 tab。
 * 空闲 10 分钟后再收，避免用户屏幕上堆一排空窗口。
 */
const IDLE_CLOSE_MS = 10 * 60e3;
function scheduleIdleClose(instance) {
  if (instance.tabs.size > 0) return;
  clearTimeout(instance.idleTimer);
  instance.idleTimer = setTimeout(() => {
    if (instance.tabs.size === 0) {
      closeAccount(instance.accountId).catch(() => {});
    }
  }, IDLE_CLOSE_MS);
  instance.idleTimer.unref?.();
}

async function newTab(instance) {
  clearTimeout(instance.idleTimer);
  let res;
  try {
    res = await fetch(`${base(instance.port)}/json/new?${encodeURIComponent("about:blank")}`, {
      method: "PUT",
      signal: AbortSignal.timeout(10e3),
    });
  } catch (err) {
    throw new Error(`连不上端口 ${instance.port} 的 Chrome：${err.message}`);
  }
  if (!res.ok) throw new Error(`开新 tab 失败：HTTP ${res.status}（端口 ${instance.port}）`);
  const target = await res.json();
  if (!target.webSocketDebuggerUrl) throw new Error(`Chrome 没有返回 tab 调试地址（端口 ${instance.port}）`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("连不上 Chrome 调试端口")), 10e3);
    timer.unref?.();
    ws.onopen = () => {
      clearTimeout(timer);
      resolveOpen();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      rejectOpen(new Error("连不上 Chrome 调试端口"));
    };
  });

  let n = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();

  const rejectPending = (reason) => {
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(reason);
    }
  };

  ws.onmessage = (m) => {
    let d;
    try {
      d = JSON.parse(m.data);
    } catch {
      return;
    }
    if (d.id) {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.error ? p.reject(new Error(`${p.method}: ${d.error.message}`)) : p.resolve(d.result);
      return;
    }
    for (const fn of listeners) fn(d);
  };

  ws.onclose = () => {
    closed = true;
    rejectPending(new Error("tab 连接已断开"));
  };
  ws.onerror = () => {
    /* 具体错误由 onclose / 各次 send 的超时体现 */
  };

  const send = (method, params = {}, timeout = 60e3) =>
    new Promise((resolveSend, rejectSend) => {
      if (closed) return rejectSend(new Error("tab 已关闭"));
      const id = ++n;
      const timer = setTimeout(() => {
        if (pending.delete(id)) rejectSend(new Error(`${method} 超时`));
      }, timeout);
      timer.unref?.();
      pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectSend(err);
        },
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        rejectSend(err);
      }
    });

  /** 等一个 CDP 事件；goto 用它把「导航」和「load 完成」分成两件事。 */
  function waitEvent(method, { timeout = 30e3, what = method } = {}) {
    return new Promise((resolveEvent, rejectEvent) => {
      const on = (d) => {
        if (d.method !== method) return;
        clearTimeout(timer);
        listeners.delete(on);
        resolveEvent(d.params);
      };
      const timer = setTimeout(() => {
        listeners.delete(on);
        rejectEvent(new Error(`等不到${what}`));
      }, timeout);
      timer.unref?.();
      listeners.add(on);
    });
  }

  const tab = {
    accountId: instance.accountId,
    port: instance.port,
    send,

    /**
     * 页面内求值。函数会被序列化后调用；字符串在没有参数时按表达式求值，
     * 这样 `tab.eval("location.href")` 与 `tab.eval(() => location.href)` 都成立。
     */
    async eval(fn, ...args) {
      const call = `(${fn})(...${JSON.stringify(args)})`;
      const expression = typeof fn === "string" && args.length === 0 ? fn : call;
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },

    /**
     * 轮询到真值为止。导航途中执行上下文会被销毁，单次求值报错不能当作「条件不成立又没
     * 有解释」，所以保留最后一次错误，超时时一起抛出来（规则 12：失败要能排障）。
     */
    async waitFor(fn, args = [], options = {}) {
      if (!Array.isArray(args)) {
        options = args ?? {};
        args = [];
      }
      const { timeout = 30e3, every = 500, what = "页面元素" } = options;
      const end = Date.now() + timeout;
      let lastError = null;
      for (;;) {
        try {
          const v = await tab.eval(fn, ...args);
          if (v) return v;
          lastError = null;
        } catch (err) {
          lastError = err;
        }
        if (Date.now() > end) {
          throw new Error(`等不到${what}${lastError ? `（最后一次错误：${lastError.message}）` : ""}`);
        }
        await sleep(every);
      }
    },

    /** 元素中心点（页面坐标 → 视口坐标），滚动必须是 instant，平滑滚动会让坐标错位。 */
    point(find, arg) {
      if (typeof find !== "function") throw new TypeError("point 需要查找函数");
      return tab.eval(
        `(() => { const e = (${String(find)})(${JSON.stringify(arg)}); if (!e) return null;
           e.scrollIntoView({ block: 'center', behavior: 'instant' });
           const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
      );
    },

    /** 真实鼠标：moved → pressed → released。element.click() 会被部分站点忽略。 */
    async click([x, y]) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("click 需要 [x, y] 两个数字坐标");
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(120);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    },

    /**
     * 按文案点按钮。同一账号可能被平台切成中文或英文（规则 5），所以传数组、任一命中即可。
     * 找不到时把当前页面的候选文案一起抛出来——适配器挂了，人得知道当时按钮叫什么。
     *
     * opts: { selector?, timeout?, every?, contains?, what? }
     */
    async clickText(texts, options = {}) {
      const wanted = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
      if (!wanted.length) throw new TypeError("clickText 需要至少一个非空文案（字符串或字符串数组）");
      const {
        selector = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], label, summary',
        timeout = 30e3,
        every = 500,
        contains = false,
        what = "按钮",
      } = options;

      const end = Date.now() + timeout;
      let candidates = [];
      let lastError = null;
      for (;;) {
        try {
          const found = await tab.eval(
            (sel, targets, useContains) => {
              const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
              const wanted = targets.map(norm);
              const seen = [];
              for (const el of document.querySelectorAll(sel)) {
                const text = norm(el.innerText || el.textContent);
                if (!text) continue;
                if (seen.length < 12 && !seen.includes(text)) seen.push(text.slice(0, 40));
                const hit = wanted.some((w) => (useContains ? text.includes(w) : text === w));
                if (!hit) continue;
                el.scrollIntoView({ block: "center", behavior: "instant" });
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) continue;
                return { point: [r.x + r.width / 2, r.y + r.height / 2], text };
              }
              return { point: null, candidates: seen };
            },
            selector,
            wanted,
            contains,
          );
          if (found?.point) {
            await tab.click(found.point);
            return found.text;
          }
          candidates = found?.candidates ?? [];
          lastError = null;
        } catch (err) {
          lastError = err;
        }
        if (Date.now() > end) {
          const pageUrl = await tab.url().catch(() => "");
          const list = candidates.length ? candidates.join(" / ") : "（页面上没有可点的候选项）";
          throw new Error(
            `等不到${what}「${wanted.join(" / ")}」；候选：${list}${pageUrl ? `；当前页面：${pageUrl}` : ""}` +
              (lastError ? `（最后一次错误：${lastError.message}）` : ""),
          );
        }
        await sleep(every);
      }
    },

    type: (text) => send("Input.insertText", { text: String(text) }),

    /** 回车、Tab、Escape 都走这里；键码缺省时按常见键补齐，避免适配器各自记数字。 */
    async key(key, code = key, keyCode) {
      const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
      const vk = keyCode ?? codes[key] ?? 0;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
    },

    /** Draft.js 在 macOS 上对合成 Cmd+A 不认，必须用 commands:['selectAll']。 */
    async selectAll() {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
    },

    /**
     * 清空富文本编辑器并断言（规则 7）。assertEmptyFn 返回 true 或空字符串表示已清空，
     * false / 非空字符串表示还留着内容；断言在短轮询里重试，给 React 一点提交时间。
     */
    async clear(assertEmptyFn, { timeout = 2000, every = 100 } = {}) {
      if (assertEmptyFn !== undefined && typeof assertEmptyFn !== "function") throw new TypeError("clear 的断言必须是一个返回布尔值或文本的函数");
      await tab.selectAll();
      await tab.key("Backspace", "Backspace", 8);
      await sleep(120);
      if (!assertEmptyFn) return;
      const end = Date.now() + timeout;
      let last;
      for (;;) {
        last = await tab.eval(assertEmptyFn);
        if (last === true || last === "") return;
        if (Date.now() > end) {
          const shown = typeof last === "string" ? last.slice(0, 120) : String(last);
          throw new Error(`清空失败：编辑器里还有内容「${shown}」`);
        }
        await sleep(every);
      }
    },

    /** 等文件控件出现再 setFileInputFiles；先校验文件存在，错误信息里带路径。 */
    async upload(selectorExpr, files) {
      if (typeof selectorExpr !== "string" || !selectorExpr.trim()) throw new TypeError("upload 需要一个求值到文件控件的表达式");
      if (!Array.isArray(files) || !files.length) throw new TypeError("upload 需要至少一个文件路径");
      for (const file of files) {
        if (typeof file !== "string" || !isAbsolute(file)) throw new TypeError(`上传路径必须是绝对路径：${file}`);
        if (!existsSync(file)) throw new Error(`上传文件不存在：${file}`);
      }
      const end = Date.now() + 30e3;
      let objectId = null;
      while (!objectId && Date.now() < end) {
        const r = await send("Runtime.evaluate", { expression: selectorExpr });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        objectId = r.result.objectId ?? null;
        if (!objectId) await sleep(300);
      }
      if (!objectId) throw new Error("找不到上传控件（30 秒内没有出现）");
      await send("DOM.enable");
      await send("DOM.setFileInputFiles", { objectId, files });
    },

    /**
     * 点封闭 shadow root 里的按钮（小红书 xhs-publish-btn）：页面 JS 看不见，CDP pierce 能看见。
     * 文案同样接受数组（中英双匹配）；仍用真实鼠标点击。
     */
    async clickInShadow(host, text) {
      if (typeof host !== "string" || !host.trim()) throw new TypeError("clickInShadow 需要 host 标签名");
      const texts = (Array.isArray(text) ? text : [text]).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
      if (!texts.length) throw new TypeError("clickInShadow 需要按钮文案");
      await send("DOM.enable");
      const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
      const find = (node, pred) => {
        if (!node) return null;
        if (pred(node)) return node;
        for (const c of node.children ?? []) {
          const hit = find(c, pred);
          if (hit) return hit;
        }
        for (const s of node.shadowRoots ?? []) {
          const hit = find(s, pred);
          if (hit) return hit;
        }
        return null;
      };
      const textOf = (node) => {
        if (!node) return "";
        if (node.nodeType === 3) return node.nodeValue ?? "";
        return (node.children ?? []).map(textOf).join(" ");
      };
      const el = find(root, (n) => (n.nodeName || "").toUpperCase() === host.toUpperCase());
      if (!el) throw new Error(`找不到 <${host}>`);

      const wanted = new Set(texts.map((t) => t.toLowerCase()));
      const seen = [];
      const btn = find(el, (n) => {
        if ((n.nodeName || "").toUpperCase() !== "BUTTON") return false;
        const label = textOf(n).replace(/\s+/g, " ").trim();
        if (label && seen.length < 12) seen.push(label);
        return wanted.has(label.toLowerCase());
      });
      if (!btn) throw new Error(`<${host}> 里找不到「${texts.join(" / ")}」按钮；候选：${seen.join(" / ") || "（没有按钮）"}`);

      // 先把按钮滚进视口再量 quad；shadow 里没有页面级 API，只能对节点调用。
      try {
        const { object } = await send("DOM.resolveNode", { nodeId: btn.nodeId });
        if (object?.objectId) {
          await send("Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: "function(){ this.scrollIntoView({ block: 'center', behavior: 'instant' }); }",
          });
          await sleep(100);
        }
      } catch {
        /* 节点不可解析时仍然尝试量 quad，失败会给出更具体的错误 */
      }
      const { quads } = await send("DOM.getContentQuads", { nodeId: btn.nodeId });
      if (!quads?.length) throw new Error(`<${host}> 的「${texts.join(" / ")}」按钮不可见`);
      const xs = [0, 2, 4, 6].map((i) => quads[0][i]);
      const ys = [1, 3, 5, 7].map((i) => quads[0][i]);
      await tab.click([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
    },

    /**
     * 读页面自己发出的 JSON 响应（合规的采集方式：不逆向签名，只读页面已签好的那次请求）。
     * match 对响应 URL 生效，返回 [{url, body}]。
     */
    async collectJson(match, run, { timeout = 45e3, until = null } = {}) {
      await send("Network.enable");
      const found = [];
      const requests = new Map();
      const onEvent = (d) => {
        if (d.method !== "Network.responseReceived") return;
        match.lastIndex = 0; // 带 /g 的正则 test 有状态，先归零再匹配
        if (match.test(d.params.response.url)) requests.set(d.params.requestId, d.params.response.url);
      };
      listeners.add(onEvent);
      const drain = setInterval(async () => {
        for (const [requestId, url] of [...requests]) {
          requests.delete(requestId);
          try {
            const r = await send("Network.getResponseBody", { requestId });
            found.push({ url, body: JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString() : r.body) });
          } catch {
            /* body 已被回收 / 不是 JSON —— 下一次刷新会再拿 */
          }
        }
      }, 500);
      drain.unref?.();
      try {
        await run();
        const end = Date.now() + timeout;
        while (!until?.(found) && Date.now() < end) await sleep(500);
      } finally {
        clearInterval(drain);
        listeners.delete(onEvent);
      }
      return found;
    },

    /** 读某个域名下的 cookie。登录态判定不能只看页面文案：页面会重载、文案会变。 */
    async cookies(domain = null) {
      // 不 enable 的话 getCookies 会静默返回空数组——之前就是这样误判过登录态。
      await send("Network.enable");
      const res = await send("Network.getCookies", domain ? { urls: [domain] } : {});
      return (res?.cookies ?? []).map((c) => ({ name: c.name, domain: c.domain, value: c.value, expires: c.expires }));
    },

    async screenshot() {
      return Buffer.from((await send("Page.captureScreenshot")).data, "base64");
    },

    /** 导航并等 load；返回时页面已经稳定，而不是「navigate 发出去就算完」。 */
    async goto(url, { timeout = 30e3, waitUntil = "load" } = {}) {
      if (typeof url !== "string" || !url.trim()) throw new TypeError("goto 需要 URL 字符串");

      // 只改 hash 的「导航」不会触发 load，等 load 会白等到超时。SPA 里这是常态。
      const [base, hash] = url.split("#");
      if (hash != null) {
        const current = await tab.eval("location.href").catch(() => "");
        if (current.split("#")[0] === base) {
          await tab.eval(`location.hash = ${JSON.stringify(`#${hash}`)}`);
          return;
        }
      }

      await send("Page.enable");
      if (waitUntil === "domcontentloaded") {
        // 重页面（小红书登录页 4 秒才 load）只要 DOM 就绪就能继续：
        // 二维码是页面自己的异步请求，跟 load 事件没有先后关系。
        await tab.eval("document.readyState");
      }
      const loadedEvent = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
      const loaded = waitEvent(loadedEvent, { timeout, what: `页面加载（${url}）` });
      loaded.catch(() => {}); // 下面若因 errorText 提前抛出，别留下未处理的 rejection
      const res = await send("Page.navigate", { url });
      if (res?.errorText) throw new Error(`打不开 ${url}：${res.errorText}`);
      await loaded;
    },

    /** 当前地址；适配器用它判断是否被踢到 /login。 */
    async url() {
      return tab.eval("location.href");
    },

    /** 只关这个 tab，Chrome 实例和别的 tab 都不动。 */
    async close() {
      if (closed) return;
      closed = true;
      instance.tabs.delete(tab);
      scheduleIdleClose(instance);
      try {
        ws.close();
      } catch {
        /* 已经断了 */
      }
      try {
        await fetch(`${base(instance.port)}/json/close/${encodeURIComponent(target.id)}`, { signal: AbortSignal.timeout(5000) });
      } catch {
        /* 实例先退出了也无妨，tab 已经没了 */
      }
    },
  };

  // closeAccount 关实例时用：只断 socket，不再向可能已经退出的浏览器发 HTTP。
  Object.defineProperty(tab, "__dispose", {
    enumerable: false,
    value: () => {
      closed = true;
      instance.tabs.delete(tab);
      rejectPending(new Error("tab 已关闭"));
      try {
        ws.close();
      } catch {
        /* 已经断了 */
      }
    },
  });

  try {
    await send("Page.bringToFront");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch (err) {
    tab.__dispose();
    throw err;
  }

  clearTimeout(instance.idleTimer);
  instance.tabs.add(tab);
  return tab;
}

// ------------------------------------------------------------------ 对外入口

/**
 * 用该账号的 profile 打开（或复用）一个 tab。
 * 复用粒度是 Chrome 实例：同账号已有实例就只开新 tab，绝不另起一个实例（那会串登录态）。
 */
export async function openAccount(options = {}) {
  if (!options || typeof options !== "object") throw new TypeError("openAccount 需要 { accountId, url?, headless? }");
  const { accountId, url, headless = false, reuse = false } = options;
  const id = requireAccountId(accountId);
  if (url !== undefined && url !== null) {
    if (typeof url !== "string" || !url.trim()) throw new TypeError("url 必须是非空字符串（或省略）");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError(`url 不是合法地址：${url}`);
    }
    if (!["http:", "https:", "about:"].includes(parsed.protocol)) throw new TypeError(`url 只支持 http/https：${url}`);
  }

  const instance = await ensureInstance(id, { headless });
  // reuse：复用已有标签页。传字符串时按 URL 匹配，避免拿到 about:blank
  // 这种空页（会把「已登录」误判成未登录）。
  let existing = null;
  if (typeof reuse === "string") {
    for (const t of instance.tabs) {
      const here = await t.url().catch(() => "");
      if (here.includes(reuse)) {
        existing = t;
        break;
      }
    }
  } else if (reuse) {
    existing = [...instance.tabs][0] ?? null;
  }
  if (existing) {
    try {
      if (url) await existing.goto(url);
      return existing;
    } catch {
      /* 旧的废了就开新的 */
    }
  }
  const tab = await newTab(instance);
  try {
    if (url) await tab.goto(url);
  } catch (err) {
    await tab.close().catch(() => {});
    throw err;
  }
  return tab;
}

/** 兼容壳：旧代码没有账号概念，统一落到 default 账号。 */
export async function openTab(url) {
  return openAccount({ accountId: DEFAULT_ACCOUNT, url });
}

/**
 * 关掉该账号的 Chrome 实例（daemon 退出时用）。tab.close() 只关 tab，这里才关浏览器。
 * 进程重启后实例表是空的，所以还会读 profile 里的标记做一次「认领后关闭」。
 */
export async function closeAccount(accountId) {
  const id = requireAccountId(accountId);
  const instance = instances.get(id);

  if (!instance) {
    const profile = accountProfile(id);
    const marker = readMarker(profile);
    if (!marker || marker.accountId !== id || !Number.isInteger(Number(marker.port))) return false;
    const port = Number(marker.port);
    try {
      await closeBrowser(port);
    } catch {
      /* 下面用 pid 兜底 */
    }
    if (!(await waitDown(port, 5e3))) killByPid(marker.pid);
    await waitPidGone(marker.pid, 2e3);
    clearStaleSingleton(profile, marker.pid);
    removeMarker(profile);
    return true;
  }

  await Promise.allSettled([...instance.tabs].map((t) => t.close()));
  try {
    await closeBrowser(instance.port);
  } catch {
    /* 下面用 pid 兜底 */
  }
  const marker = readMarker(instance.profile);
  const pid = instance.pid ?? marker?.pid;
  if (!(await waitDown(instance.port, 5e3))) {
    killByPid(pid);
    await waitDown(instance.port, 2e3);
  }
  if (!(await waitPidGone(pid, 2e3))) {
    killByPid(pid);
    await waitPidGone(pid, 2e3);
  }
  clearStaleSingleton(instance.profile, pid);
  forget(id);
  removeMarker(instance.profile);
  return true;
}

// ------------------------------------------------------------------ 取证

let lastStamp = 0;

/** 同一毫秒内连续取两张现场也要拿到不同文件名。 */
function nextStamp() {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

/**
 * 失败留现场（规则 12）：state/evidence/<accountId>/<tag>-<ts>.png。
 * 只建目录不建文件——截图由适配器写进来；目录 0700，截图里可能有登录态。
 * tag 会被清洗成安全文件名，适配器可以传平台/步骤名，不用关心文件系统。
 */
/**
 * 这个账号是不是已经有一个活着的浏览器（通常是用户正开着的登录窗口）。
 *
 * 适配器的 check() 以前一律 closeAccount()，遇到「用户正在登录」就会把人家的窗口关掉；
 * 有了这个探针，check 只在「自己新建的无头实例」上做清理。
 */
export function hasLiveBrowser(accountId) {
  const id = requireAccountId(accountId);
  const live = instances.get(id);
  return Boolean(live && live.tabs?.size);
}

export function evidencePath(accountId, tag = "evidence") {
  const id = requireAccountId(accountId);
  const dir = join(evidenceRoot(), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* 非 POSIX 文件系统上尽力而为 */
  }
  const cleaned = String(tag ?? "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60);
  const safe = cleaned || "evidence";
  return join(dir, `${safe}-${nextStamp()}.png`);
}
