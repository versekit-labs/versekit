#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const publicUrl = "https://hifabu.com/download/";
const publicDirectory = "/var/www/hifabu/download";
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const appSizeLimit = 5_000_000;
const platforms = {
  "darwin-arm64": ["aarch64-macos", "darwin-arm64"],
  "darwin-x64": ["x86_64-macos", "darwin-amd64"],
  "linux-arm64": ["aarch64-linux", "linux-arm64"],
  "linux-x64": ["x86_64-linux", "linux-amd64"],
};
const nodeVersion = "v26.13.1";
const biliupVersion = "v0.2.4";
const larkVersion = "1.0.97";
const nodeDist = `https://nodejs.org/dist/${nodeVersion}/`;
const biliupRelease = `https://github.com/biliup/biliup-rs/releases/download/${biliupVersion}/`;
const larkRelease = `https://github.com/larksuite/cli/releases/download/v${larkVersion}/`;
const dependencies = [
  {
    name: "node", version: nodeVersion, origin: nodeDist,
    checksums: ["SHASUMS256.txt", nodeDist + "SHASUMS256.txt"],
    filename: (platform) => `node-${nodeVersion}-${platform}.tar.gz`,
  },
  {
    name: "biliup", version: biliupVersion, origin: biliupRelease,
    checksums: ["biliup-release.json", `https://api.github.com/repos/biliup/biliup-rs/releases/tags/${biliupVersion}`],
    license: [`biliup-rs-${biliupVersion}-LICENSE.txt`, `https://raw.githubusercontent.com/biliup/biliup-rs/${biliupVersion}/LICENSE`],
    filename: (platform) => `biliupR-${biliupVersion}-${platforms[platform][0]}.tar.xz`,
  },
  {
    name: "lark-cli", version: larkVersion, origin: larkRelease,
    checksums: ["checksums.txt", larkRelease + "checksums.txt"],
    filename: (platform) => `lark-cli-${larkVersion}-${platforms[platform][1]}.tar.gz`,
  },
];

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const git = (args, options = {}) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
  maxBuffer: 64 * 1024 * 1024,
  ...options,
});

function taggedRelease() {
  if (git(["status", "--porcelain", "--untracked-files=all"]).length) {
    fail("release_dirty", "工作区有改动。请从干净的发版 tag 检出。");
  }
  const commit = git(["rev-parse", "HEAD"]).toString().trim();
  const pkg = JSON.parse(git(["show", `${commit}:package.json`]).toString());
  if (typeof pkg.version !== "string" || !semver.test(pkg.version) || !/^[0-9a-f]{40}$/.test(commit)) {
    fail("release_version", "package.json 必须使用语义化版本，仓库必须使用 40 位提交号。");
  }
  const tag = `refs/tags/app-v${pkg.version}`;
  let taggedCommit;
  try {
    taggedCommit = git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]).toString().trim();
  } catch {
    fail("release_tag", `请检出与 package.json 对应的 app-v${pkg.version} tag。`);
  }
  if (commit !== taggedCommit) fail("release_tag", `HEAD 未指向 app-v${pkg.version}。`);
  const tagDate = git(["for-each-ref", "--format=%(creatordate:iso-strict)", tag]).toString().trim();
  return { version: pkg.version, commit, releasedAt: new Date(tagDate).toISOString().slice(0, 10) };
}

const runtimeFiles = [
  /^packages\/[^/]+\/src\//,              // CLI、内核、适配器及其他工作区实现。
  /^packages\/web\/public\//,            // 本地服务对外提供的静态文件。
  /^bin\//,                               // 仓库命令入口。
  /^(?:packages\/[^/]+\/)?package\.json$/, // ESM 类型、工作区包元数据及适配器发现。
  /^scripts\/demo-seed\.mjs$/,            // hifabu demo seed 的按需入口。
  /^(?:LICENSE|THIRD_PARTY_NOTICES\.md)$/,  // 随程序分发的许可声明。
];

