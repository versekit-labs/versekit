import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repository, "deploy/hifabu/publish-release.mjs");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(readFileSync(file));
const version = "0.3.0";
const tag = "app-v" + version;
const nodeFile = "node-v26.13.1-darwin-arm64.tar.gz";
const biliupFile = "biliupR-v0.2.4-aarch64-macos.tar.xz";
const archiveFile = `hifabu-app-${version}.tar.gz`;

function put(path, data, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, { mode });
}

function fixture(t, { full = false, tagged = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hifabu-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const primary = join(root, "primary");
  const second = join(root, "second");
  const publishDir = join(root, "published");
  const template = join(root, "template.sh");
  const changelog = join(root, "notes.md");
  const fakeBin = join(root, "fake-bin");
  const calls = join(root, "curl-calls");
  const transport = join(root, "transport-calls");
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Release test", GIT_AUTHOR_EMAIL: "release@example.test",
    GIT_COMMITTER_NAME: "Release test", GIT_COMMITTER_EMAIL: "release@example.test",
    GIT_AUTHOR_DATE: "2026-12-01T09:00:00Z", GIT_COMMITTER_DATE: "2026-12-01T09:00:00Z",
  };
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env, encoding: "utf8" });
  git("init", "-q", "--template=", "-b", "main");
  if (full) {
    const paths = [
      "packages/*/src/**", "packages/*/package.json", "packages/web/public/**", "bin/**",
      "LICENSE", "THIRD_PARTY_NOTICES.md", ".gitattributes", "scripts/demo-seed.mjs",
    ];
    const tracked = execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: repository, encoding: "utf8" });
    for (const path of tracked.split("\0").filter(Boolean)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      copyFileSync(join(repository, path), join(repo, path));
    }
  } else {
    put(join(repo, "packages/cli/src/vk.mjs"), "console.log('test');\n", 0o755);
  }
  const packageJson = full ? json(join(repository, "package.json")) : { type: "module" };
  put(join(repo, "package.json"), JSON.stringify({ ...packageJson, version }, null, 2) + "\n");
  for (const name of ["docs/private.md", ".claude/private.md", "packages/core/test/private.mjs", "install.sh", "site/private.html"]) {
    put(join(repo, name), "outside runtime package\n");
  }
  git("add", ".");
  git("commit", "-qm", "test release");
  if (tagged) git("tag", "-am", "local test only", tag);

  const nodeChecksums = [];
  const larkChecksums = [];
  const biliupAssets = [];
  for (const [platform, biliup, lark] of [
    ["darwin-arm64", "aarch64-macos", "darwin-arm64"],
    ["darwin-x64", "x86_64-macos", "darwin-amd64"],
    ["linux-arm64", "aarch64-linux", "linux-arm64"],
    ["linux-x64", "x86_64-linux", "linux-amd64"],
  ]) {
    const node = `node-v26.13.1-${platform}.tar.gz`;
    const larkName = `lark-cli-1.0.97-${lark}.tar.gz`;
    const biliupName = `biliupR-v0.2.4-${biliup}.tar.xz`;
    for (const name of [node, larkName, biliupName]) put(join(primary, name), `test data ${name}\n`);
    put(join(second, biliupName), readFileSync(join(primary, biliupName)));
    nodeChecksums.push(`${sha(join(primary, node))}  ${node}`);
    larkChecksums.push(`${sha(join(primary, larkName))} *${larkName}`);
    biliupAssets.push({
      name: biliupName, digest: "sha256:" + sha(join(primary, biliupName)),
      browser_download_url: "https://github.com/biliup/biliup-rs/releases/download/v0.2.4/" + biliupName,
    });
  }
  put(join(primary, "SHASUMS256.txt"), nodeChecksums.join("\n") + "\n");
  put(join(primary, "checksums.txt"), larkChecksums.join("\n") + "\n");
  put(join(primary, "biliup-release.json"), JSON.stringify({ tag_name: "v0.2.4", assets: biliupAssets }));
  put(join(primary, "biliup-rs-v0.2.4-LICENSE.txt"), "MIT License\nCopyright (c) 2022 ForgQi\n");
  put(template, "#!/usr/bin/env bash\nHIFABU_RELEASE_MANIFEST=@HIFABU_RELEASE_MANIFEST@\nprintf '%s\\n' \"$HIFABU_RELEASE_MANIFEST\"\n");
  put(changelog, "# Test release\n\nQuoted 'notes', `$HOME`, and $() are literal.\n");

  put(join(fakeBin, "curl"), `#!${process.execPath}
const { appendFileSync, copyFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const args = process.argv.slice(2);
const url = args.at(-1);
appendFileSync(process.env.RELEASE_CURL_CALLS, url + "\\n");
if (process.env.RELEASE_CURL_FAIL && url.includes(process.env.RELEASE_CURL_FAIL)) process.exit(22);
const name = url.includes("api.github.com") ? "biliup-release.json" :
  url.endsWith("/LICENSE") ? "biliup-rs-v0.2.4-LICENSE.txt" : basename(url);
copyFileSync(join(process.env.RELEASE_CURL_PRIMARY, name), args[args.indexOf("--output") + 1]);
`, 0o755);
  put(join(fakeBin, "ssh"), `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const [dash, host, command] = process.argv.slice(2);
if (dash !== "--" || host !== "fake-seoul") process.exit(2);
const root = "/var/www/hifabu/download";
const destination = process.env.RELEASE_FAKE_DESTINATION;
appendFileSync(process.env.RELEASE_TRANSPORT_CALLS, "ssh\\n");
const result = spawnSync("/bin/sh", ["-c", command.replaceAll(root, destination)], {
  input: readFileSync(0), encoding: "utf8",
});
process.stdout.write(result.stdout.replaceAll(destination, root));
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`, 0o755);
  put(join(fakeBin, "scp"), `#!${process.execPath}
const { appendFileSync, cpSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const [recursive, dash, ...args] = process.argv.slice(2);
const prefix = "fake-seoul:/var/www/hifabu/download/";
const target = args.pop();
if (recursive !== "-r" || dash !== "--" || !target.startsWith(prefix)) process.exit(2);
const destination = join(process.env.RELEASE_FAKE_DESTINATION, target.slice(prefix.length));
appendFileSync(process.env.RELEASE_TRANSPORT_CALLS, "scp\\n");
for (const dir of args) cpSync(dir, join(destination, basename(dir)), { recursive: true });
if (process.env.RELEASE_CORRUPT_UPLOAD) writeFileSync(join(destination, "0.3.0/CHANGELOG.md"), "corrupted transfer");
`, 0o755);

  const invoke = (args, extraEnv) => spawnSync(process.execPath, [script, ...args], {
    cwd: repo, encoding: "utf8",
    env: {
      ...env, PATH: `${fakeBin}:${env.PATH}`, RELEASE_CURL_CALLS: calls, RELEASE_CURL_PRIMARY: primary,
      RELEASE_TRANSPORT_CALLS: transport, RELEASE_FAKE_DESTINATION: publishDir,
      ...extraEnv,
    },
  });
  const inputs = ["--deps-dir", primary, "--biliup-second-dir", second, "--installer-template", template, "--changelog", changelog];
  return { root, repo, primary, second, publishDir, template, changelog, calls, transport, git, invoke, inputs };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function cli(cwd, args, home) {
  return execFileSync(process.execPath, args, {
    cwd, encoding: "utf8", env: { ...process.env, HIFABU_HOME: home },
  });
}

