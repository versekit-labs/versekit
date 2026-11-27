import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatBytes, renderDownloadPage, renderUnavailablePage } from "../../../site/download/render.mjs";
import { fakeRelease, NODE_VERSION } from "./install-fixtures.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PUBLISH_SCRIPT = join(REPO, "deploy/hifabu/publish-release.mjs");
const INSTALL_TEMPLATE = join(REPO, "deploy/hifabu/install-template.sh");
const OS = platform() === "darwin" ? "darwin" : "linux";
const CPU = arch() === "arm64" ? "arm64" : "x64";
const PLATFORM = `${OS}-${CPU}`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sampleManifest(overrides = {}) {
  const mkFile = (url, size, upstream) => ({ url, size, sha256: "a".repeat(64), upstream });
  return {
    schema: "hifabu.release/1",
    version: "0.3.0",
    commit: "1".repeat(40),
    releasedAt: "2026-12-01",
    app: { url: "https://hifabu.com/download/0.3.0/hifabu-app-0.3.0.tar.gz", size: 2_100_000, sha256: "b".repeat(64) },
    node: {
      version: "v26.13.1",
      files: {
        "darwin-arm64": mkFile("https://hifabu.com/download/deps/node-v26.13.1-darwin-arm64.tar.gz", 45_200_000, "https://nodejs.org/dist/v26.13.1/node-v26.13.1-darwin-arm64.tar.gz"),
        "darwin-x64": mkFile("https://hifabu.com/download/deps/node-v26.13.1-darwin-x64.tar.gz", 46_800_000, "https://nodejs.org/dist/v26.13.1/node-v26.13.1-darwin-x64.tar.gz"),
      },
    },
    components: {
      biliup: {
        version: "v0.2.4",
        files: {
          "darwin-arm64": mkFile("https://hifabu.com/download/deps/biliupR-v0.2.4-aarch64-macos.tar.xz", 5_200_000, "https://github.com/biliup/biliup-rs/releases/download/v0.2.4/biliupR-v0.2.4-aarch64-macos.tar.xz"),
        },
      },
      "lark-cli": {
        version: "1.0.97",
        files: {
          "darwin-arm64": mkFile("https://hifabu.com/download/deps/lark-cli-1.0.97-darwin-arm64.tar.gz", 10_400_000, "https://github.com/larksuite/cli/releases/download/v1.0.97/lark-cli-1.0.97-darwin-arm64.tar.gz"),
        },
      },
    },
    notes: "# Hifabu 0.3.0\n\n## 新增\n- 首个锁定版本发版，支持先校验再运行。\n- <script>alert(1)</script> 转义测试。",
    ...overrides,
  };
}

