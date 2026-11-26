import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderInstallTxt,
  renderPluginArtifacts,
  renderPluginHtml,
} from "../../../site/plugin/render.mjs";

const publisher = fileURLToPath(new URL("../../../deploy/hifabu/publish-plugin.mjs", import.meta.url));
const pluginDir = fileURLToPath(new URL("../../../plugins/hifabu/", import.meta.url));
const sitePluginDir = fileURLToPath(new URL("../../../site/plugin/", import.meta.url));
const manifestPath = ".claude-plugin/plugin.json";
const manifest = JSON.parse(readFileSync(join(pluginDir, manifestPath), "utf8"));
const versionCheck = fileURLToPath(new URL("../../../plugins/hifabu-src/version.mjs", import.meta.url));
const archive = `hifabu-${manifest.version}.zip`;
const publicUrl = "https://hifabu.com/plugin/";
const siteDir = "/var/www/hifabu/plugin";
const files = [archive, "index.html", "install.txt", "marketplace.json"].sort();

function unescapeHtml(text) {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function stripTags(html) {
  return unescapeHtml(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

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
  const run = (args, extraEnv, entry = publisher) => spawnSync(process.execPath, [entry, "--host", "fixture", ...args], {
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

test("ACC-plugin-dist-05: dry-run 打包插件并打印四个 SHA-256，不运行 SSH 或 SCP", (t) => {
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
    `  claude plugin install hifabu --marketplace ${publicUrl}marketplace.json`,
  ));
  assert.ok(install.includes("/reload-plugins"));
  assert.ok(install.split("\n").includes(
    "  claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu",
  ));
  assert.ok(install.includes(`${digests[archive]}  ${archive}`));
  const html = readFileSync(join(output, "index.html"), "utf8");
  assert.ok(html.includes(digests[archive]));
  assert.ok(!html.includes("{{"));
  assert.ok(!install.includes("{{"));

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
  const sitePlugin = join(root, "site", "plugin");
  mkdirSync(release, { recursive: true });
  mkdirSync(tooling, { recursive: true });
  cpSync(pluginDir, plugin, { recursive: true });
  cpSync(sitePluginDir, sitePlugin, { recursive: true });
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
  writeFileSync(join(remote, "index.html"), "previous page");
  writeFileSync(join(remote, "marketplace.json"), "previous marketplace");
  writeFileSync(join(remote, "install.txt"), "previous instructions");

  const failed = run([], { PUBLISH_FAIL_SCP: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /scp/);
  assert.deepEqual(readdirSync(remote).sort(), ["hifabu-previous.zip", "index.html", "install.txt", "marketplace.json"]);
  assert.equal(readFileSync(join(remote, "index.html"), "utf8"), "previous page");
  assert.equal(readFileSync(join(remote, "marketplace.json"), "utf8"), "previous marketplace");
  assert.equal(readFileSync(join(remote, "install.txt"), "utf8"), "previous instructions");

  const first = run([]);
  assert.equal(first.status, 0, first.stderr);
  const original = readFileSync(join(remote, archive));
  const expectedSha = createHash("sha256").update(original).digest("hex");
  assert.equal(JSON.parse(readFileSync(join(remote, "marketplace.json"), "utf8")).plugins[0].source.sha256,
    expectedSha);
  assert.ok(readFileSync(join(remote, "index.html"), "utf8").includes(expectedSha));
  assert.ok(readFileSync(join(remote, "install.txt"), "utf8").includes(expectedSha));
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

test("ACC-plugin-v2-11: 插件页结构顺序、与 install.txt 同源逐句一致、无禁词", (t) => {
  // 1) 仓库里的模板与同源渲染器完全同步
  const checkedInHtml = readFileSync(join(sitePluginDir, "index.html"), "utf8");
  const checkedInTxt = readFileSync(join(sitePluginDir, "install.txt"), "utf8");
  assert.equal(checkedInHtml, renderPluginHtml({}, { allowPlaceholders: true }));
  assert.equal(checkedInTxt, renderInstallTxt({}, { allowPlaceholders: true }));

  // 2) 通过发布脚本 --dry-run 生成完整成品
  const { root, run } = fixture(t);
  const output = join(root, "output");
  const res = run(["--dry-run", "--output-dir", output], { PUBLISH_NO_UPLOAD: "1" });
  assert.equal(res.status, 0, res.stderr);
  const html = readFileSync(join(output, "index.html"), "utf8");
  const txt = readFileSync(join(output, "install.txt"), "utf8");
  const marketplace = JSON.parse(readFileSync(join(output, "marketplace.json"), "utf8"));
  const zipSha = marketplace.plugins[0].source.sha256;

  // 3) 页面包含 PAGE.md §2 规定的全部 10 块并按顺序排列
  assert.match(html, /<link rel="alternate" type="text\/plain" href="install\.txt" title="Instructions for AI assistants">/);
  const sectionTags = [...html.matchAll(/<(?:header|section\b[^>]*|footer)>/g)].map((m) => m[0]);
  assert.deepEqual(sectionTags, [
    "<header>",
    '<section class="hero">',
    '<section id="install">',
    '<section id="for-ai-assistants">',
    '<section id="what-it-installs">',
    '<section id="before-you-start">',
    '<section id="first-use">',
    '<section id="update">',
    '<section id="uninstall">',
    '<section id="questions">',
    "<footer>",
  ]);

  // 4) 「在 Claude Code 里说一句」排第一，终端一行排第二
  const installBlock = /<section id="install">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
  const stepHeadings = [...installBlock.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(stepHeadings, ["Ask Claude Code", "Or paste one line in a terminal"]);

  // 5) 占位符全部填完、sha256 与 marketplace.json 一致
  assert.ok(!html.includes("{{"), "index.html 不得残留 {{");
  assert.ok(!txt.includes("{{"), "install.txt 不得残留 {{");
  assert.ok(html.includes(`<code class="hash" data-release="zip_sha256">${zipSha}</code>`));
  assert.ok(html.includes(`data-release="version">${manifest.version}<`));
  assert.ok(html.includes(`https://github.com/versekit-labs/versekit/tree/hifabu--v${manifest.version}/plugins/hifabu`));
  assert.ok(html.includes(`https://github.com/versekit-labs/versekit/blob/hifabu--v${manifest.version}/plugins/hifabu/CHANGELOG.md`));
  assert.ok(txt.includes(`    ${zipSha}  ${archive}`));

  // 6) install.txt 纯文本、英文在前中文在后、每行不超过 100 字符
  assert.ok(txt.indexOf("What it does") < txt.indexOf("会做什么"));
  for (const line of txt.split("\n")) {
    assert.ok(line.length <= 100, `install.txt 行超 100 字符 (${line.length}): ${line}`);
  }

  // 7) 页面 For AI assistants 一段与 install.txt 英文「What it does」「Expected flow」逐句相同
  const htmlWhatRaw = /<p data-ai-section="what-it-does">([\s\S]*?)<\/p>/.exec(html)?.[1];
  const htmlFlowRaw = /<p data-ai-section="expected-flow">([\s\S]*?)<\/p>/.exec(html)?.[1];
  assert.ok(htmlWhatRaw && htmlFlowRaw);
  const htmlWhatText = stripTags(htmlWhatRaw).replace(/^What it does:\s*/, "");
  const htmlFlowText = stripTags(htmlFlowRaw).replace(/^Expected flow:\s*/, "");

  const txtWhatSection = /What it does\n([\s\S]*?)\n\nExpected flow/.exec(txt)?.[1];
  const txtFlowSection = /Expected flow\n([\s\S]*?)\n\nUpdate/.exec(txt)?.[1];
  assert.ok(txtWhatSection && txtFlowSection);

  const txtWhatItems = txtWhatSection
    .split(/\n(?=  - )/)
    .map((block) => block.replace(/^  - /, "").replace(/\n    /g, " ").replace(/\s+/g, " ").trim());
  const txtWhatJoined = txtWhatItems
    .map((item) => (item.endsWith(".") ? item : `${item}.`))
    .join(" ");
  const txtFlowJoined = txtFlowSection.replace(/\s+/g, " ").trim();

  assert.equal(htmlWhatText, txtWhatJoined);
  assert.equal(htmlFlowText, txtFlowJoined);

  // 8) 不含 VerseKit（除仓库地址外）、不含 curl | bash、不对 AI 下祈使命令
  const scrubRepo = (text) => text.replaceAll("https://github.com/versekit-labs/versekit", "");
  for (const [label, content] of [["index.html", html], ["install.txt", txt]]) {
    assert.doesNotMatch(scrubRepo(content), /versekit/i, `${label} 不得出现 VerseKit`);
    assert.doesNotMatch(content, /\bcurl\b/i, `${label} 不得出现 curl`);
    assert.doesNotMatch(content, /please run|请执行/i, `${label} 不得对 AI 使用祈使命令`);
  }
});

test("ACC-plugin-v2-11: 生成结果若留有 {{ 占位符，渲染器与发布脚本均拒绝发布", (t) => {
  const sample = {
    version: "0.2.2",
    released_at: "2026-11-26",
    zip_name: "hifabu-0.2.2.zip",
    zip_url: "https://hifabu.com/plugin/hifabu-0.2.2.zip",
    zip_sha256: "a".repeat(64),
    source_url: "https://github.com/versekit-labs/versekit/tree/hifabu--v0.2.2/plugins/hifabu",
    changelog_url: "https://github.com/versekit-labs/versekit/blob/hifabu--v0.2.2/plugins/hifabu/CHANGELOG.md",
  };
  const validTemplate = readFileSync(join(sitePluginDir, "index.html"), "utf8");

  assert.throws(
    () => renderPluginArtifacts(sample, { templateHtml: validTemplate.replace("</footer>", "{{unknown}}</footer>") }),
    /未知占位符|未替换占位符/,
  );
  assert.throws(
    () => renderPluginArtifacts(sample, { templateHtml: validTemplate.replace("</footer>", "{{unclosed</footer>") }),
    /未替换占位符/,
  );
  assert.throws(
    () => renderPluginArtifacts({ ...sample, version: "{{bad}}" }),
    /未替换占位符/,
  );

  // 端到端测试：模板残留未填占位时，publish-plugin.mjs 退出非 0 且不调用 ssh/scp
  const { root, calls, remote, run } = fixture(t);
  const copyRoot = join(root, "repo");
  const release = join(copyRoot, "deploy", "hifabu");
  const plugin = join(copyRoot, "plugins", "hifabu");
  const tooling = join(copyRoot, "plugins", "hifabu-src");
  const sitePlugin = join(copyRoot, "site", "plugin");
  mkdirSync(release, { recursive: true });
  mkdirSync(tooling, { recursive: true });
  cpSync(pluginDir, plugin, { recursive: true });
  cpSync(sitePluginDir, sitePlugin, { recursive: true });
  copyFileSync(versionCheck, join(tooling, "version.mjs"));
  const entry = join(release, "publish-plugin.mjs");
  copyFileSync(publisher, entry);
  writeFileSync(join(sitePlugin, "index.html"), validTemplate.replace("</footer>", "{{leftover}}</footer>"));

  const blocked = run([], { PUBLISH_NO_UPLOAD: "1" }, entry);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /占位符/);
  assert.throws(() => readFileSync(calls), { code: "ENOENT" });
  assert.deepEqual(readdirSync(remote), []);
});
