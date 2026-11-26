// 一键安装（ACC-install-01..05）：本机假下载源 + 临时 HOME 里真跑 install.sh。
//
// 不碰真实环境：HOME 是临时目录，服务名带测试前缀，端口是随机空闲端口，服务以 --offline 起，
// 托管方式固定 detach（CI 的 Linux 没有 systemd 的退回路径，Mac 上也不注册真 LaunchAgent）。
// launchd 路径单独一条，只在 macOS 且有图形会话时跑，同样用临时 HOME 与测试服务名。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createServer as netServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INSTALL_SH = join(ROOT, "install.sh");
// unix socket 路径在 macOS 上不能超过 104 字节：$TMPDIR 太长，所以 macOS 上用 /tmp。
const WORK = mkdtempSync(join(platform() === "darwin" ? "/tmp" : tmpdir(), "vk-install-"));
const OS = platform() === "darwin" ? "darwin" : "linux";
const CPU = arch() === "arm64" ? "arm64" : "x64";
const BILIUP_PLAT = `${CPU === "arm64" ? "aarch64" : "x86_64"}-${OS === "darwin" ? "macos" : "linux"}`;
// 假 Node 的版本号取自 install.sh 里写死的默认值：脚本默认要装哪一版，测试就按那一版造包。
const PINNED = /VERSEKIT_NODE_VERSION:-v(\d+\.\d+\.\d+)\}/.exec(readFileSync(INSTALL_SH, "utf8"));
const NODE_VER = PINNED?.[1] ?? "0.0.0";
const NODE_FILE = `node-v${NODE_VER}-${OS}-${CPU}.tar.gz`;

// 假 lark-cli：版本号取自 install.sh 里写死的默认值，--version 输出和真的一样的格式。
const LARK_PIN = /VERSEKIT_LARK_VERSION:-(\d+\.\d+\.\d+)\}/.exec(readFileSync(INSTALL_SH, "utf8"));
const LARK_VER = LARK_PIN?.[1] ?? "0.0.0";
const LARK_FILE = `lark-cli-${LARK_VER}-${OS}-${CPU === "arm64" ? "arm64" : "amd64"}.tar.gz`;
let breakLarkSum = false;
let larkArchiveHits = 0;

const homes = [];
let server;
let base;
let breakNodeSum = false;
let appTarball = "app-1";

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

