// 后台自动更新（#217）：真的跑 install.sh、真的起服务、真的退回。
//
// 不碰真实环境：HOME 是临时目录，服务名带测试前缀，端口随机，服务以 --offline 起，托管方式固定 detach；
// 下载源是本机假 hifabu.com，提供正式版安装器、清单、Node 和程序包。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createServer as netServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeRelease, NODE_VERSION } from "../../core/test/install-fixtures.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INSTALL_SH = join(ROOT, "install.sh");
const WORK = mkdtempSync(join(platform() === "darwin" ? "/tmp" : tmpdir(), "vk-upd-"));
const OS = platform() === "darwin" ? "darwin" : "linux";
const CPU = arch() === "arm64" ? "arm64" : "x64";
const PLATFORM = `${OS}-${CPU}`;

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const OLD_SERVICE = "com.versekit.daemon";
const NEW_SERVICE = "com.hifabu.daemon";
const homes = [];
let server;
let base;
let servedRelease = "app-1";
let releases;
const requests = [];
const overrides = new Map();

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
  writeFileSync(join(dir, "bin", "node"), `#!/bin/sh\n[ "$1" = "-v" ] && { echo ${NODE_VERSION}; exit 0; }\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(dir, "bin", "node"), 0o755);
  tar(["-czf", join(WORK, "node.tar.gz"), "-C", join(WORK, "node-pkg"), "node"]);
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
  mkdirSync(join(dir, "deploy/hifabu"), { recursive: true });
  cpSync(join(ROOT, "deploy/hifabu/install-template.sh"), join(dir, "deploy/hifabu/install-template.sh"));
  patch?.(dir);
  tar(["-czf", join(WORK, `${name}.tar.gz`), "-C", join(WORK, `${name}-src`), "versekit-main"]);
}

before(async () => {
  buildFakeNode();
  buildApp("app-1", "0.1.0");
  buildApp("app-2", "9.9.9");
  // 坏包：能起来、/today 是 200，但 /api/now 一直报错——install.sh 自己发现不了，要靠更新后的自检。
  buildApp("app-bad", "10.0.0", (dir) => {
    const f = join(dir, "packages/core/src/handlers.mjs");
    const src = readFileSync(f, "utf8");
    const patched = src.replace("now: () => ({ ...store.statusSnapshot() }),", 'now: () => { throw new Error("故意坏掉"); },');
    assert.notEqual(patched, src, "坏包补丁没打上：handlers.mjs 里的 now 写法变了，这条测试要跟着改");
    writeFileSync(f, patched);
  });
  buildApp("app-init-bad", "8.8.8", (dir) => {
    writeFileSync(join(dir, "packages/core/src/schema.sql"), "injected init failure");
  });
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push({ url, headers: req.headers });
    const body = overrides.has(url) ? overrides.get(url) : releases[servedRelease]?.[url];
    if (body === null) return req.socket.destroy();
    if (body !== undefined) return res.end(body);
    res.writeHead(404).end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  releases = Object.fromEntries([
    ["app-1", "0.1.0", A],
    ["app-2", "9.9.9", B],
    ["app-bad", "10.0.0", C],
    ["app-init-bad", "8.8.8", C],
  ].map(([name, version, commit]) => [
    name,
    fakeRelease(base, {
      version, commit, platform: PLATFORM,
      app: readFileSync(join(WORK, `${name}.tar.gz`)),
      node: readFileSync(join(WORK, "node.tar.gz")),
    }),
  ]));
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
    HIFABU_PORT: String(port),
    HIFABU_SERVICE_LABEL: `com.versekit.test.upd.${process.pid}.${homes.length}`,
    HIFABU_SERVICE_MANAGER: "detach",
    HIFABU_OFFLINE: "1",
    HIFABU_NO_OPEN: "1",
    HIFABU_INSTALL_TEST: "1",
    HIFABU_DOWNLOAD_URL: base,
    HIFABU_APP_URL: `${base}/retired-archive?name=fixture-device`,
    GH_TOKEN: "fixture-private-token",
    HIFABU_UPDATE_API: base,
    HIFABU_UPDATE_START_DELAY_MS: "600000",
    HIFABU_UPDATE_HEALTH_TIMEOUT_MS: "4000",
    ...extra,
  };
  delete env.HIFABU_HOME;
  delete env.HIFABU_PREFIX;
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
const hifabuOf = (h) => join(h.prefix, "bin", "hifabu");
const hifabu = (h, ...args) => sh(h, hifabuOf(h), args);
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

// 只替换系统服务管理器。注册表与定义都在临时 HOME，受管进程是真实的离线 Hifabu。
function fakeServiceManager(h, manager) {
  const bin = join(h.home, "manager-bin");
  mkdirSync(bin);
  h.env.PATH = `${bin}:${h.env.PATH}`;
  h.env.XDG_CONFIG_HOME = join(h.home, ".config");
  h.env.HIFABU_SERVICE_MANAGER = manager;
  const command = manager === "launchd" ? "launchctl" : "systemctl";
  writeFileSync(join(bin, command), `#!${process.execPath}\n` + String.raw`
const { existsSync, readFileSync, writeFileSync, rmSync, appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { basename, join } = require("node:path");
const home = process.env.HOME;
const args = process.argv.slice(2).filter((arg) => arg !== "--user");
const [action, target, plist] = args;
const systemd = basename(process.argv[1]) === "systemctl";
const unit = args.find((arg) => arg.endsWith(".service")) ?? "";
const label = systemd ? unit.replace(/\.service$/, "") : (plist ? basename(plist, ".plist") : basename(target ?? ""));
const pidFile = join(home, label + ".manager-pid");
const enabled = join(home, label + ".manager-enabled");
const failFile = join(home, "manager-failure");
const step = [action, label].join(" ");
appendFileSync(join(home, "manager-log"), step + "\n");
if (existsSync(failFile) && readFileSync(failFile, "utf8") === step) {
  rmSync(failFile);
  if (action === "disable") rmSync(enabled, { force: true });
  console.error("故意失败 " + step);
  process.exit(1);
}
const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
if (action === "print" || action === "show") {
  if (systemd) console.log("ActiveState=" + (pid ? "active" : "inactive") + "\nMainPID=" + pid);
  else if (pid) console.log("state = running\npid = " + pid);
  else process.exit(1);
}
if (action === "is-enabled") {
  console.log(existsSync(enabled) ? "enabled" : "disabled");
  process.exit(existsSync(enabled) ? 0 : 1);
}
if (action === "disable") rmSync(enabled, { force: true });
if (action === "enable") writeFileSync(enabled, "");
if ((action === "stop" || action === "bootout" || (action === "disable" && args.includes("--now"))) && pid) {
  try { process.kill(pid, "SIGTERM"); } catch (err) { if (err.code !== "ESRCH") throw err; }
  rmSync(pidFile);
}
if (!pid && (action === "start" || action === "bootstrap" || (action === "enable" && args.includes("--now")))) {
  const file = systemd ? join(home, ".config/systemd/user", unit) : plist;
  const config = readFileSync(file, "utf8");
  const argv = systemd
    ? Array.from(config.match(/^ExecStart=(.*)$/m)[1].matchAll(/"([^"]*)"/g), ([, arg]) => arg)
    : Array.from(config.split("<array>")[1].split("</array>")[0].matchAll(/<string>(.*?)<\/string>/g), ([, arg]) => arg);
  if (!argv.includes("--offline")) throw new Error("测试服务必须离线");
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}
`, { mode: 0o755 });
}

async function dataSnapshot(h, loginFiles) {
  const read = async (path) => {
    const res = await fetch(`http://127.0.0.1:${h.port}${path}`);
    assert.equal(res.status, 200, path);
    return res.json();
  };
  const { accounts } = await read("/api/accounts");
  const { works } = await read("/api/works");
  return {
    accounts: accounts.map(({ id, state }) => ({ id, state })),
    works: works.map(({ id }) => id),
    files: loginFiles.map(sha),
  };
}

