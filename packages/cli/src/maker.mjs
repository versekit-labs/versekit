import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, futimesSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { COMMANDS, parseArgs } from "../../core/src/commands.mjs";
import { isLoopback } from "../../cloud/src/transport.mjs";
import { createDeliveryHandlers, deliveryTargetPlatforms } from "../../core/src/maker-handlers.mjs";
import { getGroupSnapshot, pushDelivery, relayConnectionKey } from "../../relay/src/client.mjs";
import { isVersionedDelivery } from "../../relay/src/delivery-v1.mjs";
import { projectGroupSnapshot } from "../../relay/src/group-snapshot.mjs";
import { formatBytes, formatDuration, RETENTION_MS } from "../../relay/src/status.mjs";
import { parseArgv } from "./argv.mjs";
import { createCloudHandlers } from "./cloud.mjs";

const makerCommands = COMMANDS.filter(({ roles }) => roles?.includes("maker"));
const options = new Map([["--name", "name"], ["--role", "role"], ["--group", "group"], ["--dry-run", "dryRun"]]);
const globalOptions = new Set(["--data", "--json", "--human", "--offline", "--help"]);
const queueFilename = /^dl_[0-9a-f]{12,32}\.json$/;
const heartbeatMs = 2000;
const leaseMs = 60_000;

function statIfPresent(path) {
  return statSync(path, { throwIfNoEntry: false });
}

function sameFile(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true;
    throw err;
  }
}

function readLock(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const pid = Number(readFileSync(fd, "utf8").trim());
    return { stat, pid, live: Date.now() - stat.mtimeMs < (pid ? leaseMs : 500) && (!pid || pidAlive(pid)) };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeLock(path, expected, { stale = false } = {}) {
  // Serialize removals so a second reaper cannot unlink a replacement lock.
  // Publish a nonempty guard directory atomically. Only its unique marker can
  // be removed on recovery, and rmdir cannot remove a replacement guard.
  const guard = path + ".remove";
  const marker = process.pid + "-" + randomUUID();
  const candidate = guard + "." + marker;
  mkdirSync(candidate, { mode: 0o700 });
  function clearGuard(owner) {
    rmSync(join(guard, owner), { force: true });
    try {
      rmdirSync(guard);
    } catch (err) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) throw err;
    }
  }
  try {
    writeFileSync(join(candidate, marker), "", { mode: 0o600, flag: "wx" });
    try {
      renameSync(candidate, guard);
    } catch (err) {
      if (!["ENOTEMPTY", "EEXIST"].includes(err.code)) throw err;
      try {
        for (const owner of readdirSync(guard)) {
          if (!pidAlive(Number(owner.split("-")[0]))) clearGuard(owner);
        }
      } catch (scanError) {
        if (scanError.code !== "ENOENT") throw scanError;
      }
      return false;
    }
    try {
      const current = readLock(path);
      if (sameFile(expected, current.stat) && (!stale || !current.live)) rmSync(path);
      return true;
    } finally {
      clearGuard(marker);
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

async function acquireLock(path) {
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid) + "\n");
        const identity = fstatSync(fd);
        const owns = () => sameFile(identity, statIfPresent(path));
        return {
          owns,
          beat() {
            const now = new Date();
            futimesSync(fd, now, now);
          },
          async release() {
            try {
              while (owns() && !removeLock(path, identity)) await wait(25);
            } finally {
              closeSync(fd);
            }
          },
        };
      } catch (err) {
        closeSync(fd);
        throw err;
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const observed = readLock(path);
      if (observed.live && observed.pid) return null;
      if (observed.live || (observed.stat && !removeLock(path, observed.stat, { stale: true }))) await wait(25);
    }
  }
}