/** 假 Node：`-v` 报 22.99.0，其余转给真 Node。 */
function buildFakeNode() {
  const dir = join(WORK, "node-pkg", "node");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "node"), `#!/bin/sh\n[ "$1" = "-v" ] && { echo v${NODE_VER}; exit 0; }\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(dir, "bin", "node"), 0o755);
  tar(["-czf", join(WORK, NODE_FILE), "-C", join(WORK, "node-pkg"), "node"]);
}

/** 假 versekit：拿当前仓库的程序文件（不含测试和 git）打成 tarball，版本号可改。 */
function buildApp(name, version) {
  const dir = join(WORK, `${name}-src`, "versekit-main");
  mkdirSync(dir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  pkg.version = version;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const skip = (src) => !/(^|\/)(node_modules|test|\.git)(\/|$)/.test(src);
  cpSync(join(ROOT, "packages"), join(dir, "packages"), { recursive: true, filter: skip });
  cpSync(join(ROOT, "schemas"), join(dir, "schemas"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true, filter: skip });
  tar(["-czf", join(WORK, `${name}.tar.gz`), "-C", join(WORK, `${name}-src`), "versekit-main"]);
}

function buildLark() {
  const dir = join(WORK, "lark-pkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lark-cli"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "lark-cli version ${LARK_VER}"; exit 0; }\necho lark-fake\n`);
  chmodSync(join(dir, "lark-cli"), 0o755);
  tar(["-czf", join(WORK, LARK_FILE), "-C", dir, "lark-cli"]);
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
  buildBiliup();
  buildLark();
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/node/SHASUMS256.txt") {
      const sum = breakNodeSum ? "0".repeat(64) : sha(join(WORK, NODE_FILE));
      res.end(`${sum}  ${NODE_FILE}\n${"1".repeat(64)}  node-v${NODE_VER}-win-x64.zip\n`);
    } else if (url === `/node/${NODE_FILE}`) res.end(readFileSync(join(WORK, NODE_FILE)));
    else if (url === "/app.tar.gz") res.end(readFileSync(join(WORK, `${appTarball}.tar.gz`)));
    else if (url === "/lark/checksums.txt") {
      const sum = breakLarkSum ? "0".repeat(64) : sha(join(WORK, LARK_FILE));
      res.end(`${sum}  ${LARK_FILE}\n${"2".repeat(64)}  lark-cli-${LARK_VER}-windows-amd64.zip\n`);
    } else if (url === `/lark/${LARK_FILE}`) {
      larkArchiveHits += 1;
      res.end(readFileSync(join(WORK, LARK_FILE)));
    } else if (url === "/biliup.tar.gz") res.end(readFileSync(join(WORK, "biliup.tar.gz")));
    else {
      res.statusCode = 404;
      res.end("no");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // 兜底：把每个临时 HOME 里还活着的测试服务拆掉。
  for (const h of homes) {
    const vk = join(h.home, ".versekit", "bin", "vk");
    if (existsSync(vk)) spawnSync(vk, ["service", "uninstall", "--service-only"], { env: h.env, stdio: "ignore" });
  }
  server?.close();
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
    VERSEKIT_SERVICE_LABEL: `com.versekit.test.${process.pid}.${homes.length}`,
    VERSEKIT_SERVICE_MANAGER: "detach",
    VERSEKIT_OFFLINE: "1",
    VERSEKIT_NO_OPEN: "1",
    VERSEKIT_NODE_URL: `${base}/node`,
    VERSEKIT_APP_URL: `${base}/app.tar.gz`,
    VERSEKIT_BILIUP_URL: `${base}/biliup.tar.gz`,
    VERSEKIT_LARK_URL: `${base}/lark`,
    ...extra,
  };
  delete env.VK_HOME;
  delete env.VERSEKIT_PREFIX;
  const h = { home, port, env };
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
const install = (h, opts) => sh(h, "bash", [INSTALL_SH], opts);
const vkOf = (h) => join(h.home, ".versekit", "bin", "vk");

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

