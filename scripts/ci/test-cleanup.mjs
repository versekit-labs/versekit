// 测试收尾（ACC-test-cleanup-01）：被 `node --test --import` 预加载进每个测试文件的进程。
// 登记本进程里建过的临时目录（fs.mkdtemp*）和起过的子进程（child_process.spawn 系），
// 进程退出（正常、失败、被超时 SIGTERM/SIGINT 杀掉）时：
//   1. 结束本进程起的、还活着的子进程（守护进程、假 lark-cli 等）；
//   2. 关掉 `--user-data-dir` 落在这些临时目录下的 Chrome（不碰别的 Chrome）；
//   3. 删掉这些临时目录。
// 先 SIGTERM、等一会儿再 SIGKILL：Chrome 被强杀会在 com.google.Chrome.code_sign_clone 留程序副本。
import { readEnv } from "../../packages/core/src/env.mjs";
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { sep, resolve, dirname, basename, join } from "node:path";

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

// 测试里为了 unix socket 路径够短，把 mkdtemp 的前缀写死在 /tmp 下。全量测试（scripts/ci/test-all.mjs）给了独占根目录
// （HIFABU_TEST_ROOT，也在 /tmp 下、名字很短），这里把 /tmp 下的 mkdtemp 前缀改到根目录里：
// 路径只多几个字符，而这些目录从此归本次全量测试独有——并发的另一份全量测试不会把它们当成自己的残留，也不会误删。
const testRoot = readEnv("HIFABU_TEST_ROOT");
const TEST_ROOT = testRoot ? resolve(testRoot) : null;
function redirect(prefix) {
  if (!TEST_ROOT || typeof prefix !== "string") return prefix;
  const dir = dirname(resolve(prefix));
  if (dir === "/tmp" || dir === "/private/tmp") return join(TEST_ROOT, basename(prefix));
  return prefix;
}

// 「记账」：测试里直接 mkdir 在系统临时目录（/tmp、原 $TMPDIR，或 HIFABU_TEST_SCAN_DIRS）下的 vk* 目录——这种目录不走 mkdtemp，
// 没法归到独占根目录里。把它们记进 HIFABU_TEST_ROOT/.created，由 test-all 跑完后检查：还在就列出来并失败。
// 这样残留归属是精确的（本次测试进程自己建的），不会把同一台机器上别的会话的目录算进来、更不会误删。
const SCAN_DIRS = (readEnv("HIFABU_TEST_SCAN_DIRS") ?? "").split(":").filter(Boolean);
function ledger(p) {
  if (!TEST_ROOT || !SCAN_DIRS.length || typeof p !== "string") return;
  const given = resolve(p);
  // macOS：/tmp → /private/tmp。给的路径和扫描目录两边都按 realpath 比一遍。
  for (const abs of new Set([given, join(real(dirname(given)), basename(given))])) {
    for (const b of SCAN_DIRS.flatMap((d) => [d, real(d)])) {
      if (!abs.startsWith(b + sep)) continue;
      const first = abs.slice(b.length + 1).split(sep)[0];
      if (!first.startsWith("vk")) continue;
      try {
        fs.appendFileSync(join(TEST_ROOT, ".created"), join(b, first) + "\n");
      } catch {}
      return;
    }
  }
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

/** 列出所有带 `--user-data-dir=` 的进程：[{pid, userDataDir}]（不含本进程）。 */
export function chromeProcesses() {
  let text = "";
  try {
    text = cp.execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const found = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const at = m[2].indexOf("--user-data-dir=");
    if (at < 0) continue;
    // 路径可能带空格：取到下一个 " --" 为止。
    const rest = m[2].slice(at + "--user-data-dir=".length);
    const end = rest.indexOf(" --");
    found.push({ pid, userDataDir: end < 0 ? rest : rest.slice(0, end) });
  }
  return found;
}

/** 列出 `--user-data-dir` 落在 rootDirs 之下的进程：[{pid, userDataDir}]。 */
export function chromeUnder(rootDirs) {
  if (!rootDirs.length) return [];
  const rs = roots(rootDirs);
  return chromeProcesses()
    .map((c) => {
      const hit = rs.find((r) => c.userDataDir === r || c.userDataDir.startsWith(r + sep));
      return hit ? { pid: c.pid, userDataDir: hit } : null;
    })
    .filter(Boolean);
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
      args[0] = redirect(args[0]);
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
    return origMkdtemp.call(this, redirect(prefix), opts, (err, p) => {
      if (!err) trackDir(p);
      done2(err, p);
    });
  };

  const origMkdirSync = fs.mkdirSync;
  fs.mkdirSync = function (p, ...rest) {
    const r = origMkdirSync.call(this, p, ...rest);
    ledger(p);
    return r;
  };
  const origMkdirP = fs.promises.mkdir;
  fs.promises.mkdir = async function (p, ...rest) {
    const r = await origMkdirP.call(this, p, ...rest);
    ledger(p);
    return r;
  };
  const origMkdir = fs.mkdir;
  fs.mkdir = function (p, ...rest) {
    const cb = rest.pop();
    return origMkdir.call(this, p, ...rest, (err, ...r) => {
      if (!err) ledger(p);
      cb(err, ...r);
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

