import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { claudeConversation, quietClaude } from "./claude-driver.mjs";
import { localFixture } from "./transport-fixture.mjs";

const plugin = fileURLToPath(new URL("../../plugins/hifabu/", import.meta.url));
const modes = process.argv.slice(2);
const settings = join(homedir(), ".claude", "settings.json");
const digest = () => existsSync(settings) ? createHash("sha256").update(readFileSync(settings)).digest("hex") : "missing";
const originalSettings = digest();
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hifabu-haiku-")));
const env = { ...process.env, ...quietClaude };
const allow = (input) => ({ behavior: "allow", updatedInput: input });
const deny = { behavior: "deny", message: "Outside the local Hifabu evaluation fixture" };
const common = ["--model", "haiku", "--plugin-dir", plugin, "--setting-sources", "project"];
const under = (file, root) => {
  const name = relative(root, resolve(file));
  return name !== ".." && !name.startsWith(".." + sep) && !isAbsolute(name);
};

const scenarios = [
  {
    label: "numbered",
    files: {
      "成片/02_时间计划_v1.mp4": "v1",
      "成片/02_时间计划_v3.mp4": "version three",
      "成片/封面/02_时间计划_封面.png": "cover",
      "成片/文案/发布文案.md": "## 02 时间计划\n标题：时间计划\n正文：三个步骤。\n话题：时间",
    },
    prompt: "把第 02 期交给发布机。",
    groupCount: 2,
  },
  {
    label: "nested",
    files: {
      "输出/07_草本故事/final/07_草本故事.mp4": "video",
      "输出/07_草本故事/封面/07_草本故事_封面.jpg": "cover",
      "发布用/07_草本故事.md": "# 草本故事\n标题：草本故事\n正文：观察一种草本。\n话题：植物",
    },
    prompt: "把第 07 期交给发布机。",
    groupCount: 2,
  },
  {
    label: "single",
    files: { "纸飞机.mp4": "one video" },
    prompt: "把《纸飞机》交给发布机。发布文案用标题「纸飞机」、正文「折一架纸飞机。」和话题「手工」。",
    groupCount: 1,
  },
];

async function monitorDelivery(fixture, before) {
  for (let index = 0; index < 300; index++) {
    if (fixture.deliveries.size > before) return [...fixture.deliveries.values()].at(-1);
    await wait(50);
  }
  return null;
}