const markerCount = (file) => (readFileSync(file, "utf8").match(/# >>> versekit >>>/g) ?? []).length;

// 这几条按顺序依赖同一个临时 HOME：装 → 升级 → 卸载。
let main;

test("ACC-install-01/02/05：一条命令装好——私有 Node、程序、biliup、服务、控制台 200、最后一行写明地址", { timeout: 120000 }, async () => {
  main = await newHome();
  const r = await install(main);
  assert.equal(r.code, 0, r.stdout + r.stderr);

  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.at(-1), `装好了，控制台地址 http://127.0.0.1:${main.port}，终端可以关了`, r.stderr);

  const prefix = join(main.home, ".versekit");
  for (const f of ["node/bin/node", "app/packages/cli/src/vk.mjs", "bin/biliup", "bin/lark-cli", "bin/vk"]) assert.ok(existsSync(join(prefix, f)), `缺 ${f}`);
  assert.ok(existsSync(join(main.home, ".local/state/versekit/vk.db")), "vk init 应该建库");
  assert.equal(await status(main.port), 200);

  // 服务描述落盘，且是离线模式（VERSEKIT_OFFLINE=1）
  const meta = JSON.parse(readFileSync(join(main.home, ".local/state/versekit/service.json"), "utf8"));
  assert.equal(meta.manager, "detach");
  assert.equal(meta.offline, true);
  assert.equal(meta.port, main.port);
  assert.match(readFileSync(join(main.home, ".local/state/versekit/vk.log"), "utf8"), /离线模式/);

  // PATH 那一行：带标记、只有一段
  const rc = join(main.home, ".zshrc");
  assert.equal(markerCount(rc), 1);
  assert.match(readFileSync(rc, "utf8"), new RegExp(`export PATH="${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/bin:\\$PATH"`));

  // 装好的 vk 可以直接用，服务环境里能找到 biliup
  const v = await sh(main, vkOf(main), ["service", "status"]);
  const st = JSON.parse(v.stdout);
  assert.equal(st.running, true);
  assert.equal(st.reachable, true);
  assert.equal(st.manager, "detach");
});

test("ACC-install-03：再运行一次就是升级——数据、配置、凭证保留，输出前后版本，只留一段 PATH", { timeout: 120000 }, async () => {
  const vk = vkOf(main);
  const added = await sh(main, vk, ["group", "add", "保留我"]);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const cred = join(main.home, ".config/versekit/credentials/keep.txt");
  writeFileSync(cred, "secret");
  const before = JSON.parse((await sh(main, vk, ["service", "status"])).stdout).pid;

  appTarball = "app-2";
  const r = await install(main);
  appTarball = "app-1";
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /已升级 0\.1\.0\+未知提交 → 9\.9\.9\+未知提交/);
  assert.equal(r.stdout.trim().split("\n").at(-1), `装好了，控制台地址 http://127.0.0.1:${main.port}，终端可以关了`);

  assert.equal(JSON.parse(readFileSync(join(main.home, ".versekit/app/package.json"), "utf8")).version, "9.9.9");
  assert.equal(readFileSync(cred, "utf8"), "secret");
  assert.match((await sh(main, vk, ["group", "list"])).stdout, /保留我/);
  assert.equal(markerCount(join(main.home, ".zshrc")), 1);
  assert.equal(await status(main.port), 200);
  const after = JSON.parse((await sh(main, vk, ["service", "status"])).stdout).pid;
  assert.notEqual(after, before, "升级要重启服务");
  assert.ok(!existsSync(join(main.home, ".versekit/app.prev")), "升级成功后不留旧程序");
});

test("ACC-install-04：vk service stop / start / restart 管得住后台服务", { timeout: 60000 }, async () => {
  const vk = vkOf(main);
  const stopped = JSON.parse((await sh(main, vk, ["service", "stop"])).stdout);
  assert.equal(stopped.running, false);
  assert.equal(await status(main.port), null);
  const started = JSON.parse((await sh(main, vk, ["service", "start"])).stdout);
  assert.equal(started.running, true);
  assert.equal(await status(main.port), 200);
  const restarted = JSON.parse((await sh(main, vk, ["service", "restart"])).stdout);
  assert.equal(restarted.reachable, true);
});