function readJson(filename) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function fileUploadState(directory) {
  function records() {
    let files;
    try {
      files = readdirSync(directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return files.filter((name) => queueFilename.test(name)).map((name) => readJson(join(directory, name))).filter(Boolean);
  }

  function save(id, record) {
    const name = `${id}.json`;
    if (!queueFilename.test(name)) throw new Error("投递号不合法。");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, name);
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  return {
    jobs: () => records().flatMap(({ job }) => job ? [job] : []).sort((a, b) => a.createdAt - b.createdAt),
    failures: () => records().flatMap(({ failure }) => failure ? [failure] : []),
    putJob(job) {
      save(job.id, { job });
    },
    finishJob(id, failure, since) {
      if (!failure) return rmSync(join(directory, id + ".json"), { force: true });
      save(id, { failure, event: { type: "delivery.upload_failed", at: failure.updatedAt, error_code: failure.errorCode } });
      const history = this.failures().sort((a, b) => b.updatedAt - a.updatedAt);
      for (const [i, row] of history.entries()) {
        const name = row.id + ".json";
        if (queueFilename.test(name) && (i >= 20 || row.updatedAt < since)) rmSync(join(directory, name), { force: true });
      }
    },
  };
}

function makerUploadQueue(state, lockPath) {
  const matching = (cfg) => state.jobs().filter((row) => row.url === cfg.url && row.connectionKey === relayConnectionKey(cfg));
  return {
    background: true,
    matching,
    register(job) {
      const existing = state.jobs().find((row) => row.url === job.url && row.connectionKey === job.connectionKey &&
        row.group === job.group && JSON.stringify(row.manifest) === JSON.stringify(job.manifest) &&
        JSON.stringify(row.files) === JSON.stringify(job.files));
      if (existing) return existing;
      const stored = { ...job, attempts: 0, retryAt: 0 };
      state.putJob(stored);
      return stored;
    },
    list(cfg) {
      const { live, pid } = readLock(lockPath);
      return matching(cfg).map((row) => ({ ...row, queued: !live || row.uploaderPid !== pid || !!row.errorCode }));
    },
  };
}

async function uploadJob(job, cfg, { state, signal, checkOwnership, progress }) {
  try {
    if (isVersionedDelivery(job.manifest)) await deliveryTargetPlatforms(cfg, job.group);
    await pushDelivery({
      ...cfg, id: job.id, group: job.group, manifest: job.manifest, files: job.files, retries: 0, signal,
      onProgress: ({ deliverySent }) => { progress.sent = deliverySent; },
    });
    checkOwnership();
    state.finishJob(job.id);
  } catch (err) {
    checkOwnership();
    const updatedAt = Date.now();
    const errorCode = err.code ?? "upload_failed";
    if (err.retryable) {
      const attempts = job.attempts + 1;
      const retryAt = updatedAt + Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5));
      state.putJob({ ...job, attempts, retryAt, updatedAt, sent: progress.sent, errorCode, reason: err.message });
      return;
    }
    const { id, url, connectionKey, title, group, totalBytes, createdAt, uploadBytesPerSecond } = job;
    const nextStep = errorCode === "disk_low" || errorCode === "quota_exceeded" ? "清出中转空间后，再从制作机重新交付。"
      : errorCode === "relay_disabled" ? "到我的 Hifabu 申请开通传片，再从制作机重新交付。"
      : errorCode === "source_unavailable" || errorCode === "hash_mismatch" ? "检查制作机上的素材，选好文件后重新交付。"
      : errorCode === "group_not_found" ? "选一个存在的账号组，再从制作机重新交付。"
      : "检查中转连接后，从制作机重新交付。";
    state.finishJob(id, { id, url, connectionKey, title, group, totalBytes, createdAt, updatedAt, uploadBytesPerSecond,
      sent: progress.sent, errorCode, reason: err.message, nextStep }, updatedAt - RETENTION_MS);
  }
}

