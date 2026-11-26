import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, CLOUD_COMMANDS } from "../packages/core/src/commands.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = "packages/cli/src/maker.mjs";
const registry = "packages/core/src/commands.mjs";
const buildScript = "scripts/build-maker-client.mjs";
const pluginDir = join(root, "plugins/hifabu");
const launchers = ["bin/hifabu", "bin/hifabu-runtime"];
const byteLimit = 256 * 1024;
const cloudNames = new Set(["device.link.start", "device.link.poll", "device.refresh", "device.revoke.self"]);
const namedImport = /^import \{([^}]+)\} from "([^"]+)";$/;
const namedDeclaration = /^export ((?:async )?(?:const|function|class) (\w+))/;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function projectRegistry(source) {
  const parser = source.indexOf("const EMPTY_STRING_MEANS_VALUE =");
  if (parser === -1) throw new Error("找不到命令参数校验");
  const maker = COMMANDS.filter((command) => command.roles?.includes("maker"));
  const cloud = CLOUD_COMMANDS.filter((command) => cloudNames.has(command.name));
  if (cloud.length !== cloudNames.size) throw new Error("制作机所需的云端命令不完整");
  return [
    `export const COMMANDS = ${JSON.stringify(maker, null, 2)};`,
    `export const CLOUD_COMMANDS = ${JSON.stringify(cloud, null, 2)};`,
    source.slice(parser),
  ].join("\n\n");
}

// The maker sources use static named imports and named declarations. Preserve one
// lexical scope per module and fail the build if a source uses a different form.
function link(entryFile) {
  const builtins = new Map();
  const modules = new Map();
  const visiting = new Set();
  function visit(file) {
    if (modules.has(file)) return;
    if (visiting.has(file)) throw new Error(`制作机模块存在循环依赖：${file}`);
    if (!/^packages\/(core|cli|cloud|relay)\/src\/[a-z0-9-]+\.mjs$/.test(file)) {
      throw new Error(`制作机模块路径无效：${file}`);
    }
    visiting.add(file);
    let source = readFileSync(join(root, file), "utf8");
    if (file === registry) source = projectRegistry(source);
    const exports = [];
    const body = source.trimEnd().split("\n").map((line) => {
      const imported = namedImport.exec(line);
      if (imported) {
        const [, bindings, specifier] = imported;
        const names = bindings.trim().replace(/\s+as\s+/g, ": ");
        if (specifier.startsWith("node:") && specifier !== "node:sqlite") {
          if (!builtins.has(specifier)) builtins.set(specifier, `builtin${builtins.size}`);
          return `const { ${names} } = ${builtins.get(specifier)};`;
        }
        if (!specifier.startsWith(".")) throw new Error(`制作机模块 ${file} 引用了 ${specifier}`);
        const dependency = posix.normalize(posix.join(posix.dirname(file), specifier));
        visit(dependency);
        return `const { ${names} } = modules[${JSON.stringify(dependency)}];`;
      }
      const declaration = namedDeclaration.exec(line);
      if (declaration) {
        exports.push(declaration[2]);
        return line.slice("export ".length);
      }
      if (/^(?:import|export)\b/.test(line)) throw new Error(`制作机模块 ${file} 有无法构建的声明：${line}`);
      return line;
    });
    visiting.delete(file);
    const isEntry = file === entryFile;
    if (isEntry && exports.length) throw new Error("制作机入口不能有导出");
    const declaration = isEntry ? "await (async () => {" : `modules[${JSON.stringify(file)}] = (() => {`;
    const content = body.join("\n");
    modules.set(file, `// ${file}\n${declaration}\n${content}\n${isEntry ? "" : `  return { ${exports.join(", ")} };\n`}})();`);
  }
  visit(entryFile);
  const imports = [...builtins].map(([name, binding]) => `import * as ${binding} from ${JSON.stringify(name)};`);
  const body = [...imports, "", "const modules = Object.create(null);", "", ...modules.values()].join("\n\n") + "\n";
  return { body, inputs: [...modules.keys(), buildScript] };
}

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out-dir" || !args[1])) {
  throw new Error("用法：node scripts/build-maker-client.mjs [--out-dir <目录>]");
}
const out = args.length ? resolve(args[1]) : pluginDir;
const { body, inputs } = link(entry);
const payloadHash = sha256(body);
// The artifact is committed separately. Building at that commit still points to
// the last commit that supplied its source files. A shallow checkout may lack
// that commit, so preserve the recorded source when rebuilding the same body.
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const shallow = git(["rev-parse", "--is-shallow-repository"]) === "true";
let existing = "";
try {
  existing = readFileSync(join(pluginDir, "lib/hifabu.mjs"), "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const prefix = existing.match(/^\/\/ Generated by [^\n]+\n\/\/ Source commit: ([0-9a-f]{40})\n\/\/ SHA-256 \(body\): ([0-9a-f]{64})\n\n/);
const sameBody = prefix && prefix[2] === payloadHash && existing.slice(prefix[0].length) === body;
const latest = git(["log", "-1", "--format=%H", "--", ...inputs, ...launchers.map((file) => join(pluginDir, file))]);
// A shallow boundary appears to have changed every file. Only use the stored
// source revision when the latest candidate is such a boundary.
const boundaries = shallow ? readFileSync(git(["rev-parse", "--path-format=absolute", "--git-path", "shallow"]), "utf8").split("\n") : [];
const commit = sameBody && boundaries.includes(latest) ? prefix[1] : latest;
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("找不到制作机源码提交");
const artifacts = new Map([
  ...launchers.map((file) => [file, readFileSync(join(pluginDir, file))]),
  ["lib/hifabu.mjs", `// Generated by ${buildScript}\n// Source commit: ${commit}\n// SHA-256 (body): ${payloadHash}\n\n${body}`],
]);
if (Buffer.byteLength(artifacts.get("lib/hifabu.mjs")) > byteLimit) throw new Error("制作机单文件超过 256 KiB");
for (const [file, bytes] of artifacts) {
  const path = join(out, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  if (launchers.includes(file)) chmodSync(path, 0o755);
  console.log(`${file} ${Buffer.byteLength(bytes)} bytes sha256 ${sha256(bytes)}`);
}