test("ACC-install-04：vk service uninstall 默认保留数据，并拆掉服务、程序文件和 PATH 那段", { timeout: 60000 }, async () => {
  const r = await sh(main, vkOf(main), ["service", "uninstall"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(await status(main.port), null, "服务应该停了");
  assert.ok(!existsSync(join(main.home, ".local/state/versekit/service.json")));
  for (const d of ["app", "node", "bin"]) assert.ok(!existsSync(join(main.home, ".versekit", d)), `${d} 应该被删掉`);
  assert.equal(markerCount(join(main.home, ".zshrc")), 0);
  // 数据还在
  assert.ok(existsSync(join(main.home, ".local/state/versekit/vk.db")));
  assert.ok(existsSync(join(main.home, ".config/versekit/credentials/keep.txt")));
});

test("ACC-install-04：--purge 先列出要删的目录，再删数据", { timeout: 120000 }, async () => {
  const h = await newHome();
  assert.equal((await install(h)).code, 0);
  const r = await sh(h, vkOf(h), ["service", "uninstall", "--purge"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const listed = r.stderr + r.stdout;
  assert.ok(listed.includes(join(h.home, ".config/versekit")) && listed.includes(join(h.home, ".local/state/versekit")), "要先把目录列出来");
  assert.ok(!existsSync(join(h.home, ".config/versekit")));
  assert.ok(!existsSync(join(h.home, ".local/state/versekit")));
});

test("ACC-install-03/05：校验不过——非 0 退出、说清哪一步、不留服务、不动 PATH", { timeout: 60000 }, async () => {
  const h = await newHome();
  breakNodeSum = true;
  const r = await install(h);
  breakNodeSum = false;
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /校验 Node/);
  assert.match(r.stderr, /怎么办/);
  assert.ok(!existsSync(join(h.home, ".local/state/versekit/service.json")));
  assert.equal(await status(h.port), null);
  assert.ok(!existsSync(join(h.home, ".zshrc")), "失败了就不该改 shell 配置");
});

test("ACC-v3-feishu-08：首次安装装上飞书组件 lark-cli（校验过、可执行、版本对）；重复运行跳过下载；系统里的 lark-cli 不动", { timeout: 180000 }, async () => {
  assert.ok(LARK_PIN, "install.sh 里要有写死的 VERSEKIT_LARK_VERSION 默认值");
  // 系统 PATH 里放一个「已有的」lark-cli，装完它必须原样还在。
  const sysBin = join(WORK, "sysbin");
  mkdirSync(sysBin, { recursive: true });
  writeFileSync(join(sysBin, "lark-cli"), "#!/bin/sh\necho system-lark\n");
  chmodSync(join(sysBin, "lark-cli"), 0o755);
  const h = await newHome({ PATH: `${sysBin}:${process.env.PATH}` });
  const own = join(h.home, ".versekit", "bin", "lark-cli");
  const before = larkArchiveHits;
  const first = await install(h);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(larkArchiveHits, before + 1, "首次应下载一次");
  assert.ok(existsSync(own), "lark-cli 装在 versekit 目录下");
  const v = spawnSync(own, ["--version"], { encoding: "utf8" });
  assert.equal(v.stdout.trim(), `lark-cli version ${LARK_VER}`);
  assert.equal(readFileSync(join(sysBin, "lark-cli"), "utf8"), "#!/bin/sh\necho system-lark\n", "系统里已有的 lark-cli 不动");

  const again = await install(h);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /飞书组件 lark-cli \S+ 已经在了，跳过下载/);
  assert.equal(larkArchiveHits, before + 1, "重复运行不该再下载");
  assert.ok(existsSync(own));
  await sh(h, vkOf(h), ["service", "uninstall", "--service-only"]);
});

test("ACC-v3-feishu-08：lark-cli 校验不过——不拖垮安装：versekit 照常装好，说清原因和补装办法，不留飞书组件", { timeout: 120000 }, async () => {
  const h = await newHome();
  breakLarkSum = true;
  const r = await install(h);
  breakLarkSum = false;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /飞书组件没装上/);
  assert.match(r.stderr, /校验不通过/);
  assert.match(r.stderr, /重新运行这一行安装命令/);
  assert.ok(!existsSync(join(h.home, ".versekit/bin/lark-cli")), "校验不过不能装上");
  assert.ok(existsSync(join(h.home, ".versekit/app")), "versekit 本体照常装上");
  assert.ok(existsSync(join(h.home, ".versekit/bin/vk")));
  assert.notEqual(await status(h.port), null, "后台服务在跑");
  await sh(h, vkOf(h), ["service", "uninstall", "--service-only"]);
  // 网络恢复后重新运行：补装上
  const again = await install(h);
  assert.equal(again.code, 0, again.stderr);
  assert.ok(existsSync(join(h.home, ".versekit/bin/lark-cli")), "重新运行后补装");
  await sh(h, vkOf(h), ["service", "uninstall", "--service-only"]);
});

test("ACC-install-03：下载失败——退出码非 0 并指出是哪一步", { timeout: 60000 }, async () => {
  const h = await newHome({ VERSEKIT_BILIUP_URL: `${base}/nope.tar.gz` });
  const r = await install(h);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /下载 biliup/);
  assert.ok(!existsSync(join(h.home, ".local/state/versekit/service.json")));
  assert.ok(!existsSync(join(h.home, ".versekit/app")), "还没走到换程序就失败，不该留下半个安装");
});