async function measureDowntime(port, operation) {
  let lastHealthy = performance.now();
  let unavailableAt;
  let downtimeMs = 0;
  let done = false;
  const monitor = (async () => {
    while (!done) {
      const healthy = await status(port, "/api/now") === 200;
      const now = performance.now();
      if (!healthy) unavailableAt ??= lastHealthy;
      else {
        if (unavailableAt !== undefined) downtimeMs += now - unavailableAt;
        unavailableAt = undefined;
        lastHealthy = now;
      }
      await sleep(25);
    }
  })();
  try {
    const result = await operation();
    await waitFor(() => unavailableAt === undefined, () => "升级结束时 /api/now 仍未恢复");
    return { ...result, downtimeMs };
  } finally {
    done = true;
    await monitor;
  }
}

async function installV1(h) {
  servedRelease = "app-1";
  const r = await sh(h, "bash", [INSTALL_SH]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
}

for (const manager of ["launchd", "systemd"]) {
  test(`ACC-brand-06 ${manager}：自检失败恢复旧服务，通过后只保留新服务和原数据`, { timeout: 120000 }, async (t) => {
    const h = await newHome({ HIFABU_SERVICE_LABEL: OLD_SERVICE });
    fakeServiceManager(h, manager);
    h.env.HIFABU_HOME = h.home;
    await installV1(h);
    delete h.env.HIFABU_SERVICE_LABEL;
    const initial = json(await hifabu(h, "service", "status"));
    assert.equal(initial.label, OLD_SERVICE);
    assert.equal(initial.running && initial.reachable, true);
    const asset = join(h.home, "migration-fixture.mp4");
    writeFileSync(asset, "migration fixture");
    for (const args of [
      ["group", "add", "迁移验收"],
      ["account", "add", "bilibili", "--group", "迁移验收", "--name", "测试 B 站"],
      ["account", "add", "tiktok", "--group", "迁移验收", "--name", "测试 TikTok"],
      ["work", "add", asset],
    ]) {
      const seeded = await hifabu(h, ...args);
      assert.equal(seeded.code, 0, seeded.stdout + seeded.stderr);
    }

    const loginFiles = [
      join(h.home, ".config/versekit/credentials/test-session.json"),
      join(h.home, ".local/state/versekit/browser/test-account/Default/Cookies"),
    ];
    loginFiles.forEach((file, i) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `fixture-login-state-${i}`);
    });
    const before = await dataSnapshot(h, loginFiles);
    assert.equal(before.accounts.length, 2);
    assert.equal(before.works.length, 1);
    const defs = manager === "launchd" ? "Library/LaunchAgents" : ".config/systemd/user";
    const ext = manager === "launchd" ? ".plist" : ".service";
    const definitionFiles = () => readdirSync(join(h.home, defs)).sort();
    const runningLabels = () => readdirSync(h.home).filter((file) => file.endsWith(".manager-pid"))
      .map((file) => file.replace(/\.manager-pid$/, ""));
    const oldDefinition = readFileSync(join(h.home, defs, OLD_SERVICE + ext), "utf8");

    const assertRestored = async () => {
      assert.equal(appVersion(h), "0.1.0");
      const restored = json(await hifabu(h, "service", "status"));
      assert.equal(restored.label, OLD_SERVICE);
      assert.equal(restored.running && restored.reachable, true);
      assert.equal(await status(h.port, "/api/now"), 200);
      assert.deepEqual(runningLabels(), [OLD_SERVICE]);
      assert.deepEqual(definitionFiles(), [OLD_SERVICE + ext]);
      assert.equal(readFileSync(join(h.home, defs, OLD_SERVICE + ext), "utf8"), oldDefinition);
      assert.deepEqual(await dataSnapshot(h, loginFiles), before);
    };

    servedRelease = "app-bad";
    const unhealthy = await measureDowntime(h.port, () => hifabu(h, "update", "--now"));
    assert.equal(unhealthy.code, 1, unhealthy.stdout + unhealthy.stderr);
    assert.match(json(unhealthy).reason, /com\.hifabu\.daemon 没通过自检/, unhealthy.stderr);
    assert.equal(json(unhealthy).rolledBack, true);
    await assertRestored();
    const events = json(await hifabu(h, "events"));
    const event = (events.events ?? events.rows ?? events).find((row) => row.type === "update.failed");
    assert.equal(event?.payload.error_code, "update_failed");
    assert.match(event.payload.reason, /没通过自检/);

    if (manager === "launchd") {
      servedRelease = "app-init-bad";
      const result = await sh(h, "bash", [INSTALL_SH], { env: { HIFABU_APP_COMMIT: B } });
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /hifabu init 失败/);
      await assertRestored();
      const log = json(await hifabu(h, "events"));
      const failed = (log.events ?? log.rows ?? log).find((row) => row.payload?.error_code === "install_update_failed");
      assert.match(failed?.payload.reason, /hifabu init 失败/);
    }

    servedRelease = "app-2";
    if (manager === "systemd") {
      const fail = join(h.home, "manager-failure");
      for (const step of [`stop ${OLD_SERVICE}`, `enable ${NEW_SERVICE}`, `disable ${OLD_SERVICE}`]) {
        writeFileSync(fail, step);
        const result = await hifabu(h, "update", "--now");
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.match(json(result).reason, /故意失败/);
        await assertRestored();
        assert.ok(existsSync(join(h.home, OLD_SERVICE + ".manager-enabled")));
        assert.ok(!existsSync(join(h.home, NEW_SERVICE + ".manager-enabled")));
      }
    }

    const updated = await measureDowntime(h.port, () => manager === "launchd"
      // 旧更新器会把已安装的标签传给新版安装脚本。
      ? sh(h, "bash", [INSTALL_SH], { env: { HIFABU_SERVICE_LABEL: OLD_SERVICE, HIFABU_UPDATE: "1", HIFABU_APP_COMMIT: B } })
      : hifabu(h, "update", "--now"));
    assert.equal(updated.code, 0, updated.stdout + updated.stderr);
    assert.equal(appVersion(h), "9.9.9");
    const service = json(await hifabu(h, "service", "status"));
    assert.equal(service.label, NEW_SERVICE);
    assert.equal(service.port, h.port);
    assert.equal(service.running && service.reachable, true);
    assert.deepEqual(runningLabels(), [NEW_SERVICE]);
    assert.deepEqual(definitionFiles(), [NEW_SERVICE + ext]);
    assert.deepEqual(await dataSnapshot(h, loginFiles), before);
    if (manager === "systemd") assert.ok(!existsSync(join(h.home, OLD_SERVICE + ".manager-enabled")));
    t.diagnostic(`${manager}: accounts ${before.accounts.length} → ${before.accounts.length}, works ${before.works.length} → ${before.works.length}, unchanged login files: ${loginFiles.length}; /api/now outage: upgrade ${(updated.downtimeMs / 1000).toFixed(2)}s, rollback after failed health check ${(unhealthy.downtimeMs / 1000).toFixed(2)}s (25ms polling)`);
  });
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