test("ACC-release-01 同一临时 tag 的离线预览可复现，解包后 CLI、适配器和演示数据可用", (t) => {
  const f = fixture(t, { full: true });
  const dry = (path) => success(f.invoke(["--dry-run", "--output-dir", path, ...f.inputs]));
  const first = join(f.root, "first");
  const second = join(f.root, "second-output");
  const plan = dry(first);
  f.git("tag", "-d", tag);
  f.git("tag", "-am", "local test only", tag);
  const secondPlan = dry(second);
  assert.equal(plan, secondPlan);
  assert.ok(!existsSync(f.calls), "dry-run must not call curl");

  const app = join(first, version, archiveFile);
  const firstSha = sha(app);
  const secondSha = sha(join(second, version, archiveFile));
  assert.equal(firstSha, secondSha);
  assert.ok(lstatSync(app).size < 5_000_000);
  t.diagnostic(`临时仓库 ${tag} 第一次 SHA-256 ${firstSha}`);
  t.diagnostic(`临时仓库 ${tag} 第二次 SHA-256 ${secondSha}`);
  t.diagnostic(`运行包 ${lstatSync(app).size} bytes\n${plan.trimEnd()}`);

  const names = execFileSync("tar", ["-tzf", app], { encoding: "utf8" }).trimEnd().split("\n");
  const expected = f.git("ls-files", "--", "bin/**", "packages/*/src/**", "packages/*/package.json", "packages/web/public/**",
    "package.json", "scripts/demo-seed.mjs", "LICENSE", "THIRD_PARTY_NOTICES.md").trimEnd().split("\n");
  assert.deepEqual(names.map((name) => name.slice(`hifabu-app-${version}/`.length)).sort(), expected.sort());
  const extract = join(f.root, "unpacked");
  mkdirSync(extract);
  execFileSync("tar", ["-xzf", app, "-C", extract, "--strip-components=1"]);
  const vk = "packages/cli/src/vk.mjs";
  const home = join(f.root, "home");
  assert.match(cli(extract, [vk, "--help"], home), /hifabu/);
  const discovery = (root) => {
    const module = pathToFileURL(join(root, "packages/core/src/adapters.mjs")).href;
    return JSON.parse(cli(root, ["--input-type=module", "-e",
      `import { loadAdapters } from ${JSON.stringify(module)}; const { adapters, errors } = await loadAdapters(); console.log(JSON.stringify({ platforms: adapters.map(x => x.platform).sort(), errors }));`,
    ], home));
  };
  const original = discovery(repository);
  assert.ok(original.platforms.length > 0);
  assert.deepEqual(original.errors, []);
  assert.deepEqual(discovery(extract), original);
  const demo = JSON.parse(cli(extract, [vk, "demo", "seed"], home));
  assert.ok(demo.works > 0 && demo.publishes > 0);

  const manifestPath = join(first, version, "manifest.json");
  const manifest = json(manifestPath);
  const schema = json(join(repository, "schemas/release-v1.json"));
  assert.deepEqual(Object.keys(manifest).sort(), [...schema.required].sort());
  assert.equal(manifest.schema, schema.properties.schema.const);
  assert.equal(manifest.commit, f.git("rev-parse", "HEAD").trim());
  assert.equal(manifest.releasedAt, "2026-12-01");
  assert.equal(manifest.app.sha256, firstSha);
  assert.equal(manifest.app.size, lstatSync(app).size);
  assert.equal(manifest.node.files["darwin-arm64"].sha256, sha(join(f.primary, nodeFile)));
  assert.equal(manifest.components.biliup.files["darwin-arm64"].checksumSource, "github-release-digest+dual-download");
  assert.equal(json(join(first, "latest.json")).sha256, sha(manifestPath));
  assert.match(readFileSync(join(first, version, "SHA256SUMS"), "utf8"), new RegExp(firstSha + "  " + archiveFile));
  const install = join(first, version, "install.sh");
  assert.match(plan, new RegExp(sha(install)));
  assert.deepEqual(JSON.parse(execFileSync("bash", [install], { encoding: "utf8" })), manifest);
});

