#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_PUBLIC_URL = "https://hifabu.com/download/";
const TEMPLATE_PATH = new URL("./template.html", import.meta.url);
const SHA256_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const escapeAttr = (value) => escapeHtml(value).replaceAll("\n", "&#10;");

function normalizeBaseUrl(publicUrl = DEFAULT_PUBLIC_URL) {
  const url = new URL(publicUrl);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(`无效的文件体积：${bytes}`);
  }
  if (bytes >= 10_000_000) {
    const mb = Math.round(bytes / 1_000_000);
    return { en: `~${mb} MB`, zh: `约 ${mb} MB` };
  }
  if (bytes >= 1_000_000) {
    const mb = (bytes / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return { en: `~${mb} MB`, zh: `约 ${mb} MB` };
  }
  if (bytes >= 1_000) {
    const kb = Math.max(1, Math.round(bytes / 1_000));
    return { en: `~${kb} KB`, zh: `约 ${kb} KB` };
  }
  return { en: `${bytes} B`, zh: `${bytes} B` };
}

function primaryFile(files, label) {
  if (!files || typeof files !== "object") throw new Error(`清单缺少 ${label} 文件表`);
  const record = files["darwin-arm64"] ?? files["darwin-x64"] ?? Object.values(files)[0];
  if (!record || typeof record !== "object") throw new Error(`清单缺少 ${label} 平台文件`);
  return record;
}

function hostOf(urlText) {
  return new URL(urlText).host;
}

function upstreamLabel(urlText) {
  const url = new URL(urlText);
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `github.com/${parts[0]}/${parts[1]}`;
  }
  return url.host;
}

function describeSource(file) {
  const mirror = hostOf(file.url);
  if (!file.upstream) return { en: mirror, zh: mirror };
  const upstream = upstreamLabel(file.upstream);
  if (upstream === mirror) return { en: mirror, zh: mirror };
  return { en: `${upstream} (mirrored on ${mirror})`, zh: `${upstream}，${mirror} 镜像` };
}