test("ACC-install-03：8787 被别的程序占用时自动换空闲端口，最后一行写明实际地址", { timeout: 120000 }, async () => {
  const h = await newHome();
  const blocker = netServer();
  await new Promise((r) => blocker.listen(h.port, "127.0.0.1", r));
  try {
    const r = await install(h);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const last = r.stdout.trim().split("\n").at(-1);
    const m = /控制台地址 http:\/\/127\.0\.0\.1:(\d+)，/.exec(last);
    assert.ok(m, last);
    assert.notEqual(Number(m[1]), h.port);
    assert.equal(await status(Number(m[1])), 200);
  } finally {
    blocker.close();
  }
});

const darwinGui = platform() === "darwin" && spawnSync("launchctl", ["print", `gui/${process.getuid()}`], { stdio: "ignore" }).status === 0;

test("ACC-install-02：macOS 用 LaunchAgent（RunAtLoad + KeepAlive），卸载后服务和 plist 都不在", { skip: !darwinGui && "仅 macOS 图形会话", timeout: 120000 }, async () => {
  const h = await newHome({ VERSEKIT_SERVICE_MANAGER: "" });
  delete h.env.VERSEKIT_SERVICE_MANAGER;
  const r = await install(h);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const label = h.env.VERSEKIT_SERVICE_LABEL;
  const plist = join(h.home, "Library/LaunchAgents", `${label}.plist`);
  try {
    assert.ok(existsSync(plist));
    const text = readFileSync(plist, "utf8");
    assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(text, /<key>KeepAlive<\/key><true\/>/);
    assert.match(text, /\.versekit\/bin/, "服务 PATH 要含 ~/.versekit/bin");
    const loaded = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8" });
    assert.equal(loaded.status, 0, "launchctl print 应显示已加载");
    assert.equal(await status(h.port), 200);
    // 服务正在运行时 restart：必须真的重启回来（bootout 异步，曾导致重启后服务消失）
    const before = JSON.parse((await sh(h, vkOf(h), ["service", "status"])).stdout).pid;
    const t0 = Date.now();
    const re = JSON.parse((await sh(h, vkOf(h), ["service", "restart"])).stdout);
    assert.equal(re.running, true);
    assert.equal(re.loaded, true);
    assert.equal(re.reachable, true);
    assert.notEqual(re.pid, before, "restart 应换新进程");
    assert.ok(Date.now() - t0 < 25000, "restart 不该拖到超时");
    assert.equal(await status(h.port), 200);
  } finally {
    const u = await sh(h, vkOf(h), ["service", "uninstall"]);
    assert.equal(u.code, 0, u.stdout + u.stderr);
  }
  assert.ok(!existsSync(plist));
  assert.notEqual(spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "ignore" }).status, 0);
  assert.equal(await status(h.port), null);
});

test("ACC-install-01：Node 版本写死为 26.x，下载地址不含浮动的 latest-*", () => {
  const sh = readFileSync(INSTALL_SH, "utf8");
  assert.ok(PINNED, "install.sh 里要有写死的 VERSEKIT_NODE_VERSION 默认值");
  assert.equal(NODE_VER.split(".")[0], "26", "默认装 Node 26 LTS");
  assert.match(sh, /https:\/\/nodejs\.org\/dist\/\$NODE_VERSION/);
  assert.doesNotMatch(sh, /latest-v\d+\.x/);
});

test("ACC-install-06：安装输出有「正在…」进度提示，非 tty 时不刷进度条", { timeout: 120000 }, async () => {
  const h = await newHome();
  const r = await install(h);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const re of [/下载 Node v\S+（约 \d+MB/, /校验并解压 Node……/, /下载 versekit 程序（约 \d+MB/, /解压 versekit……/, /下载 biliup（约 \d+MB/, /初始化数据库.*……/, /等控制台起来.*……/]) {
    assert.match(r.stdout, re);
  }
  assert.doesNotMatch(r.stderr, /#{5,}/, "非 tty 不应输出 curl 进度条");
  await sh(h, vkOf(h), ["service", "uninstall", "--service-only"]);
});

