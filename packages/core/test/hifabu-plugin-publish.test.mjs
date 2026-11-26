import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const publisher = fileURLToPath(new URL("../../../deploy/hifabu/publish-plugin.mjs", import.meta.url));
const pluginDir = fileURLToPath(new URL("../../../plugins/hifabu/", import.meta.url));
const manifestPath = ".claude-plugin/plugin.json";
const manifest = JSON.parse(readFileSync(join(pluginDir, manifestPath), "utf8"));
const versionCheck = fileURLToPath(new URL("../../../plugins/hifabu-src/version.mjs", import.meta.url));
const archive = `hifabu-${manifest.version}.zip`;
const publicUrl = "https://hifabu.com/plugin/";
const siteDir = "/var/www/hifabu/plugin";
const files = [archive, "install.txt", "marketplace.json"].sort();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hifabu-plugin-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  const remote = join(root, "remote");
  mkdirSync(bin);
  mkdirSync(remote);
  // Both upload commands run solely against the temporary local directory.
  const stub = `#!/usr/bin/env node
    const assert = require("node:assert/strict");
    const { spawnSync } = require("node:child_process");
    const { appendFileSync, copyFileSync, readFileSync } = require("node:fs");
    const { basename, join } = require("node:path");
    const siteDir = ${JSON.stringify(siteDir)};
    const tool = basename(process.argv[1]);
    const [separator, ...args] = process.argv.slice(2);
    const { PUBLISH_CALLS, PUBLISH_REMOTE } = process.env;
    appendFileSync(PUBLISH_CALLS, tool + "\\n");
    assert.equal(separator, "--");
    if (process.env.PUBLISH_NO_UPLOAD) throw new Error("unexpected " + tool);
    if (tool === "scp") {
      const destination = args.pop();
      assert.match(destination, /^fixture:\\/var\\/www\\/hifabu\\/plugin\\/\\.publish-plugin\\.[a-zA-Z0-9]{8}\\/$/);
      const stage = destination.slice("fixture:".length + siteDir.length + 1);
      copyFileSync(args[0], join(PUBLISH_REMOTE, stage, basename(args[0])));
      if (process.env.PUBLISH_FAIL_SCP) process.exit(1);
      for (const path of args.slice(1)) copyFileSync(path, join(PUBLISH_REMOTE, stage, basename(path)));
    } else {
      const [host, command] = args;
      assert.equal(host, "fixture");
      const script = command === "sh -s" ? readFileSync(0, "utf8") : command;
      const result = spawnSync("/bin/sh", ["-s"], {
        cwd: PUBLISH_REMOTE,
        input: script.replaceAll(siteDir, "."),
        encoding: "utf8",
      });
      process.stdout.write(result.stdout.replace(/^\\.\\//, siteDir + "/"));
      process.stderr.write(result.stderr);
      process.exitCode = result.status;
    }
  `;
  for (const tool of ["ssh", "scp"]) writeFileSync(join(bin, tool), stub, { mode: 0o755 });
  const run = (args, extraEnv) => spawnSync(process.execPath, [publisher, "--host", "fixture", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH].join(delimiter),
      PUBLISH_CALLS: calls,
      PUBLISH_REMOTE: remote,
      ...extraEnv,
    },
  });
  return { root, calls, remote, run };
}

