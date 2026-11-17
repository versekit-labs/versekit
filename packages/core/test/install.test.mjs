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
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true, filter: skip });
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
  buildBiliup();
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/node/SHASUMS256.txt") {
      const sum = breakNodeSum ? "0".repeat(64) : sha(join(WORK, NODE_FILE));
      res.end(`${sum}  ${NODE_FILE}\n${"1".repeat(64)}  node-v${NODE_VER}-win-x64.zip\n`);
    } else if (url === `/node/${NODE_FILE}`) res.end(readFileSync(join(WORK, NODE_FILE)));
    else if (url === "/app.tar.gz") res.end(readFileSync(join(WORK, `${appTarball}.tar.gz`)));
    else if (url === "/biliup.tar.gz") res.end(readFileSync(join(WORK, "biliup.tar.gz")));
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
  for (const f of ["node/bin/node", "app/packages/cli/src/vk.mjs", "bin/biliup", "bin/vk"]) assert.ok(existsSync(join(prefix, f)), `缺 ${f}`);
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
  assert.match(r.stdout, /已升级 0\.1\.0 → 9\.9\.9/);
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
