// 测试收尾（ACC-test-cleanup-01）：被 `node --test --import` 预加载进每个测试文件的进程。
// 登记本进程里建过的临时目录（fs.mkdtemp*）和起过的子进程（child_process.spawn 系），
// 进程退出（正常、失败、被超时 SIGTERM/SIGINT 杀掉）时：
//   1. 结束本进程起的、还活着的子进程（守护进程、假 lark-cli 等）；
//   2. 关掉 `--user-data-dir` 落在这些临时目录下的 Chrome（不碰别的 Chrome）；
//   3. 删掉这些临时目录。
// 先 SIGTERM、等一会儿再 SIGKILL：Chrome 被强杀会在 com.google.Chrome.code_sign_clone 留程序副本。
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { sep, resolve } from "node:path";

const dirs = new Set();
const children = new Set();
let done = false;

/** 登记一个要在退出时清理的临时目录。 */
export function trackDir(dir) {
  if (typeof dir === "string" && dir) dirs.add(resolve(dir));
  return dir;
}
/** 登记一个要在退出时结束的子进程。 */
export function trackChild(child) {
  if (child && typeof child.pid === "number") children.add(child);
  return child;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** 目录的所有写法（原路径 + realpath，macOS 的 /var → /private/var）。 */
function roots(list) {
  const out = new Set();
  for (const d of list) {
    out.add(resolve(d));
    out.add(real(d));
  }
  return [...out];
}

/** 列出 `--user-data-dir` 落在 rootDirs 之下的进程：[{pid, userDataDir}]。 */
export function chromeUnder(rootDirs) {
  if (!rootDirs.length) return [];
  let text = "";
  try {
    text = cp.execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const rs = roots(rootDirs);
  const found = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const at = m[2].indexOf("--user-data-dir=");
    if (at < 0) continue;
    const rest = m[2].slice(at + "--user-data-dir=".length);
    const hit = rs.find((r) => rest === r || rest.startsWith(r + sep) || rest.startsWith(r + " --"));
    if (hit) found.push({ pid, userDataDir: hit });
  }
  return found;
}

function killAll(pids, graceMs = 4000) {
  const list = [...new Set(pids)].filter((p) => p !== process.pid);
  for (const p of list) {
    try {
      process.kill(p, "SIGTERM");
    } catch {}
  }
  const end = Date.now() + graceMs;
  while (Date.now() < end && list.some(alive)) sleepSync(50);
  for (const p of list.filter(alive)) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
}

/** 收尾：结束子进程 → 关 Chrome → 删目录。可重复调用。 */
export function cleanupNow() {
  killAll([...children].map((c) => c.pid));
  children.clear();
  const list = [...dirs];
  for (let i = 0; i < 2; i++) {
    const chrome = chromeUnder(list);
    if (!chrome.length) break;
    killAll(chrome.map((c) => c.pid));
  }
  for (const d of list) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
    dirs.delete(d);
  }
}

function finish() {
  if (done) return;
  done = true;
  try {
    cleanupNow();
  } catch {}
}

// —— 接线：只在被 --import 预加载时打补丁（测试里 import 本模块拿 trackDir 也安全：补丁只打一次）。
if (!globalThis.__vkTestCleanupInstalled) {
  globalThis.__vkTestCleanupInstalled = true;

  const wrapMk = (obj, name) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function (...args) {
      const r = orig.apply(this, args);
      if (r && typeof r.then === "function") return r.then((p) => (trackDir(p), p));
      trackDir(r);
      return r;
    };
  };
  wrapMk(fs, "mkdtempSync");
  wrapMk(fs.promises, "mkdtemp");
  const origMkdtemp = fs.mkdtemp;
  fs.mkdtemp = function (prefix, options, cb) {
    const done2 = typeof options === "function" ? options : cb;
    const opts = typeof options === "function" ? undefined : options;
    return origMkdtemp.call(this, prefix, opts, (err, p) => {
      if (!err) trackDir(p);
      done2(err, p);
    });
  };

  for (const name of ["spawn", "fork"]) {
    const orig = cp[name];
    cp[name] = function (...args) {
      return trackChild(orig.apply(this, args));
    };
  }
  syncBuiltinESMExports();

  process.on("exit", finish);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    // once：清理完以默认行为重发信号，退出码仍然是「被信号杀掉」。
    process.once(sig, () => {
      finish();
      process.kill(process.pid, sig);
    });
  }
}