// USTAR headers preserve Git's executable bit and use fixed metadata on every host.
function tarHeader(path, mode, size) {
  const header = Buffer.alloc(512);
  let name = path;
  if (Buffer.byteLength(path) > 100) {
    const split = path.lastIndexOf("/");
    name = path.slice(split + 1);
    const prefix = path.slice(0, split);
    if (split < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
      fail("release_archive", `打包路径超过 USTAR 限制：${path}`);
    }
    header.write(prefix, 345);
  }
  header.write(name);
  header.write(mode.toString(8).padStart(7, "0"), 100);
  header.write("0000000\0".repeat(2), 108);
  header.write(size.toString(8).padStart(11, "0"), 124);
  header.write("00000000000", 136);
  header.fill(0x20, 148, 156);
  header.write("0", 156);
  header.write("ustar\x0000", 257);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}

function appArchive({ version, commit }) {
  const entries = git(["ls-tree", "-rz", "--full-tree", commit]).toString().split("\0").filter(Boolean);
  const files = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    if (!runtimeFiles.some((pattern) => pattern.test(path))) continue;
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755"].includes(mode) || path.includes("\ufffd") || /[\x00-\x1f\\]/.test(path)) {
      fail("release_archive", `发布包只接受常规文件：${path}`);
    }
    files.push({ mode, oid, path });
  }
  if (!files.some(({ path }) => path === "packages/cli/src/vk.mjs")) {
    fail("release_archive", "发布包缺少 CLI 入口。");
  }
  const blobs = git(["cat-file", "--batch"], { input: files.map(({ oid }) => oid).join("\n") + "\n" });
  const chunks = [];
  let offset = 0;
  for (const { mode, oid, path } of files) {
    const headerEnd = blobs.indexOf(10, offset);
    const [responseOid, type, length] = blobs.subarray(offset, headerEnd).toString().split(" ");
    const size = Number(length);
    offset = headerEnd + 1;
    if (responseOid !== oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0 ||
        blobs[offset + size] !== 10) {
      fail("release_archive", `无法读取 tag 中的文件：${path}`);
    }
    chunks.push(tarHeader(`hifabu-app-${version}/${path}`, mode === "100755" ? 0o755 : 0o644, size));
    chunks.push(blobs.subarray(offset, offset + size), Buffer.alloc((512 - size % 512) % 512));
    offset += size + 1;
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
  if (archive.length >= appSizeLimit) fail("release_archive", `发布包超过体积限制：${archive.length} 字节。`);
  return archive;
}

function localFile(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
    fail("release_input", `缺少本地文件或不是常规文件：${path}`);
  }
  return readFileSync(path);
}

function download(url, path) {
  try {
    execFileSync("curl", ["--disable", "--proto", "=https", "--proto-redir", "=https", "--fail", "--silent",
      "--show-error", "--location", "--retry", "2", "--connect-timeout", "15", "--max-time", "600", "--output", path, url]);
  } catch (error) {
    fail("release_download", `无法下载 ${url}（curl ${error.status ?? error.code}）。`);
  }
}

