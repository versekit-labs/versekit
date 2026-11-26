// hifabu service：后台服务的安装 / 状态 / 启停 / 卸载（ACC-install-02 / 04）。
//
// 三种托管方式，按环境自动选（HIFABU_SERVICE_MANAGER 可强制）：
//   launchd  macOS LaunchAgent（RunAtLoad + KeepAlive）：关终端、重登、重启都还在，崩了被拉起
//   systemd  Linux `systemd --user`（Restart=always）
//   detach   没有 systemd 时退回：自己 spawn 一个脱离终端的进程；重启电脑后要再运行一次安装命令
//
// 所有路径、服务名、端口都能用环境变量覆盖，开发机上用测试服务名 + 临时 HOME 就不会碰真实环境。

import { readEnv } from "../../core/src/env.mjs";
import { spawnSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, readdirSync, rmdirSync, mkdtempSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request } from "node:http";
import { paths, emit } from "../../core/src/index.mjs";
import * as updates from "../../core/src/update.mjs";

export const DEFAULT_LABEL = "com.hifabu.daemon";
const LEGACY_LABEL = "com.versekit.daemon";
export const DEFAULT_PORT = 8787;
export const RC_BEGIN = "# >>> versekit >>>";
export const RC_END = "# <<< versekit <<<";

const CLI = fileURLToPath(new URL("./vk.mjs", import.meta.url));
const APP_ROOT = dirname(dirname(dirname(dirname(CLI))));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

export const labelOf = (env = process.env) => readEnv("HIFABU_SERVICE_LABEL", env) || DEFAULT_LABEL;

export function describeInstall() {
  return `后台服务 ${labelOf()}：运行本地控制台、处理已确认的排期并采集发布数据。日志：${paths().log}`;
}

export function recordReleaseTransition() {
  const message = "已改为从 hifabu.com 获取正式版本";
  appendFileSync(paths().log, `[${new Date().toISOString()}] [release.transition] ${message}\n`, { mode: 0o600 });
  return message;
}

/**
 * 安装前缀：`<prefix>/app` 是程序，`<prefix>/node` 私有 Node，`<prefix>/bin` 放 hifabu、vk 别名与 biliup。
 * 在源码仓库里直接跑 hifabu（目录名不是 app）时没有「安装」可言，`installed` 为 false，
 * 卸载就绝不会去删仓库。
 */
export function installLayout(env = process.env) {
  const prefix = readEnv("HIFABU_PREFIX", env);
  const fromApp = basename(APP_ROOT) === "app" ? dirname(APP_ROOT) : null;
  const root = prefix || fromApp || join(homedir(), ".versekit");
  return {
    prefix: root,
    app: join(root, "app"),
    node: join(root, "node"),
    bin: join(root, "bin"),
    installed: basename(APP_ROOT) === "app" && join(root, "app") === APP_ROOT,
  };
}

