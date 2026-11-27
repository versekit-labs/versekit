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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeRelease, NODE_VERSION } from "./install-fixtures.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INSTALL_SH = join(ROOT, "install.sh");
// unix socket 路径在 macOS 上不能超过 104 字节：$TMPDIR 太长，所以 macOS 上用 /tmp。
const WORK = mkdtempSync(join(platform() === "darwin" ? "/tmp" : tmpdir(), "vk-install-"));
const OS = platform() === "darwin" ? "darwin" : "linux";
const CPU = arch() === "arm64" ? "arm64" : "x64";
const PLATFORM = `${OS}-${CPU}`;
const A = "a".repeat(40);
const B = "b".repeat(40);
const FIRST = "0.1.0";
const SECOND = "9.9.9";
const homes = [];
const hits = [];
let server;
let base;
let currentVersion = FIRST;
let releases;
let breakPath;
let missingPath;
let serveNode;

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

/** 假 Node：`-v` 报清单里的版本，其余转给真 Node。 */
function buildFakeNode() {
  const dir = join(WORK, "node-pkg", "node");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "node"), `#!/bin/sh\n[ "$1" = "-v" ] && { echo ${NODE_VERSION}; exit 0; }\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(dir, "bin", "node"), 0o755);
  tar(["-czf", join(WORK, "node.tar.gz"), "-C", join(WORK, "node-pkg"), "node"]);
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
  if (name === "source") {
    cpSync(INSTALL_SH, join(dir, "install.sh"));
    mkdirSync(join(dir, "deploy/hifabu"), { recursive: true });
    cpSync(join(ROOT, "deploy/hifabu/install-template.sh"), join(dir, "deploy/hifabu/install-template.sh"));
  }
  tar(["-czf", join(WORK, `${name}.tar.gz`), "-C", join(WORK, `${name}-src`), "versekit-main"]);
}

function buildComponent(name) {
  const dir = join(WORK, `${name}-pkg`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\necho ${name}-release\n`, { mode: 0o755 });
  tar(["-czf", join(WORK, `${name}.tar.gz`), "-C", dir, name]);
}

