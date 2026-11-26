import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claudeConversation, isolatedClaudeEnv, scriptedModel } from "../../../test/plugin/claude-driver.mjs";
import { localFixture } from "../../../test/plugin/transport-fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plugin = join(root, "plugins/hifabu");
const maker = join(plugin, "bin/hifabu");
const refs = join("skills", "handoff", "references");
const version = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"))).version;
const canUseClaude = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
const exec = promisify(execFile);

function temp(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hf-plugin-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pretty = (value) => JSON.stringify(value, null, 2) + "\n";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tool = (name, input) => ({ name, input });
const read = (path) => tool("Read", { file_path: path });
const write = (path, value) => tool("Write", { file_path: path, content: pretty(value) });
const skill = tool("Skill", { skill: "hifabu:handoff" });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const observed = (trace, regex) => trace.tools.some(({ input }) => regex.test(input.command ?? ""));

async function until(probe) {
  for (let index = 0; index < 300; index++) {
    const result = probe();
    if (result) return result;
    await wait(50);
  }
  assert.fail("等待回环上传超时");
}

test("ACC-plugin-v2-03: scan bounds metadata by type and modification time", (t) => {
  const folder = temp(t);
  for (const name of [".git", ".hidden", "node_modules", "media"]) {
    mkdirSync(join(folder, name));
    writeFileSync(join(folder, name, "bad.mp4"), "unread");
  }
  const media = join(folder, "media");
  rmSync(join(media, "bad.mp4"));
  for (let index = 0; index <= 100; index++) {
    const path = join(media, `video-${index}.MP4`);
    writeFileSync(path, "should not read me", { mode: 0 });
    utimesSync(path, index + 1, index + 1);
  }
  writeFileSync(join(media, "cover.png"), "cover");
  writeFileSync(join(media, "copy.md"), "copy");
  writeFileSync(join(media, "secret.json"), "outside inventory");
  symlinkSync(join(media, "video-100.MP4"), join(folder, "linked.mp4"));
  const run = (path) => spawnSync(maker, ["scan", path, "--json"], { encoding: "utf8" });
  const scanned = run(folder);
  assert.equal(scanned.status, 0, scanned.stderr);
  const { root: found, files, truncated } = JSON.parse(scanned.stdout);
  assert.equal(found, folder);
  assert.equal(truncated, true);
  assert.equal(files.length, 102);
  const videos = files.filter(({ kind }) => kind === "video");
  assert.equal(videos[0].path, "media/video-100.MP4");
  assert.equal(videos.at(-1).path, "media/video-1.MP4");
  assert.deepEqual(Object.keys(videos[0]).sort(), ["kind", "mtimeMs", "path"]);
  const error = run(join(folder, "missing"));
  assert.equal(error.status, 1);
  assert.equal(JSON.parse(error.stdout).error.code, "scan_failed");
});

test("ACC-plugin-v2-01: runtime surface and on-demand skill references", () => {
  const contents = readFileSync(join(plugin, "skills/handoff/SKILL.md"), "utf8");
  assert.ok(contents.trimEnd().split("\n").length <= 120);
  const [description, trigger] = ["description", "when_to_use"].map((key) => contents.match(new RegExp("^" + key + ": (.+)$", "m"))[1]);
  assert.ok(description.length + trigger.length <= 1536);
  assert.match(contents, /^allowed-tools: Bash\(hifabu \*\) Read Glob Grep$/m);
  for (const doc of ["project-setup", "copy", "status", "errors", "setup"]) {
    assert.ok(contents.includes(`references/${doc}.md`));
    assert.ok(statSync(join(plugin, refs, doc + ".md")).size);
  }
});

test("ACC-plugin-v2-03: committed project identity is carried by Git worktrees and renames", (t) => {
  const work = temp(t);
  const original = join(work, "original");
  const linked = join(work, "linked");
  const moved = join(work, "moved");
  mkdirSync(join(original, ".hifabu"), { recursive: true });
  const convention = ".hifabu/project.json";
  writeFileSync(join(original, convention), pretty({ id: "p_stable", episodes: {} }));
  const git = (args, cwd = original) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["add", convention]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "confirmed convention"]);
  git(["worktree", "add", "--detach", linked]);
  git(["worktree", "move", linked, moved]);
  assert.deepEqual(readFileSync(join(original, convention)), readFileSync(join(moved, convention)));
  renameSync(original, join(work, "renamed-original"));
  assert.equal(JSON.parse(readFileSync(join(work, "renamed-original", convention))).id, "p_stable");
});

