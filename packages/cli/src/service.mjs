// vk service：后台服务的安装 / 状态 / 启停 / 卸载（ACC-install-02 / 04）。
//
// 三种托管方式，按环境自动选（VERSEKIT_SERVICE_MANAGER 可强制）：
//   launchd  macOS LaunchAgent（RunAtLoad + KeepAlive）：关终端、重登、重启都还在，崩了被拉起
//   systemd  Linux `systemd --user`（Restart=always）
//   detach   没有 systemd 时退回：自己 spawn 一个脱离终端的进程；重启电脑后要再运行一次安装命令
//
// 所有路径、服务名、端口都能用环境变量覆盖，开发机上用测试服务名 + 临时 HOME 就不会碰真实环境。

import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, readdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { paths } from "../../core/src/index.mjs";

export const DEFAULT_LABEL = "com.versekit.daemon";
export const DEFAULT_PORT = 8787;
export const RC_BEGIN = "# >>> versekit >>>";
export const RC_END = "# <<< versekit <<<";

const CLI = fileURLToPath(new URL("./vk.mjs", import.meta.url));
const APP_ROOT = dirname(dirname(dirname(dirname(CLI))));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

export const labelOf = (env = process.env) => env.VERSEKIT_SERVICE_LABEL || DEFAULT_LABEL;

/**
 * 安装前缀：`<prefix>/app` 是程序，`<prefix>/node` 私有 Node，`<prefix>/bin` 放 vk 与 biliup。
 * 在源码仓库里直接跑 vk（目录名不是 app）时没有「安装」可言，`installed` 为 false，
 * 卸载就绝不会去删仓库。
 */
export function installLayout(env = process.env) {
  const prefix = env.VERSEKIT_PREFIX || join(homedir(), ".versekit");
  const fromApp = basename(APP_ROOT) === "app" ? dirname(APP_ROOT) : null;
  const root = env.VERSEKIT_PREFIX ? prefix : (fromApp ?? prefix);
  return {
    prefix: root,
    app: join(root, "app"),
    node: join(root, "node"),
    bin: join(root, "bin"),
    installed: basename(APP_ROOT) === "app" && join(root, "app") === APP_ROOT,
  };
}

export function detectManager(env = process.env) {
  const forced = env.VERSEKIT_SERVICE_MANAGER;
  if (forced) {
    if (!["launchd", "systemd", "detach"].includes(forced)) throw new Error(`不认识的 VERSEKIT_SERVICE_MANAGER=${forced}（可选 launchd / systemd / detach）`);
    return forced;
  }
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") {
    const r = run("systemctl", ["--user", "show-environment"]);
    if (!r.error && r.status === 0) return "systemd";
  }
  return "detach";
}

const metaFile = () => join(paths().state, "service.json");
const pidFile = () => join(paths().state, "service.pid");

function readMeta() {
  try {
    return JSON.parse(readFileSync(metaFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(meta) {
  mkdirSync(paths().state, { recursive: true, mode: 0o700 });
  writeFileSync(metaFile(), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
}

const plistPath = (label) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const unitName = (label) => `${label}.service`;
const unitPath = (label) => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", unitName(label));
const guiTarget = (label) => `gui/${process.getuid()}/${label}`;

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 服务进程的环境：PATH 含 <prefix>/bin 与私有 Node，所以 vk doctor 能找到 biliup。 */
export function serviceEnvVars(env = process.env) {
  const layout = installLayout(env);
  const nodeDir = dirname(process.execPath);
  const pathParts = [layout.bin, nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const vars = { PATH: [...new Set(pathParts)].join(":"), HOME: homedir() };
  if (env.VK_HOME) vars.VK_HOME = env.VK_HOME;
  if (env.VERSEKIT_PREFIX) vars.VERSEKIT_PREFIX = env.VERSEKIT_PREFIX;
  return vars;
}

export function serveArgs({ port, offline }) {
  return [CLI, "serve", "--port", String(port), ...(offline ? ["--offline"] : [])];
}

export function renderPlist({ label, port, offline, env = process.env }) {
  const vars = serviceEnvVars(env);
  const log = paths().log;
  const args = [process.execPath, ...serveArgs({ port, offline })];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(vars).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function renderUnit({ port, offline, env = process.env }) {
  const vars = serviceEnvVars(env);
  const log = paths().log;
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=versekit 控制台与后台守护进程

[Service]
ExecStart=${[process.execPath, ...serveArgs({ port, offline })].map(q).join(" ")}
${Object.entries(vars).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

/** GET http://127.0.0.1:<port>/today → 状态码；连不上返回 null。 */
export function probe(port, path = "/today", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function waitUp(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await probe(port)) === 200) return true;
    await sleep(300);
  }
  return false;
}

async function waitDown(port, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await probe(port, "/today", 500)) === null) return true;
    await sleep(200);
  }
  return false;
}

// ---------------------------------------------------------------- launchd

function launchdLoaded(label) {
  const r = run("launchctl", ["print", guiTarget(label)]);
  if (r.status !== 0) return { loaded: false, running: false, pid: null };
  const pid = /\bpid = (\d+)/.exec(r.stdout)?.[1];
  return { loaded: true, running: /state = running/.test(r.stdout), pid: pid ? Number(pid) : null };
}

/** bootout 是异步的：命令返回时服务可能还在卸载中，必须等到 launchctl print 查不到才算拆干净。 */
async function launchdBootout(label, timeoutMs = 15000) {
  if (!launchdLoaded(label).loaded) return;
  run("launchctl", ["bootout", guiTarget(label)]);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!launchdLoaded(label).loaded) return;
    await sleep(150);
  }
}

async function launchdBootstrap(label) {
  // 刚 bootout 完立刻 bootstrap 偶尔会 EIO（5）/ 已加载（37），短暂重试。
  let r;
  for (let i = 0; i < 20; i++) {
    r = run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath(label)]);
    if (r.status === 0 || launchdLoaded(label).loaded) return;
    await sleep(300);
  }
  if (r.status !== 0) {
    throw new Error(`launchctl bootstrap 失败：${(r.stderr || r.stdout).trim() || `退出码 ${r.status}`}（需要在登录后的图形会话里运行；SSH 登录请先在本机桌面登录一次）`);
  }
}