function fetchDependencies(root, secondBiliupOnly) {
  const selected = secondBiliupOnly ? dependencies.filter(({ name }) => name === "biliup") : dependencies;
  const stage = mkdtempSync(join(tmpdir(), "hifabu-upstream-"));
  try {
    if (lstatSync(root, { throwIfNoEntry: false })) fail("release_input", `下载目录已经存在：${root}`);
    for (const dep of selected) {
      for (const platform of Object.keys(platforms)) {
        const name = dep.filename(platform);
        download(dep.origin + name, join(stage, name));
      }
      if (!secondBiliupOnly) {
        for (const [name, url] of [dep.checksums, dep.license].filter(Boolean)) download(url, join(stage, name));
      }
    }
    mkdirSync(root);
    try {
      for (const name of readdirSync(stage)) copyFileSync(join(stage, name), join(root, name));
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function expectedChecksums(dep, bytes) {
  const checksums = new Map();
  function add(name, sha256) {
    if (checksums.has(name)) fail("release_checksum", `上游校验清单包含重复条目：${name}`);
    checksums.set(name, sha256.toLowerCase());
  }
  if (dep.name === "biliup") {
    const release = JSON.parse(bytes.toString());
    if (release.tag_name !== dep.version || !Array.isArray(release.assets)) {
      fail("release_checksum", "biliup 的 GitHub 资产清单与固定版本不符。");
    }
    for (const asset of release.assets) {
      if (/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest) && asset.browser_download_url === dep.origin + asset.name) {
        add(asset.name, asset.digest.slice(7));
      }
    }
  } else {
    for (const line of bytes.toString().split(/\r?\n/)) {
      const match = /^([a-fA-F0-9]{64})[ \t]+\*?(\S+)[ \t]*$/.exec(line);
      if (match) add(match[2], match[1]);
    }
  }
  return checksums;
}

function stageDependencies(root, input, secondBiliup, online) {
  const manifests = {};
  for (const dep of dependencies) {
    const file = (name) => join(root, "deps", name);
    const upstreamInput = ([name, url]) => {
      if (!online) return localFile(join(input, name));
      const path = join(root, name);
      download(url, path);
      return localFile(path);
    };
    const checksums = expectedChecksums(dep, upstreamInput(dep.checksums));
    const manifest = { version: dep.version, files: {} };
    for (const platform of Object.keys(platforms)) {
      const name = dep.filename(platform);
      writeFileSync(file(name), localFile(join(input, name)));
      const mirrored = localFile(file(name));
      const sha256 = digest(mirrored);
      if (mirrored.length === 0 || sha256 !== checksums.get(name)) {
        fail("release_checksum", `上游 SHA-256 不匹配：${name}（预期 ${checksums.get(name) ?? "缺失"}，实算 ${sha256}）。`);
      }
      if (dep.name === "biliup" && digest(localFile(join(secondBiliup, name))) !== sha256) {
        fail("release_checksum", `biliup 两个网络的下载内容不同：${name}`);
      }
      const record = { url: publicUrl + "deps/" + name, sha256, size: mirrored.length, upstream: dep.origin + name };
      if (dep.name === "biliup") record.checksumSource = "github-release-digest+dual-download";
      manifest.files[platform] = record;
    }
    if (dep.license) {
      const [name] = dep.license;
      const license = upstreamInput(dep.license);
      if (!license.toString().includes("MIT License") || !license.toString().includes("Copyright (c) 2022 ForgQi")) {
        fail("release_license", `缺少锁定版本的 MIT 声明：${name}`);
      }
      writeFileSync(file(name), license);
      manifest.licenseUrl = publicUrl + "deps/" + name;
    }
    manifests[dep.name] = manifest;
  }
  return manifests;
}

function renderInstaller(path, manifest) {
  const template = localFile(path).toString();
  const marker = "@HIFABU_RELEASE_MANIFEST@";
  const [before, after, extra] = template.split(marker);
  if (after === undefined || extra !== undefined || !template.startsWith("#!")) {
    fail("release_installer", `安装模板必须以 shebang 开头，只含一个 ${marker}。`);
  }
  const literal = "'" + json(manifest).trimEnd().replaceAll("'", "'\\''") + "'";
  const script = before + literal + after;
  try {
    execFileSync("bash", ["-n"], { input: script });
  } catch {
    fail("release_installer", "嵌入清单后，安装模板未通过 bash -n。");
  }
  return script;
}

function build(root, release, options, online) {
  const { version } = release;
  const directory = join(root, version);
  const name = `hifabu-app-${version}.tar.gz`;
  const archive = appArchive(release);
  const notes = localFile(options.changelog).toString().trimEnd();
  if (!notes.trim()) fail("release_changelog", "请提供非空的本版 CHANGELOG。");
  mkdirSync(directory, { mode: 0o755 });
  mkdirSync(join(root, "deps"), { mode: 0o755 });
  const { node, ...components } = stageDependencies(root, options["deps-dir"], options["biliup-second-dir"], online);
  const manifest = {
    schema: "hifabu.release/1", ...release,
    app: { url: publicUrl + version + "/" + name, sha256: digest(archive), size: archive.length },
    node, components, notes,
  };
  writeFileSync(join(directory, name), archive);
  writeFileSync(join(directory, "CHANGELOG.md"), notes + "\n");
  writeFileSync(join(directory, "manifest.json"), json(manifest));
  writeFileSync(join(directory, "install.sh"), renderInstaller(options["installer-template"], manifest));
  const sums = readdirSync(directory).sort().map((file) => `${digest(localFile(join(directory, file)))}  ${file}`);
  writeFileSync(join(directory, "SHA256SUMS"), sums.join("\n") + "\n");
  return manifest;
}

function readJsonIfPresent(path, fallback) {
  if (!lstatSync(path, { throwIfNoEntry: false })) return fallback;
  return JSON.parse(localFile(path));
}

function sortReleases(releases) {
  const collator = new Intl.Collator("en", { numeric: true });
  return releases.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt) || collator.compare(b.version, a.version));
}