before(async () => {
  buildFakeNode();
  buildApp("app-1", FIRST);
  buildApp("app-2", SECOND);
  buildApp("source", "8.8.8");
  buildComponent("biliup");
  buildComponent("lark-cli");
  server = createServer((req, res) => {
    const url = req.url;
    hits.push(url);
    const body = releases[currentVersion][url] ?? releases[FIRST][url] ?? releases[SECOND][url];
    if (body === undefined || url === missingPath) return res.writeHead(404).end("no");
    if (serveNode && url === "/deps/node.tar.gz") return serveNode(req, res, body);
    if (url !== breakPath) return res.end(body);
    if (url.endsWith("/SHA256SUMS")) return res.end(body.replace(/^\w{64}(?=  manifest\.json$)/m, "0".repeat(64)));
    res.end(Buffer.concat([Buffer.from(body), Buffer.from("corrupted")]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  releases = Object.fromEntries([[FIRST, A, "app-1"], [SECOND, B, "app-2"]].map(([version, commit, app]) => [
    version,
    fakeRelease(base, {
      version, commit, platform: PLATFORM,
      app: readFileSync(join(WORK, `${app}.tar.gz`)),
      node: readFileSync(join(WORK, "node.tar.gz")),
      components: {
        biliup: readFileSync(join(WORK, "biliup.tar.gz")),
        "lark-cli": readFileSync(join(WORK, "lark-cli.tar.gz")),
      },
    }),
  ]));
  writeFileSync(join(WORK, "release-install.sh"), releases[FIRST][`/${FIRST}/install.sh`]);
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
    HIFABU_PORT: String(port),
    HIFABU_SERVICE_LABEL: `com.versekit.test.${process.pid}.${homes.length}`,
    HIFABU_SERVICE_MANAGER: "detach",
    HIFABU_OFFLINE: "1",
    HIFABU_NO_OPEN: "1",
    HIFABU_INSTALL_TEST: "1",
    HIFABU_DOWNLOAD_URL: base,
    ...extra,
  };
  delete env.HIFABU_HOME;
  delete env.HIFABU_PREFIX;
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

test("ACC-brand-05 安装器兼容旧环境变量，新变量即使为空也优先", { timeout: 120000 }, async () => {
  const h = await newHome();
  const data = join(h.home, "data");
  delete h.env.HIFABU_PORT;
  Object.assign(h.env, {
    VK_HOME: data,
    VERSEKIT_PORT: String(h.port),
    VERSEKIT_SERVICE_MANAGER: "invalid",
    VERSEKIT_APP_SHA256: "invalid",
    HIFABU_APP_SHA256: "",
  });
  try {
    const r = await install(h);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(await status(h.port), 200);
    assert.ok(existsSync(join(data, ".local/state/versekit/vk.db")));
    assert.equal(r.stderr.match(/VK_HOME 已改名为 HIFABU_HOME/g)?.length, 1, r.stderr);
    assert.equal(r.stderr.match(/VERSEKIT_PORT 已改名为 HIFABU_PORT/g)?.length, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /(?:VERSEKIT_SERVICE_MANAGER|VERSEKIT_APP_SHA256) 已改名/);
  } finally {
    if (existsSync(vkOf(h))) await sh(h, vkOf(h), ["service", "uninstall", "--service-only"]);
  }
});

// 这几条按顺序依赖同一个临时 HOME：装 → 升级 → 卸载。
let main;

test("ACC-release-02 / ACC-install-01/02/05：正式版全新安装只装 Node 和程序，先预告服务", { timeout: 120000 }, async (t) => {
  main = await newHome();
  const start = hits.length;
  const r = await sh(main, "bash", [join(WORK, "release-install.sh")], {
    env: { HIFABU_APP_URL: "file:///not-the-release", HIFABU_APP_SHA256: "invalid" },
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  t.diagnostic(r.stdout.trim());
  assert.deepEqual(hits.slice(start), ["/deps/node.tar.gz", `/${FIRST}/app.tar.gz`]);
  assert.match(r.stdout, /后台服务 com\.versekit\.test\.[^：]+：.*控制台.*排期.*日志：.*vk\.log\n▸ 注册后台服务/);

  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.at(-1), `装好了，控制台地址 http://127.0.0.1:${main.port}，终端可以关了`, r.stderr);

  const prefix = join(main.home, ".versekit");
  for (const f of ["node/bin/node", "app/packages/cli/src/vk.mjs", "bin/vk"]) assert.ok(existsSync(join(prefix, f)), `缺 ${f}`);
  assert.equal(readFileSync(join(prefix, "app/release-manifest.json"), "utf8"), releases[FIRST][`/${FIRST}/manifest.json`]);
  assert.ok(existsSync(join(main.home, ".local/state/versekit/vk.db")), "vk init 应该建库");
  assert.equal(await status(main.port), 200);

  // 服务描述落盘，且是离线模式（HIFABU_OFFLINE=1）
  const meta = JSON.parse(readFileSync(join(main.home, ".local/state/versekit/service.json"), "utf8"));
  assert.equal(meta.manager, "detach");
  assert.equal(meta.offline, true);
  assert.equal(meta.port, main.port);
  assert.match(readFileSync(join(main.home, ".local/state/versekit/vk.log"), "utf8"), /离线模式/);

  // PATH 那一行：带标记、只有一段
  const rc = join(main.home, ".zshrc");
  assert.equal(markerCount(rc), 1);
  assert.match(readFileSync(rc, "utf8"), new RegExp(`export PATH="${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/bin:\\$PATH"`));

  assert.deepEqual(readdirSync(join(prefix, "bin")).sort(), ["hifabu", "vk"]);
  // 装好的 vk 可以直接用。
  const v = await sh(main, vkOf(main), ["service", "status"]);
  const st = JSON.parse(v.stdout);
  assert.equal(st.running, true);
  assert.equal(st.reachable, true);
  assert.equal(st.manager, "detach");
});

test("ACC-release-02 / ACC-install-03：旧地址按 latest.json 升级，保留数据并更新已有组件", { timeout: 120000 }, async (t) => {
  const vk = vkOf(main);
  const added = await sh(main, vk, ["group", "add", "保留我"]);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const cred = join(main.home, ".config/versekit/credentials/keep.txt");
  writeFileSync(cred, "secret");
  const before = JSON.parse((await sh(main, vk, ["service", "status"])).stdout).pid;

  const prefix = join(main.home, ".versekit");
  const stamp = join(prefix, "app/.versekit-build.json");
  writeFileSync(stamp, readFileSync(stamp, "utf8").replace(/^  "release":.*\n/m, ""));
  for (const name of ["biliup", "lark-cli"]) writeFileSync(join(prefix, "bin", name), "old version", { mode: 0o755 });

  currentVersion = SECOND;
  const r = await install(main);
  currentVersion = FIRST;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  t.diagnostic(r.stdout.trim());
  assert.match(r.stdout, /^安装地址已改为 hifabu\.com\/download/);
  assert.match(r.stdout, /已升级 0\.1\.0\+aaaaaaa → 9\.9\.9/);
  assert.match(readFileSync(join(main.home, ".local/state/versekit/vk.log"), "utf8"), /\[release\.transition\] 已改为从 hifabu\.com 获取正式版本/);
  for (const name of ["biliup", "lark-cli"]) {
    assert.equal((await sh(main, join(prefix, "bin", name), [])).stdout.trim(), `${name}-release`);
  }
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

test("ACC-release-02：升级后 release-manifest.json 原样换成本次发版清单", () => {
  const installed = readFileSync(join(main.home, ".versekit/app/release-manifest.json"), "utf8");
  assert.equal(installed, releases[SECOND][`/${SECOND}/manifest.json`]);
  assert.notEqual(installed, releases[FIRST][`/${FIRST}/manifest.json`]);
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

test("ACC-release-02：任一文件 SHA-256 不符就停止，首次失败无残留", { timeout: 60000 }, async (t) => {
  for (const path of ["/deps/node.tar.gz", `/${FIRST}/app.tar.gz`, `/${FIRST}/install.sh`, `/${FIRST}/manifest.json`]) {
    const h = await newHome();
    breakPath = path;
    const r = await install(h);
    breakPath = undefined;
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(`${path.split("/").at(-1)} 的 SHA-256 校验不通过`), r.stderr);
    assert.ok(!existsSync(join(h.home, ".versekit")));
    assert.ok(!existsSync(join(h.home, ".local/state/versekit/service.json")));
    assert.ok(!existsSync(join(h.home, ".zshrc")));
    assert.equal(await status(h.port), null);
    if (path.endsWith("app.tar.gz")) t.diagnostic(r.stderr.trim());
  }
});

test("ACC-release-02：版本指针与 SHA256SUMS 的清单哈希不一致，拒绝下载安装脚本", { timeout: 60000 }, async () => {
  const h = await newHome();
  const start = hits.length;
  breakPath = `/${FIRST}/SHA256SUMS`;
  const r = await install(h);
  breakPath = undefined;
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /SHA256SUMS 中 manifest\.json 的 SHA-256 与 latest\.json 不符（期望 [0-9a-f]{64}，实际 0{64}）/);
  assert.deepEqual(hits.slice(start), ["/latest.json", `/${FIRST}/SHA256SUMS`, `/${FIRST}/manifest.json`]);
  assert.ok(!existsSync(join(h.home, ".versekit")));
});

test("ACC-release-02：测试下载源需要显式打开测试开关", async () => {
  const h = await newHome();
  const start = hits.length;
  const r = await install(h, { env: { HIFABU_INSTALL_TEST: "" } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /仅离线测试可设置测试下载源/);
  assert.deepEqual(hits.slice(start), []);
});

test("ACC-release-02：已有组件的校验失败保留旧程序、组件和服务", { timeout: 120000 }, async () => {
  const h = await newHome();
  assert.equal((await install(h)).code, 0);
  const prefix = join(h.home, ".versekit");
  const lark = join(prefix, "bin/lark-cli");
  writeFileSync(lark, "keep lark", { mode: 0o755 });
  breakPath = "/deps/lark-cli.tar.gz";
  currentVersion = SECOND;
  const start = hits.length;
  const r = await install(h);
  currentVersion = FIRST;
  breakPath = undefined;
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /lark-cli\.tar\.gz 的 SHA-256 校验不通过/);
  assert.ok(!hits.slice(start).includes("/deps/biliup.tar.gz"));
  assert.equal(readFileSync(lark, "utf8"), "keep lark");
  assert.equal(JSON.parse(readFileSync(join(prefix, "app/package.json"), "utf8")).version, FIRST);
  assert.equal(await status(h.port), 200);
  assert.match((await sh(h, vkOf(h), ["events"])).stdout, /install_update_failed/);
});

test("ACC-install-03：下载失败——退出码非 0 并指出文件", { timeout: 60000 }, async () => {
  const h = await newHome();
  missingPath = `/${FIRST}/app.tar.gz`;
  const r = await install(h);
  missingPath = undefined;
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /下载失败：.*app\.tar\.gz/);
});

test("ACC-release-07：安装器续传、校验失败后重下，耗尽五次重试后清理半截文件", { timeout: 60000 }, async (t) => {
  for (const [scenario, succeeds, corrupt, ignoresRange] of [
    ["中途断线后续传并通过校验", true, false, false],
    ["续传后的 SHA-256 不符时丢弃并从头下载", true, true, false],
    ["镜像忽略 Range 时从头下载", true, false, true],
    ["持续断线时报告下载失败并清理半截文件", false, false, false],
  ]) {
    await t.test(scenario, async (t) => {
      const h = await newHome();
      const downloads = join(h.home, "downloads");
      mkdirSync(downloads);
      const offsets = [];
      let halfway;
      serveNode = (req, res, body) => {
        const requested = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
        offsets.push(requested);
        halfway = Math.floor(body.length / 2);
        const offset = ignoresRange ? 0 : requested;
        const remaining = body.subarray(offset);
        res.setHeader("Content-Length", remaining.length);
        if (offset) {
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${offset}-${body.length - 1}/${body.length}`);
        }
        if (!succeeds || offsets.length === 1) {
          const part = Buffer.from(remaining.subarray(0, Math.floor(remaining.length / 2)));
          if (corrupt) part[0] ^= 1;
          return res.write(part, () => setTimeout(() => res.destroy(), 25));
        }
        res.end(remaining);
      };
      t.after(() => { serveNode = undefined; });

      const r = await sh(h, "bash", [join(WORK, "release-install.sh")], { env: { TMPDIR: downloads } });
      assert.deepEqual(readdirSync(downloads), []);
      if (succeeds) {
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /校验通过，解压 Node/);
        assert.deepEqual(offsets, corrupt || ignoresRange ? [0, halfway, 0] : [0, halfway]);
        assert.equal(await status(h.port), 200);
      } else {
        assert.equal(r.code, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /下载失败：.*node\.tar\.gz/);
        assert.equal(offsets.length, 6);
        assert.deepEqual(offsets.slice(0, 2), [0, halfway]);
        assert.ok(offsets.slice(1).every((offset, i) => offset > offsets[i]));
        assert.ok(!existsSync(join(h.home, ".versekit")));
      }
    });
  }
});

test("ACC-release-02：旧更新器传入本地源码包，保留 app.prev 且不改 PATH", { timeout: 120000 }, async (t) => {
  const h = await newHome();
  assert.equal((await install(h)).code, 0);
  const previousPath = readFileSync(join(h.home, ".zshrc"), "utf8");
  const prefix = join(h.home, ".versekit");
  const source = join(WORK, "source.tar.gz");
  const start = hits.length;
  const r = await sh(h, "bash", [join(WORK, "source-src/versekit-main/install.sh")], {
    env: { VERSEKIT_UPDATE: "1", VERSEKIT_APP_URL: pathToFileURL(source).href, VERSEKIT_APP_COMMIT: B },
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const previous = JSON.parse(readFileSync(join(prefix, "app.prev/package.json"), "utf8")).version;
  const installed = JSON.parse(readFileSync(join(prefix, "app/package.json"), "utf8")).version;
  assert.equal(previous, FIRST);
  assert.equal(installed, "8.8.8");
  assert.equal(await status(h.port, "/api/now"), 200);
  assert.equal(readFileSync(join(h.home, ".zshrc"), "utf8"), previousPath);
  assert.deepEqual(hits.slice(start), []);
  t.diagnostic(`${r.stdout.trim()}\napp.prev/package.json version=${previous}；app/package.json version=${installed}；/api/now=200；PATH 未改`);
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
  const h = await newHome({ HIFABU_SERVICE_MANAGER: "" });
  delete h.env.HIFABU_SERVICE_MANAGER;
  const r = await install(h);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const label = h.env.HIFABU_SERVICE_LABEL;
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

test("ACC-install-06：安装输出有「正在…」进度提示，非 tty 时不刷进度条", { timeout: 120000 }, async () => {
  const h = await newHome();
  const r = await install(h);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const re of [/下载 Node v\S+……/, /校验通过，解压 Node……/, /准备 Hifabu 程序……/, /解压 Hifabu 程序……/, /初始化数据库.*……/, /等控制台起来.*……/]) {
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
  for (const need of ["package.json", "packages/cli/src/vk.mjs", "packages/core/src/schema.sql", "scripts/demo-seed.mjs"]) {
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

test("ACC-release-02：重装同一锁定版本不会报告升级", { timeout: 120000 }, async () => {
  const h = await newHome();
  assert.equal((await install(h)).code, 0);
  const again = await install(h);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /已是最新（aaaaaaa），重新装了一遍/);
  assert.doesNotMatch(again.stdout, /已升级/);
});
