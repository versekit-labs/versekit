import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { relayAccountId } from "../../packages/cloud/src/relay-control.mjs";

const oldUnit = "versekit-relay.service";
const newUnit = "hifabu-relay.service";
const oldHome = "/var/lib/versekit-relay";
const newHome = "/var/lib/hifabu-relay";
const oldApp = "/opt/versekit";
const newApp = "/opt/hifabu";
const caddyFile = "/etc/caddy/Caddyfile";
const unitDir = "/etc/systemd/system";
const configFile = ".config/versekit/config.json";
const defaultStorage = ".local/state/versekit/relay";
const unitTemplate = new URL("./hifabu-relay.service", import.meta.url);
const journalFile = join(unitDir, ".hifabu-relay-rename.json");
const parkedUnit = join(unitDir, oldUnit + ".pre-hifabu");
const pairs = [[oldHome, newHome], [oldApp, newApp]];

const plan = {
  cutover: [
    "Hifabu R7 中转切换（在部署窗口从服务器上的独立 checkout 执行）",
    "1. 锁定切换；核对旧 systemd 单元、目录、已有 Caddy 站点块和中转配置，记录原单元的启用状态。",
    `2. 停止并禁用 ${oldUnit}；记录固定令牌目录和各账号目录的投递数、blob 数。`,
    `3. 用 mv（同文件系统 rename）移动 ${oldHome} → ${newHome}，旧路径保留符号链接一周；移动 ${oldApp} → ${newApp}。`,
    "4. 更新中转配置中指向旧目录的绝对路径；逐项复核移动后的投递数和 blob 数。",
    `5. 归档旧单元，安装并启动 ${newUnit}，保留原开机启动设置；用回环 /v1/ping 检查就绪。`,
    `6. 只更新 ${caddyFile} 中转站点的托管标记，validate 后 reload；旧 HTTPS 地址和 8790 端口继续使用。`,
    "7. 复核启动后的投递数和 blob 数；由协调器验证 0.1.0 插件、旧发布机拉取及同机其他站点。",
  ],
  rollback: [
    "Hifabu R7 中转回滚（在部署窗口从服务器上的独立 checkout 执行）",
    `1. 锁定回滚；读取切换记录，停止并禁用 ${newUnit}，记录当前投递数和 blob 数。`,
    `2. 删除指向 ${newHome} 的旧兼容链接；用 mv 将当前数据和代码移回 ${oldHome}、${oldApp}。`,
    "3. 把配置中的路径改回旧名，复核回滚前后的投递数和 blob 数。",
    `4. 恢复旧 systemd 单元及其开机启动设置，启动 ${oldUnit}，检查回环 /v1/ping。`,
    "5. 只还原 Caddy 的中转托管标记，validate 后 reload；清除切换记录。",
  ],
};

const entry = (path) => lstatSync(path, { throwIfNoEntry: false });
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

function readConfig(path) {
  requireThat(entry(path)?.isFile(), `找不到中转配置文件 ${path}。`);
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("中转配置不是有效 JSON。");
    throw error;
  }
  requireThat(config?.relay && typeof config.relay === "object" && !Array.isArray(config.relay), "缺少中转配置 relay。");
  for (const key of ["data_dir", "machine_public_key_file"]) {
    const value = config.relay[key];
    requireThat(value == null || (typeof value === "string" && isAbsolute(value) && resolve(value) === value),
      `relay.${key} 必须是规范的绝对路径。`);
  }
  return config;
}