test("ACC-release-03 vk update --check 显示正式版本；--auto off|on 就地开关", { timeout: 120000 }, async () => {
  servedRelease = "app-2";
  const c = json(await vk(main, "update", "--check"));
  assert.equal(c.message, "有新版本：9.9.9");
  assert.equal(c.notes, JSON.parse(releases["app-2"]["/9.9.9/manifest.json"]).notes);
  servedRelease = "app-1";
  assert.equal(json(await vk(main, "update", "--check")).message, "已是最新");

  const off = await vk(main, "update", "--auto", "off");
  assert.match(off.stdout, /后台自动更新：关/);
  assert.equal(json(await vk(main, "version", "--json")).auto, false);
  await vk(main, "update", "--auto", "on");
  assert.equal(json(await vk(main, "version", "--json")).auto, true);
  assert.equal(json(await vk(main, "version", "--json")).lastCheck.message, "已是最新", "检查结果记下来了，系统页显示它");
});

test("ACC-brand-04 安装 hifabu 与 vk 别名，兼容制作机的 --data", async () => {
  for (const args of [["--help"], ["commands", "--json"], ["unknown-command"]]) {
    const primary = await hifabu(main, ...args);
    const alias = await vk(main, ...args);
    assert.equal(primary.code, args[0] === "unknown-command" ? 2 : 0);
    assert.equal(alias.code, primary.code);
    assert.equal(alias.stdout, primary.stdout);
    assert.equal(alias.stderr, "vk 已改名为 hifabu\n" + primary.stderr);
  }

  const otherData = join(main.home, "unused maker data");
  const groups = await hifabu(main, "group", "list");
  assert.equal(groups.code, 0, groups.stderr);
  const { reportedAt, ...expected } = JSON.parse(groups.stdout);
  assert.ok(Array.isArray(expected.groups));
  assert.ok(Number.isSafeInteger(reportedAt));
  for (const args of [["--data", otherData, "group", "list"], ["group", "list", "--data", otherData]]) {
    const result = await hifabu(main, ...args);
    assert.equal(result.code, groups.code);
    assert.equal(result.stderr, groups.stderr);
    const { reportedAt: readAt, ...actual } = JSON.parse(result.stdout);
    assert.ok(Number.isSafeInteger(readAt) && readAt >= reportedAt);
    assert.deepEqual(actual, expected);
  }
  assert.equal(existsSync(otherData), false);
});