test("ACC-plugin-v2-10: only newer versions are reported, failed checks leave delivery working", {
  skip: process.platform === "win32", timeout: 30_000,
}, async (t) => {
  const page = readFileSync(join(root, "site/plugin/index.html"), "utf8");
  const command = "claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu";
  assert.ok(page.replaceAll("&amp;", "&").includes(command));

  const scenarios = [
    { label: "newer", latest: "0.10.0", notify: true },
    { label: "current", latest: version },
    { label: "unreachable", failed: true },
  ];
  for (const { label, latest, notify, failed } of scenarios) {
    await t.test(label, async (t) => {
      const dir = temp(t);
      const transport = await localFixture(dir, { maker });
      t.after(() => transport.close());
      const requests = [];
      const market = createServer((req, res) => {
        requests.push({ method: req.method, url: req.url, headers: req.headers });
        if (failed) return req.socket.destroy();
        res.writeHead(200, { "content-type": "application/json" })
          .end(pretty({ name: "hifabu", plugins: [{ name: "hifabu", version: latest }] }));
      });
      market.listen(0, "127.0.0.1");
      await once(market, "listening");
      t.after(() => {
        market.closeAllConnections();
        return new Promise((resolve) => market.close(resolve));
      });
      const env = {
        ...process.env,
        HOME: dir,
        HIFABU_PLUGIN_MARKETPLACE_URL: `http://127.0.0.1:${market.address().port}/plugin/marketplace.json`,
      };
      const run = async (...args) => {
        const { stdout, stderr } = await exec(maker, [...transport.args, ...args], { env, timeout: 10_000 });
        assert.equal(stderr, "");
        return JSON.parse(stdout);
      };
      const manifest = join(dir, "delivery.json");
      writeFileSync(join(dir, "video.mp4"), "video fixture");
      writeFileSync(manifest, pretty({ title: "版本检查时仍可交付", cuts: [{
        title: "成片", versions: [{ asset: "video.mp4", language: "zh" }],
      }] }));

      const preview = await run("work", "push", manifest, "--dry-run", "--group", "测试组");
      assert.equal(preview.dryRun, true);
      assert.equal(requests.length, 0);
      const submit = run("work", "push", manifest, "--group", "测试组");
      const [delivery, ...other] = await Promise.all(notify
        ? [submit, run("cloud", "status"), run("cloud", "status")]
        : [submit]);
      assert.equal(delivery.state, "pending");
      assert.equal((await until(() => transport.deliveries.get(delivery.id))).state, "pending");
      const notices = [delivery, ...other].flatMap(({ update }) => update ? [update] : []);
      assert.deepEqual(notices, notify ? [{ current: version, latest, command }] : []);
      assert.ok(!Object.hasOwn(await run("delivery", "list"), "update"));
      assert.equal(requests.length, 1);
      const [{ method, url, headers }] = requests;
      assert.equal(method, "GET");
      assert.equal(url, "/plugin/marketplace.json");
      for (const header of ["cookie", "authorization", "referer"]) assert.ok(!Object.hasOwn(headers, header));
      assert.doesNotMatch(JSON.stringify(headers), /maker@example\.test|r{43}/);

      const logDir = join(transport.dataDir, "plugin-updates");
      const [log] = readdirSync(logDir);
      const record = JSON.parse(readFileSync(join(logDir, log), "utf8"));
      assert.equal(record.error_code, failed ? "plugin_update_check_failed" : undefined);
      if (failed) assert.equal(record.event, "plugin.update_check_failed");
      t.diagnostic(`marketplace requests=${requests.length}, notices=${notices.length}, delivery=${delivery.state}`);
    });
  }
});

