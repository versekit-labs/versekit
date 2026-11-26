import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = new URL("../../../", import.meta.url);
const { bin } = JSON.parse(readFileSync(new URL("package.json", repo), "utf8"));

function run(command, args) {
  const { status, stdout, stderr, error } = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(bin[command], repo)), ...args],
    { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
  );
  assert.ifError(error);
  return { status, stdout, stderr };
}

test("ACC-brand-04 npm bin 的 hifabu 和 vk 共用命令，改名提示只走 stderr", () => {
  for (const args of [["--help"], ["commands", "--json"], ["unknown-command"]]) {
    const primary = run("hifabu", args);
    const alias = run("vk", args);
    assert.equal(primary.status, args[0] === "unknown-command" ? 2 : 0);
    assert.equal(alias.status, primary.status);
    assert.equal(alias.stdout, primary.stdout);
    assert.equal(alias.stderr, "vk 已改名为 hifabu\n" + primary.stderr);
  }
  assert.match(run("hifabu", ["--help"]).stdout, /^hifabu — Hifabu CLI/);
});