test("ACC-update-02 已是最新时 vk update 什么都不动", { timeout: 60000 }, async () => {
  servedRelease = "app-1";
  const r = json(await vk(main, "update"));
  assert.equal(r.updated, false);
  assert.equal(r.message, "已是最新");
  assert.equal(appVersion(main), "0.1.0");
});

test("ACC-release-03 校验后用正式版安装器升级，数据保留，系统页读取该版 CHANGELOG", { timeout: 180000 }, async () => {
  const added = await vk(main, "group", "add", "保留我");
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const cred = join(main.home, ".config/versekit/credentials/keep.txt");
  writeFileSync(cred, "secret");
  const rcBefore = readFileSync(join(main.home, ".zshrc"), "utf8");

  // 模拟升级前只安装了 vk 的老版本。
  const launcher = readFileSync(hifabuOf(main), "utf8");
  rmSync(vkOf(main));
  writeFileSync(vkOf(main), launcher.split("\n").filter((line) => !line.includes("vk 已改名")).join("\n"), { mode: 0o755 });
  rmSync(hifabuOf(main));

  servedRelease = "app-2";
  requests.length = 0;
  const r = await vk(main, "update");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(requests.map(({ url }) => url), [
    "/latest.json", "/9.9.9/SHA256SUMS", "/9.9.9/manifest.json", "/9.9.9/install.sh",
    "/deps/node.tar.gz", "/9.9.9/app.tar.gz",
  ]);
  for (const { headers } of requests) {
    for (const name of ["authorization", "cookie", "referer"]) assert.equal(headers[name], undefined);
  }
  assert.ok(requests.slice(0, 4).every(({ headers }) => headers["user-agent"] === "versekit-updater"));
  assert.doesNotMatch(JSON.stringify(requests), /fixture-device|fixture-private-token/);
  assert.equal((await hifabu(main, "--help")).code, 0);
  assert.equal((await vk(main, "--help")).stderr, "vk 已改名为 hifabu\n");
  const out = json(r);
  assert.equal(out.updated, true, r.stdout);
  assert.equal(appVersion(main), "9.9.9");
  assert.ok(!existsSync(join(main.prefix, "app.prev")), "自检通过后清掉 app.prev");
  assert.ok(!existsSync(join(main.prefix, "bin/biliup.new")));

  const v = json(await vk(main, "version", "--json"));
  assert.equal(v.version, "9.9.9");
  assert.equal(v.commit, B, "提交号是新包的");
  assert.equal(v.lastUpdate.version, "9.9.9");
  const notes = JSON.parse(releases["app-2"]["/9.9.9/manifest.json"]).notes;
  assert.equal(v.lastUpdate.notes, notes);
  assert.equal(v.notes, notes);
  const api = await fetch(`http://127.0.0.1:${main.port}/api/update`);
  assert.equal((await api.json()).notes, notes);
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
  servedRelease = "app-bad";
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

test("ACC-release-03 校验不通过时拒绝执行安装脚本", { timeout: 120000 }, async (t) => {
  servedRelease = "app-bad";
  const versionDir = "/10.0.0";
  const sums = `${versionDir}/SHA256SUMS`;
  const manifest = `${versionDir}/manifest.json`;
  const installer = `${versionDir}/install.sh`;
  const initial = json(await vk(main, "service", "status"));
  for (const [path, damage, expected] of [
    [sums, (value) => value.replace(/[0-9a-f]{64}(?=  manifest\.json)/, "0".repeat(64)), /manifest\.json.*与 latest\.json 不符/],
    [manifest, (value) => value + " ", /manifest\.json 的 SHA-256 校验不通过/],
    [installer, (value) => value + "\n# unexpected change\n", /install\.sh 的 SHA-256 校验不通过/],
  ]) {
    await t.test(path, async (t) => {
      overrides.set(path, damage(releases["app-bad"][path]));
      t.after(() => overrides.delete(path));
      requests.length = 0;
      const r = await vk(main, "update");
      assert.equal(r.code, 1, r.stdout + r.stderr);
      const result = json(r);
      assert.match(result.reason ?? result.error?.message, expected);
      const expectedRequests = {
        [sums]: ["/latest.json", sums],
        [manifest]: ["/latest.json", sums, manifest, manifest],
        [installer]: ["/latest.json", sums, manifest, installer, installer],
      };
      assert.deepEqual(requests.map(({ url }) => url), expectedRequests[path]);
      assert.equal(appVersion(main), "9.9.9");
      assert.equal(json(await vk(main, "service", "status")).pid, initial.pid);
      assert.equal(await status(main.port), 200);
    });
  }
  const events = json(await vk(main, "events"));
  const event = (events.events ?? events.rows ?? events).find((e) => e.type === "update.failed" && e.payload.reason.includes("install.sh"));
  assert.equal(event?.payload.error_code, "update_failed");
  assert.match(event.payload.message, /继续运行.*install\.sh 的 SHA-256 校验不通过/);
});

test("ACC-release-03 下载断线只记日志，不产生更新失败事件或提醒", { timeout: 120000 }, async (t) => {
  servedRelease = "app-bad";
  const before = json(await vk(main, "events"));
  const state = json(await vk(main, "version", "--json"));
  for (const path of ["/latest.json", "/10.0.0/manifest.json", "/10.0.0/install.sh", "/10.0.0/app.tar.gz"]) {
    await t.test(path, async (t) => {
      overrides.set(path, null);
      t.after(() => overrides.delete(path));
      const r = await vk(main, "update");
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /\[update\] 下载.*稍后再试/);
      assert.equal(json(r).updated, false);
      assert.equal(appVersion(main), "9.9.9");
      assert.equal(await status(main.port), 200);
      assert.deepEqual(json(await vk(main, "events")), before);
      const after = json(await vk(main, "version", "--json"));
      assert.deepEqual(after.lastFailure, state.lastFailure);
      assert.match(after.lastCheckError.message, /下载.*稍后再试/);
    });
  }
});

test("ACC-update-03 后台服务自己更新：启动后检查，空闲就更新（脱离守护进程跑完，服务换成新版本）", { timeout: 180000 }, async () => {
  const h = await newHome({ HIFABU_UPDATE_START_DELAY_MS: "1500" });
  // 装 v1 后再发布新版，避免安装过程中触发自动更新。
  await installV1(h);
  assert.equal(appVersion(h), "0.1.0");
  await sleep(2500); // 启动检查：已是最新
  assert.equal(appVersion(h), "0.1.0");

  servedRelease = "app-2";
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
  const manifest = "/9.9.9/manifest.json";
  const newRelease = releases["app-2"];
  let pending;
  const updateServer = createServer((req, res) => {
    requests.push(req.url);
    // 等开关落盘，再让旧进程收到版本清单。
    if (req.url === manifest && !pending) {
      pending = res;
      return;
    }
    if (newRelease[req.url] !== undefined) return res.end(newRelease[req.url]);
    res.writeHead(404).end();
  });
  t.after(() => {
    updateServer.close();
    updateServer.closeAllConnections();
  });
  await new Promise((resolve) => updateServer.listen(0, "127.0.0.1", resolve));

  const h = await newHome({
    HIFABU_UPDATE_API: `http://127.0.0.1:${updateServer.address().port}`,
    HIFABU_UPDATE_START_DELAY_MS: "500",
  });
  await installV1(h);
  const initial = json(await vk(h, "service", "status"));
  assert.equal(initial.running && initial.reachable, true);
  await waitFor(() => pending, () => `启动检查未到达 manifest.json：${JSON.stringify(requests)}`);
  const off = await vk(h, "update", "--auto", "off");
  assert.equal(off.code, 0, off.stdout + off.stderr);
  assert.equal(json(await vk(h, "version", "--json")).auto, false);

  const log = () => readFileSync(initial.log, "utf8");
  const discarded = /\[update\] 检查期间关闭了自动更新，跳过安装/;
  servedRelease = "app-2";
  pending.end(newRelease[manifest]);
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
  assert.deepEqual(requests, ["/latest.json", "/9.9.9/SHA256SUMS", manifest], "只有关闭前的检查可以访问下载源");
  assert.equal(appVersion(h), "0.1.0");
  assert.equal(await status(service.port), 200);
});
