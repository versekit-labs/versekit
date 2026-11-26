// 后台自动更新（#217）：真的跑 install.sh、真的起服务、真的退回。
//
// 不碰真实环境：HOME 是临时目录，服务名带测试前缀，端口随机，服务以 --offline 起，托管方式固定 detach；
// 下载源是本机假服务器（Node、biliup、versekit tarball、假 GitHub API 全在里面）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createServer as netServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, chmodSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INSTALL_SH = join(ROOT, "install.sh");
const WORK = mkdtempSync(join(platform() === "darwin" ? "/tmp" : tmpdir(), "vk-upd-"));
const OS = platform() === "darwin" ? "darwin" : "linux";
const CPU = arch() === "arm64" ? "arm64" : "x64";
const BILIUP_PLAT = `${CPU === "arm64" ? "aarch64" : "x86_64"}-${OS === "darwin" ? "macos" : "linux"}`;
const NODE_VER = /VERSEKIT_NODE_VERSION:-v(\d+\.\d+\.\d+)\}/.exec(readFileSync(INSTALL_SH, "utf8"))?.[1] ?? "0.0.0";
const NODE_FILE = `node-v${NODE_VER}-${OS}-${CPU}.tar.gz`;

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const homes = [];
let server;
let base;
let appTarball = "app-1";
let latest = B;
let titles = ["修了一处", "加了一个功能"];

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const tar = (args) => {
  const r = spawnSync("tar", args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, message) {
  const end = Date.now() + 10000;
  do {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  } while (Date.now() < end);
  assert.fail(message());
}

function buildFakeNode() {
  const dir = join(WORK, "node-pkg", "node");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "node"), `#!/bin/sh\n[ "$1" = "-v" ] && { echo v${NODE_VER}; exit 0; }\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(dir, "bin", "node"), 0o755);
  tar(["-czf", join(WORK, NODE_FILE), "-C", join(WORK, "node-pkg"), "node"]);
}

/** 假 versekit：当前仓库的程序文件（含 install.sh）打成 tarball；patch 可以把它改坏。 */
function buildApp(name, version, patch = null) {
  const dir = join(WORK, `${name}-src`, "versekit-main");
  mkdirSync(dir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  pkg.version = version;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const skip = (src) => !/(^|\/)(node_modules|test|\.git)(\/|$)/.test(src);
  cpSync(join(ROOT, "packages"), join(dir, "packages"), { recursive: true, filter: skip });
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true, filter: skip });
  cpSync(INSTALL_SH, join(dir, "install.sh"));
  patch?.(dir);
  tar(["-czf", join(WORK, `${name}.tar.gz`), "-C", join(WORK, `${name}-src`), "versekit-main"]);
}

function buildBiliup() {
  const dir = join(WORK, "biliup-pkg", `biliupR-v0.0.0-${BILIUP_PLAT}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "biliup"), "#!/bin/sh\necho biliup-fake\n");
  chmodSync(join(dir, "biliup"), 0o755);
  tar(["-czf", join(WORK, "biliup.tar.gz"), "-C", join(WORK, "biliup-pkg"), `biliupR-v0.0.0-${BILIUP_PLAT}`]);
}

before(async () => {
  buildFakeNode();
  buildApp("app-1", "0.1.0");
  buildApp("app-2", "9.9.9");
  // 坏包：能起来、/today 是 200，但 /api/now 一直报错——install.sh 自己发现不了，要靠更新后的自检。
  buildApp("app-bad", "8.8.8", (dir) => {
    const f = join(dir, "packages/core/src/handlers.mjs");
    const src = readFileSync(f, "utf8");
    const patched = src.replace("now: () => ({ ...store.statusSnapshot() }),", 'now: () => { throw new Error("故意坏掉"); },');
    assert.notEqual(patched, src, "坏包补丁没打上：handlers.mjs 里的 now 写法变了，这条测试要跟着改");
    writeFileSync(f, patched);
  });
  buildBiliup();
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/node/SHASUMS256.txt") res.end(`${sha(join(WORK, NODE_FILE))}  ${NODE_FILE}\n`);
    else if (url === `/node/${NODE_FILE}`) res.end(readFileSync(join(WORK, NODE_FILE)));
    else if (url === "/app.tar.gz") {
      if (appTarball === "404") { res.statusCode = 404; return res.end("no"); }
      res.end(readFileSync(join(WORK, `${appTarball}.tar.gz`)));
    } else if (url === "/biliup.tar.gz") res.end(readFileSync(join(WORK, "biliup.tar.gz")));
    else if (url === "/api/commits/main") res.end(JSON.stringify({ sha: latest }));
    else if (url.startsWith("/api/compare/")) {
      res.end(JSON.stringify({ status: "ahead", ahead_by: titles.length, commits: titles.slice().reverse().map((t) => ({ commit: { message: `${t}\n\n正文` } })) }));
    } else {
      res.statusCode = 404;
      res.end("no");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const h of homes) {
    const vk = join(h.home, ".versekit", "bin", "vk");
    if (existsSync(vk)) spawnSync(vk, ["service", "uninstall", "--service-only"], { env: h.env, stdio: "ignore" });
  }
  server?.close();
  server?.closeAllConnections?.();
  rmSync(WORK, { recursive: true, force: true });
});

