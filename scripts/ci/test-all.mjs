// `npm test` 入口（ACC-test-cleanup-01）：
//  - 给本次全量测试一个独占的临时根目录（TMPDIR），测试里 mkdtemp 出来的东西都落在里面；
//  - 每个测试文件进程预加载 scripts/ci/test-cleanup.mjs（退出时关 Chrome、结束子进程、删目录）；
//  - 跑完检查（口径 (c)）：本次测试自己留下的东西必须为 0，有就列出来并失败（同时清掉，免得继续占盘）：
//      · 独占根目录里还剩的 vk* 目录；
//      · 测试里直接 mkdir 在 /tmp、系统临时目录（$TMPDIR）下的 vk* 目录（预加载工具记账，见 test-cleanup.mjs）；
//      · `--user-data-dir` 落在上面这些目录里的 Chrome 进程。
//    归属按「本次测试进程自己建的」精确认定，而不是「跑完之后 /tmp 下多了什么」：这台机器上常有别的会话同时在跑测试，
//    它们的目录和 Chrome 不能算进来，更不能误删。系统临时目录下多出来、但认不出归属的 vk* 目录只作提示（不失败、不动）。
// 独占根目录让「同时起 3 份全量测试」互不误判；测试里写死 /tmp 的 mkdtemp 会被改到根目录里（见 test-cleanup.mjs）。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, readdirSync as ls, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeProcesses, chromeUnder } from "./test-cleanup.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 路径要短：unix socket 路径在 macOS 上上限 104 字节，而 macOS 的 $TMPDIR（/var/folders/…/T）自己就有 50 字节，
// 再叠测试目录就会超（bootstrap 测试的 CLI 子进程连不上守护进程）。macOS 上改用 /tmp 下的独占目录。
// 名字不以 vk 开头：它不是「残留」，而且并发的另一份全量测试扫 /tmp 时不会把它当成自己的残留。
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "tr-"));

// 要扫的系统临时目录：原始 $TMPDIR（子进程里会被换成 root）、/tmp。
// VK_TEST_ALL_SCAN（逗号分隔）：换掉要扫的目录，给「残留检查本身」的测试用，免得它在真 /tmp 里留的目录被别的全量测试撞见。
const scanList = process.env.VK_TEST_ALL_SCAN?.split(",").filter(Boolean) ?? [tmpdir(), "/tmp"];
const scanDirs = [...new Set(scanList.map((d) => { try { return realpathSync(d); } catch { return d; } }))];
const vkDirs = (dir) => {
  try {
    return readdirSync(dir).filter((n) => n.startsWith("vk"));
  } catch {
    return [];
  }
};
const beforeDirs = new Set(scanDirs.flatMap((d) => vkDirs(d).map((n) => join(d, n))));
const beforePids = new Set(chromeProcesses().map((c) => c.pid));

function files() {
  const out = [];
  for (const pkg of ls(join(repo, "packages")).sort()) {
    const dir = join(repo, "packages", pkg, "test");
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of ls(dir).sort()) if (f.endsWith(".test.mjs")) out.push(join("packages", pkg, "test", f));
  }
  return out;
}

const preload = join(repo, "scripts", "ci", "test-cleanup.mjs");
// VK_TEST_ALL_FILES（逗号分隔）：只跑指定文件，给「残留检查本身」的测试用；平时不设。
const only = process.env.VK_TEST_ALL_FILES?.split(",").filter(Boolean);
const args = ["--test", "--import", preload, ...process.argv.slice(2), ...(only ?? files())];
const child = spawn(process.execPath, args, {
  cwd: repo,
  stdio: "inherit",
  env: { ...process.env, VK_TEST_ALL_FILES: "", VK_TEST_ALL_SCAN: "", VK_TEST_SCAN_DIRS: scanDirs.join(":"), VK_TEST_ROOT: root, TMPDIR: root, TMP: root, TEMP: root },
});
const code = await new Promise((r) => {
  child.on("exit", (c, sig) => r(c ?? (sig ? 1 : 0)));
});

const leftovers = [];
// 本次测试自己的：独占根目录里的 vk* + 记账里还在的目录。
const mine = new Set(vkDirs(root).map((n) => join(root, n)));
try {
  for (const line of readFileSync(join(root, ".created"), "utf8").split("\n")) if (line && existsSync(line)) mine.add(line);
} catch {}
const mineDirs = [...mine];
const stray = () => chromeUnder([root, ...mineDirs]);
const chrome = stray();
for (const c of chrome) leftovers.push(`Chrome 进程 pid ${c.pid}（--user-data-dir 在 ${c.userDataDir} 下）`);
for (const d of mineDirs) leftovers.push(`临时目录 ${d}`);

// 认不出归属的新 vk* 目录 / Chrome：多半是同一台机器上别的会话，只提示，不动。
const unowned = scanDirs
  .flatMap((d) => vkDirs(d).map((n) => join(d, n)))
  .filter((p) => !beforeDirs.has(p) && !mine.has(p));
const unownedChrome = chromeProcesses().filter(
  (c) => !beforePids.has(c.pid) && scanDirs.some((d) => c.userDataDir.startsWith(d + "/vk")) && !chrome.some((x) => x.pid === c.pid),
);

// 先收拾再汇报：残留不能继续占盘。
for (const c of chrome) {
  try {
    process.kill(c.pid, "SIGTERM");
  } catch {}
}
if (chrome.length) await new Promise((r) => setTimeout(r, 1500));
for (const c of stray()) {
  try {
    process.kill(c.pid, "SIGKILL");
  } catch {}
}
for (const d of mineDirs) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
if (unowned.length || unownedChrome.length) {
  console.log(
    `提示：系统临时目录下多了 ${unowned.length} 个认不出归属的 vk* 目录、${unownedChrome.length} 个 Chrome（别的会话同时在跑测试时会这样；本次测试没有留这些，未处理）`,
  );
}

if (leftovers.length) {
  console.error(`\n测试残留检查失败：全量测试跑完后还剩 ${leftovers.length} 项（已清理，但要查是谁漏了收尾）：`);
  for (const l of leftovers) console.error(`  - ${l}`);
  process.exit(code || 1);
}
console.log(`测试残留检查：通过（临时目录 0、测试 Chrome 0）`);
process.exit(code);