// ---------------------------------------------------------------- detach

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const n = Number(readFileSync(pidFile(), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function detachStart({ port, offline }) {
  const existing = readPid();
  if (existing && pidAlive(existing)) return existing;
  mkdirSync(paths().state, { recursive: true, mode: 0o700 });
  const fd = openSync(paths().log, "a", 0o600);
  const child = spawn(process.execPath, serveArgs({ port, offline }), {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...serviceEnvVars() },
  });
  child.unref();
  closeSync(fd);
  writeFileSync(pidFile(), String(child.pid));
  return child.pid;
}

async function detachStop() {
  const pid = readPid();
  if (pid && pidAlive(pid)) {
    process.kill(pid, "SIGTERM");
    const end = Date.now() + 8000;
    while (Date.now() < end && pidAlive(pid)) await sleep(150);
    if (pidAlive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(pidFile(), { force: true });
}

// ---------------------------------------------------------------- 对外操作

function requireInstalled() {
  const meta = readMeta();
  if (!meta) throw new Error("后台服务还没有安装：先运行安装命令，或 vk service install");
  return meta;
}

export async function status() {
  const meta = readMeta();
  const label = meta?.label ?? labelOf();
  const manager = meta?.manager ?? null;
  const data = { ok: true, installed: Boolean(meta), manager, label, port: meta?.port ?? null, offline: Boolean(meta?.offline), running: false, pid: null, reachable: false, url: null, log: paths().log };
  if (!meta) return data;
  if (manager === "launchd") Object.assign(data, launchdLoaded(label));
  else if (manager === "systemd") {
    const r = run("systemctl", ["--user", "show", unitName(label), "--property=ActiveState,MainPID"]);
    const active = /ActiveState=(\w+)/.exec(r.stdout)?.[1];
    const pid = Number(/MainPID=(\d+)/.exec(r.stdout)?.[1] ?? 0);
    data.running = active === "active";
    data.pid = pid || null;
  } else {
    const pid = readPid();
    data.running = Boolean(pid && pidAlive(pid));
    data.pid = data.running ? pid : null;
  }
  data.url = `http://127.0.0.1:${meta.port}`;
  data.reachable = (await probe(meta.port)) === 200;
  return data;
}

/** 注册并启动。已存在则先停再重写（升级走这里）。 */
export async function install({ port = DEFAULT_PORT, offline = false, waitMs = 30000, env = process.env } = {}) {
  const label = labelOf(env);
  const manager = detectManager(env);
  const prev = readMeta();
  if (prev) await stopInternal(prev);

  mkdirSync(paths().state, { recursive: true, mode: 0o700 });
  if (manager === "launchd") {
    const file = plistPath(label);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPlist({ label, port, offline, env }));
    await launchdBootout(label);
    await launchdBootstrap(label);
  } else if (manager === "systemd") {
    const file = unitPath(label);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderUnit({ port, offline, env }));
    run("systemctl", ["--user", "daemon-reload"]);
    const r = run("systemctl", ["--user", "enable", "--now", unitName(label)]);
    if (r.status !== 0) throw new Error(`systemctl enable 失败：${(r.stderr || r.stdout).trim()}`);
  } else {
    detachStart({ port, offline });
  }
  writeMeta({ manager, label, port, offline, installed_at: new Date().toISOString() });

  const up = await waitUp(port, waitMs);
  const result = { ...(await status()), up };
  if (manager === "detach") result.note = "没有 systemd，已退回后台进程：重启电脑后要再运行一次安装命令";
  return result;
}

async function stopInternal(meta) {
  if (meta.manager === "launchd") await launchdBootout(meta.label);
  else if (meta.manager === "systemd") run("systemctl", ["--user", "stop", unitName(meta.label)]);
  else await detachStop();
  if (meta.port) await waitDown(meta.port);
}

export async function stop() {
  const meta = requireInstalled();
  await stopInternal(meta);
  return status();
}

export async function start() {
  const meta = requireInstalled();
  if (meta.manager === "launchd") {
    if (!launchdLoaded(meta.label).loaded) {
      if (!existsSync(plistPath(meta.label))) throw new Error(`找不到 ${plistPath(meta.label)}：重新运行安装命令`);
      await launchdBootstrap(meta.label);
    }
  } else if (meta.manager === "systemd") {
    const r = run("systemctl", ["--user", "start", unitName(meta.label)]);
    if (r.status !== 0) throw new Error(`systemctl start 失败：${(r.stderr || r.stdout).trim()}`);
  } else detachStart(meta);
  await waitUp(meta.port, 30000);
  return status();
}

export async function restart() {
  const meta = requireInstalled();
  await stopInternal(meta);
  return start();
}

/** 从 rc 文件里摘掉带标记的那一段；只动我们自己写的块。 */
export function stripRcBlock(text) {
  const begin = text.indexOf(RC_BEGIN);
  const end = text.indexOf(RC_END);
  if (begin === -1 || end === -1 || end < begin) return text;
  const after = text.slice(end + RC_END.length).replace(/^\n/, "");
  return (text.slice(0, begin).replace(/\n+$/, "\n") + after).replace(/^\n+$/, "");
}

function cleanRc(home) {
  const files = [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => join(home, f));
  files.push(join(home, ".config", "fish", "conf.d", "versekit.fish"));
  const touched = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    if (basename(f) === "versekit.fish") {
      rmSync(f, { force: true });
      touched.push(f);
    } else if (text.includes(RC_BEGIN)) {
      writeFileSync(f, stripRcBlock(text));
      touched.push(f);
    }
  }
  return touched;
}