test("ACC-release-01 拒绝无对应 tag、HEAD 已移动，以及未提交的文件", (t) => {
  const f = fixture(t, { tagged: false });
  const dry = () => f.invoke(["--dry-run", ...f.inputs]);
  assert.match(dry().stderr, /release_tag.*app-v0\.3\.0/);
  f.git("tag", tag);
  put(join(f.repo, "untracked.txt"), "not clean");
  assert.match(dry().stderr, /release_dirty/);
  f.git("add", "untracked.txt");
  assert.match(dry().stderr, /release_dirty/);
  f.git("commit", "-qm", "move HEAD beyond the tag");
  assert.match(dry().stderr, /release_tag.*HEAD/);
  assert.ok(!existsSync(f.calls));
});

test("ACC-release-02 发布脚本将完整锁定清单嵌入实际安装模板", (t) => {
  const f = fixture(t);
  const output = join(f.root, "release");
  const inputs = f.inputs.map((arg) => arg === f.template ? join(repository, "deploy/hifabu/install-template.sh") : arg);
  success(f.invoke(["--dry-run", "--output-dir", output, ...inputs]));
  const script = readFileSync(join(output, version, "install.sh"), "utf8");
  const inspect = script.replace(/\nmain "\$@"\n$/, "\nprintf '%s' \"$HIFABU_RELEASE_MANIFEST\"\n");
  assert.notEqual(inspect, script);
  const embedded = JSON.parse(execFileSync("bash", [], { input: inspect, encoding: "utf8" }));
  assert.deepEqual(embedded, json(join(output, version, "manifest.json")));
});

