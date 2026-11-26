import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lockFile = "version-lock.json";
const { version } = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
// 0.1.0 发布内容不含这两个生成文件。第 5 单切到 0.2.0 时取消排除、全量计算。
const unreleasedMakerFiles = new Set(["bin/hifabu", "lib/hifabu.mjs"]);
// 原 0.1.0 记录也散列了本检查脚本自身。保留发布时的摘要，使测试规则更新不重写历史版本。
const releasedVersionTestHash = "0f2aba33a0733f8b0536c089914576956ca979bc16a5d22656506921d2dabab5";

function contentHash() {
  const files = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path).split(sep).join("/");
    // The lock records this digest and cannot be part of its own input.
    if (name === lockFile) continue;
    if (version === "0.1.0") {
      if (unreleasedMakerFiles.has(name)) continue;
      if (name === "test/version.test.mjs") {
        files.set(name, ["file", releasedVersionTestHash]);
        continue;
      }
    }
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