function releasesIn(destination) {
  const versions = readdirSync(destination, { withFileTypes: true }).filter((entry) => entry.isDirectory() && semver.test(entry.name));
  return sortReleases(versions.map(({ name }) => {
    const manifest = JSON.parse(localFile(join(destination, name, "manifest.json")));
    if (manifest.schema !== "hifabu.release/1" || manifest.version !== name ||
        !/^\d{4}-\d{2}-\d{2}$/.test(manifest.releasedAt)) {
      fail("release_manifest", `已有版本清单无效：${name}/manifest.json`);
    }
    return manifest;
  }));
}

const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function versionsPage(releases, withdrawals) {
  const rows = releases.map(({ version, releasedAt }) => {
    const reason = withdrawals[version];
    const detail = reason ? `已撤回 · ${escapeHtml(reason)}` : `<a href="../${version}/install.sh">安装脚本</a>`;
    return `<li><a href="../${version}/manifest.json">${version}</a> · ${releasedAt} · ${detail}</li>`;
  });
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hifabu 发布机历史版本</title>
<h1>Hifabu 发布机历史版本</h1>
<ul>
${rows.join("\n")}
</ul>
</html>
`;
}

function latestPointer(root, version) {
  const manifest = `${version}/manifest.json`;
  return { version, manifest, sha256: digest(localFile(join(root, manifest))) };
}

function existingFileMatches(source, target) {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || !localFile(source).equals(localFile(target))) {
    fail("release_conflict", `已有文件内容不同，拒绝覆盖：${target}`);
  }
  return true;
}

function requireDirectory(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    fail("release_input", `目录不存在或不是常规目录：${path}`);
  }
}

function ensureDirectory(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    mkdirSync(path);
    chmodSync(path, 0o755);
  }
  requireDirectory(path);
}

function replacePublicFile(stage, destination, name, content) {
  const source = join(stage, basename(name));
  writeFileSync(source, content);
  chmodSync(source, 0o644);
  renameSync(source, join(destination, name));
}

function activateVersion(stage, destination, version) {
  const versions = join(destination, "versions");
  requireDirectory(versions);
  const withdrawals = readJsonIfPresent(join(versions, "withdrawn.json"), {});
  if (withdrawals[version]) fail("release_withdrawn", `版本 ${version} 已撤回。请提升版本号。`);
  const latest = latestPointer(destination, version);
  replacePublicFile(stage, destination, "versions/index.html", versionsPage(releasesIn(destination), withdrawals));
  replacePublicFile(stage, destination, "latest.json", json(latest));
}

function publish(stage, destination, manifest, activate) {
  const { version } = manifest;
  const candidate = join(stage, version);
  const target = join(destination, version);
  const deps = join(destination, "deps");
  const files = readdirSync(candidate).sort();
  const depFiles = readdirSync(join(stage, "deps")).sort();
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (activate && !existing) fail("release_activate", `请先就位并验证候选版本 ${version}。`);
  if (existing) {
    requireDirectory(target);
    if (readdirSync(target).sort().join("\n") !== files.join("\n")) {
      fail("release_conflict", `已有版本目录的文件集合不同：${target}`);
    }
    for (const name of files) existingFileMatches(join(candidate, name), join(target, name));
  }
  ensureDirectory(deps);
  ensureDirectory(join(destination, "versions"));
  const withdrawals = readJsonIfPresent(join(destination, "versions", "withdrawn.json"), {});
  if (withdrawals[version]) fail("release_withdrawn", `版本 ${version} 已撤回。请提升版本号。`);
  const newDeps = depFiles.filter((name) => !existingFileMatches(join(stage, "deps", name), join(deps, name)));
  for (const name of newDeps) {
    const source = join(stage, "deps", name);
    chmodSync(source, 0o644);
    linkSync(source, join(deps, name));
  }

  if (!existing) {
    chmodSync(candidate, 0o755);
    for (const name of files) chmodSync(join(candidate, name), 0o644);
    renameSync(candidate, target);
  }
  if (activate) {
    activateVersion(stage, destination, version);
  } else {
    console.log(`候选版本 ${version} 已就位。完成全新安装和升级验证后，使用 --activate 切换 latest.json。`);
  }
}

function withPublishLock(destination, callback) {
  ensureDirectory(destination);
  const lock = join(destination, ".publish-release.lock");
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail("release_locked", `发布目录正由另一个进程使用：${lock}`);
    }
    throw error;
  }
  try {
    const stage = mkdtempSync(join(destination, ".release-"));
    try {
      return callback(stage);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } finally {
    rmdirSync(lock);
  }
}

function printPlan(root, files) {
  console.log(`SHA-256 · ${publicDirectory}/`);
  for (const name of files) console.log(`${digest(localFile(join(root, name)))}  ${name}`);
}

function releaseFiles(root, version) {
  return [version, "deps"].flatMap((dir) =>
    readdirSync(join(root, dir)).sort().map((name) => `${dir}/${name}`));
}

const remoteStageName = /^\.publish-release\.[a-zA-Z0-9]{8}$/;
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function receiveRelease({ destination, upload, version, expected, activate }) {
  if (!semver.test(version) || (!activate && (dirname(upload) !== destination || !remoteStageName.test(basename(upload))))) {
    fail("release_upload", "远端暂存路径或版本无效。");
  }
  requireDirectory(destination);
  withPublishLock(destination, (stage) => {
    const source = activate ? destination : upload;
    requireDirectory(source);
    requireDirectory(join(source, version));
    requireDirectory(join(source, "deps"));
    const paths = Object.keys(expected).sort();
    const present = releaseFiles(source, version).filter((path) => !activate || !path.startsWith("deps/") || Object.hasOwn(expected, path));
    if (paths.join("\n") !== present.sort().join("\n")) {
      fail("release_upload", "远端版本或依赖文件清单不匹配。");
    }
    for (const path of paths) {
      if (digest(localFile(join(source, path))) !== expected[path]) {
        fail("release_checksum", `远端 SHA-256 不匹配：${path}`);
      }
    }
    const manifest = JSON.parse(localFile(join(source, version, "manifest.json")));
    if (manifest.schema !== "hifabu.release/1" || version !== manifest.version) {
      fail("release_upload", "远端清单版本不匹配。");
    }
    if (activate) activateVersion(stage, destination, version);
    else publish(upload, destination, manifest, false);
  });
}

function uploadRelease(host, stage, { version }, activate) {
  const ssh = (command, input) => {
    try {
      return execFileSync("ssh", ["--", host, command], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      fail("release_upload", `SSH ${host} 失败：${error.stderr?.trim() || error.code || error.status}`);
    }
  };
  const destination = publicDirectory;
  const expected = Object.fromEntries(releaseFiles(stage, version).map((path) => [path, digest(localFile(join(stage, path)))]));
  const script = localFile(fileURLToPath(import.meta.url));
  let upload;
  if (!activate) {
    upload = ssh(`umask 022; mkdir -p -- ${destination} && mktemp -d ${destination}/.publish-release.XXXXXXXX`).trim();
    if (dirname(upload) !== destination || !remoteStageName.test(basename(upload))) {
      fail("release_upload", "SSH 未返回预期的发布暂存目录。");
    }
  }
  try {
    if (upload) execFileSync("scp", ["-r", "--", join(stage, version), join(stage, "deps"), `${host}:${upload}/`]);
    const request = shellQuote(JSON.stringify({ destination, upload, version, expected, activate }));
    const output = ssh(`node --input-type=module - --receive-release ${request}`, script);
    if (output) process.stdout.write(output);
  } finally {
    if (upload) {
      try {
        ssh(`rm -rf -- ${shellQuote(upload)}`);
      } catch (error) {
        console.error(`清理远端暂存目录失败：${upload}（${error.message}）`);
      }
    }
  }
}

function preview(stage, options, manifest) {
  const { version } = manifest;
  const target = options["publish-dir"];
  const releases = target && lstatSync(target, { throwIfNoEntry: false }) ? releasesIn(target) : [];
  const withdrawals = target ? readJsonIfPresent(join(target, "versions", "withdrawn.json"), {}) : {};
  mkdirSync(join(stage, "versions"));
  const versions = sortReleases([manifest, ...releases.filter((item) => item.version !== version)]);
  writeFileSync(join(stage, "versions", "index.html"), versionsPage(versions, withdrawals));
  writeFileSync(join(stage, "latest.json"), json(latestPointer(stage, version)));
  const files = [...releaseFiles(stage, version), "versions/index.html", "latest.json"];
  printPlan(stage, files);
  if (options["output-dir"]) {
    const output = resolve(options["output-dir"]);
    mkdirSync(output);
    for (const dir of [version, "deps", "versions"]) mkdirSync(join(output, dir));
    for (const name of files) copyFileSync(join(stage, name), join(output, name));
  }
}

function prune(destination, confirmation) {
  const referenced = new Set();
  for (const manifest of releasesIn(destination)) {
    for (const dep of [manifest.node, ...Object.values(manifest.components)]) {
      const urls = Object.values(dep.files).map(({ url }) => url);
      if (dep.licenseUrl) urls.push(dep.licenseUrl);
      for (const url of urls.filter((url) => url.startsWith(publicUrl + "deps/"))) referenced.add(basename(url));
    }
  }
  const deps = join(destination, "deps");
  requireDirectory(deps);
  const cutoff = Date.now() - 90 * 24 * 60 * 60_000;
  const stale = readdirSync(deps).sort().flatMap((name) => {
    const entry = lstatSync(join(deps, name));
    return entry.isFile() && !referenced.has(name) && entry.mtimeMs < cutoff
      ? [{ name, updated: entry.mtimeMs, size: entry.size }] : [];
  });
  if (!stale.length) {
    console.log("没有超过 90 天且未被版本引用的依赖文件。");
    return;
  }
  const fingerprint = digest(json(stale));
  for (const { name } of stale) console.log(`deps/${name}`);
  if (!confirmation) {
    console.log(`确认以上清单后加 --confirm-prune ${fingerprint} 重新执行。`);
    return;
  }
  if (confirmation !== fingerprint) fail("release_prune", "待清理文件已变化。请重新预览。");
  for (const { name } of stale) rmSync(join(deps, name));
}

function withdraw(stage, destination, { withdraw: version, reason, replacement }) {
  const releases = releasesIn(destination);
  const versions = join(destination, "versions");
  requireDirectory(versions);
  const withdrawals = readJsonIfPresent(join(versions, "withdrawn.json"), {});
  if (!releases.some((item) => item.version === version)) fail("release_withdrawn", `找不到版本 ${version}。`);
  const latest = readJsonIfPresent(join(destination, "latest.json"), {});
  const isLatest = latest.version === version;
  const alternatives = releases.filter((item) => item.version !== version && !withdrawals[item.version]);
  if (replacement && (!isLatest || !alternatives.some((item) => item.version === replacement))) {
    fail("release_withdrawn", `无法把 latest.json 切换到 ${replacement}。`);
  }
  if (isLatest && !replacement && alternatives.length > 0) {
    fail("release_withdrawn", "撤回当前版本时，请指定已验证的 --replacement 版本。");
  }
  withdrawals[version] = reason.trim();
  replacePublicFile(stage, destination, "versions/withdrawn.json", json(withdrawals));
  replacePublicFile(stage, destination, "versions/index.html", versionsPage(releases, withdrawals));
  if (replacement) {
    replacePublicFile(stage, destination, "latest.json", json(latestPointer(destination, replacement)));
  } else if (isLatest) {
    renameSync(join(destination, "latest.json"), join(stage, "withdrawn-latest.json"));
  }
  console.log(`已撤回 ${version}，保留版本文件。`);
}

function main() {
  const { values: args } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      "dry-run": { type: "boolean" },
      "output-dir": { type: "string" },
      "publish-dir": { type: "string" },
      host: { type: "string" },
      "fetch-deps": { type: "string" },
      "fetch-biliup": { type: "string" },
      "deps-dir": { type: "string" },
      "biliup-second-dir": { type: "string" },
      "installer-template": { type: "string" },
      changelog: { type: "string" },
      activate: { type: "boolean" },
      prune: { type: "boolean" },
      "confirm-prune": { type: "string" },
      withdraw: { type: "string" },
      reason: { type: "string" },
      replacement: { type: "string" },
    },
  });
  if (args.help) {
    console.log(`用法：node deploy/hifabu/publish-release.mjs
  --fetch-deps <新目录>
  --fetch-biliup <新目录>  # 从另一网络下载
  [--dry-run [--output-dir <新目录>]] [--host <SSH 别名> | --publish-dir <下载根目录>] [--activate]
    --deps-dir <首份依赖> --biliup-second-dir <第二份 biliup>
    --installer-template <P2 模板> --changelog <本版说明>
  --publish-dir <下载根目录> --prune [--confirm-prune <清理清单哈希>]
  --publish-dir <下载根目录> --withdraw <版本> --reason <原因> [--replacement <已验证旧版本>]`);
    return;
  }
  const dry = args["dry-run"];
  const destination = args["publish-dir"] && resolve(args["publish-dir"]);
  const host = args.host;
  const release = taggedRelease();
  const modes = [args["fetch-deps"], args["fetch-biliup"], args.prune, args.withdraw].filter(Boolean);
  if (modes.length > 1 || (dry && (modes.length || args.activate)) || (args["output-dir"] && !dry) ||
      (host && (destination || modes.length || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))) ||
      (args["confirm-prune"] && !args.prune) || ((args.reason || args.replacement) && !args.withdraw)) {
    fail("release_input", "发布操作参数冲突。请用 --help 查看各操作。");
  }
  if (args["fetch-deps"] || args["fetch-biliup"]) {
    fetchDependencies(resolve(args["fetch-deps"] ?? args["fetch-biliup"]), Boolean(args["fetch-biliup"]));
    return;
  }
  if (!dry && !destination && !host) fail("release_input", "请指定 --host 或 --publish-dir，或用 --dry-run 离线预览。");
  if (args.prune || args.withdraw) {
    if (args.withdraw && (!semver.test(args.withdraw) || !args.reason?.trim())) {
      fail("release_input", "撤回需要语义化版本和非空的 --reason。");
    }
    requireDirectory(destination);
    withPublishLock(destination, (stage) => {
      if (args.prune) prune(destination, args["confirm-prune"]);
      else withdraw(stage, destination, args);
    });
    return;
  }

  for (const name of ["installer-template", "changelog", "deps-dir", "biliup-second-dir"]) {
    if (!args[name]) fail("release_input", `缺少 --${name}。请用 --help 查看发版输入。`);
  }
  requireDirectory(args["deps-dir"]);
  requireDirectory(args["biliup-second-dir"]);
  if (realpathSync(args["deps-dir"]) === realpathSync(args["biliup-second-dir"])) {
    fail("release_input", "biliup 的第二份下载必须来自另一个本地目录。");
  }
  if (dry || host) {
    const stage = mkdtempSync(join(tmpdir(), "hifabu-release-"));
    try {
      const manifest = build(stage, release, args, !dry);
      if (dry) preview(stage, args, manifest);
      else {
        printPlan(stage, releaseFiles(stage, manifest.version));
        uploadRelease(host, stage, manifest, Boolean(args.activate));
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    return;
  }
  withPublishLock(destination, (stage) => {
    const manifest = build(stage, release, args, true);
    printPlan(stage, releaseFiles(stage, manifest.version));
    publish(stage, destination, manifest, Boolean(args.activate));
  });
}

try {
  if (process.argv[1] === "-" && process.argv[2] === "--receive-release") receiveRelease(JSON.parse(process.argv[3]));
  else main();
} catch (error) {
  console.error(`[${error.code ?? "release_failed"}] 发版失败：${error.message}`);
  process.exitCode = 1;
}