test("ACC-release-01 缺发版说明、缺安装模板或占位符不正确时退出", (t) => {
  const f = fixture(t);
  for (const flag of ["--changelog", "--installer-template"]) {
    const inputs = f.inputs.filter((_, i) => i !== f.inputs.indexOf(flag) && i !== f.inputs.indexOf(flag) + 1);
    assert.match(f.invoke(["--dry-run", ...inputs]).stderr, new RegExp(flag));
  }
  put(f.template, "#!/bin/bash\necho no-placeholder\n");
  assert.match(f.invoke(["--dry-run", ...f.inputs]).stderr, /release_installer.*@HIFABU_RELEASE_MANIFEST@/);
});

test("ACC-release-01 Node 与 lark-cli 官方校验、biliup 官方 digest 与双份下载都必须匹配", (t) => {
  const f = fixture(t);
  const output = join(f.root, "out");
  const dry = () => f.invoke(["--dry-run", "--output-dir", output, ...f.inputs]);
  for (const [dir, name, expected] of [
    [f.primary, nodeFile, /release_checksum.*node-v26/],
    [f.primary, "lark-cli-1.0.97-linux-arm64.tar.gz", /release_checksum.*lark-cli/],
    [f.primary, biliupFile, /release_checksum.*上游 SHA-256 不匹配.*biliupR/],
    [f.second, biliupFile, /release_checksum.*两个网络的下载内容不同/],
  ]) {
    const path = join(dir, name);
    const original = readFileSync(path);
    put(path, "corrupted");
    const result = dry();
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.ok(!existsSync(output));
    put(path, original);
  }
  const real = f.invoke(["--publish-dir", f.publishDir, ...f.inputs], { RELEASE_CURL_FAIL: "api.github.com" });
  assert.equal(real.status, 1);
  assert.match(real.stderr, /release_download.*api\.github\.com/);
  assert.deepEqual(readdirSync(f.publishDir), []);
});

test("ACC-release-01 候选先就位，验证后切换 latest，重复发布只接受相同内容", (t) => {
  const f = fixture(t);
  const stage = ["--publish-dir", f.publishDir, ...f.inputs];
  const latest = join(f.publishDir, "latest.json");
  const manifest = join(f.publishDir, version, "manifest.json");
  assert.match(f.invoke([...stage, "--activate"]).stderr, /release_activate/);
  success(f.invoke(stage));
  assert.ok(!existsSync(latest));
  assert.ok(existsSync(manifest));
  const original = readFileSync(manifest);
  success(f.invoke([...stage, "--activate"]));
  assert.equal(json(latest).sha256, sha(manifest));
  const initialPointer = readFileSync(latest);
  const initialInode = lstatSync(latest).ino;
  success(f.invoke([...stage, "--activate"]));
  assert.deepEqual(readFileSync(latest), initialPointer);
  assert.notEqual(lstatSync(latest).ino, initialInode, "latest must be replaced by rename");
  assert.match(readFileSync(join(f.publishDir, "versions/index.html"), "utf8"), /0\.3\.0\/install\.sh/);
  assert.deepEqual(readFileSync(manifest), original);

  put(f.changelog, "changed after publication");
  const conflict = f.invoke([...stage, "--activate"]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /release_conflict.*CHANGELOG.md/);
  assert.deepEqual(readFileSync(latest), initialPointer);
  assert.deepEqual(readFileSync(manifest), original);
  const sameVersion = "# Test release\n\nQuoted 'notes', `$HOME`, and $() are literal.\n";
  put(f.changelog, sameVersion);
  put(join(f.publishDir, "deps", nodeFile), "changed mirrored content");
  const depConflict = f.invoke([...stage, "--activate"]);
  assert.equal(depConflict.status, 1);
  assert.match(depConflict.stderr, /release_conflict.*deps/);
  assert.deepEqual(readFileSync(latest), initialPointer);
  assert.ok(!readdirSync(f.publishDir).some((name) => name.startsWith(".")));
});