test("ACC-install-06：export-ignore 之后的程序包 ≤ 5MB，只含运行需要的文件，且 vk init / doctor / 控制台照常", { timeout: 120000 }, async () => {
  // 用临时 index 把工作区（含未提交的 .gitattributes）打成与 GitHub 源码包等价的归档。
  const idx = join(WORK, "slim.index");
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const git = (args, opts = {}) => {
    const r = spawnSync("git", args, { cwd: ROOT, env, encoding: "utf8", maxBuffer: 1 << 28, ...opts });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git(["add", "-A"]);
  const tree = git(["write-tree"]).trim();
  const out = join(WORK, "slim.tar");
  git(["archive", "-o", out, tree]);
  const gz = spawnSync("gzip", ["-kf", out]);
  assert.equal(gz.status, 0);
  const size = readFileSync(`${out}.gz`).length;
  assert.ok(size <= 5 * 1024 * 1024, `程序包 ${size} 字节，超过 5MB`);

  const names = spawnSync("tar", ["-tf", out], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout.split("\n").filter(Boolean);
  for (const bad of [".claude/", ".impeccable/", "docs/", "assets/", "site/", "bin/", ".github/"]) {
    assert.ok(!names.some((n) => n.startsWith(bad)), `不该打进包：${bad}`);
  }
  assert.ok(!names.some((n) => /^packages\/[^/]+\/test\//.test(n)), "各包 test 不该打进包");
  for (const need of ["package.json", "packages/cli/src/vk.mjs", "packages/core/src/schema.sql", "schemas/delivery-v1.json", "scripts/demo-seed.mjs"]) {
    assert.ok(names.includes(need), `缺运行必需文件 ${need}`);
  }
  assert.ok(names.some((n) => n.startsWith("packages/web/public/")), "控制台静态页要在包里");

  // 解压后在临时 HOME 里真跑：vk init → doctor → serve（控制台各页 200）。
  const dir = join(WORK, "slim-x");
  mkdirSync(dir, { recursive: true });
  tar(["-xf", out, "-C", dir]);
  const h = await newHome();
  const vk = join(dir, "packages/cli/src/vk.mjs");
  const run = (args) => spawnSync(process.execPath, ["--no-warnings", vk, ...args], { env: h.env, encoding: "utf8", cwd: dir });
  const init = run(["init"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const doc = run(["doctor"]);
  assert.ok(doc.stdout.trim().startsWith("{") || doc.stdout.length > 0, doc.stderr);
  const srv = spawn(process.execPath, ["--no-warnings", vk, "serve", "--offline", "--port", String(h.port)], { env: h.env, cwd: dir, stdio: "ignore" });
  try {
    let code = null;
    for (let i = 0; i < 40 && code !== 200; i++) {
      code = await status(h.port, "/today");
      if (code !== 200) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(code, 200, "瘦身包里的控制台 /today 应返回 200");
  } finally {
    srv.kill();
  }
});

test("ACC-update-06：版本号带短提交号——不同提交装上去前后不同，同一提交重装不说已升级", { timeout: 180000 }, async () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const h = await newHome();
  const first = await install(h, { env: { VERSEKIT_APP_COMMIT: A } });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /已安装 0\.1\.0\+aaaaaaa/);

  const second = await install(h, { env: { VERSEKIT_APP_COMMIT: B } });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /已升级 0\.1\.0\+aaaaaaa → 0\.1\.0\+bbbbbbb/);

  const again = await install(h, { env: { VERSEKIT_APP_COMMIT: B } });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /已是最新（bbbbbbb），重新装了一遍/);
  assert.doesNotMatch(again.stdout, /已升级/);

  const v = await sh(h, vkOf(h), ["version"]);
  assert.match(v.stdout.split("\n")[0], /^0\.1\.0\+bbbbbbb/);
  await sh(h, vkOf(h), ["service", "uninstall", "--service-only"]);
});