function renderNotes(notes) {
  const lines = String(notes ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      out.push(`<h3>${escapeHtml(heading[1])}</h3>`);
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${escapeHtml(item[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeList();
  return out.join("\n    ");
}

function validateInputs(manifest, installSha256) {
  if (!manifest || manifest.schema !== "hifabu.release/1") {
    throw new Error("发版清单 schema 必须为 hifabu.release/1");
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("发版清单缺少版本号");
  }
  if (typeof manifest.releasedAt !== "string" || !DATE_RE.test(manifest.releasedAt)) {
    throw new Error("发版清单缺少有效的发布日期");
  }
  if (!manifest.app || typeof manifest.app.url !== "string") {
    throw new Error("发版清单缺少程序包信息");
  }
  if (!manifest.node || typeof manifest.node.version !== "string") {
    throw new Error("发版清单缺少 Node 信息");
  }
  if (!manifest.components?.biliup || !manifest.components?.["lark-cli"]) {
    throw new Error("发版清单缺少 biliup 或 lark-cli 组件信息");
  }
  if (typeof manifest.notes !== "string" || !manifest.notes.trim()) {
    throw new Error("发版清单缺少更新说明");
  }
  if (typeof installSha256 !== "string" || !SHA256_RE.test(installSha256)) {
    throw new Error("缺少有效的 install.sh SHA-256");
  }
}

export function renderDownloadPage({ manifest, installSha256, publicUrl = DEFAULT_PUBLIC_URL, template } = {}) {
  validateInputs(manifest, installSha256);
  const base = normalizeBaseUrl(publicUrl);
  const version = manifest.version;
  const installUrl = `${base}${version}/install.sh`;
  const installCmd = `curl -fsSL ${installUrl} | bash`;
  const verifyLines = [
    `curl -fsSLO ${installUrl}`,
    `echo "${installSha256}  install.sh" | shasum -a 256 -c`,
    "bash install.sh",
  ].join("\n");

  const nodeFile = primaryFile(manifest.node.files, "node");
  const biliupFile = primaryFile(manifest.components.biliup.files, "biliup");
  const larkFile = primaryFile(manifest.components["lark-cli"].files, "lark-cli");

  const nodeSize = formatBytes(nodeFile.size);
  const appSize = formatBytes(manifest.app.size);
  const biliupSize = formatBytes(biliupFile.size);
  const larkSize = formatBytes(larkFile.size);

  const nodeSource = describeSource(nodeFile);
  const biliupSource = describeSource(biliupFile);
  const larkSource = describeSource(larkFile);

  const tokens = {
    VERSION: escapeHtml(version),
    RELEASED_AT: escapeHtml(manifest.releasedAt),
    INSTALL_CMD: escapeHtml(installCmd),
    INSTALL_CMD_ATTR: escapeAttr(installCmd),
    TERMINAL_CMD: escapeHtml(installCmd),
    NODE_VERSION: escapeHtml(manifest.node.version),
    NODE_SIZE_EN: escapeHtml(nodeSize.en),
    NODE_SIZE_ZH: escapeHtml(nodeSize.zh),
    NODE_SOURCE_EN: escapeHtml(nodeSource.en),
    NODE_SOURCE_ZH: escapeHtml(nodeSource.zh),
    APP_SIZE_EN: escapeHtml(appSize.en),
    APP_SIZE_ZH: escapeHtml(appSize.zh),
    APP_SOURCE_HOST: escapeHtml(hostOf(manifest.app.url)),
    BILIUP_VERSION: escapeHtml(manifest.components.biliup.version),
    BILIUP_SIZE_EN: escapeHtml(biliupSize.en),
    BILIUP_SIZE_ZH: escapeHtml(biliupSize.zh),
    BILIUP_SOURCE_EN: escapeHtml(biliupSource.en),
    BILIUP_SOURCE_ZH: escapeHtml(biliupSource.zh),
    LARK_VERSION: escapeHtml(manifest.components["lark-cli"].version),
    LARK_SIZE_EN: escapeHtml(larkSize.en),
    LARK_SIZE_ZH: escapeHtml(larkSize.zh),
    LARK_SOURCE_EN: escapeHtml(larkSource.en),
    LARK_SOURCE_ZH: escapeHtml(larkSource.zh),
    INSTALL_SHA256: escapeHtml(installSha256),
    SHA256SUMS_HREF: escapeAttr(`${version}/SHA256SUMS`),
    MANIFEST_HREF: escapeAttr(`${version}/manifest.json`),
    TAG_HREF: escapeAttr(`https://github.com/versekit-labs/versekit/tree/app-v${version}`),
    TAG_NAME: escapeHtml(`app-v${version}`),
    NOTES_HTML: renderNotes(manifest.notes),
    VERIFY_LINES: escapeHtml(verifyLines),
    VERIFY_LINES_ATTR: escapeAttr(verifyLines),
  };

  const source = template ?? readFileSync(TEMPLATE_PATH, "utf8");
  const rendered = source.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (!Object.hasOwn(tokens, key)) throw new Error(`模板存在未知占位符：${match}`);
    return tokens[key];
  });
  return rendered;
}

export function renderUnavailablePage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download Hifabu · Hi 发布</title>
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" href="../apple-touch-icon.png">
<link rel="stylesheet" href="../style.css">
</head>
<body>
<main class="home">
<header>
  <a class="brand" href="../" aria-label="Hi 发布 (Hifabu) home">
    <picture>
      <source srcset="../logo-dark.svg" media="(prefers-color-scheme: dark)">
      <img src="../logo-light.svg" width="140" height="51" alt="Hifabu (Hi 发布)">
    </picture>
  </a>
  <nav aria-label="Site">
    <a href="./" aria-current="page">Download</a>
    <a href="../plugin/">Claude Code plugin</a>
    <a href="../privacy/">Privacy Policy</a>
    <a href="../terms/">Terms of Service</a>
    <a href="/login">Sign in</a>
  </nav>
</header>
<section class="hero">
  <p class="kicker">Hifabu · Hi 发布</p>
  <h1>No active release is available right now.</h1>
  <p class="lead">The current release has been withdrawn while a fix is prepared. You can check <a href="versions/">previous versions</a> for status and details.</p>
  <p class="zh" lang="zh-CN">当前版本已撤回，新版本准备好后会更新在此页。可以查看<a href="versions/">历史版本列表</a>了解原因。</p>
</section>
<footer>
  <a href="../">Home</a>
  <a href="./" aria-current="page">Download</a>
  <a href="../plugin/">Claude Code plugin</a>
  <a href="../privacy/">Privacy Policy</a>
  <a href="../terms/">Terms of Service</a>
  <a href="mailto:creator.omnikit@gmail.com">Contact</a>
  <span>© 2026 Hifabu</span>
</footer>
</main>
</body>
</html>
`;
}

function runCli() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      "install-sha256": { type: "string" },
      "release-dir": { type: "string" },
      "public-url": { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("用法：node site/download/render.mjs (--release-dir <版本目录> | --manifest <manifest.json> --install-sha256 <sha256>) [--public-url <URL>] [--output <index.html>]");
    return;
  }
  let manifestPath = values.manifest;
  let installSha256 = values["install-sha256"];
  if (values["release-dir"]) {
    const dir = resolve(values["release-dir"]);
    manifestPath ??= join(dir, "manifest.json");
    installSha256 ??= createHash("sha256").update(readFileSync(join(dir, "install.sh"))).digest("hex");
  }
  if (!manifestPath || !installSha256) {
    throw new Error("请提供 --release-dir，或同时提供 --manifest 与 --install-sha256。");
  }
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const html = renderDownloadPage({
    manifest,
    installSha256,
    publicUrl: values["public-url"] ?? DEFAULT_PUBLIC_URL,
  });
  if (values.output) {
    const target = resolve(values.output);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
  } else {
    process.stdout.write(html);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