async function newHome(extra = {}) {
  const home = mkdtempSync(join(WORK, "home-"));
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/zsh",
    VERSEKIT_PORT: String(port),
    VERSEKIT_SERVICE_LABEL: `com.versekit.test.upd.${process.pid}.${homes.length}`,
    VERSEKIT_SERVICE_MANAGER: "detach",
    VERSEKIT_OFFLINE: "1",
    VERSEKIT_NO_OPEN: "1",
    VERSEKIT_NODE_URL: `${base}/node`,
    VERSEKIT_APP_URL: `${base}/app.tar.gz`,
    VERSEKIT_BILIUP_URL: `${base}/biliup.tar.gz`,
    VERSEKIT_LARK_URL: `${base}/lark`,
    VERSEKIT_UPDATE_API: `${base}/api`,
    VERSEKIT_UPDATE_HEALTH_TIMEOUT_MS: "4000",
    ...extra,
  };
  delete env.VK_HOME;
  delete env.VERSEKIT_PREFIX;
  const h = { home, port, env, prefix: join(home, ".versekit") };
  homes.push(h);
  return h;
}

const sh = (h, cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...h.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
const vkOf = (h) => join(h.prefix, "bin", "vk");
const vk = (h, ...args) => sh(h, vkOf(h), args);
const json = (r) => JSON.parse(r.stdout);
const status = (port, path = "/today") =>
  new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
    req.end();
  });
const appVersion = (h) => JSON.parse(readFileSync(join(h.prefix, "app/package.json"), "utf8")).version;

