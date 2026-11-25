import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lockFile = "version-lock.json";
const { version } = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));

function contentHash() {
  const files = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path).split(sep).join("/");
    // The lock records this digest and cannot be part of its own input.
    if (name === lockFile) continue;
    const link = entry.isSymbolicLink();
    const bytes = link ? readlinkSync(path, { encoding: "buffer" }) : readFileSync(path);
    files.set(name, [link ? "link" : "file", createHash("sha256").update(bytes).digest("hex")]);
  }
  const names = [...files.keys()].sort();
  return createHash("sha256").update(JSON.stringify(names.map((name) => [name, ...files.get(name)]))).digest("hex");
}

if (process.argv.includes("--print-hash")) {
  console.log(JSON.stringify({ [version]: contentHash() }, null, 2));
} else {
  test("ACC-plugin-dist-01: 插件内容变更需要新的版本和哈希记录", () => {
    const locks = JSON.parse(readFileSync(join(root, lockFile), "utf8"));
    const actual = contentHash();
    assert.equal(
      locks[version],
      actual,
      "插件版本记录与内容不一致。提高 plugin.json 的 version，运行 node plugins/hifabu/test/version.test.mjs --print-hash，并把新条目追加到 version-lock.json。保留旧版本记录。",
    );
  });
}