function replaceFile(path, content) {
  const { uid, gid, mode } = statSync(path);
  const scratch = mkdtempSync(join(dirname(path), ".hifabu-rename-"));
  try {
    const next = join(scratch, "next");
    writeFileSync(next, content, { mode: 0o600 });
    chownSync(next, uid, gid);
    chmodSync(next, mode & 0o777);
    renameSync(next, path);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function rebase(path, moves) {
  for (const [from, to] of moves) {
    if (path === from || path.startsWith(from + "/")) return to + path.slice(from.length);
  }
  return path;
}

function rebaseConfig(path, moves) {
  const config = readConfig(path);
  let changed = false;
  for (const key of ["data_dir", "machine_public_key_file"]) {
    const current = config.relay[key];
    if (current == null) continue;
    const next = rebase(current, moves);
    if (next !== current) {
      config.relay[key] = next;
      changed = true;
    }
  }
  if (changed) replaceFile(path, JSON.stringify(config, null, 2) + "\n");
}

function markerPair(brand) {
  return [`# >>> ${brand} relay (managed by deploy/volc1) >>>`, `# <<< ${brand} relay <<<`];
}

function caddyContents(contents, target, allowCurrent = false) {
  const lines = contents.split("\n");
  const old = markerPair("versekit");
  const next = markerPair("hifabu");
  const marks = lines.filter((line) => [...old, ...next].includes(line));
  const isPair = (pair) => marks.length === 2 && pair.every((mark, index) => mark === marks[index]);
  const desired = target === "hifabu" ? next : old;
  const previous = target === "hifabu" ? old : next;
  if (allowCurrent && isPair(desired)) return contents;
  requireThat(isPair(previous), "Caddyfile 必须有且仅有一组匹配的中转托管标记，请核对站点。");
  return lines.map((line) => line === previous[0] ? desired[0] : line === previous[1] ? desired[1] : line).join("\n");
}

function storageCounts(root, home) {
  const { relay } = readConfig(root(join(home, configFile)));
  const storage = root(relay.data_dir ?? join(home, defaultStorage));
  requireThat(statSync(storage, { throwIfNoEntry: false })?.isDirectory(), `找不到中转数据目录 ${storage}。`);
  function files(folder, pattern) {
    const info = entry(folder);
    if (!info) return 0;
    requireThat(info.isDirectory(), `中转目录布局不符合预期：${folder}。`);
    return readdirSync(folder, { withFileTypes: true }).filter((file) => file.isFile() && pattern.test(file.name)).length;
  }
  function count(folder) {
    return {
      deliveries: files(join(folder, "deliveries"), /\.json$/),
      blobs: files(join(folder, "blobs"), /^[0-9a-f]{64}$/),
    };
  }
  const legacy = count(storage);
  const accounts = Object.fromEntries(readdirSync(storage, { withFileTypes: true })
    .filter((item) => item.isDirectory() && relayAccountId.test(item.name))
    .map((item) => item.name).sort().map((name) => [name, count(join(storage, name))]));
  const total = Object.values(accounts).reduce(
    (sum, counters) => ({ deliveries: sum.deliveries + counters.deliveries, blobs: sum.blobs + counters.blobs }),
    { ...legacy },
  );
  return { total, legacy, accounts };
}

const commandOnServer = (command, ...args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

async function probe(command, unit) {
  for (let attempt = 1; attempt <= 15; attempt++) {
    let status;
    try {
      status = command("curl", "--noproxy", "*", "--silent", "--max-time", "2", "--output", "/dev/null",
        "--write-out", "%{http_code}", "http://127.0.0.1:8790/v1/ping");
    } catch (error) {
      // The socket may be unavailable while systemd starts Node.
      if (![7, 28, 52, 56].includes(error.status)) throw error;
    }
    if (status === "401") {
      command("systemctl", "is-active", "--quiet", unit);
      return;
    }
    if (attempt < 15) await setTimeout(1000);
  }
  throw new Error(`中转未就绪，请查看 journalctl -u ${unit}。`);
}

// 测试传入临时目录和 systemctl / Caddy 替身。命令行只操作本机。
export async function renameRelay(action, { root = (path) => path, command = commandOnServer, log = console.log } = {}) {
  const home = entry(root(newHome))?.isDirectory() ? newHome : oldHome;
  if (action === "counts") {
    log(JSON.stringify(storageCounts(root, home)));
    return;
  }

  const originalUnit = root(join(unitDir, oldUnit));
  const installedUnit = root(join(unitDir, newUnit));
  const archivedUnit = root(parkedUnit);
  const journal = root(journalFile);
  const caddy = root(caddyFile);
  const validateCaddy = () => command("caddy", "validate", "--config", caddy, "--adapter", "caddyfile");
  function updateCaddy(target) {
    const before = readFileSync(caddy, "utf8");
    const after = caddyContents(before, target, target === "versekit");
    if (before !== after) replaceFile(caddy, after);
    validateCaddy();
    command("systemctl", "reload", "caddy");
  }
  function counts(label, path) {
    const values = storageCounts(root, path);
    log(`${label} ${JSON.stringify(values)}`);
    return JSON.stringify(values);
  }

  if (action === "cutover") {
    requireThat(!entry(journal) && !entry(archivedUnit), "已有 R7 切换记录，必要时先运行 rollback-rename。");
    requireThat(entry(originalUnit)?.isFile() && !entry(installedUnit), "systemd 中转单元不是预期的旧部署状态。");
    requireThat(command("systemctl", "show", "--property=FragmentPath", "--value", oldUnit) === originalUnit &&
      command("systemctl", "show", "--property=DropInPaths", "--value", oldUnit) === "", "旧中转有自定义 systemd 路径或覆盖，请先核对配置。");
    command("systemctl", "is-active", "--quiet", oldUnit);
    const enabled = command("systemctl", "show", "--property=UnitFileState", "--value", oldUnit);
    requireThat(enabled === "enabled" || enabled === "disabled", `无法保留旧单元启用状态：${enabled}。`);
    for (const [from, to] of pairs) {
      requireThat(entry(root(from))?.isDirectory() && !entry(root(to)), `切换需要原目录 ${from} 且目标 ${to} 尚不存在。`);
      requireThat(statSync(root(from)).dev === statSync(root(dirname(to))).dev, `${from} 和 ${to} 必须在同一文件系统。`);
    }
    requireThat(entry(caddy)?.isFile(), "Caddyfile 必须是普通文件。");
    caddyContents(readFileSync(caddy, "utf8"), "hifabu");
    validateCaddy();
    storageCounts(root, oldHome);
    const template = readFileSync(unitTemplate);
    writeFileSync(journal, JSON.stringify({ enabled }), { flag: "wx", mode: 0o600 });
    command("systemctl", "stop", oldUnit);
    command("systemctl", "disable", oldUnit);
    const before = counts("切换前", oldHome);
    for (const [from, to] of pairs) renameSync(root(from), root(to));
    symlinkSync(root(newHome), root(oldHome));
    rebaseConfig(root(join(newHome, configFile)), pairs);
    requireThat(before === counts("切换后", newHome), "中转数量不一致，暂停切换并核对目录。");
    renameSync(originalUnit, archivedUnit);
    writeFileSync(installedUnit, template, { flag: "wx", mode: 0o644 });
    command("systemctl", "daemon-reload");
    if (enabled === "enabled") command("systemctl", "enable", newUnit);
    command("systemctl", "start", newUnit);
    await probe(command, newUnit);
    requireThat(before === counts("启动后", newHome), "启动后中转数量不一致，请检查保留期清理和外部写入。");
    updateCaddy("hifabu");
    return;
  }

  requireThat(entry(journal)?.isFile(), "找不到 R7 切换记录。");
  const { enabled } = JSON.parse(readFileSync(journal, "utf8"));
  requireThat(enabled === "enabled" || enabled === "disabled", "R7 切换记录无效。");
  const compatibilityLink = entry(root(oldHome))?.isSymbolicLink();
  requireThat(!compatibilityLink || readlinkSync(root(oldHome)) === root(newHome), "旧数据路径指向其他位置，停止回滚。");
  requireThat(entry(archivedUnit)?.isFile() || entry(originalUnit)?.isFile(), "找不到旧中转单元。");
  for (const [from, to] of pairs) {
    const source = entry(root(from));
    const target = entry(root(to));
    const hasOld = source?.isDirectory();
    const hasNew = target?.isDirectory();
    requireThat(Boolean(hasOld) !== Boolean(hasNew) && (!target || hasNew) &&
      (!source || hasOld || (from === oldHome && compatibilityLink)), `无法判定应回滚的目录：${from}、${to}。`);
  }
  requireThat(entry(caddy)?.isFile(), "Caddyfile 必须是普通文件。");
  caddyContents(readFileSync(caddy, "utf8"), "versekit", true);
  if (entry(installedUnit)) {
    command("systemctl", "daemon-reload");
    command("systemctl", "stop", newUnit);
    command("systemctl", "disable", newUnit);
  } else if (entry(originalUnit)) {
    command("systemctl", "stop", oldUnit);
  }
  // 如果中断发生在目录移动之后、配置切换之前，先将当前配置指到实际位置供计数使用。
  if (compatibilityLink) unlinkSync(root(oldHome));
  const currentMoves = pairs.filter(([, to]) => entry(root(to))?.isDirectory());
  const currentPaths = pairs.map(([from, to]) => entry(root(to)) ? [from, to] : [to, from]);
  const currentConfig = root(join(home, configFile));
  rebaseConfig(currentConfig, currentPaths);
  const before = counts("回滚前", home);
  for (const [from, to] of currentMoves.toReversed()) renameSync(root(to), root(from));
  rebaseConfig(root(join(oldHome, configFile)), pairs.map(([from, to]) => [to, from]));
  requireThat(before === counts("回滚后", oldHome), "回滚数量不一致，暂停启动并核对目录。");
  if (entry(installedUnit)) unlinkSync(installedUnit);
  if (entry(archivedUnit)) renameSync(archivedUnit, originalUnit);
  command("systemctl", "daemon-reload");
  if (enabled === "enabled") command("systemctl", "enable", oldUnit);
  command("systemctl", "start", oldUnit);
  await probe(command, oldUnit);
  updateCaddy("versekit");
  unlinkSync(journal);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, option, ...extra] = process.argv.slice(2);
  try {
    requireThat(Object.hasOwn(plan, action) && !extra.length, "请使用 deploy/cutover-rename 或 deploy/rollback-rename。");
    if (option === "--dry-run") {
      console.log(plan[action].join("\n"));
    } else {
      requireThat(option === undefined || (option === "--counts" && action === "cutover"), "未知的 R7 参数。");
      if (option === undefined) requireThat(process.getuid() === 0, "请在中转服务器以 root 执行。");
      await renameRelay(option === "--counts" ? "counts" : action);
    }
  } catch (error) {
    console.error(`Hifabu R7 操作失败：${error.message}`);
    if (option === undefined && entry(journalFile)) console.error("已保留 R7 切换记录。请在维护窗口核对现场，必要时执行 deploy/rollback-rename。");
    process.exitCode = 1;
  }
}