async function runUploader({ state, queue, lockPath, connection }) {
  const cfg = connection();
  if (!cfg || !queue.matching(cfg).length) return;
  const lock = await acquireLock(lockPath);
  if (!lock) return;
  const controller = new AbortController();
  const checkOwnership = () => {
    const current = connection();
    if (!lock.owns() || !current || current.url !== cfg.url || current.accountId !== cfg.accountId) controller.abort();
    controller.signal.throwIfAborted();
  };
  const secured = { ...cfg, async token() {
    checkOwnership();
    const token = await cfg.token();
    checkOwnership();
    return token;
  } };
  let progress;
  let sample;
  const timer = setInterval(() => {
    try {
      checkOwnership();
      lock.beat();
      if (progress) {
        const now = Date.now();
        const bytes = progress.sent - sample.sent;
        if (bytes > 0) progress.uploadBytesPerSecond = bytes * 1000 / (now - sample.at);
        state.putJob({ ...progress, updatedAt: now });
        sample = { sent: progress.sent, at: now };
      }
    } catch (err) {
      controller.abort(err);
    }
  }, heartbeatMs).unref();
  const awake = process.platform === "darwin"
    ? spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).on("error", () => {}).unref()
    : null;
  try {
    for (;;) {
      checkOwnership();
      const jobs = queue.matching(cfg);
      if (!jobs.length) return true;
      const now = Date.now();
      const job = jobs.find((row) => row.retryAt <= now);
      if (!job) {
        await wait(Math.min(heartbeatMs, ...jobs.map((row) => row.retryAt - now)), undefined, { signal: controller.signal });
        continue;
      }
      progress = { ...job, uploaderPid: process.pid, errorCode: null, updatedAt: now };
      sample = { sent: job.sent, at: now };
      state.putJob(progress);
      await uploadJob(job, secured, { state, signal: controller.signal, checkOwnership, progress });
      progress = null;
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err;
    return true;
  } finally {
    clearInterval(timer);
    awake?.kill();
    await lock.release();
  }
}

