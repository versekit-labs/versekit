#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkVersion } from "../../plugins/hifabu-src/version.mjs";
import { DEFAULT_REPO_URL, renderPluginArtifacts } from "../../site/plugin/render.mjs";

const pluginDir = fileURLToPath(new URL("../../plugins/hifabu/", import.meta.url));
const packageFiles = [
  ".claude-plugin/plugin.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "bin/hifabu",
  "bin/hifabu-runtime",
  "lib/hifabu.mjs",
  "skills/handoff/SKILL.md",
  "skills/handoff/references/copy.md",
  "skills/handoff/references/errors.md",
  "skills/handoff/references/project-setup.md",
  "skills/handoff/references/setup.md",
  "skills/handoff/references/status.md",
];
const publicUrl = "https://hifabu.com/plugin/";
const destination = "/var/www/hifabu/plugin";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;
const usage = "用法：node deploy/hifabu/publish-plugin.mjs [--dry-run] [--host <SSH 别名>] [--output-dir <目录>]";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function build(root) {
  const content = join(root, "content");
  mkdirSync(content);
  checkVersion(pluginDir);
  const pluginRoot = realpathSync(pluginDir);
  const timestamp = new Date("2000-01-01T00:00:00Z");
  for (const name of packageFiles) {
    const source = join(pluginRoot, name);
    const info = lstatSync(source);
    if (!info.isFile() || realpathSync(source) !== source) {
      throw new Error(`插件包含无法打包的条目：${name}`);
    }
    const target = join(content, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, info.mode & 0o111 ? 0o755 : 0o644);
    utimesSync(target, timestamp, timestamp);
  }

  const { name, version, description, author, homepage, license } =
    JSON.parse(readFileSync(join(content, ".claude-plugin/plugin.json"), "utf8"));
  if (name !== "hifabu" || typeof version !== "string" || !semver.test(version)) {
    throw new Error("plugin.json 必须使用 hifabu 名称及有效的语义化版本号。");
  }
  const archive = `${name}-${version}.zip`;
  execFileSync("zip", ["-q", "-X", "-D", join(root, archive), "-@"], {
    cwd: content,
    env: { ...process.env, TZ: "UTC", ZIPOPT: "" },
    input: packageFiles.join("\n") + "\n",
  });

  const zipUrl = new URL(encodeURIComponent(archive), publicUrl).href;
  const zipSha256 = sha256(join(root, archive));
  const marketplace = {
    name,
    owner: author,
    metadata: { description: "Hifabu 的 Claude Code 插件市场。" },
    plugins: [{
      name, version, description, author, homepage, license,
      source: {
        source: "archive",
        url: zipUrl,
        sha256: zipSha256,
      },
    }],
  };
  writeFileSync(join(root, "marketplace.json"), JSON.stringify(marketplace, null, 2) + "\n");
  const tag = `${name}--v${version}`;
  const { html, installTxt } = renderPluginArtifacts({
    version,
    released_at: new Date().toISOString().slice(0, 10),
    zip_name: archive,
    zip_url: zipUrl,
    zip_sha256: zipSha256,
    source_url: `${DEFAULT_REPO_URL}/tree/${tag}/plugins/hifabu`,
    changelog_url: `${DEFAULT_REPO_URL}/blob/${tag}/plugins/hifabu/CHANGELOG.md`,
  }, { publicUrl });
  if (html.includes("{{") || installTxt.includes("{{")) {
    throw new Error("生成的插件页或 install.txt 仍留有未替换占位符，拒绝发布。");
  }
  writeFileSync(join(root, "index.html"), html);
  writeFileSync(join(root, "install.txt"), installTxt);
  return [archive, "index.html", "install.txt", "marketplace.json"];
}

function upload(host, root, files) {
  const ssh = (command, input) =>
    execFileSync("ssh", ["--", host, command], { encoding: "utf8", input });
  const stage = ssh(`umask 022; mkdir -p -- ${destination} && mktemp -d ${destination}/.publish-plugin.XXXXXXXX`).trim();
  if (!stage.startsWith(`${destination}/`) || !/^\.publish-plugin\.[a-zA-Z0-9]{8}$/.test(stage.slice(destination.length + 1))) {
    throw new Error("SSH 未返回预期的发布暂存目录。");
  }
  const [archive] = files;
  try {
    execFileSync("scp", ["--", ...files.map((name) => join(root, name)), `${host}:${stage}/`]);
    ssh("sh -s", `set -eu
cd '${destination}'
stage='${stage}'
archive='${archive}'
chmod 644 "$stage/$archive" "$stage/index.html" "$stage/install.txt" "$stage/marketplace.json"
for manifest in index.html install.txt marketplace.json; do
  if [ -d "$manifest" ]; then
    echo "发布文件路径是目录：$manifest" >&2
    exit 1
  fi
done
# 用硬链接以排他的方式公开 zip。重试时只接受字节相同的已有文件。
if ! ln -- "$stage/$archive" . 2>/dev/null; then
  if [ ! -f "$archive" ] || [ -L "$archive" ] || ! cmp -s -- "$stage/$archive" "$archive"; then
    printf '已有 zip 内容不同或无法创建（%s）。检查发布目录权限或提升插件版本。\\n' "$archive" >&2
    exit 1
  fi
fi
mv -f -- "$stage/index.html" index.html
mv -f -- "$stage/install.txt" install.txt
mv -f -- "$stage/marketplace.json" marketplace.json
`);
  } finally {
    try {
      ssh(`rm -rf -- '${stage}'`);
    } catch (error) {
      console.error(`清理发布暂存目录失败：${host}:${stage}（${error.message}）`);
    }
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      "output-dir": { type: "string" },
      host: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if ((values.host !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(values.host)) ||
      (!values["dry-run"] && !values.host)) {
    throw new Error(`请用 --host 传入有效的 SSH 主机别名。\n${usage}`);
  }
  const root = mkdtempSync(join(tmpdir(), "hifabu-plugin-"));
  try {
    const files = build(root);
    if (values["output-dir"]) {
      const output = resolve(values["output-dir"]);
      mkdirSync(output, { recursive: true });
      for (const name of files) copyFileSync(join(root, name), join(output, name));
    }
    console.log(`SHA-256 · ${values.host ? `${values.host}:` : ""}${destination}/`);
    for (const name of files) console.log(`${sha256(join(root, name))}  ${name}`);
    if (!values["dry-run"]) upload(values.host, root, files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`插件发布失败：${error.message}`);
  if (error.stdout?.length) console.error(String(error.stdout).trimEnd());
  process.exitCode = 1;
}
