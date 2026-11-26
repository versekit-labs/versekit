import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const allowlistPath = "scripts/ci/brand-allowlist.txt";
const allowedReasons = new Set(["协议常量", "仓库地址", "Orca 流程", "历史文档", "迁移代码", "白名单本身"]);
const categories = ["用户看得见的字", "命令", "环境变量", "本机路径", "内部名字", "服务器", "其他"];
const legacy = /(?<env>\b(?:VERSEKIT_|VK_)[A-Za-z0-9_]*)|(?<brand>[Vv][Ee][Rr][Ss][Ee][Kk][Ii][Tt])|(?<command>\bvk\b)(?=$|[\s`"'<>;|&),}\]])/g;
const commandStart = /(?:^\s*(?:(?:[$>#*+-]|\d+\.)[ \t]+)?|`+[ \t]*|\bnpm[ \t]+run[ \t]+|\bcommand[ \t]+-v[ \t]+|[;&|][ \t]*|(?:^|[[(,:=][ \t]*)["'])$/;
const brandInPath = /(?:[/\\]|\.)versekit|versekit[\w.-]*[/\\]|\bcom\.versekit\b/i;
const serverLocation = /^(?:deploy\/|docs\/deploy[-.])|(?:^|\/)server\//;
const sourceFile = /\.(?:[cm]?[jt]sx?|css|json|ya?ml|toml|sh|sql)$/;
const internalName = /@versekit[-/]|[\w.-]+[-_]versekit\b|\bversekit[-_][\w-]+/i;
const visibleSource = /^(?:packages\/web\/public\/|site\/|docs\/design\/|\.impeccable\/surfaces\/)|\/(?:cards?|messages?|status)\.[cm]?js$/;

function loadAllowlist() {
  return readFileSync(join(root, allowlistPath), "utf8").split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return [];
    const fields = line.split("\t").map((field) => field.trim());
    const [path, pattern, category, reason] = fields;
    const location = `${allowlistPath}:${index + 1}`;
    if (fields.length !== 4 || !path || !pattern || !allowedReasons.has(category) || !reason) {
      throw new Error(`${location}：每项必须写明路径、匹配规则、有效的理由类别和一句话理由（用制表符分隔）`);
    }
    if (path === "*" && pattern === "-") {
      throw new Error(`${location}：全仓库规则必须限定匹配内容`);
    }
    try {
      return [{ path, pattern: pattern === "-" ? null : new RegExp(pattern, "g") }];
    } catch (error) {
      throw new Error(`${location}：匹配规则无效（${error.message}）`);
    }
  });
}

function readText(file) {
  const path = join(root, file);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  const bytes = readFileSync(path);
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch (error) {
    if (error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") return null;
    throw error;
  }
}

function classify(file, line, match) {
  if (match.groups.env) return "环境变量";
  if (match.groups.command) return "命令";

  // 只看命中所在的片段，别把同一行上的产品名误归到路径或内部名字。
  const before = line.slice(0, match.index).match(/[\w@.$~+\/\\-]*$/)[0];
  const after = line.slice(match.index + match[0].length).match(/^[\w.\/\\-]*/)[0];
  const word = before + match[0] + after;
  if (serverLocation.test(file) || /(?:^|\/)(?:opt|var\/lib|etc\/systemd)\/.*versekit|versekit[\w-]*\.service\b/i.test(word)) return "服务器";
  if (!word.startsWith("@") && brandInPath.test(word)) return "本机路径";
  if (internalName.test(word) || /\b(?:name|profile)\s*[:=]\s*["']$/i.test(line.slice(0, match.index))) return "内部名字";
  if (visibleSource.test(file) || /^\s*(?:<|.*\b(?:title|message|summary|hint|label|content|description)\s*:)/.test(line)) return "用户看得见的字";
  if (sourceFile.test(file)) return "内部名字";
  return "其他";
}

function main(args) {
  if (args.length && (args.length !== 1 || args[0] !== "--strict")) {
    throw new Error("用法：npm run check:brand -- [--strict]");
  }
  const strict = args.length === 1;
  const allowlist = loadAllowlist();
  const tracked = execFileSync("git", ["ls-files", "--cached", "--deduplicate", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
  const results = new Map(categories.map((category) => [category, { count: 0, examples: new Set() }]));
  let total = 0;

  for (const file of tracked) {
    const rules = allowlist.filter(({ path }) => path === "*" || path === file || (path.endsWith("/") && file.startsWith(path)));
    if (rules.some(({ pattern }) => pattern === null)) continue;
    const text = readText(file);
    if (text === null) continue;
    text.split(/\r\n|\r|\n/).forEach((line, index) => {
      const matches = [...line.matchAll(legacy)].filter((match) =>
        !match.groups.command || commandStart.test(line.slice(0, match.index)),
      );
      if (!matches.length) return;
      const allowed = rules.flatMap(({ pattern }) => [...line.matchAll(pattern)]);
      for (const match of matches) {
        if (allowed.some((span) => span.index <= match.index && match.index + match[0].length <= span.index + span[0].length)) continue;
        const result = results.get(classify(file, line, match));
        result.count += 1;
        total += 1;
        if (result.examples.size < 3) result.examples.add(`${file.replace(/[\r\n]/g, (char) => char === "\r" ? "\\r" : "\\n")}:${index + 1}`);
      }
    });
  }

  console.log(`品牌检查（${strict ? "严格模式" : "报告模式"}，按命中次数统计）`);
  for (const [category, { count, examples }] of results) {
    console.log(`  ${category}：${count} 处${count ? `（${[...examples].join("、")}）` : ""}`);
  }
  console.log(`总计：${total} 处白名单外残留`);
  return strict && total > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`品牌检查出错：${error.message}`);
  process.exitCode = 1;
}