// The skill owns preference changes. An explicit group can be a one-off override.
function projectGroup(dataDir, manifest) {
  let directory = dirname(manifest);
  for (;;) {
    const project = readJson(join(directory, ".hifabu", "project.json"));
    if (project) {
      if (typeof project.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(project.id)) return null;
      const group = readJson(join(dataDir, "projects", `${project.id}.json`))?.group;
      return typeof group === "string" ? group : null;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

function usage() {
  console.log([
    "Hifabu 制作机",
    "全局选项  --data <目录>  --json  --human  --offline  --help",
    ...makerCommands.map(({ cli }) => cli.usage),
  ].join("\n"));
}

function commandArgs(command, target, flags) {
  const args = {};
  if (command.name === "work.push" && target) args.manifest = resolve(target);
  if (command.name === "delivery.show" && target) args.id = target;
  if (target && !Object.keys(args).length) throw new Error(command.cli.usage);
  for (const [flag, value] of Object.entries(flags)) {
    if (globalOptions.has(flag)) continue;
    const field = options.get(flag);
    if (!field || !Object.hasOwn(command.args, field) || value === undefined) throw new Error(command.cli.usage);
    args[field] = value;
  }
  return parseArgs(command, args);
}

function printHuman(name, data) {
  if (name.startsWith("cloud.")) {
    if (data.loggedIn) console.log(`${data.email} · ${data.role === "maker" ? "制作机" : "发布机"} · 传片${data.relayEnabled ? "已开通" : "未开通"}`);
    else console.log(data.message ?? "这台机器未登录 Hifabu。");
  } else if (name === "group.list") {
    if (data.reportedAt == null) console.log("发布机还没同步账号组。");
    else if (!data.groups.length) console.log("发布机上还没有账号组。");
    for (const group of data.groups) {
      console.log(`${group.default ? "* " : ""}${group.name} · ${group.accounts.map(({ platform, name }) => `${platform} ${name}`).join("、")}`);
    }
  } else if (name === "work.push" && data.dryRun) {
    console.log(`预览「${data.title}」→ 账号组「${data.group}」，传输约 ${formatDuration(data.etaSeconds)}`);
    for (const file of data.files) console.log(`  ${file.name} · ${formatBytes(file.size)}`);
    for (const row of data.rejected) console.log(`  ${row.cut}：${row.reason}`);
    for (const warning of data.warnings) console.log(warning.message);
  } else if (name === "work.push") {
    console.log(data.message);
    console.log(`${data.files} 个文件，${formatBytes(data.bytes)} → 账号组「${data.group}」`);
  } else {
    if (data.warning) console.log(data.warning);
    const rows = data.deliveries ?? [data];
    if (!rows.length) console.log("还没有投递");
    for (const { id, title, label, message, nextStep } of rows) {
      console.log(`${id}${title ? " · " + title : ""} · ${label}：${message}`);
      if (nextStep) console.log(`下一步：${nextStep}`);
    }
  }
}

const { flags, pos } = parseArgv(process.argv.slice(2));
const human = flags["--human"] && !flags["--json"];
const out = (data) => console.log(JSON.stringify(data, null, 2));

try {
  if (Object.hasOwn(flags, "--data") && !flags["--data"]) throw new Error("--data 需要目录路径。");
  const dataDir = resolve(flags["--data"] ?? join(homedir(), ".local", "state", "hifabu", "maker"));
  const offline = Boolean(flags["--offline"]);
  const lockPath = join(dataDir, "uploader.lock");
  const log = (message) => console.error(message);
  const makeCloud = () => createCloudHandlers({
    offline, openBrowser, log, credentialsDir: dataDir,
    credentialName: "device.json", persistMachineToken: false, defaultRole: "maker",
  });
  const cloud = makeCloud();
  const makerConnection = () => {
    const cfg = cloud.relayConnection();
    if (!cfg) throw Object.assign(new Error("这台电脑还没登录 Hifabu。"), { code: "cloud_login_required", hint: "hifabu cloud login" });
    if (cfg.role !== "maker" || !cfg.url) {
      throw Object.assign(new Error("这台机器没有制作机的传片连接。请核对 Hifabu 机器角色和中转地址。"), { code: "maker_relay_unavailable" });
    }
    if (offline && !isLoopback(new URL(cfg.url))) {
      throw Object.assign(new Error("离线模式只能连接本机中转。"), { code: "offline_mode" });
    }
    return cfg;
  };
  const connection = (api = cloud) => {
    const cfg = api.relayConnection();
    if (cfg?.role === "maker" && cfg.url && (!offline || isLoopback(new URL(cfg.url)))) return cfg;
  };
  const state = fileUploadState(join(dataDir, "queue"));
  const uploadQueue = makerUploadQueue(state, lockPath);
  async function kickUploader() {
    if (!state.jobs().length) return;
    const { live, pid } = readLock(lockPath);
    if (live && pid) return;
    const cfg = connection();
    if (!cfg || !uploadQueue.matching(cfg).length) return;
    const child = spawn(process.execPath, [process.argv[1], "_uploader", "--data", dataDir, ...(offline ? ["--offline"] : [])],
      { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    child.unref();
  }

  if (pos.length === 1 && pos[0] === "_uploader") {
    const options = { state, queue: uploadQueue, lockPath, connection: () => connection(makeCloud()) };
    // Recheck after releasing the lock in case a foreground command saw the
    // live worker while it was finishing and queued another job.
    while (await runUploader(options)) {}
  } else {
    await kickUploader();
    if (!pos.length || flags["--help"]) usage();
    else {
      const [area, action = (area === "group" || area === "delivery") ? "list" : "", target] = pos;
      const command = makerCommands.find(({ name }) => name === area + "." + action);
      if (!command || pos.length > 3) throw new Error("未知制作机命令，运行 hifabu --help 查看。");

      const args = commandArgs(command, target, flags);
      const handlers = {
        ...cloud,
        ...createDeliveryHandlers({ makerConnection, state, uploadQueue, defaultGroupOf: (manifest) => projectGroup(dataDir, manifest), log }),
        async "group.list"() {
          const snapshot = await getGroupSnapshot(makerConnection());
          return snapshot ? projectGroupSnapshot(snapshot) : { groups: [], reportedAt: null };
        },
      };
      let data = await handlers[command.name](args);
      if (command.name === "cloud.login" && data.state === "waiting") {
        console.error(`请在浏览器核对 ${data.code} 后点「允许」。接入地址：${data.url}`);
        const deadline = data.expiresAt + 2000;
        do {
          await wait(700);
          data = await handlers["cloud.status"]();
        } while (data.state === "waiting" && Date.now() < deadline);
        if (data.state !== "linked") {
          const code = data.error_code ?? (data.state === "waiting" ? "device_link_expired" : "device_link_cancelled");
          throw Object.assign(new Error(data.message ?? "这次接入没有完成，请重新登录 Hifabu。"), { code });
        }
      }
      if ((command.name === "work.push" && !data.dryRun) || command.name === "cloud.login") await kickUploader();
      if (human) printHuman(command.name, data);
      else out({ ...data, ok: true });
    }
  }
} catch (error) {
  const { code = "error", message, hint } = error;
  if (human) console.error(`出错：${message}${hint ? "\n下一步：" + hint : ""}`);
  else out({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } });
  process.exitCode = 1;
}
