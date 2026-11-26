import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../hifabu/", import.meta.url));
const lockFile = "version-lock.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function contentHash(pluginDir) {
  const files = new Map();
  for (const entry of readdirSync(pluginDir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(pluginDir, path).split(sep).join("/");
    // The lock records this digest and cannot be part of its own input.
    if (name === lockFile) continue;
    const link = entry.isSymbolicLink();
    const bytes = link ? readlinkSync(path, { encoding: "buffer" }) : readFileSync(path);
    files.set(name, [link ? "link" : "file", digest(bytes)]);
  }
  return digest(JSON.stringify([...files.keys()].sort().map((name) => [name, ...files.get(name)])));
}

function manifestVersion(pluginDir) {
  return JSON.parse(readFileSync(join(pluginDir, ".claude-plugin/plugin.json"), "utf8")).version;
}

export function checkVersion(pluginDir = root) {
  const version = manifestVersion(pluginDir);
  const locks = JSON.parse(readFileSync(join(pluginDir, lockFile), "utf8"));
  if (locks[version] !== contentHash(pluginDir)) {
    throw new Error("插件版本记录与内容不一致。提升版本后用 node plugins/hifabu-src/version.mjs --print-hash 生成新条目，保留旧记录。");
  }
}

if (process.argv[1] && process.argv.includes("--print-hash") && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  console.log(JSON.stringify({ [manifestVersion(root)]: contentHash(root) }, null, 2));
}
