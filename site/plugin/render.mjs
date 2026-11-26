import { readFileSync } from "node:fs";

export const DEFAULT_PUBLIC_URL = "https://hifabu.com/plugin/";
export const DEFAULT_REPO_URL = "https://github.com/versekit-labs/versekit";

const TEMPLATE_PATH = new URL("./index.html", import.meta.url);
const SHA256_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINE_LENGTH = 100;

export const REQUIRED_PLACEHOLDERS = [
  "version",
  "released_at",
  "zip_name",
  "zip_url",
  "zip_sha256",
  "source_url",
  "changelog_url",
];

export const TEMPLATE_TOKENS = Object.freeze(
  Object.fromEntries(REQUIRED_PLACEHOLDERS.map((key) => [key, `{{${key}}}`])),
);

export const UPDATE_COMMAND =
  "claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu";
export const UNINSTALL_COMMAND = "claude plugin uninstall hifabu@hifabu";

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

export function normalizeBaseUrl(publicUrl = DEFAULT_PUBLIC_URL) {
  const url = new URL(publicUrl);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function installCommand(publicUrl = DEFAULT_PUBLIC_URL) {
  return `claude plugin install hifabu --marketplace ${normalizeBaseUrl(publicUrl)}marketplace.json`;
}

// Single source of truth shared between #for-ai-assistants in index.html and install.txt.
export function aiAssistantCopy(tokens, publicUrl = DEFAULT_PUBLIC_URL) {
  return {
    command: installCommand(publicUrl),
    whatItDoes: [
      {
        text: "Adds the Hifabu plugin marketplace from hifabu.com to Claude Code.",
        lines: ["Adds the Hifabu plugin marketplace from hifabu.com to Claude Code."],
      },
      {
        text: 'Installs one plugin, "hifabu": one skill (handoff) and a small command-line program named hifabu.',
        lines: [
          'Installs one plugin, "hifabu": one skill (handoff) and a small command-line',
          "program named hifabu.",
        ],
      },
      {
        prefix: "Claude Code checks the plugin archive against this SHA-256 before installing:",
        checksum: true,
        text: `Claude Code checks the plugin archive against this SHA-256 before installing: ${tokens.zip_sha256}  ${tokens.zip_name}`,
        lines: [
          "Claude Code checks the plugin archive against this SHA-256 before installing:",
          `${tokens.zip_sha256}  ${tokens.zip_name}`,
        ],
      },
      {
        text: "No hooks, no MCP server, no background service, no shell script piped from the web.",
        lines: ["No hooks, no MCP server, no background service, no shell script piped from the web."],
      },
      {
        text: "The plugin connects only to hifabu.com, and only uploads files the user asks it to hand over. It never publishes anything.",
        lines: [
          "The plugin connects only to hifabu.com, and only uploads files the user asks",
          "it to hand over. It never publishes anything.",
        ],
      },
    ],
    expectedFlow: {
      sentences: [
        'The assistant shows the user the command above and the points under "What it does", and runs it after the user agrees.',
        "Claude Code also asks for permission before it runs the command.",
        "After it finishes, the plugin is loaded by running /reload-plugins in Claude Code, or by starting a new session.",
      ],
      lines: [
        'The assistant shows the user the command above and the points under "What it does",',
        "and runs it after the user agrees. Claude Code also asks for permission before it",
        "runs the command. After it finishes, the plugin is loaded by running /reload-plugins",
        "in Claude Code, or by starting a new session.",
      ],
    },
  };
}

function renderWhatItDoesHtml(tokens, copy) {
  const parts = copy.whatItDoes.map((item) => {
    if (!item.checksum) return escapeHtml(item.text);
    return `${escapeHtml(item.prefix)} <code class="hash" data-release="zip_sha256">${escapeHtml(tokens.zip_sha256)}</code> <span data-release="zip_name">${escapeHtml(tokens.zip_name)}</span>.`;
  });
  return `What it does: ${parts.join(" ")}`;
}

function renderExpectedFlowHtml(copy) {
  return `Expected flow: ${copy.expectedFlow.sentences
    .map((sentence) => escapeHtml(sentence).replace("/reload-plugins", "<code>/reload-plugins</code>"))
    .join(" ")}`;
}

function validateRelease(release) {
  if (!release || typeof release !== "object") {
    throw new Error("缺少插件发布元数据。");
  }
  for (const key of REQUIRED_PLACEHOLDERS) {
    const value = release[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`缺少插件发布字段：${key}`);
    }
    if (value.includes("{{")) {
      throw new Error(`发布字段 ${key} 包含未替换占位符。`);
    }
  }
  if (!DATE_RE.test(release.released_at)) {
    throw new Error(`released_at 必须为 YYYY-MM-DD：${release.released_at}`);
  }
  if (!SHA256_RE.test(release.zip_sha256)) {
    throw new Error(`zip_sha256 必须为 64 位小写十六进制：${release.zip_sha256}`);
  }
}

function assertNoPlaceholders(content, label) {
  const match = /\{\{[^}\n]*\}?\}?/.exec(content);
  if (match) {
    throw new Error(`${label} 仍留有未替换占位符（${match[0]}），拒绝发布。`);
  }
}