async function installV1(h, commit = A) {
  appTarball = "app-1";
  const r = await sh(h, "bash", [INSTALL_SH], { env: { VERSEKIT_APP_COMMIT: commit } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
}

let main;

test("ACC-update-01 装好的程序知道自己是哪个提交：app/.versekit-build.json 与 vk version（版本 + 短提交号 + 安装时间）", { timeout: 120000 }, async () => {
  main = await newHome();
  await installV1(main);
  const stamp = JSON.parse(readFileSync(join(main.prefix, "app/.versekit-build.json"), "utf8"));
  assert.equal(stamp.commit, A);
  assert.equal(stamp.version, "0.1.0");
  assert.match(stamp.installed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  const v = await vk(main, "version");
  assert.equal(v.code, 0, v.stderr);
  assert.match(v.stdout.split("\n")[0], new RegExp(`^0\\.1\\.0\\+aaaaaaa · 安装于 ${stamp.installed_at}$`));
  const j = json(await vk(main, "version", "--json"));
  assert.equal(j.commit, A);
  assert.equal(j.auto, true);

  // 系统页读的是同一份：HTTP GET /api/update
  assert.equal(await status(main.port, "/api/update"), 200);
});

test("ACC-update-02 vk update --check 说人话；--auto off|on 就地开关", { timeout: 120000 }, async () => {
  latest = B;
  const c = json(await vk(main, "update", "--check"));
  assert.equal(c.message, "有新版本：2 个提交");
  assert.deepEqual(c.commits, ["修了一处", "加了一个功能"].reverse().reverse());
  latest = A;
  assert.equal(json(await vk(main, "update", "--check")).message, "已是最新");

  const off = await vk(main, "update", "--auto", "off");
  assert.match(off.stdout, /后台自动更新：关/);
  assert.equal(json(await vk(main, "version", "--json")).auto, false);
  await vk(main, "update", "--auto", "on");
  assert.equal(json(await vk(main, "version", "--json")).auto, true);
  assert.equal(json(await vk(main, "version", "--json")).lastCheck.message, "已是最新", "检查结果记下来了，系统页显示它");
});

test("ACC-update-02 已是最新时 vk update 什么都不动", { timeout: 60000 }, async () => {
  latest = A;
  const r = json(await vk(main, "update"));
  assert.equal(r.updated, false);
  assert.equal(r.message, "已是最新");
  assert.equal(appVersion(main), "0.1.0");
});

test("ACC-update-02/05 更新：用新包里的 install.sh 升级，数据/账号/配置保留，app.prev 清掉，提交号更新，系统页看得到更新内容", { timeout: 180000 }, async () => {
  const added = await vk(main, "group", "add", "保留我");
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const cred = join(main.home, ".config/versekit/credentials/keep.txt");
  writeFileSync(cred, "secret");
  const rcBefore = readFileSync(join(main.home, ".zshrc"), "utf8");

  latest = B;
  titles = ["一", "二", "三", "四", "五", "六"];
  appTarball = "app-2";
  const r = await vk(main, "update");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = json(r);
  assert.equal(out.updated, true, r.stdout);
  assert.equal(appVersion(main), "9.9.9");
  assert.ok(!existsSync(join(main.prefix, "app.prev")), "自检通过后清掉 app.prev");
  assert.ok(!existsSync(join(main.prefix, "bin/biliup.new")));

  const v = json(await vk(main, "version", "--json"));
  assert.equal(v.version, "9.9.9");
  assert.equal(v.commit, B, "提交号是新包的");
  assert.equal(v.lastUpdate.version, "9.9.9");
  assert.equal(v.lastUpdate.commits.length, 5, "最多 5 条提交标题");
  assert.deepEqual(v.lastUpdate.commits, ["一", "二", "三", "四", "五"]);
  assert.equal(v.lastFailure, null);

  // 数据都在，服务照常
  assert.equal(readFileSync(cred, "utf8"), "secret");
  assert.match((await vk(main, "group", "list")).stdout, /保留我/);
  assert.equal(await status(main.port), 200);
  assert.equal(await status(main.port, "/api/now"), 200);
  const st = json(await vk(main, "service", "status"));
  assert.equal(st.running && st.reachable, true);
  // 自动更新不碰 PATH 配置：不新增 rc 段，也不在没有 SHELL 的环境里凭空建 ~/.profile
  assert.equal(readFileSync(join(main.home, ".zshrc"), "utf8"), rcBefore);
  assert.ok(!existsSync(join(main.home, ".profile")));
});

test("ACC-update-04 新包故意坏掉（起得来、/api 不通过自检）：自动退回旧版本，服务照常可用，留事件，系统页能看到", { timeout: 180000 }, async () => {
  assert.equal(appVersion(main), "9.9.9");
  latest = C;
  appTarball = "app-bad";
  const r = await vk(main, "update");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const out = json(r);
  assert.equal(out.ok, false);
  assert.equal(out.rolledBack, true);
  assert.match(out.message, /^自动更新失败，已回到 9\.9\.9\+bbbbbbb：/);
  assert.match(out.message, /没通过自检/);

  // 回到了旧版本，服务照常可用
  assert.equal(appVersion(main), "9.9.9");
  assert.ok(!existsSync(join(main.prefix, "app.prev")));
  assert.equal(JSON.parse(readFileSync(join(main.prefix, "app/.versekit-build.json"), "utf8")).commit, B);
  assert.equal(await status(main.port), 200);
  assert.equal(await status(main.port, "/api/now"), 200, "旧版本的 /api 是好的");
  assert.equal(json(await vk(main, "service", "status")).running, true);

  // 留事件 + 系统页「最近出的问题」读的状态
  const events = json(await vk(main, "events"));
  const ev = (events.events ?? events.rows ?? events).find((e) => e.type === "update.failed");
  assert.ok(ev, `没有 update.failed 事件：${JSON.stringify(events).slice(0, 300)}`);
  assert.match(ev.payload.message, /^自动更新失败，已回到 9\.9\.9/);
  const v = json(await vk(main, "version", "--json"));
  assert.match(v.lastFailure.message, /^自动更新失败，已回到 9\.9\.9/);
  assert.equal(v.lastFailure.to, C);
});

test("ACC-update-04 下载不到新包：什么都没动，同样说人话并留事件", { timeout: 120000 }, async () => {
  latest = C;
  appTarball = "404";
  const r = await vk(main, "update");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(json(r).message, /^自动更新失败，已回到 9\.9\.9.*下载新版本失败/);
  assert.equal(appVersion(main), "9.9.9");
  assert.equal(await status(main.port), 200);
});

test("ACC-update-03 后台服务自己更新：启动后检查，空闲就更新（脱离守护进程跑完，服务换成新版本）", { timeout: 180000 }, async () => {
  const h = await newHome({ VERSEKIT_UPDATE_START_DELAY_MS: "1500" });
  // 装 v1 之前假 GitHub 就说「已是最新」，装好后再放出新版本，避免装的过程中被自己更新
  latest = A;
  await installV1(h);
  assert.equal(appVersion(h), "0.1.0");
  await sleep(2500); // 启动检查：已是最新
  assert.equal(appVersion(h), "0.1.0");

  latest = B;
  appTarball = "app-2";
  // 重启服务触发「启动时检查」
  const rs = await vk(h, "service", "restart");
  assert.equal(rs.code, 0, rs.stdout + rs.stderr);

  const end = Date.now() + 90000;
  let done = false;
  while (Date.now() < end) {
    if (existsSync(join(h.prefix, "app/package.json")) && appVersion(h) === "9.9.9" && (await status(h.port, "/api/now")) === 200 && !existsSync(join(h.prefix, "app.prev"))) {
      done = true;
      break;
    }
    await sleep(500);
  }
  const log = existsSync(join(h.home, ".local/state/versekit/vk.log")) ? readFileSync(join(h.home, ".local/state/versekit/vk.log"), "utf8") : "";
  assert.ok(done, `后台没有自己更新成功。日志：\n${log.slice(-1500)}`);
  assert.match(log, /\[update\] 有新版本.*空闲，开始更新/);
  assert.equal(json(await vk(h, "version", "--json")).commit, B);
});

test("ACC-update-03 自动更新关掉：服务启动后不检查、不更新", { timeout: 120000 }, async (t) => {
  const requests = [];
  const comparePath = `/api/compare/${A}...${B}`;
  const comparison = JSON.stringify({ status: "ahead", ahead_by: 1, commits: [] });
  let firstCompare;
  const updateServer = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/api/commits/main") return res.end(JSON.stringify({ sha: B }));
    if (req.url === comparePath) {
      // 卡住旧进程的检查，保证开关先落盘、GitHub 响应后到。
      if (!firstCompare) {
        firstCompare = res;
        return;
      }
      return res.end(comparison);
    }
    res.writeHead(404).end();
  });
  t.after(() => {
    updateServer.close();
    updateServer.closeAllConnections();
  });
  await new Promise((resolve) => updateServer.listen(0, "127.0.0.1", resolve));

  const h = await newHome({
    VERSEKIT_UPDATE_API: `http://127.0.0.1:${updateServer.address().port}/api`,
    VERSEKIT_UPDATE_START_DELAY_MS: "500",
  });
  await installV1(h);
  const initial = json(await vk(h, "service", "status"));
  assert.equal(initial.running && initial.reachable, true);
  await waitFor(() => firstCompare, () => `启动检查未到达 compare：${JSON.stringify(requests)}`);
  const off = await vk(h, "update", "--auto", "off");
  assert.equal(off.code, 0, off.stdout + off.stderr);
  assert.equal(json(await vk(h, "version", "--json")).auto, false);

  const log = () => readFileSync(initial.log, "utf8");
  const discarded = /\[update\] 检查期间关闭了自动更新，跳过安装/;
  appTarball = "app-2";
  firstCompare.end(comparison);
  const outcome = await waitFor(
    () => log().match(/\[update\] (?:检查期间关闭了自动更新，跳过安装|.*空闲，开始更新)/)?.[0],
    () => `旧进程没有处理完检查：\n${log()}`,
  );
  assert.match(outcome, discarded);

  const logOffset = log().length;
  const restarted = await vk(h, "service", "restart");
  assert.equal(restarted.code, 0, restarted.stdout + restarted.stderr);
  const service = json(restarted);
  assert.equal(service.running && service.reachable, true, restarted.stdout);
  assert.notEqual(service.pid, initial.pid);
  await waitFor(
    () => log().slice(logOffset).includes("[update] 自动更新已关闭，跳过检查"),
    () => `重启后没有走到关闭分支：\n${log().slice(logOffset)}\n请求：${JSON.stringify(requests)}`,
  );
  assert.deepEqual(requests, ["/api/commits/main", comparePath], "只有关闭前的检查可以访问 GitHub");
  assert.equal(appVersion(h), "0.1.0");
  assert.equal(await status(service.port), 200);
});
