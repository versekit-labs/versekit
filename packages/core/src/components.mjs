import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, accessSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readEnv } from "./env.mjs";

const exec = promisify(execFile);
const components = new Map([
  ["biliup", { env: "HIFABU_BILIUP_BIN", source: "biliup/biliup-rs" }],
  ["lark-cli", { env: "HIFABU_LARK_BIN", source: "larksuite/cli" }],
]);
const MAX_BYTES = 64 * 1024 ** 2;
const VERSION = /^v?\d+\.\d+\.\d+$/;
const app = fileURLToPath(new URL("../../..", import.meta.url));
const installedVersions = new Map();

const failure = (code, message) => Object.assign(new Error(message), { code });
const prefix = () => resolve(readEnv("HIFABU_PREFIX") || (basename(app) === "app" ? dirname(app) : join(homedir(), ".versekit")));
const binDir = () => join(prefix(), "bin");

function componentOf(name) {
  const component = components.get(name);
  if (!component) throw failure("component_unknown", "只可以管理 B 站和飞书的组件。");
  return component;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fromPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = resolve(dir, name);
    if (isExecutable(path)) return path;
  }
  return null;
}

/** An explicit override or an existing PATH install is still usable. Prefer the private bin by default. */
export function componentBinary(name) {
  const configured = readEnv(componentOf(name).env);
  if (configured) {
    if (isExecutable(configured)) return resolve(configured);
    return configured.includes("/") ? null : fromPath(configured);
  }
  const own = join(binDir(), name);
  return isExecutable(own) ? own : fromPath(name);
}

function approvedUrl(raw, local = false) {
  const url = new URL(raw);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.username || url.password || (local ? !loopback : url.protocol !== "https:")) throw new Error("下载地址无效");
  return url;
}

async function readManifest() {
  const path = readEnv("HIFABU_RELEASE_MANIFEST") || join(app, "release-manifest.json");
  try {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (manifest?.schema !== "hifabu.release/1" || !Object.keys(manifest.components ?? {}).length) throw new Error("invalid manifest");
    return manifest;
  } catch (err) {
    if (err.code === "ENOENT") throw failure("manifest_missing", "当前安装没有发版清单。请先更新 Hifabu。");
    throw failure("manifest_invalid", "当前安装的发版清单读不出来。请更新 Hifabu 后重试。");
  }
}

function lockedAsset(manifest, name) {
  const entry = manifest.components[name];
  const file = entry?.files?.[`${process.platform}-${process.arch}`];
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
    throw failure("component_unsupported", `这台发布机不支持安装 ${name}。`);
  }
  try {
    const local = Boolean(readEnv("HIFABU_RELEASE_MANIFEST")) && String(file.url).startsWith("http:");
    const url = approvedUrl(file.url, local);
    const upstream = approvedUrl(file.upstream);
    if (!VERSION.test(entry.version) || !/^[0-9a-f]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_BYTES) throw new Error("invalid asset");
    return { version: entry.version, size: file.size, sha256: file.sha256, url, upstream: upstream.href, local };
  } catch {
    throw failure("manifest_invalid", `发版清单里的 ${name} 下载信息不完整。请更新 Hifabu 后重试。`);
  }
}