export function renderInstallTxt(release, { publicUrl = DEFAULT_PUBLIC_URL, allowPlaceholders = false } = {}) {
  const tokens = allowPlaceholders ? { ...TEMPLATE_TOKENS, ...release } : release;
  if (!allowPlaceholders) validateRelease(tokens);
  const base = normalizeBaseUrl(publicUrl);
  const copy = aiAssistantCopy(tokens, base);

  const bulletLines = copy.whatItDoes.flatMap((item) =>
    item.lines.map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`)),
  );
  const flowLines = copy.expectedFlow.lines.map((line) => `  ${line}`);

  const lines = [
    "Hifabu plugin for Claude Code - installation notes",
    `Version ${tokens.version} · ${tokens.released_at}`,
    "",
    "This file describes how the Hifabu plugin is installed. It is written for AI assistants",
    "that a user has asked to install the plugin, and for anyone who wants to check it first.",
    "",
    "What the command is",
    `  ${copy.command}`,
    "",
    "What it does",
    ...bulletLines,
    "",
    "Expected flow",
    ...flowLines,
    "",
    "Update",
    `  ${UPDATE_COMMAND}`,
    "",
    "Uninstall",
    '  Say "sign out of Hifabu" in Claude Code first, then:',
    `  ${UNINSTALL_COMMAND}`,
    "",
    `Source code: ${tokens.source_url}`,
    `Changes: ${tokens.changelog_url}`,
    `Page: ${base}`,
    "",
    "----",
    "",
    "Hifabu Claude Code 插件 · 安装说明",
    `版本 ${tokens.version} · ${tokens.released_at}`,
    "",
    "这份说明写给受用户之托安装插件的 AI 助手，也写给想先核对一遍的人。",
    "",
    "命令",
    `  ${copy.command}`,
    "",
    "会做什么",
    "  - 把 hifabu.com 上的 Hifabu 插件市场加到 Claude Code。",
    "  - 安装一个插件 hifabu：一个技能（handoff）和一个名叫 hifabu 的命令行小程序。",
    "  - 安装前，Claude Code 会按下面的 SHA-256 核对插件压缩包：",
    `    ${tokens.zip_sha256}  ${tokens.zip_name}`,
    "  - 没有 hooks，没有 MCP 服务，不注册后台服务，不从网上拉脚本直接执行。",
    "  - 插件只连 hifabu.com，只上传用户要交的文件，从不发布任何东西。",
    "",
    "预期的流程",
    "  助手先把上面的命令和「会做什么」给用户看，用户同意后再执行。执行前 Claude Code",
    "  也会请用户允许。装完后，在 Claude Code 里运行 /reload-plugins 或重开会话，插件才会加载。",
    "",
    "更新",
    `  ${UPDATE_COMMAND}`,
    "",
    "卸载",
    "  先在 Claude Code 里说「退出 Hifabu」，再运行：",
    `  ${UNINSTALL_COMMAND}`,
    "",
  ];

  const text = lines.join("\n");
  if (!allowPlaceholders) {
    assertNoPlaceholders(text, "install.txt");
    for (const line of lines) {
      if (line.length > MAX_LINE_LENGTH) {
        throw new Error(`install.txt 存在超过 ${MAX_LINE_LENGTH} 字符的行（${line.length}）：${line}`);
      }
    }
  }
  return text;
}

export function renderPluginHtml(
  release,
  { publicUrl = DEFAULT_PUBLIC_URL, templateHtml, allowPlaceholders = false } = {},
) {
  const tokens = allowPlaceholders ? { ...TEMPLATE_TOKENS, ...release } : release;
  if (!allowPlaceholders) validateRelease(tokens);
  const base = normalizeBaseUrl(publicUrl);
  const copy = aiAssistantCopy(tokens, base);
  const source = templateHtml ?? readFileSync(TEMPLATE_PATH, "utf8");

  const whatRe = /(<p\s+data-ai-section="what-it-does">)[\s\S]*?(<\/p>)/;
  const flowRe = /(<p\s+data-ai-section="expected-flow">)[\s\S]*?(<\/p>)/;
  if (!whatRe.test(source) || !flowRe.test(source)) {
    throw new Error("插件页模板缺少 data-ai-section 段落标记。");
  }

  let html = source
    .replace(whatRe, `$1${renderWhatItDoesHtml(tokens, copy)}$2`)
    .replace(flowRe, `$1${renderExpectedFlowHtml(copy)}$2`);

  if (base !== DEFAULT_PUBLIC_URL) {
    html = html.replaceAll(`${DEFAULT_PUBLIC_URL}marketplace.json`, `${base}marketplace.json`);
  }

  if (!allowPlaceholders) {
    html = html.replace(/\{\{([a-z0-9_]+)\}\}/g, (match, key) => {
      if (!Object.hasOwn(tokens, key)) {
        throw new Error(`插件页模板存在未知占位符：${match}`);
      }
      return escapeHtml(tokens[key]);
    });
    assertNoPlaceholders(html, "index.html");
  }
  return html;
}

export function renderPluginArtifacts(release, options = {}) {
  const html = renderPluginHtml(release, options);
  const installTxt = renderInstallTxt(release, options);
  return { html, installTxt };
}