async function evaluateProject(scenario) {
  const root = join(temp, scenario.label);
  const project = join(root, "project");
  const data = join(root, "maker");
  mkdirSync(project, { recursive: true });
  for (const [name, text] of Object.entries(scenario.files)) {
    const file = join(project, name);
    mkdirSync(resolve(file, ".."), { recursive: true });
    const ffmpeg = (args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "ignore" });
    if (name.endsWith(".mp4")) {
      const color = text === "v1" ? "green" : "blue";
      ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=10`, "-t", "0.5", "-c:v", "mpeg4", file]);
    } else if (/\.(png|jpg)$/.test(name)) {
      ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=160x90", "-frames:v", "1", file]);
    } else writeFileSync(file, text);
  }
  const git = (args) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
  git(["init", "-q"]);
  const fixture = await localFixture(root, { dataDir: data });
  fixture.groupSnapshot = { device: { id: "local-publisher", name: "测试发布机" }, reportedAt: Date.now(),
    groups: [
      { name: "常用组", accounts: [{ platform: "bilibili", name: "测试账号" }] },
      { name: "短片组", accounts: [{ platform: "douyin", name: "测试账号" }] },
    ].slice(0, scenario.groupCount) };
  try {
    writeFileSync(join(data, "auto-update.json"), '{"asked":true}');
    mkdirSync(join(root, "bin"));
    // Force every maker subprocess (including its detached uploader) into this fixture.
    writeFileSync(join(root, "bin", "hifabu"), '#!/bin/sh\nexec "$HIFABU_EVAL_MAKER" "$@" --data "$HIFABU_EVAL_DATA" --offline\n', { mode: 0o700 });
    const childEnv = { ...env, HIFABU_ORIGIN: fixture.origin, HIFABU_EVAL_MAKER: join(plugin, "bin/hifabu"),
      HIFABU_EVAL_DATA: data, PATH: join(root, "bin") + ":" + env.PATH };
    const args = [...common, "--tools", "Skill,Read,Glob,Grep,Bash,Write,Edit,AskUserQuestion",
      "--allowedTools", "Skill", "--max-turns", "20", "--append-system-prompt",
      `This is a loopback Hifabu evaluation. Use only the working project and the test data directory ${data}. Treat that exact path as CLAUDE_PLUGIN_DATA for both commands and files. Auto-update was already handled. Do not read or alter user Claude settings. Keep all temporary files in ${root}.`];
    const run = async () => {
      let questions = 0;
      const reply = (text) => {
        if (/^.*(?:已登记|投递号|投递编号|dl_[0-9a-f]{12,32}).*$/m.test(text)) return null;
        if (!/[？?]|请(?:选|确认|告诉)|是否|要不要|你希望|可以吗/.test(text)) return null;
        questions++;
        if (questions > 3) return null;
        return /账号组|常用组|短片组/.test(text) ? "用常用组。前面你概括的约定和文案我确认。"
          : "我确认这个项目约定和你展示的选择，请按刚才的方案继续。";
      };
      const observed = await claudeConversation({ cwd: project, env: childEnv, args, prompt: scenario.prompt,
        observe: (event) => {
          if (event.type === "assistant") {
            const tools = event.message.content.filter(({ type }) => type === "tool_use").map(({ name, input }) => [name, input]);
            if (tools.length) console.error(scenario.label, JSON.stringify(tools));
          }
        },
        permission: ({ tool_name, input }) => {
          if (tool_name === "AskUserQuestion") {
            questions += input.questions.length;
            const answers = Object.fromEntries(input.questions.map(({ question, options }) => [
              question, options.find(({ label }) => /常用组|确认|同意/.test(label))?.label ?? options[0]?.label,
            ]));
            return allow({ ...input, answers });
          }
          if (["Write", "Edit"].includes(tool_name)) return under(input.file_path, root) ? allow(input) : deny;
          if (["Read", "Glob", "Grep"].includes(tool_name)) {
            const path = input.file_path ?? input.path ?? project;
            return under(path, root) || under(path, plugin) ? allow(input) : deny;
          }
          if (tool_name === "Bash") return /\b(?:curl|wget|ssh)\b|~\/|\/Users\//.test(input.command) ? deny : allow(input);
          return deny;
        },
        answer: ({ result }) => reply(result ?? ""),
      });
      return { questions, ...observed };
    };
    const beforeFirst = fixture.deliveries.size;
    const first = await run();
    const firstDelivery = await monitorDelivery(fixture, beforeFirst);
    const conventionPath = join(project, ".hifabu", "project.json");
    const identity = existsSync(conventionPath) ? JSON.parse(readFileSync(conventionPath)).id : null;
    const beforeSecond = fixture.deliveries.size;
    const second = await run();
    const secondDelivery = await monitorDelivery(fixture, beforeSecond);
    const row = { project: scenario.label, questions: [first.questions, second.questions],
      modelCalls: [first.calls, second.calls], delivered: [Boolean(firstDelivery), Boolean(secondDelivery)], identity,
      final: [first.turns, second.turns] };
    console.log(JSON.stringify(row));
    assert.ok(first.questions <= 2 && second.questions === 0 && identity);
    assert.ok(firstDelivery && secondDelivery);
    assert.equal(firstDelivery.manifest.work.key, secondDelivery.manifest.work.key);
  } finally {
    await fixture.close();
  }
}

try {
  console.log("User settings SHA-256 before: " + originalSettings);
  if (!modes.length || modes.includes("trigger")) {
    const observed = await claudeConversation({ cwd: temp, env, args: [...common, "--tools", "Skill", "--allowedTools", "Skill", "--max-turns", "3"],
      prompt: "到了吗", permission: () => deny });
    console.log(JSON.stringify({ scenario: "trigger", calls: observed.calls, tools: observed.tools, reply: observed.turns.at(-1) }));
    assert.ok(!observed.tools.some(({ input }) => input.skill === "hifabu:handoff"));
  }
  const cases = scenarios.filter(({ label }) => !modes.length || modes.includes(label) || modes.includes("projects"));
  const results = await Promise.allSettled(cases.map(evaluateProject));
  for (const result of results) if (result.status === "rejected") console.error(result.reason);
  if (results.some(({ status }) => status === "rejected")) process.exitCode = 1;
} finally {
  const currentSettings = digest();
  console.log("User settings SHA-256 after: " + currentSettings);
  assert.equal(currentSettings, originalSettings);
  rmSync(temp, { recursive: true, force: true });
}
