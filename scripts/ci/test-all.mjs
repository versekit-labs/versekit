// `npm test` 入口（ACC-test-cleanup-01）：
//  - 给本次全量测试一个独占的临时根目录（TMPDIR），测试里 mkdtemp 出来的东西都落在里面；
//  - 每个测试文件进程预加载 scripts/ci/test-cleanup.mjs（退出时关 Chrome、结束子进程、删目录）；
//  - 跑完检查：根目录下还剩的 vk* 目录、`--user-data-dir` 落在根目录下的 Chrome 进程，必须为 0；
//    有残留就列出来并失败（同时清掉，免得继续占盘）。
// 独占根目录让「同时起 3 份全量测试」互不误判。
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, readdirSync as ls, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeUnder } from "./test-cleanup.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 路径要短：unix socket 路径在 macOS 上上限 104 字节，而 macOS 的 $TMPDIR（/var/folders/…/T）自己就有 50 字节，
// 再叠测试目录就会超（bootstrap 测试的 CLI 子进程连不上守护进程）。macOS 上改用 /tmp 下的独占目录。
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "vkr-"));

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
const args = ["--test", "--import", preload, ...process.argv.slice(2), ...files()];
const child = spawn(process.execPath, args, {
  cwd: repo,
  stdio: "inherit",
  env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
});
const code = await new Promise((r) => {
  child.on("exit", (c, sig) => r(c ?? (sig ? 1 : 0)));
});

const leftovers = [];
const chrome = chromeUnder([root]);
for (const c of chrome) leftovers.push(`Chrome 进程 pid ${c.pid}（--user-data-dir 在 ${c.userDataDir} 下）`);
let dirs = [];
try {
  dirs = readdirSync(root).filter((n) => n.startsWith("vk"));
} catch {}
for (const d of dirs) leftovers.push(`临时目录 ${join(root, d)}`);

// 先收拾再汇报：残留不能继续占盘。
for (const c of chrome) {
  try {
    process.kill(c.pid, "SIGTERM");
  } catch {}
}
if (chrome.length) await new Promise((r) => setTimeout(r, 1500));
for (const c of chromeUnder([root])) {
  try {
    process.kill(c.pid, "SIGKILL");
  } catch {}
}
rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

if (leftovers.length) {
  console.error(`\n测试残留检查失败：全量测试跑完后还剩 ${leftovers.length} 项（已清理，但要查是谁漏了收尾）：`);
  for (const l of leftovers) console.error(`  - ${l}`);
  process.exit(code || 1);
}
console.log(`测试残留检查：通过（临时目录 0、测试 Chrome 0）`);
process.exit(code);