test("ACC-plugin-dist-05: dry-run 打包插件并打印三个 SHA-256，不运行 SSH 或 SCP", (t) => {
  const { root, calls, run } = fixture(t);
  const output = join(root, "output");
  const args = ["--dry-run", "--output-dir", output];
  const result = run(args, { PUBLISH_NO_UPLOAD: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => readFileSync(calls), { code: "ENOENT" });
  assert.deepEqual(readdirSync(output).sort(), files);
  const digests = Object.fromEntries(files.map((name) => {
    const digest = createHash("sha256").update(readFileSync(join(output, name))).digest("hex");
    assert.ok(result.stdout.includes(`${digest}  ${name}`));
    return [name, digest];
  }));
  const marketplace = JSON.parse(readFileSync(join(output, "marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "hifabu");
  assert.deepEqual(marketplace.owner, manifest.author);
  assert.equal(marketplace.plugins.length, 1);
  const { name, version, description, author, homepage, license } = manifest;
  assert.deepEqual(marketplace.plugins[0], {
    name, version, description, author, homepage, license,
    source: {
      source: "archive",
      url: `${publicUrl}${encodeURIComponent(archive)}`,
      sha256: digests[archive],
    },
  });
  const archivePath = join(output, archive);
  const names = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" }).trim().split("\n");
  const expected = [
    ".claude-plugin/plugin.json", "CHANGELOG.md", "LICENSE", "README.md",
    "bin/hifabu", "bin/hifabu-runtime", "lib/hifabu.mjs", "skills/handoff/SKILL.md",
    ...["copy", "errors", "project-setup", "setup", "status"].map((name) => `skills/handoff/references/${name}.md`),
  ];
  assert.deepEqual(names, expected);
  for (const name of names) {
    assert.doesNotMatch(name, /\.DS_Store|(?:^|\/)\.\.(?:\/|$)/);
    const content = execFileSync("unzip", ["-p", archivePath, name]);
    assert.deepEqual(content, readFileSync(join(pluginDir, name)));
    assert.doesNotMatch(content.toString(), /vibe-video|tcm-video|\/Users\/|\/home\/|[\w.+-]+@[\w.-]+\.(?:com|net|org)\b/i);
  }
  const install = readFileSync(join(output, "install.txt"), "utf8");
  assert.ok(install.split("\n").includes(
    `claude plugin marketplace add ${publicUrl}marketplace.json && claude plugin install hifabu@hifabu`,
  ));
  assert.ok(install.includes("/reload-plugins"));
  assert.ok(install.split("\n").includes(
    "claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu",
  ));
  const retry = run(args, { PUBLISH_NO_UPLOAD: "1", TZ: "Asia/Seoul" });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout, result.stdout);
  assert.throws(() => readFileSync(calls), { code: "ENOENT" });
});

test("ACC-plugin-dist-01: 散列所有插件内容，打包只用白名单", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hifabu-plugin-version-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, "deploy", "hifabu");
  const plugin = join(root, "plugins", "hifabu");
  const tooling = join(root, "plugins", "hifabu-src");
  mkdirSync(release, { recursive: true });
  mkdirSync(tooling, { recursive: true });
  cpSync(pluginDir, plugin, { recursive: true });
  const unlisted = join(plugin, ".DS_Store");
  writeFileSync(unlisted, "unlisted content without a version bump");
  const versionHelper = join(tooling, "version.mjs");
  copyFileSync(versionCheck, versionHelper);
  const entry = join(release, "publish-plugin.mjs");
  copyFileSync(publisher, entry);
  const result = spawnSync(process.execPath, [entry, "--dry-run"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /插件版本记录与内容不一致/);
  assert.equal(result.stdout, "");

  // Even a recorded extra file is not part of the package allowlist.
  const contentLock = JSON.parse(execFileSync(process.execPath, [versionHelper, "--print-hash"], { encoding: "utf8" }));
  writeFileSync(join(plugin, "version-lock.json"), JSON.stringify(contentLock));
  const output = join(root, "output");
  execFileSync(process.execPath, [entry, "--dry-run", "--output-dir", output]);
  const packageList = execFileSync("unzip", ["-Z1", join(output, archive)], { encoding: "utf8" });
  assert.doesNotMatch(packageList, /\.DS_Store|version-lock/);
});

test("ACC-plugin-dist-05: 发布可重试，保留旧包和同名 zip，传输失败时不切换清单", (t) => {
  const { remote, run } = fixture(t);
  writeFileSync(join(remote, "hifabu-previous.zip"), "previous version");
  writeFileSync(join(remote, "marketplace.json"), "previous marketplace");
  writeFileSync(join(remote, "install.txt"), "previous instructions");

  const failed = run([], { PUBLISH_FAIL_SCP: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /scp/);
  assert.deepEqual(readdirSync(remote).sort(), ["hifabu-previous.zip", "install.txt", "marketplace.json"]);
  assert.equal(readFileSync(join(remote, "marketplace.json"), "utf8"), "previous marketplace");
  assert.equal(readFileSync(join(remote, "install.txt"), "utf8"), "previous instructions");

  const first = run([]);
  assert.equal(first.status, 0, first.stderr);
  const original = readFileSync(join(remote, archive));
  assert.equal(JSON.parse(readFileSync(join(remote, "marketplace.json"), "utf8")).plugins[0].source.sha256,
    createHash("sha256").update(original).digest("hex"));
  const retry = run([]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(readFileSync(join(remote, archive)), original);

  writeFileSync(join(remote, archive), "existing same-version bytes");
  writeFileSync(join(remote, "marketplace.json"), "current marketplace");
  const conflict = run([]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /已有 zip 内容不同/);
  assert.equal(readFileSync(join(remote, archive), "utf8"), "existing same-version bytes");
  assert.equal(readFileSync(join(remote, "marketplace.json"), "utf8"), "current marketplace");
  assert.equal(readFileSync(join(remote, "hifabu-previous.zip"), "utf8"), "previous version");
  assert.deepEqual(readdirSync(remote).sort(), [...files, "hifabu-previous.zip"].sort());
});
