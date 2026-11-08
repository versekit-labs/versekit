#!/usr/bin/env node
// 零后门门禁（BLUEPRINT §3.9「no-backdoor」/ PRD §5.3 零后门律）。
//
// 规则只有一条：packages/web/** 与 packages/channel-*/** 不得绕过 core 直接碰数据库或凭证。
// 落到可执行的检查上是三件事：
//   · import 了 core 的数据库入口（core/src/index.mjs）——绕开命令接口与状态机
//   · import 了 node:sqlite / sqlite3 / better-sqlite3——自带一份表结构
//   · 代码里出现凭证目录或 vk.db 的路径字面量——知道路径，写只是时间问题
//
// 为什么不用 eslint：
//   零依赖是硬约束（连 eslint/prettier 都不进 devDependencies），而这条规则只回答上面三个
//   问题。用正则 60 行就能写完，每条命中都能打印「文件:行 + 原文 + 怎么修」，而且规则本身
//   是可读的中文注释，不需要额外解释「为什么这条 lint 规则存在」。代价是它只做静态文本
//   匹配，不做 AST / 数据流分析：字符串拼接出来的路径、变量间接 import 都可能漏。
//   所以规则故意写得窄而硬——只认 import/require 说明符和带引号的路径字面量——宁可漏报
//   一个变形，也不要误报一片正常代码。这个门禁是「防回归的绊线」，不是沙箱；真正的隔离
//   靠 core 的接口边界。
//
// 包还不存在时（当前就是）：打印「尚无 web/channel 包，门禁生效于未来包」并成功退出。
// 这样 CI 从第一天就有这条门禁，未来包一落地自动开始被扫，不需要有人记得来改 CI。
//
// 用法：node scripts/ci/no-backdoor.mjs   （npm run check:backdoor）

import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES = join(ROOT, "packages");
const NAME = "零后门门禁 no-backdoor";

const CODE_EXT = new Set([".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo"]);

// 零后门律的适用面：web 与所有 channel-* 包。
const TARGET_PREFIX = "channel-";
const TARGET_EXACT = "web";

const RULES = {
  "no-backdoor.core-db": {
    why: "import 了 core 的数据库入口",
    fix: "web/channel 只能通过 core 的命令接口（或本机 HTTP）拿数据，不能直接 import core 的数据库模块；否则表结构与状态机会出现第二份实现",
  },
  "no-backdoor.sqlite": {
    why: "直接使用 SQLite 驱动",
    fix: "数据库只属于 core：去掉 node:sqlite/sqlite3 依赖，改成调用 core 的命令；自带一份 schema 就是零后门律要防的事",
  },
  "no-backdoor.credentials": {
    why: "代码里出现凭证目录或数据库文件路径",
    fix: "凭证路径与 vk.db 只能由 core 拼装；web/channel 通过 core 的接口拿数据，不要在本地拼 ~/.config/versekit 或 credentials",
  },
};

// 只认带引号的路径字面量：注释、UI 文案里的英文单词不误伤。
const CRED_PATH_MARKERS = ["credentials", ".config/versekit", ".local/state/versekit", "vk.db"];
const QUOTE = /["'`]/;

// import ... from "x" / import "x" / import("x") / require("x") / export ... from "x"
const SPECIFIER_RE =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/;

const CORE_DB_RE = /(^|\/)core\/src\/index\.mjs$/;
const SQLITE_RE = /^(node:sqlite|sqlite3|better-sqlite3|node-sqlite3)$/;

/** 找出该扫的包目录。不存在不是错误——门禁为未来的包准备。 */
function targetDirs() {
  let entries;
  try {
    entries = readdirSync(PACKAGES, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && (e.name === TARGET_EXACT || e.name.startsWith(TARGET_PREFIX)))
    .map((e) => e.name)
    .sort();
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && CODE_EXT.has(extname(entry.name))) out.push(full);
  }
  return out;
}

function specifierOf(line) {
  const m = SPECIFIER_RE.exec(line);
  return m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : null;
}

// ---------------------------------------------------------------- 扫描

const dirs = targetDirs();
if (dirs.length === 0) {
  console.log(`▸ ${NAME}`);
  console.log("  ⊘ 尚无 web/channel 包，门禁生效于未来包（扫描面：packages/web/**、packages/channel-*/**）");
  console.log(`\n✓ ${NAME}通过：0 个包可扫描，规则已就绪`);
  process.exit(0);
}

const files = [];
for (const dir of dirs) walk(join(PACKAGES, dir), files);

const findings = [];
const seen = new Set();

function report(file, line, rule, text) {
  const key = `${file}:${line}:${rule}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ file: relative(ROOT, file), line, rule, text: text.trim() });
}

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, index) => {
    const lineNo = index + 1;

    const spec = specifierOf(text);
    if (spec) {
      if (CORE_DB_RE.test(spec)) report(file, lineNo, "no-backdoor.core-db", `${text}   ← ${spec}`);
      else if (SQLITE_RE.test(spec)) report(file, lineNo, "no-backdoor.sqlite", `${text}   ← ${spec}`);
    }

    if (QUOTE.test(text) && CRED_PATH_MARKERS.some((marker) => text.includes(marker))) {
      report(file, lineNo, "no-backdoor.credentials", text);
    }
  });
}

// ---------------------------------------------------------------- 输出

console.log(`▸ ${NAME}`);
console.log(`  扫描 ${files.length} 个文件：${dirs.map((d) => `packages/${d}`).join("、")}`);

for (const [id, rule] of Object.entries(RULES)) {
  const hits = findings.filter((f) => f.rule === id);
  console.log(`  ${hits.length ? "✗" : "✓"} ${id.padEnd(30)}${rule.why}（${hits.length} 处）`);
}

if (findings.length) {
  console.log("");
  for (const f of findings) console.log(`  ✗ ${f.file}:${f.line}  [${f.rule}]\n      ${f.text}\n      ↳ 怎么修：${RULES[f.rule].fix}`);
  console.log(`\n✗ ${NAME}失败：${findings.length} 处违规。零后门律见 AGENTS.md §3 / BLUEPRINT §3.8。`);
  console.log("  复现：npm run check:backdoor");
  process.exit(1);
}

console.log(`\n✓ ${NAME}通过：${files.length} 个文件没有直连数据库 / 凭证目录的入口`);