export function dataDirs() {
  const p = paths();
  return [p.config, p.state];
}

/**
 * 卸载。默认只拆服务和程序文件，数据（库、配置、凭证、浏览器登录）原样保留；
 * `purge` 才删数据，且先把要删的目录列出来。`serviceOnly` 给安装脚本回滚用。
 */
export async function uninstall({ purge = false, serviceOnly = false, log = () => {}, env = process.env } = {}) {
  const meta = readMeta();
  const label = meta?.label ?? labelOf(env);
  const manager = meta?.manager ?? detectManager(env);
  const removed = [];

  if (meta) await stopInternal(meta);
  if (manager === "launchd") {
    await launchdBootout(label);
    if (existsSync(plistPath(label))) {
      rmSync(plistPath(label), { force: true });
      removed.push(plistPath(label));
    }
  } else if (manager === "systemd") {
    run("systemctl", ["--user", "disable", "--now", unitName(label)]);
    if (existsSync(unitPath(label))) {
      rmSync(unitPath(label), { force: true });
      removed.push(unitPath(label));
      run("systemctl", ["--user", "daemon-reload"]);
    }
  } else await detachStop();
  rmSync(metaFile(), { force: true });

  const layout = installLayout(env);
  if (!serviceOnly) {
    cleanRc(homedir());
    if (layout.installed) {
      for (const dir of [layout.app, layout.node, layout.bin]) {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        }
      }
      rmSync(join(layout.prefix, "app.prev"), { recursive: true, force: true });
      try {
        if (readdirSync(layout.prefix).length === 0) rmdirSync(layout.prefix);
      } catch {
        /* 前缀里还有别的东西：留着 */
      }
    }
  }

  const purged = [];
  if (purge && !serviceOnly) {
    const dirs = dataDirs();
    log(`--purge：将删除以下数据目录（库、配置、凭证、浏览器登录）：\n${dirs.map((d) => `  ${d}`).join("\n")}`);
    for (const d of dirs) {
      if (existsSync(d)) {
        rmSync(d, { recursive: true, force: true });
        purged.push(d);
      }
    }
  }
  return { ok: true, manager, label, removed, purged, kept_data: !purge && !serviceOnly ? dataDirs() : [] };
}