async function versionOf(binary) {
  if (!binary) return null;
  try {
    const installed = installedVersions.get(binary);
    if (installed && installed.identity === binaryIdentity(binary)) return installed.version;
    const { stdout, stderr } = await exec(binary, ["--version"], { timeout: 5000, maxBuffer: 8192 });
    return (stdout + stderr).match(/\bv?\d+\.\d+\.\d+\b/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function binaryIdentity(binary) {
  const { dev, ino, size, mtimeMs } = statSync(binary);
  return `${dev}:${ino}:${size}:${mtimeMs}`;
}

export async function listComponents() {
  let manifest, releaseError = null;
  try { manifest = await readManifest(); }
  catch (err) { releaseError = err.message; }

  return { components: await Promise.all([...components].map(async ([name, spec]) => {
    const binary = componentBinary(name);
    let lock, installError = releaseError;
    if (manifest) {
      try { lock = lockedAsset(manifest, name); }
      catch (err) { installError = err.message; }
    }
    return {
      name,
      installed: Boolean(binary),
      installedVersion: await versionOf(binary),
      removable: isExecutable(join(binDir(), name)),
      lockedVersion: lock?.version ?? null,
      size: lock?.size ?? null,
      source: spec.source,
      upstream: lock?.upstream ?? null,
      installError,
    };
  })) };
}

async function download(name, lock, offline) {
  if (offline && !lock.local) throw failure("offline_mode", "离线模式只能从本机测试源下载组件。");
  let bytes;
  try {
    const response = await fetch(lock.url, { redirect: "error", signal: AbortSignal.timeout(90_000) });
    if (!response.ok || !response.body) throw new Error("download failed");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > lock.size) throw failure("component_checksum", `${name} 下载文件大于清单所列大小，安装已停止。`);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks, size);
  } catch (err) {
    if (err.code === "component_checksum") throw err;
    throw failure("component_download", `没能下载 ${name}。请检查发布机的网络后重试。`);
  }
  if (bytes.length !== lock.size || createHash("sha256").update(bytes).digest("hex") !== lock.sha256) {
    throw failure("component_checksum", `${name} 的文件校验没通过，安装已停止。请重试。`);
  }
  return bytes;
}

async function binaryFromArchive(path, name) {
  try {
    // Only read the named member to stdout. No archive entry writes paths or links on disk.
    const options = { timeout: 15_000, maxBuffer: MAX_BYTES };
    const { stdout: listing } = await exec("tar", ["-tf", path], { ...options, maxBuffer: 128 * 1024 });
    const entries = listing.split("\n").filter((entry) => !entry.endsWith("/") && basename(entry) === name);
    if (entries.length !== 1 || entries[0].startsWith("/") || entries[0].split("/").includes("..")) throw new Error("invalid member");
    const { stdout: binary } = await exec("tar", ["-xOf", path, "--", entries[0]], { ...options, encoding: "buffer" });
    if (!binary.length) throw new Error("empty member");
    return binary;
  } catch {
    throw failure("component_archive", `${name} 的压缩包打不开或找不到可执行文件。请重试。`);
  }
}

const installing = new Map();

export async function installComponent(name, { offline = false } = {}) {
  componentOf(name);
  const dir = binDir();
  const target = join(dir, name);
  if (installing.has(target)) return installing.get(target);
  if (componentBinary(name)) return { name, installed: true, already: true };

  const install = (async () => {
    const lock = lockedAsset(await readManifest(), name);
    const bytes = await download(name, lock, offline);
    let stage;
    try {
      await mkdir(dir, { recursive: true });
      stage = await mkdtemp(join(dir, ".component-"));
      const archive = join(stage, "download");
      await writeFile(archive, bytes);
      const staged = join(stage, name);
      await writeFile(staged, await binaryFromArchive(archive, name), { mode: 0o755 });
      const identity = binaryIdentity(staged);
      // Commit only after validation, and preserve an executable that appeared during the download.
      if (componentBinary(name)) return { name, installed: true, already: true };
      await rename(staged, target);
      installedVersions.set(target, { identity, version: lock.version });
      return { name, installed: true, installedVersion: lock.version };
    } catch (err) {
      if (err.code === "component_archive") throw err;
      throw failure("component_install", `没能安装 ${name}。请检查发布机的安装目录是否可写，再重试。`);
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
    }
  })();
  installing.set(target, install);
  try { return await install; }
  finally { installing.delete(target); }
}

export async function removeComponent(name) {
  componentOf(name);
  const target = join(binDir(), name);
  if (installing.has(target)) throw failure("component_busy", `${name} 正在安装，请等安装结束后再移除。`);
  let removed = false;
  try {
    await unlink(target);
    installedVersions.delete(target);
    removed = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw failure("component_remove", `没能移除 ${name}。请检查发布机的安装目录是否可写，再重试。`);
    if (componentBinary(name)) throw failure("component_external", `${name} 由系统或其他工具安装，请到原处移除。`);
  }
  return { name, removed, installed: Boolean(componentBinary(name)) };
}