export function detectManager(env = process.env) {
  const forced = readEnv("HIFABU_SERVICE_MANAGER", env);
  if (forced) {
    if (!["launchd", "systemd", "detach"].includes(forced)) throw new Error(`不认识的 HIFABU_SERVICE_MANAGER=${forced}（可选 launchd / systemd / detach）`);
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
  const dir = mkdtempSync(join(paths().state, ".service-"));
  try {
    const staged = join(dir, "service.json");
    writeFileSync(staged, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
    renameSync(staged, metaFile());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const plistPath = (label) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const unitName = (label) => `${label}.service`;
const unitPath = (label) => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", unitName(label));
const guiTarget = (label) => `gui/${process.getuid()}/${label}`;
const definitionPath = ({ manager, label }) => manager === "launchd" ? plistPath(label) : manager === "systemd" ? unitPath(label) : null;

function systemctl(...args) {
  const r = run("systemctl", ["--user", ...args]);
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`systemctl ${args.join(" ")} 失败：${(r.stderr || r.stdout).trim() || `退出码 ${r.status}`}`);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 服务进程的环境：PATH 含 <prefix>/bin 与私有 Node，所以 hifabu doctor 能找到 biliup。 */
export function serviceEnvVars(env = process.env) {
  const layout = installLayout(env);
  const nodeDir = dirname(process.execPath);
  const pathParts = [layout.bin, nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const vars = { PATH: [...new Set(pathParts)].join(":"), HOME: homedir() };
  for (const name of ["HIFABU_HOME", "HIFABU_PREFIX"]) {
    const value = readEnv(name, env);
    if (value) vars[name] = value;
  }
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
Description=Hifabu 控制台与后台守护进程

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
  if (r.error) throw r.error;
  if (r.status !== 0) return { loaded: false, running: false, pid: null };
  const pid = /\bpid = (\d+)/.exec(r.stdout)?.[1];
  return { loaded: true, running: /state = running/.test(r.stdout), pid: pid ? Number(pid) : null };
}

/** bootout 是异步的：命令返回时服务可能还在卸载中，必须等到 launchctl print 查不到才算拆干净。 */
async function launchdBootout(label, timeoutMs = 15000) {
  if (!launchdLoaded(label).loaded) return;
  const r = run("launchctl", ["bootout", guiTarget(label)]);
  if (r.error) throw r.error;
  if (r.status !== 0 && launchdLoaded(label).loaded) {
    throw new Error(`launchctl bootout ${label} 失败：${(r.stderr || r.stdout).trim() || `退出码 ${r.status}`}`);
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!launchdLoaded(label).loaded) return;
    await sleep(150);
  }
  throw new Error(`launchctl bootout ${label} 超时`);
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
  if (!meta) throw new Error("后台服务还没有安装：先运行安装命令，或 hifabu service install");
  return meta;
}

async function inspectService(meta) {
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

export const status = () => inspectService(readMeta());

async function registerService(meta, env) {
  const { label, manager } = meta;
  const file = definitionPath(meta);
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    const opts = { ...meta, env };
    writeFileSync(file, manager === "launchd" ? renderPlist(opts) : renderUnit(opts));
  }
  if (manager === "launchd") {
    await launchdBootout(label);
    await launchdBootstrap(label);
  } else if (manager === "systemd") {
    systemctl("daemon-reload");
    systemctl("enable", "--now", unitName(label));
  } else detachStart(meta);
}

async function removeRegistration(meta) {
  if (meta.manager === "launchd") await launchdBootout(meta.label);
  else if (meta.manager === "systemd") systemctl("disable", "--now", unitName(meta.label));
  else await detachStop();

  const file = definitionPath(meta);
  if (file) rmSync(file, { force: true });
  if (meta.manager === "systemd") systemctl("daemon-reload");
}

async function migrateLabel(prev, next, env) {
  const oldFile = definitionPath(prev);
  const newFile = definitionPath(next);
  if (newFile && existsSync(newFile)) throw new Error(`新服务定义已存在：${newFile}；请先核对该服务归属`);
  const oldDefinition = oldFile ? readFileSync(oldFile) : null;
  const oldEnabled = prev.manager === "systemd" && run("systemctl", ["--user", "is-enabled", unitName(prev.label)]).status === 0;
  const wasRunning = (await inspectService(prev)).running;
  let registering = false;
  let removingOld = false;
  try {
    // 同一数据目录只有一个守护进程。保留旧定义，直到新进程过了两个自检接口。
    await stopInternal(prev);
    registering = true;
    await registerService(next, env);
    if (!(await waitHealthy(next.port, healthTimeoutMs(env)))) {
      throw new Error(`新服务 ${next.label} 没通过自检（${HEALTH_PATH} 或 /today）`);
    }
    const result = await inspectService(next);
    if (!result.running || !result.reachable) throw new Error(`新服务 ${next.label} 已停止或不可达`);
    removingOld = true;
    // detach 没有系统服务定义，PID 文件这时属于新进程。
    if (oldFile) await removeRegistration(prev);
    writeMeta(next);
    return { ...result, up: true };
  } catch (err) {
    const failures = [];
    if (registering) await removeRegistration(next).catch((e) => failures.push(e.message));
    if (removingOld && oldFile) {
      try {
        if (!existsSync(oldFile)) writeFileSync(oldFile, oldDefinition);
        if (prev.manager === "systemd") {
          systemctl("daemon-reload");
          if (oldEnabled) systemctl("enable", unitName(prev.label));
        }
      } catch (e) {
        failures.push(e.message);
      }
    }
    if (wasRunning) {
      try {
        const restored = await start();
        if (!restored.running || !restored.reachable) failures.push(`旧服务 ${prev.label} 未能恢复`);
      } catch (e) {
        failures.push(e.message);
      }
    }
    const recovery = failures.length ? `；恢复服务时：${failures.join("；")}` : "";
    throw Object.assign(new Error(err.message + recovery, { cause: err }), { code: "service_migration_failed" });
  }
}

/** 注册并启动。已存在则先停再重写（升级走这里）。 */
export async function install({ port = DEFAULT_PORT, offline = false, waitMs = 30000, env = process.env } = {}) {
  const label = labelOf(env);
  const manager = detectManager(env);
  const prev = readMeta();
  const next = { manager, label, port, offline, installed_at: new Date().toISOString() };
  let result;
  if (prev?.label === LEGACY_LABEL && label === DEFAULT_LABEL) {
    result = await migrateLabel(prev, next, env);
  } else {
    if (prev) await stopInternal(prev);
    mkdirSync(paths().state, { recursive: true, mode: 0o700 });
    await registerService(next, env);
    writeMeta(next);
    const up = await waitUp(port, waitMs);
    result = { ...(await status()), up };
  }
  if (manager === "detach") result.note = "没有 systemd，已退回后台进程：重启电脑后要再运行一次安装命令";
  return result;
}

async function stopInternal(meta) {
  if (meta.manager === "launchd") await launchdBootout(meta.label);
  else if (meta.manager === "systemd") systemctl("stop", unitName(meta.label));
  else await detachStop();
  if (meta.port && !(await waitDown(meta.port))) throw new Error(`后台服务停机后端口 ${meta.port} 仍在响应`);
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

// ---------------------------------------------------------------- 后台自动更新（#217）
//
// 流程：查最新提交 → 下载新包 → 用新包里的 install.sh 非交互升级（Node、biliup 的版本变化也跟着升，
// 不另写一套下载/替换逻辑）→ 60 秒内服务重新起来且 /api 通过自检 → 否则退回 app.prev 并留事件。
// install.sh 自己在「起不来」时会回滚；这里补的是「起来了但不健康」那一类，所以 HIFABU_UPDATE=1 让它
// 把 app.prev 留给我们。

export const HEALTH_PATH = "/api/now";
export const HEALTH_TIMEOUT_MS = 60e3;
/** 开发机上验证「新包起来了但不健康」时可以缩短；默认 60 秒（ACC-update-04）。 */
const healthTimeoutMs = (env) => Number(readEnv("HIFABU_UPDATE_HEALTH_TIMEOUT_MS", env)) || HEALTH_TIMEOUT_MS;

const lockFile = () => join(paths().state, "update.lock");

function takeLock() {
  mkdirSync(paths().state, { recursive: true, mode: 0o700 });
  try {
    const pid = Number(readFileSync(lockFile(), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) throw new Error("已经有一次更新在进行，等它结束");
  } catch (err) {
    if (err.message.startsWith("已经有")) throw err;
  }
  writeFileSync(lockFile(), String(process.pid), { mode: 0o600 });
}

async function download(url, file) {
  const res = await fetch(url, { headers: { "User-Agent": "versekit-updater" }, signal: AbortSignal.timeout(120e3) });
  if (!res.ok) throw new Error(`下载新版本失败：${url} 返回 ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function runInstall(script, env, log) {
  return new Promise((resolve) => {
    const child = spawn("bash", [script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => {
      for (const l of `${stdout}${stderr}`.split("\n").filter(Boolean)) log(`  [install.sh] ${l}`);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitHealthy(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await probe(port, HEALTH_PATH)) === 200 && (await probe(port, "/today")) === 200) return true;
    await sleep(500);
  }
  return false;
}

/** 新版本起来了却不健康：把旧程序放回去，重新注册并启动服务。 */
async function restorePrev(layout, previous, env) {
  const prev = join(layout.prefix, "app.prev");
  if (!existsSync(prev)) throw new Error("app.prev 不见了，没法自动退回（重新运行安装命令即可）");
  const meta = readMeta();
  if (meta) {
    await stopInternal(meta);
    await removeRegistration(meta);
  }
  rmSync(metaFile(), { force: true });
  rmSync(layout.app, { recursive: true, force: true });
  renameSync(prev, layout.app);
  // Let the restored version write the service template it knows how to read.
  const home = paths().root;
  const { label, port, offline, manager } = previous;
  const args = [CLI, "service", "install", "--port", String(port), ...(offline ? ["--offline"] : [])];
  const result = run(process.execPath, args, {
    env: {
      ...env,
      HIFABU_HOME: home,
      HIFABU_PREFIX: layout.prefix,
      HIFABU_SERVICE_LABEL: label,
      HIFABU_SERVICE_MANAGER: manager,
      HIFABU_OFFLINE: offline ? "1" : "",
      VK_HOME: home,
      VERSEKIT_PREFIX: layout.prefix,
      VERSEKIT_SERVICE_LABEL: label,
      VERSEKIT_SERVICE_MANAGER: manager,
      VERSEKIT_OFFLINE: offline ? "1" : "",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "旧版后台服务未能恢复");
  return JSON.parse(result.stdout);
}

/**
 * 更新一次。`now` 为 true 时调用方已经决定不看空闲（CLI --now / 守护进程已判过）。
 * 返回 { updated, message, ... }；失败时已经退回旧版本，返回 { ok:false, rolledBack:true, message }，不抛。
 */
export async function applyUpdate({ log = () => {}, env = process.env } = {}) {
  const layout = installLayout(env);
  if (!layout.installed) throw new Error("这份程序不是用安装命令装出来的（在源码目录里直接跑），没法自动更新：用 git pull");
  const meta = readMeta();
  const current = updates.buildInfo();
  const check = await updates.checkLatest({ current, env });
  if (check.upToDate) return { ok: true, updated: false, message: "已是最新", version: current.version, display: updates.displayVersion(current), commit: current.commit };

  takeLock();
  const previous = meta ?? { label: labelOf(env), manager: detectManager(env), port: DEFAULT_PORT, offline: false };
  const { port, offline } = previous;
  const work = mkdtempSync(join(layout.prefix, ".update-"));
  updates.patchState({ in_progress: { since: Date.now(), to: check.latest } });
  const oldLabel = updates.displayVersion(current);
  const failed = (reason, extra = {}) => {
    const rolledBack = extra.restored !== false;
    const message = `自动更新失败，${rolledBack ? `已回到 ${oldLabel}` : `未能恢复 ${oldLabel} 的后台服务`}：${reason}`;
    emit({ type: "update.failed", severity: "warn", payload: { error_code: "update_failed", from: current.commit, to: check.latest, from_version: current.version, reason, message } });
    updates.patchState({ last_failure: { at: Date.now(), from: current.commit, to: check.latest, from_version: current.version, reason, message } });
    log(message);
    return { ok: false, updated: false, rolledBack, message, reason, ...extra };
  };
  try {
    log(`有新版本：${check.message}，开始更新（${current.short ?? "未知"} → ${updates.shortCommit(check.latest)}）`);
    const tarball = join(work, "app.tar.gz");
    const src = join(work, "src");
    const url = readEnv("HIFABU_APP_URL", env) || `https://codeload.github.com/versekit-labs/versekit/tar.gz/${check.latest}`;
    try {
      await download(url, tarball);
      mkdirSync(src);
      const t = run("tar", ["-xzf", tarball, "-C", src, "--strip-components=1"]);
      if (t.status !== 0) throw new Error(`新程序包解压失败：${(t.stderr || "").trim()}`);
      if (!existsSync(join(src, "install.sh"))) throw new Error("新程序包里没有 install.sh");
    } catch (err) {
      return failed(err.message);
    }

    const installEnv = {
      ...env,
      HIFABU_UPDATE: "1",
      HIFABU_NO_OPEN: "1",
      HIFABU_PREFIX: layout.prefix,
      HIFABU_APP_URL: pathToFileURL(tarball).href,
      HIFABU_APP_COMMIT: check.latest,
      HIFABU_APP_SHA256: "",
      HIFABU_PORT: String(port),
      HIFABU_OFFLINE: offline ? "1" : "",
      HIFABU_SERVICE_LABEL: previous.label === LEGACY_LABEL ? DEFAULT_LABEL : previous.label,
      ...(meta?.manager ? { HIFABU_SERVICE_MANAGER: meta.manager } : {}),
    };
    const r = await runInstall(join(src, "install.sh"), installEnv, log);
    if (r.code !== 0) {
      // install.sh 在失败时自己回滚（旧程序放回、旧服务重新注册）。
      const why = /原因：(.*)/.exec(r.stderr)?.[1]?.trim() || r.stderr.trim().split("\n").pop() || `install.sh 退出码 ${r.code}`;
      return failed(why, r.stderr.includes("未能恢复升级前的后台服务") ? { restored: false } : {});
    }

    if (!(await waitHealthy(port, healthTimeoutMs(env)))) {
      const back = await restorePrev(layout, previous, env).catch((err) => ({ up: false, error: err.message }));
      return failed(`新版本起来后 ${Math.round(healthTimeoutMs(env) / 1000)} 秒内没通过自检（${HEALTH_PATH}）${back.up ? "" : `；退回时服务也没起来：${back.error ?? "请运行 hifabu service status 看看"}`}`, { restored: Boolean(back.up) });
    }

    rmSync(join(layout.prefix, "app.prev"), { recursive: true, force: true });
    const now = updates.buildInfo({ root: `${layout.app}/` });
    updates.patchState({
      last_update: { at: Date.now(), from: current.commit, from_version: updates.displayVersion(current), to: now.commit ?? check.latest, version: now.version, display: updates.displayVersion(now), commits: check.commits },
      last_failure: null,
    });
    const message = `已更新到 ${updates.displayVersion(now)}（数据、账号、登录都保留）`;
    log(message);
    return { ok: true, updated: true, message, version: now.version, display: updates.displayVersion(now), commit: now.commit, commits: check.commits };
  } finally {
    updates.patchState({ in_progress: null });
    rmSync(work, { recursive: true, force: true });
    rmSync(lockFile(), { force: true });
  }
}

/**
 * 守护进程里要更新时用：另起一个脱离守护进程的 `hifabu update`，因为更新会停掉守护进程本身。
 * systemd 会把整个 cgroup 一起杀掉，所以那种情况用 systemd-run 让它出来单独成一个 unit。
 */
export function startDetachedUpdate({ env = process.env } = {}) {
  const layout = installLayout(env);
  if (!layout.installed) throw new Error("这份程序不是用安装命令装出来的，没法自动更新");
  mkdirSync(paths().state, { recursive: true, mode: 0o700 });
  const fd = openSync(paths().log, "a", 0o600);
  const args = [process.execPath, CLI, "update", "--now"];
  const childEnv = { ...process.env, ...serviceEnvVars(env) };
  let child;
  const viaSystemd = readMeta()?.manager === "systemd" && run("systemd-run", ["--version"]).status === 0;
  if (viaSystemd) {
    child = spawn("systemd-run", ["--user", "--collect", `--unit=versekit-update-${Date.now()}`, ...args], { detached: true, stdio: ["ignore", fd, fd], env: childEnv });
  } else {
    child = spawn(args[0], args.slice(1), { detached: true, stdio: ["ignore", fd, fd], env: childEnv });
  }
  child.unref();
  closeSync(fd);
  return { started: true, pid: child.pid, message: "已开始更新：服务会短暂重启，几十秒后回来；结果看系统页「设备」里这台电脑的版本" };
}
