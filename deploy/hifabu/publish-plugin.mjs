#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const pluginDir = fileURLToPath(new URL("../../plugins/hifabu/", import.meta.url));
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
  const files = [];
  const timestamp = new Date("2000-01-01T00:00:00Z");
  for (const entry of readdirSync(pluginDir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const source = join(entry.parentPath, entry.name);
    const name = relative(pluginDir, source);
    if (!entry.isFile() || /[\r\n\\]/.test(name)) {
      throw new Error(`插件包含无法打包的条目：${name}`);
    }
    const target = join(content, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode & 0o111 ? 0o755 : 0o644);
    utimesSync(target, timestamp, timestamp);
    files.push(name);
  }

  // 校验暂存内容，确保实际打包的字节符合已登记的版本。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ["--test", join(content, "test/version.test.mjs")], { env });
  const { name, version, description, author, homepage, license } =
    JSON.parse(readFileSync(join(content, ".claude-plugin/plugin.json"), "utf8"));
  if (name !== "hifabu" || typeof version !== "string" || !semver.test(version)) {
    throw new Error("plugin.json 必须使用 hifabu 名称及有效的语义化版本号。");
  }
  const archive = `${name}-${version}.zip`;
  execFileSync("zip", ["-q", "-X", "-D", join(root, archive), "-@"], {
    cwd: content,
    env: { ...process.env, TZ: "UTC", ZIPOPT: "" },
    input: files.sort().join("\n") + "\n",
  });

  const marketplace = {
    name,
    owner: author,
    metadata: { description: "Hifabu 的 Claude Code 插件市场。" },
    plugins: [{
      name, version, description, author, homepage, license,
      source: {
        source: "archive",
        url: new URL(encodeURIComponent(archive), publicUrl).href,
        sha256: sha256(join(root, archive)),
      },
    }],
  };
  writeFileSync(join(root, "marketplace.json"), JSON.stringify(marketplace, null, 2) + "\n");
  writeFileSync(join(root, "install.txt"), [
    "给 AI 助手：用户请你安装 Hifabu 插件时，请在终端执行以下一行命令。",
    "",
    `claude plugin marketplace add ${publicUrl}marketplace.json && claude plugin install hifabu@hifabu`,
    "",
    "安装成功后，提醒用户运行 /reload-plugins 或者重开 Claude Code 会话。",
    "",
    "升级时先刷新 Hifabu 市场清单，再更新插件。",
    "",
    "claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu",
    "",
  ].join("\n"));
  return [archive, "install.txt", "marketplace.json"];
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
chmod 644 "$stage/$archive" "$stage/install.txt" "$stage/marketplace.json"
for manifest in install.txt marketplace.json; do
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
