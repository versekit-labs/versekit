import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { COMMANDS, parseArgs } from "../../core/src/commands.mjs";
import { createDeliveryHandlers } from "../../core/src/maker-handlers.mjs";
import { getGroupSnapshot } from "../../relay/src/client.mjs";
import { projectGroupSnapshot } from "../../relay/src/group-snapshot.mjs";
import { formatBytes, formatDuration } from "../../relay/src/status.mjs";
import { parseArgv } from "./argv.mjs";
import { createCloudHandlers } from "./cloud.mjs";
import { createRelayUploadQueue } from "./relay-upload.mjs";

const makerCommands = COMMANDS.filter(({ roles }) => roles?.includes("maker"));
const options = new Map([["--name", "name"], ["--role", "role"], ["--group", "group"], ["--dry-run", "dryRun"]]);
const globalOptions = new Set(["--data", "--json", "--human", "--offline", "--help"]);
const queueFilename = /^dl_[0-9a-f]{12,32}\.json$/;

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
      save(id, { failure });
      const history = this.failures().sort((a, b) => b.updatedAt - a.updatedAt);
      for (const [i, row] of history.entries()) {
        const name = row.id + ".json";
        if (queueFilename.test(name) && (i >= 20 || row.updatedAt < since)) rmSync(join(directory, name), { force: true });
      }
    },
  };
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
  if (!pos.length || flags["--help"]) usage();
  else {
    if (Object.hasOwn(flags, "--data") && !flags["--data"]) throw new Error("--data 需要目录路径。");
    const dataDir = resolve(flags["--data"] ?? join(homedir(), ".local", "state", "hifabu", "maker"));
    const [area, action = (area === "group" || area === "delivery") ? "list" : "", target] = pos;
    const command = makerCommands.find(({ name }) => name === area + "." + action);
    if (!command || pos.length > 3) throw new Error("未知制作机命令，运行 hifabu --help 查看。");

    const args = commandArgs(command, target, flags);
    const log = (message) => console.error(message);
    const cloud = createCloudHandlers({
      offline: Boolean(flags["--offline"]), openBrowser, log, credentialsDir: dataDir,
      credentialName: "device.json", persistMachineToken: false, defaultRole: "maker",
    });
    const makerConnection = () => {
      const cfg = cloud.relayConnection();
      if (!cfg) throw Object.assign(new Error("这台电脑还没登录 Hifabu。"), { code: "cloud_login_required", hint: "hifabu cloud login" });
      if (cfg.role !== "maker" || !cfg.url) {
        throw Object.assign(new Error("这台机器没有制作机的传片连接。请核对 Hifabu 机器角色和中转地址。"), { code: "maker_relay_unavailable" });
      }
      return cfg;
    };
    const state = fileUploadState(join(dataDir, "queue"));
    const uploadQueue = createRelayUploadQueue({ state, foreground: true, log });
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
    if (human) printHuman(command.name, data);
    else out({ ...data, ok: true });
  }
} catch (error) {
  const { code = "error", message, hint } = error;
  if (human) console.error(`出错：${message}${hint ? "\n下一步：" + hint : ""}`);
  else out({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } });
  process.exitCode = 1;
}