test("ACC-plugin-v2-04/06/07/08: installed plugin, permissions, delivery resumption and logout on loopback", {
  skip: !canUseClaude, timeout: 90_000,
}, async (t) => {
  const dir = temp(t);
  const project = join(dir, "project");
  const market = join(dir, "market");
  const output = join(dir, "output");
  const marketPlugin = join(market, "hifabu");
  mkdirSync(join(market, ".claude-plugin"), { recursive: true });
  mkdirSync(marketPlugin);
  mkdirSync(join(project, ".hifabu"), { recursive: true });
  execFileSync(process.execPath, [join(root, "deploy/hifabu/publish-plugin.mjs"), "--dry-run", "--output-dir", output]);
  execFileSync("unzip", ["-q", join(output, `hifabu-${version}.zip`), "-d", marketPlugin]);
  writeFileSync(join(market, ".claude-plugin/marketplace.json"), pretty({
    name: "hifabu", owner: { name: "Hifabu" }, plugins: [{ name: "hifabu", source: "./hifabu" }],
  }));
  const model = await scriptedModel();
  t.after(() => model.close());

  function install(name) {
    const home = join(dir, name);
    const config = join(home, ".claude");
    mkdirSync(home);
    const env = isolatedClaudeEnv(process.env, home, config, model.origin);
    const { ANTHROPIC_API_KEY: _unused, ...adminEnv } = env;
    const run = (...args) => execFileSync("claude", ["plugin", ...args], { cwd: project, env: adminEnv, encoding: "utf8", timeout: 10_000 });
    const added = run("marketplace", "add", market);
    const installed = run("install", "hifabu@hifabu");
    const details = run("details", "hifabu@hifabu");
    const tokens = Number(details.match(/Always-on:\s+~?(\d+)\s+tok/)?.[1]);
    assert.ok(tokens <= 60, details);
    const selected = JSON.parse(run("list", "--json")).find(({ id }) => id === "hifabu@hifabu");
    assert.equal(selected.version, version);
    assert.equal(selected.enabled, true);
    t.diagnostic(added.trim() + " " + installed.trim() + " Always-on: " + tokens + " tok");
    return { config, env, installedRoot: selected.installPath, data: join(config, "plugins/data/hifabu-hifabu") };
  }

  const main = install("approve-home");
  const { config, installedRoot, data } = main;
  const transport = await localFixture(dir, { dataDir: data, maker: join(installedRoot, "bin/hifabu") });
  t.after(() => transport.close());
  const keychain = transport.useFakeKeychain();
  Object.assign(main.env, keychain.env);
  transport.groupSnapshot = { device: { id: "local-publisher", name: "测试发布机" }, reportedAt: Date.now(),
    groups: [{ name: "常用组", accounts: [{ platform: "bilibili", name: "Fixture A" }] },
      { name: "短片组", accounts: [{ platform: "douyin", name: "Fixture B" }] }] };
  const settings = join(config, "settings.json");
  const convention = join(project, ".hifabu/project.json");
  const preferences = join(data, "projects/p_example.json");
  const marker = join(data, "auto-update.json");
  const expectedProject = { id: "p_example", language: "zh", episodes: { video: "{episode}_{topic}*.mp4", pick: "highest-version", notCopy: ["*_文案.txt"] } };
  const raw = "05_纸飞机_v3.mp4";
  const variant = "05_纸飞机_另一剪辑.mp4";
  writeFileSync(join(project, raw), "normal clip");
  const source = join(project, variant);
  writeFileSync(source, "");
  truncateSync(source, 2 * 1024 ** 2);
  writeFileSync(join(project, "05_纸飞机_文案.txt"), "00:00:00 --> 00:00:01\n纸飞机字幕");
  const staging = join(data, "staging");
  mkdirSync(staging);
  const media = join(staging, variant);
  const hash = sha(readFileSync(source));
  const manifestPath = join(staging, "manifest.json");
  const manifest = {
    schema: "hifabu.delivery/1", work: { key: "p_example/05", title: "纸飞机" }, cuts: [{
      video: { name: variant, sha256: hash, size: statSync(source).size },
      copy: { default: { title: "纸飞机", body: "折一架纸飞机。", tags: ["手工"] } },
    }], target: { group: "常用组" }, from: { client: "hifabu-plugin/0.2.0" },
  };

  const bash = (...parts) => tool("Bash", { command: ["hifabu", "--data", quote(data), "--offline", ...parts, "--json"].join(" ") });
  const readRef = (filename, entry = main) => read(join(entry.installedRoot, refs, filename + ".md"));
  const enable = (entry) => {
    const path = join(entry.config, "settings.json");
    const oldSettings = readFileSync(path, "utf8");
    const edited = JSON.parse(oldSettings);
    edited.extraKnownMarketplaces.hifabu.autoUpdate = true;
    return [read(path), tool("Edit", { file_path: path, old_string: oldSettings.trimEnd(), new_string: pretty(edited).trimEnd() })];
  };
  const allow = (input) => ({ behavior: "allow", updatedInput: input });
  const conversation = async (entry, prompt, steps, { approve = true, answers = [] } = {}) => {
    assert.equal(model.steps.length, 0);
    model.steps.push(...steps);
    let trace;
    try {
      trace = await claudeConversation({ cwd: project, env: entry.env,
        args: ["--tools", "Skill,Read,Write,Edit,Bash", "--allowedTools", "Skill", "--max-turns", "32"],
        prompt, permission: ({ tool_name, input }) => tool_name === "Edit" && !approve
          ? { behavior: "deny", message: "User declined the auto-update edit" } : allow(input),
        answer: () => answers.shift(),
      });
    } finally {
      if (model.failure) throw model.failure;
    }
    assert.equal(model.steps.length, 0);
    return trace;
  };

  const disconnected = Promise.withResolvers();
  const ended = Promise.withResolvers();
  let dropAt = 0;
  transport.interrupt = async (digest, blob, req) => {
    if (digest !== hash || dropAt) return false;
    dropAt = blob.received;
    disconnected.resolve();
    await ended.promise;
    req.destroy();
    return true;
  };
  const flow = await conversation(main, "把第 05 期交给发布机", [
    skill, readRef("setup"), ...enable(main), write(marker, { asked: true }),
    bash("cloud", "status"), readRef("project-setup"), bash("scan", quote(project)),
    "成片从项目里找，按版本号选最新。确认这个约定吗？",
    write(convention, expectedProject), bash("group", "list"),
    "这个项目默认交到常用组（B 站），还是短片组（抖音）？",
    write(preferences, { group: "常用组" }), read(preferences), "有 v3 和另一剪辑，你选哪份？",
    readRef("copy"), "没有封面。草稿是《纸飞机》，折一架纸飞机。#手工，确认吗？",
    tool("Bash", { command: "cp " + quote(source) + " " + quote(media) }),
    write(manifestPath, manifest), bash("work", "push", quote(manifestPath), "--dry-run"),
    (request) => {
      assert.match(JSON.stringify(request.messages), /"dryRun"\s*:\s*true|dryRun\\+"\s*:\s*true/);
      return bash("work", "push", quote(manifestPath));
    },
    "已登记，常用组（B 站），现在后台传。",
  ], { answers: ["确认约定", "常用组", "另一剪辑", "确认文案"] });
  await disconnected.promise;
  assert.equal(transport.deliveries.size, 0, "Claude should exit before upload completes");
  ended.resolve();
  const delivery = await until(() => [...transport.deliveries.values()][0]);
  assert.ok(dropAt > 0);
  assert.deepEqual(transport.blobs.get(hash).offsets, [0, dropAt]);
  assert.equal(transport.blobs.get(hash).sha, hash);
  assert.equal(transport.deliveries.size, 1);
  assert.deepEqual(delivery.manifest, manifest);
  assert.equal(flow.turns.length, 5);
  assert.equal(flow.prompts.filter(({ tool_name }) => tool_name === "Edit").length, 1);
  assert.equal(JSON.parse(readFileSync(settings)).extraKnownMarketplaces.hifabu.autoUpdate, true);
  assert.equal(JSON.parse(readFileSync(settings)).extraKnownMarketplaces.hifabu.source.path, market);
  assert.deepEqual(JSON.parse(readFileSync(convention)), expectedProject);
  assert.deepEqual(JSON.parse(readFileSync(preferences)), { group: "常用组" });
  t.diagnostic(`Claude exited before upload completion; one delivery, interrupted at ${dropAt}, resumed at ${dropAt}, SHA-256 ${hash}`);

  const override = join(staging, "override.json");
  const status = await conversation(main, "这期交到短片组。然后问：到了吗？", [
    skill, read(marker), read(convention), read(preferences), bash("group", "list"),
    write(override, { ...manifest, target: { group: "短片组" } }),
    bash("work", "push", quote(override), "--dry-run"), bash("work", "push", quote(override)),
    "这次交到短片组。", readRef("status"), bash("delivery", "list"), bash("delivery", "show", delivery.id),
    "等发布机来取。",
  ], { answers: ["到了吗？"] });
  assert.ok(observed(status, /delivery show dl_/));
  assert.equal(status.prompts.filter(({ tool_name }) => tool_name === "Edit").length, 0);
  assert.deepEqual(JSON.parse(readFileSync(preferences)), { group: "常用组" });
  const overridden = await until(() => [...transport.deliveries.values()].find((row) => row.group === "短片组"));
  assert.equal(overridden.manifest.work.key, manifest.work.key);
  t.diagnostic("Second session retained the project group, one-off override delivered to another group, follow-up used delivery show");

  const snapshot = transport.groupSnapshot;
  const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000;
  snapshot.reportedAt = oldTimestamp;
  // The installed test client must use the same stub credential backend as the skill.
  const fromPlugin = (...args) => exec(join(installedRoot, "bin/hifabu"), [...transport.args, ...args],
    { env: main.env, encoding: "utf8", timeout: 30_000 }).catch((error) => error);
  const preview = () => fromPlugin("work", "push", manifestPath, "--dry-run");
  const value = ({ stdout, message, stderr }) => {
    assert.ok(stdout, message ?? stderr);
    return JSON.parse(stdout);
  };
  assert.equal(value(await fromPlugin("group", "list")).reportedAt, oldTimestamp);
  assert.equal(value(await preview()).dryRun, true);
  transport.groupSnapshot = null;
  assert.deepEqual(value(await fromPlugin("group", "list")), { groups: [], reportedAt: null, ok: true });
  assert.equal(value(await preview()).dryRun, true);
  transport.groupSnapshot = { ...snapshot, reportedAt: Date.now(), groups: snapshot.groups.slice(1) };
  const missing = await preview();
  assert.equal(missing.code, 1);
  assert.equal(value(missing).error.code, "group_not_found");
  assert.match(value(missing).error.message, /短片组/);
  assert.equal(transport.deliveries.size, 2);

  const negative = install("deny-home");
  const deniedMarker = join(negative.data, "auto-update.json");
  mkdirSync(negative.data, { recursive: true });
  const denied = await conversation(negative, "把第 05 期交给发布机", [
    skill, readRef("setup", negative), ...enable(negative), write(deniedMarker, { asked: true }), "记录了选择。",
  ], { approve: false });
  assert.equal(denied.prompts.filter(({ tool_name }) => tool_name === "Edit").length, 1);
  const next = await conversation(negative, "再交一期给发布机", [skill, read(deniedMarker), "沿用已有设置。"]);
  assert.equal(next.prompts.filter(({ tool_name }) => tool_name === "Edit").length, 0);
  assert.equal(JSON.parse(readFileSync(join(negative.config, "settings.json"))).extraKnownMarketplaces.hifabu.autoUpdate, undefined);
  assert.deepEqual(JSON.parse(readFileSync(deniedMarker)), { asked: true });
  t.diagnostic("Edit required permission in both branches. Decline persisted across sessions without altering settings.");

  const logout = await conversation(main, "退出 Hifabu", [skill, readRef("setup"), bash("cloud", "logout"), "已退出 Hifabu。"]);
  assert.ok(observed(logout, /cloud logout/));
  assert.equal(transport.credentialPresentAtRevoke, true);
  assert.equal(existsSync(transport.credentialPath), false);
  assert.equal(keychain.exists(), false);
  assert.equal((await transport.run("cloud", "status")).state, "logged_out");
  t.diagnostic("cloud logout revoked the device before deleting metadata and removed the stub Keychain item");
});