function unescapeHtml(text) {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

test("ACC-release-05: 下载页全部动态字段取自清单、包含 §3.1 全部 9 块、不含 VerseKit/vk", () => {
  const manifestA = sampleManifest();
  const shaA = "c".repeat(64);
  const htmlA = renderDownloadPage({ manifest: manifestA, installSha256: shaA });

  // 1) 版本号、发布日期、大小、sha256、更新说明全部来自清单
  assert.match(htmlA, /0\.3\.0/);
  assert.match(htmlA, /2026-12-01/);
  assert.match(htmlA, /v26\.13\.1/);
  assert.match(htmlA, /~45 MB/);
  assert.match(htmlA, /约 45 MB/);
  assert.match(htmlA, /~2\.1 MB/);
  assert.match(htmlA, /~5\.2 MB/);
  assert.match(htmlA, /~10 MB/);
  assert.match(htmlA, new RegExp(shaA));
  assert.match(htmlA, /href="0\.3\.0\/SHA256SUMS"/);
  assert.match(htmlA, /href="0\.3\.0\/manifest\.json"/);
  assert.match(htmlA, /app-v0\.3\.0/);
  assert.match(htmlA, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(htmlA, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(htmlA, /\{\{[A-Z0-9_]+\}\}/);

  // 换一份清单，版本号/大小/sha256 随之改变（证明没有手写）
  const manifestB = sampleManifest({
    version: "0.9.1",
    releasedAt: "2027-01-15",
    app: { url: "https://hifabu.com/download/0.9.1/hifabu-app-0.9.1.tar.gz", size: 3_400_000, sha256: "d".repeat(64) },
    notes: "# Hifabu 0.9.1\n\n- 更新测试说明。",
  });
  const shaB = "e".repeat(64);
  const htmlB = renderDownloadPage({ manifest: manifestB, installSha256: shaB });
  assert.doesNotMatch(htmlB, /0\.3\.0|2026-12-01|~2\.1 MB/);
  assert.match(htmlB, /0\.9\.1/);
  assert.match(htmlB, /2027-01-15/);
  assert.match(htmlB, /~3\.4 MB/);
  assert.match(htmlB, new RegExp(shaB));
  assert.match(htmlB, /https:\/\/hifabu\.com\/download\/0\.9\.1\/install\.sh/);

  // 2) 设计稿 §3.1 的 9 块都在，且第一块（hero 之后、安装之前）讲同网络
  const sectionIds = [...htmlA.matchAll(/<section\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(sectionIds.length, 9);
  assert.match(sectionIds[0], /class="hero"/);
  assert.match(sectionIds[1], /id="network"/);
  assert.match(sectionIds[2], /id="requirements"/);
  assert.match(sectionIds[3], /id="install"/);
  assert.match(sectionIds[4], /id="contents"/);
  assert.match(sectionIds[5], /id="background-service"/);
  assert.match(sectionIds[6], /id="release"/);
  assert.match(sectionIds[7], /id="uninstall"/);
  assert.match(sectionIds[8], /id="versions"/);
  assert.match(htmlA, /同一个网络/);
  assert.match(htmlA, /com\.hifabu\.daemon/);
  assert.match(htmlA, /<details class="verify">/);
  assert.doesNotMatch(htmlA, /<details class="verify" open/);
  assert.match(htmlA, /href="versions\/"/);
  assert.match(htmlA, /href="\.\.\/account"/);
  assert.match(htmlA, /旧名，之后会改/);

  // 3) 页面上不出现 VerseKit 和独立的 vk（路径里的 .versekit/versekit 除外）
  const text = visibleText(htmlA);
  assert.doesNotMatch(text, /VerseKit/);
  assert.doesNotMatch(text, /\bvk\b/i);
  const withoutLegacyPaths = text
    .replaceAll("~/.versekit/node", "")
    .replaceAll("~/.versekit/app", "")
    .replaceAll("~/.versekit/bin", "")
    .replaceAll("~/.versekit", "")
    .replaceAll("~/.config/versekit", "")
    .replaceAll("~/.local/state/versekit/", "")
    .replaceAll("~/.local/state/versekit", "");
  assert.doesNotMatch(withoutLegacyPaths, /versekit/i);

  // formatBytes 边界
  assert.deepEqual(formatBytes(512), { en: "512 B", zh: "512 B" });
  assert.deepEqual(formatBytes(12_300), { en: "~12 KB", zh: "约 12 KB" });
  assert.match(renderUnavailablePage(), /href="versions\/"/);
});

test("ACC-release-05: 官网页头导航与首页链接指向下载页，插件页不链回下载页", () => {
  const home = readFileSync(join(REPO, "site/index.html"), "utf8");
  const privacy = readFileSync(join(REPO, "site/privacy/index.html"), "utf8");
  const terms = readFileSync(join(REPO, "site/terms/index.html"), "utf8");
  const plugin = readFileSync(join(REPO, "site/plugin/index.html"), "utf8");
  const downloadTemplate = readFileSync(join(REPO, "site/download/template.html"), "utf8");

  assert.match(home, /<nav[^>]*>[\s\S]*?<a href="download\/">Download<\/a>[\s\S]*?<\/nav>/);
  assert.match(home, /<footer>[\s\S]*?<a href="download\/">Download<\/a>[\s\S]*?<\/footer>/);
  assert.ok((home.match(/href="download\/"/g) ?? []).length >= 3, "首页正文、页头、页脚均应链到下载页");
  assert.match(privacy, /<nav[^>]*>[\s\S]*?<a href="\.\.\/download\/">Download<\/a>[\s\S]*?<\/nav>/);
  assert.match(privacy, /<footer>[\s\S]*?<a href="\.\.\/download\/">Download<\/a>[\s\S]*?<\/footer>/);
  assert.match(terms, /<nav[^>]*>[\s\S]*?<a href="\.\.\/download\/">Download<\/a>[\s\S]*?<\/nav>/);
  assert.match(terms, /<footer>[\s\S]*?<a href="\.\.\/download\/">Download<\/a>[\s\S]*?<\/footer>/);
  assert.match(downloadTemplate, /<nav[^>]*>[\s\S]*?<a href="\.\/" aria-current="page">Download<\/a>[\s\S]*?<\/nav>/);
  assert.doesNotMatch(plugin, /download\//, "插件页不链回下载页（DESIGN.md §3.1）");
});

test("ACC-cloud-10: 官网和两种下载页的最后一个导航项都链到 /login", () => {
  const pages = new Map(
    ["index.html", "privacy/index.html", "terms/index.html", "plugin/index.html"]
      .map((path) => [path, readFileSync(join(REPO, "site", path), "utf8")]),
  );
  pages.set("download (release)", renderDownloadPage({ manifest: sampleManifest(), installSha256: "c".repeat(64) }));
  pages.set("download (unavailable)", renderUnavailablePage());

  for (const [name, html] of pages) {
    const nav = html.match(/<header>[\s\S]*?<nav\b[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(nav, name);
    assert.match(nav, /<a href="\/login">Sign in<\/a>\s*$/, name);
  }
});

test("ACC-release-05: publish-release.mjs 从清单生成下载页，并在激活和撤回时原子更新", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hifabu-pub-dl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const primary = join(root, "primary");
  const second = join(root, "second");
  const publishDir = join(root, "published");
  const changelog = join(root, "notes.md");
  const fakeBin = join(root, "fake-bin");
  const out = join(root, "preview");
  mkdirSync(repo);
  const put = (path, data, mode) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, { mode });
  };
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Release test", GIT_AUTHOR_EMAIL: "release@example.test",
    GIT_COMMITTER_NAME: "Release test", GIT_COMMITTER_EMAIL: "release@example.test",
    GIT_AUTHOR_DATE: "2026-12-01T09:00:00Z", GIT_COMMITTER_DATE: "2026-12-01T09:00:00Z",
  };
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env, encoding: "utf8" });
  git("init", "-q", "--template=", "-b", "main");
  put(join(repo, "packages/cli/src/vk.mjs"), "console.log('ok');\n", 0o755);
  put(join(repo, "package.json"), JSON.stringify({ type: "module", version: "0.3.0" }, null, 2) + "\n");
  git("add", ".");
  git("commit", "-qm", "init");
  git("tag", "-am", "v0.3.0", "app-v0.3.0");

  const nodeSums = [];
  const larkSums = [];
  const biliupAssets = [];
  for (const [p, biliup, lark] of [
    ["darwin-arm64", "aarch64-macos", "darwin-arm64"],
    ["darwin-x64", "x86_64-macos", "darwin-amd64"],
    ["linux-arm64", "aarch64-linux", "linux-arm64"],
    ["linux-x64", "x86_64-linux", "linux-amd64"],
  ]) {
    const node = `node-v26.13.1-${p}.tar.gz`;
    const larkName = `lark-cli-1.0.97-${lark}.tar.gz`;
    const biliupName = `biliupR-v0.2.4-${biliup}.tar.xz`;
    for (const name of [node, larkName, biliupName]) put(join(primary, name), `payload-${name}\n`);
    put(join(second, biliupName), readFileSync(join(primary, biliupName)));
    nodeSums.push(`${sha(readFileSync(join(primary, node)))}  ${node}`);
    larkSums.push(`${sha(readFileSync(join(primary, larkName)))} *${larkName}`);
    biliupAssets.push({
      name: biliupName, digest: "sha256:" + sha(readFileSync(join(primary, biliupName))),
      browser_download_url: "https://github.com/biliup/biliup-rs/releases/download/v0.2.4/" + biliupName,
    });
  }
  put(join(primary, "SHASUMS256.txt"), nodeSums.join("\n") + "\n");
  put(join(primary, "checksums.txt"), larkSums.join("\n") + "\n");
  put(join(primary, "biliup-release.json"), JSON.stringify({ tag_name: "v0.2.4", assets: biliupAssets }));
  put(join(primary, "biliup-rs-v0.2.4-LICENSE.txt"), "MIT License\nCopyright (c) 2022 ForgQi\n");
  put(changelog, "# Hifabu 0.3.0\n\n- 首个锁定发版\n");
  put(join(fakeBin, "curl"), `#!${process.execPath}
const { copyFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const args = process.argv.slice(2);
const url = args.at(-1);
const name = url.includes("api.github.com") ? "biliup-release.json" :
  url.endsWith("/LICENSE") ? "biliup-rs-v0.2.4-LICENSE.txt" : basename(url);
copyFileSync(join(process.env.RELEASE_CURL_PRIMARY, name), args[args.indexOf("--output") + 1]);
`, 0o755);

  const invoke = (args) => spawnSync(process.execPath, [PUBLISH_SCRIPT, ...args], {
    cwd: repo, encoding: "utf8",
    env: { ...env, PATH: `${fakeBin}:${env.PATH}`, RELEASE_CURL_PRIMARY: primary },
  });
  const inputs = [
    "--deps-dir", primary, "--biliup-second-dir", second,
    "--installer-template", INSTALL_TEMPLATE, "--changelog", changelog,
  ];

  const dry = invoke(["--dry-run", "--output-dir", out, ...inputs]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(existsSync(join(out, "index.html")));
  const installSha = sha(readFileSync(join(out, "0.3.0/install.sh")));
  const previewHtml = readFileSync(join(out, "index.html"), "utf8");
  assert.match(previewHtml, new RegExp(installSha));
  assert.match(previewHtml, /首个锁定发版/);

  // 候选就位时不提前改下载页，激活后才生成 index.html
  assert.equal(invoke(["--publish-dir", publishDir, ...inputs]).status, 0);
  assert.ok(!existsSync(join(publishDir, "index.html")));
  assert.equal(invoke(["--publish-dir", publishDir, "--activate", ...inputs]).status, 0);
  assert.equal(readFileSync(join(publishDir, "index.html"), "utf8"), previewHtml);

  // 撤回唯一版本后，下载页切换为已撤回提示（不再露出旧安装命令）
  assert.equal(invoke(["--publish-dir", publishDir, "--withdraw", "0.3.0", "--reason", "发现问题"]).status, 0);
  const withdrawnHtml = readFileSync(join(publishDir, "index.html"), "utf8");
  assert.doesNotMatch(withdrawnHtml, /0\.3\.0\/install\.sh/);
  assert.match(withdrawnHtml, /已撤回/);
});

test("ACC-release-05: 页面「先校验再运行」三行命令在本地假下载源上原样跑通", async (t) => {
  const work = mkdtempSync(join(platform() === "darwin" ? "/tmp" : tmpdir(), "hifabu-dl-e2e-"));
  const home = join(work, "home");
  const cwd = join(work, "run");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const port = await new Promise((resolve) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

  // 构造假 Node + 真实程序包
  const nodeDir = join(work, "node-pkg", "node");
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  writeFileSync(join(nodeDir, "bin", "node"), `#!/bin/sh\n[ "$1" = "-v" ] && { echo ${NODE_VERSION}; exit 0; }\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(nodeDir, "bin", "node"), 0o755);
  execFileSync("tar", ["-czf", join(work, "node.tar.gz"), "-C", join(work, "node-pkg"), "node"]);

  const appDir = join(work, "app-src", "hifabu-app-0.3.0");
  mkdirSync(appDir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  pkg.version = "0.3.0";
  writeFileSync(join(appDir, "package.json"), JSON.stringify(pkg, null, 2));
  const skip = (src) => !/(^|\/)(node_modules|test|\.git)(\/|$)/.test(src);
  cpSync(join(REPO, "packages"), join(appDir, "packages"), { recursive: true, filter: skip });
  cpSync(join(REPO, "scripts"), join(appDir, "scripts"), { recursive: true, filter: skip });
  execFileSync("tar", ["-czf", join(work, "app.tar.gz"), "-C", join(work, "app-src"), "hifabu-app-0.3.0"]);

  const compDir = join(work, "comp-pkg");
  mkdirSync(compDir, { recursive: true });
  writeFileSync(join(compDir, "biliup"), "#!/bin/sh\necho biliup\n", { mode: 0o755 });
  writeFileSync(join(compDir, "lark-cli"), "#!/bin/sh\necho lark-cli\n", { mode: 0o755 });
  execFileSync("tar", ["-czf", join(work, "biliup.tar.gz"), "-C", compDir, "biliup"]);
  execFileSync("tar", ["-czf", join(work, "lark-cli.tar.gz"), "-C", compDir, "lark-cli"]);

  let files;
  const server = createServer((req, res) => {
    const body = files?.[req.url];
    if (body === undefined) return res.writeHead(404).end("not found");
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/download`;

  const env = {
    ...process.env,
    HOME: home,
    HIFABU_HOME: home,
    HIFABU_PREFIX: join(home, ".versekit"),
    HIFABU_PORT: String(port),
    HIFABU_OFFLINE: "1",
    HIFABU_NO_OPEN: "1",
    HIFABU_INSTALL_TEST: "1",
    HIFABU_SERVICE_MANAGER: "detach",
    HIFABU_SERVICE_LABEL: `com.hifabu.test.dl.${process.pid}`,
    SHELL: "/bin/zsh",
  };
  t.after(async () => {
    const cli = join(home, ".versekit", "bin", "hifabu");
    if (existsSync(cli)) spawnSync(cli, ["service", "uninstall", "--service-only"], { env, stdio: "ignore" });
    await new Promise((r) => server.close(r));
    rmSync(work, { recursive: true, force: true });
  });

  const rel = fakeRelease(base, {
    version: "0.3.0",
    commit: "a".repeat(40),
    platform: PLATFORM,
    app: readFileSync(join(work, "app.tar.gz")),
    node: readFileSync(join(work, "node.tar.gz")),
    components: {
      biliup: readFileSync(join(work, "biliup.tar.gz")),
      "lark-cli": readFileSync(join(work, "lark-cli.tar.gz")),
    },
  });
  files = Object.fromEntries(Object.entries(rel).map(([k, v]) => [`/download${k}`, v]));

  const manifest = JSON.parse(rel["/0.3.0/manifest.json"]);
  const installSha = sha(Buffer.from(rel["/0.3.0/install.sh"]));
  const html = renderDownloadPage({ manifest, installSha256: installSha, publicUrl: `${base}/` });

  // 从生成的页面中直接提取「先校验再运行」三行命令并原样执行
  const match = /<pre id="verify-commands">([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(match, "页面必须包含 verify-commands 三行命令");
  const lines = unescapeHtml(match[1]).trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^curl -fsSLO http:\/\/127\.0\.0\.1:\d+\/download\/0\.3\.0\/install\.sh$/);
  assert.equal(lines[1], `echo "${installSha}  install.sh" | shasum -a 256 -c`);
  assert.equal(lines[2], "bash install.sh");

  const run = await new Promise((resolve) => {
    const child = spawn("bash", ["-euo", "pipefail", "-c", lines.join("\n")], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stdout, /install\.sh: OK/);
  assert.match(run.stdout, /装好了/);
  assert.ok(existsSync(join(home, ".versekit", "node", "bin", "node")));
  assert.ok(existsSync(join(home, ".versekit", "app", "package.json")));
  assert.ok(!existsSync(join(home, ".versekit", "bin", "biliup")));
  assert.ok(!existsSync(join(home, ".versekit", "bin", "lark-cli")));

  const today = await fetch(`http://127.0.0.1:${port}/today`);
  assert.equal(today.status, 200);
});