test("ACC-release-01 撤回保留版本与引用文件，清理只删除确认过的旧无引用依赖", (t) => {
  const f = fixture(t);
  const base = ["--publish-dir", f.publishDir];
  success(f.invoke([...base, ...f.inputs]));
  success(f.invoke([...base, "--activate", ...f.inputs]));
  success(f.invoke([...base, "--withdraw", version, "--reason", "校验 <failed>"]));
  assert.ok(!existsSync(join(f.publishDir, "latest.json")));
  assert.ok(existsSync(join(f.publishDir, version, archiveFile)));
  assert.match(readFileSync(join(f.publishDir, "versions/index.html"), "utf8"), /已撤回 · 校验 &lt;failed&gt;/);
  assert.match(f.invoke([...base, "--activate", ...f.inputs]).stderr, /release_withdrawn/);

  const deps = join(f.publishDir, "deps");
  const old = new Date(Date.now() - 100 * 24 * 60 * 60_000);
  const stale = join(deps, "unreferenced.tar.gz");
  put(stale, "older package");
  utimesSync(stale, old, old);
  utimesSync(join(deps, nodeFile), old, old);
  const preview = success(f.invoke([...base, "--prune"]));
  assert.match(preview, /deps\/unreferenced.tar.gz/);
  assert.ok(existsSync(stale));
  const confirm = preview.match(/--confirm-prune ([0-9a-f]{64})/)[1];
  assert.match(f.invoke([...base, "--prune", "--confirm-prune", "obsolete"]).stderr, /release_prune/);
  assert.ok(existsSync(stale));
  success(f.invoke([...base, "--prune", "--confirm-prune", confirm]));
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(join(deps, nodeFile)));
});

test("ACC-release-01 SSH/SCP 暂存后在目标机核对 SHA-256，激活不再传输文件", (t) => {
  const f = fixture(t);
  const args = ["--host", "fake-seoul", ...f.inputs];
  success(f.invoke(["--dry-run", ...args]));
  assert.ok(!existsSync(f.calls) && !existsSync(f.transport));

  const broken = f.invoke(args, { RELEASE_CORRUPT_UPLOAD: "1" });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /远端 SHA-256 不匹配：0\.3\.0\/CHANGELOG.md/);
  assert.deepEqual(readdirSync(f.publishDir), []);

  success(f.invoke(args));
  const manifest = join(f.publishDir, version, "manifest.json");
  const latest = join(f.publishDir, "latest.json");
  assert.ok(existsSync(manifest) && !existsSync(latest));
  const mirrored = join(f.publishDir, "deps", nodeFile);
  const expected = readFileSync(mirrored);
  put(mirrored, "wrong bytes");
  assert.match(f.invoke([...args, "--activate"]).stderr, /远端 SHA-256 不匹配：deps\/node-/);
  assert.ok(!existsSync(latest));
  put(mirrored, expected);

  const transport = readFileSync(f.transport, "utf8");
  success(f.invoke([...args, "--activate"]));
  assert.equal(readFileSync(f.transport, "utf8"), transport + "ssh\n");
  assert.equal(json(latest).sha256, sha(manifest));
  assert.ok(!readdirSync(f.publishDir).some((name) => name.startsWith(".")));
});
