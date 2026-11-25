import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMachineSigner } from "../../../packages/cloud/src/machine-token.mjs";
import { createRelayServer } from "../../../packages/relay/src/server.mjs";
import { inspectEpisode } from "../skills/handoff/inspect.mjs";

const exec = promisify(execFile);
const vk = fileURLToPath(new URL("../../../packages/cli/src/vk.mjs", import.meta.url));
const inspector = fileURLToPath(new URL("../skills/handoff/inspect.mjs", import.meta.url));
const copy = `## 01 赌徒谬误

封面：01_赌徒谬误_封面.png

第一期的发布文案。

#概率

## 02 习得性无助

**封面**：\`02_习得性无助_封面.png\`

第一段发布文案。

第二段发布文案。

#心理学 #知识科普

## 17 AI 算法简史（革命练习曲版）

封面：17_AI算法简史_封面.png

革命练习曲版的发布文案。

#AI #算法

## 17 AI 算法简史（灵动版）

封面：17_AI算法简史_灵动版_封面.png

灵动版的发布文案。

#AI #技术史`;

function fixture(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "handoff-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const project = join(temp, "vibe-video");
  const put = (path, contents = "") => {
    const filename = join(project, path);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, contents);
    return filename;
  };
  put("成片/文案/发布文案.md", copy);
  return { temp, project, put };
}

test("ACC-deliver-05: 01 从成片内的封面和文案目录取素材", (t) => {
  const { project, put } = fixture(t);
  put("成片/01_赌徒谬误_v2.mp4");
  const cover = put("成片/封面/01_赌徒谬误_封面.png");
  const result = inspectEpisode(project, "01");
  assert.equal(result.state, "ready");
  assert.equal(result.manifest.cuts[0].cover, cover);
  assert.deepEqual(result.manifest.cuts[0].copy.default, { title: "01 赌徒谬误", body: "第一期的发布文案。", tags: ["概率"] });
});

test("ACC-deliver-05: 多版本选最大编号，带封面和对应一节的发布文案", async (t) => {
  const { project, put } = fixture(t);
  const source = put("成片/02_习得性无助.mp4");
  put("成片/02_习得性无助_v2.mp4");
  const latest = put("成片/02_习得性无助_v3.mp4");
  put("成片/无水印/02_习得性无助_v4.mp4");
  const cover = put("成片/封面/02_习得性无助_封面.png");

  const { stdout } = await exec(process.execPath, [inspector, project, "2"]);
  const result = JSON.parse(stdout);
  assert.equal(result.state, "ready");
  assert.equal(result.coverMissing, false);
  assert.deepEqual(result.manifest, {
    title: "02 习得性无助", source,
    cuts: [{
      title: "02 习得性无助", cover,
      copy: { default: { title: "02 习得性无助", body: "第一段发布文案。\n\n第二段发布文案。", tags: ["心理学", "知识科普"] } },
      versions: [{ language: "zh", asset: latest }],
    }],
  });
  assert.equal(inspectEpisode(project).video.name, "02_习得性无助_v3.mp4");
  put("成片/02_习得性无助_v10.mp4");
  const next = inspectEpisode(project, "02");
  assert.equal(next.video.name, "02_习得性无助_v10.mp4");
  assert.equal(next.manifest.source, source);
});

test("ACC-plugin-dist-02: 从符号链接下的插件目录运行检查脚本会输出清单", async (t) => {
  const { temp, project, put } = fixture(t);
  put("成片/02_习得性无助_v3.mp4");
  const cachedSkill = join(temp, "plugin-skill");
  symlinkSync(dirname(inspector), cachedSkill, "junction");

  const { stdout } = await exec(process.execPath, [join(cachedSkill, "inspect.mjs"), project, "02"]);
  assert.equal(JSON.parse(stdout).state, "ready");
});

test("ACC-deliver-05: 17 两版各用对应封面和文案，灵动版每次需确认", (t) => {
  const { project, put } = fixture(t);
  const original = put("成片/17_AI算法简史.mp4");
  const variant = put("成片/17_AI算法简史_灵动版.mp4");
  const originalCover = put("成片/封面/17_AI算法简史_封面.png");
  const variantCover = put("成片/封面/17_AI算法简史_灵动版_封面.png");
  const result = inspectEpisode(project, "17");
  assert.equal(result.state, "choice_required");
  assert.deepEqual(result.choices.map(({ name }) => name).sort(), ["17_AI算法简史.mp4", "17_AI算法简史_灵动版.mp4"]);
  const regular = inspectEpisode(project, "17", "17_AI算法简史.mp4");
  assert.equal(regular.state, "ready");
  assert.equal(regular.manifest.cuts[0].cover, originalCover);
  assert.deepEqual(regular.manifest.cuts[0].copy.default, {
    title: "17 AI 算法简史（革命练习曲版）", body: "革命练习曲版的发布文案。", tags: ["AI", "算法"],
  });

  const chosen = inspectEpisode(project, "17", "17_AI算法简史_灵动版.mp4");
  assert.equal(chosen.state, "ready");
  assert.equal(chosen.manifest.source, original);
  assert.equal(chosen.manifest.cuts[0].versions[0].asset, variant);
  assert.equal(chosen.manifest.cuts[0].cover, variantCover);
  assert.deepEqual(chosen.manifest.cuts[0].copy.default, {
    title: "17 AI 算法简史（灵动版）", body: "灵动版的发布文案。", tags: ["AI", "技术史"],
  });
  assert.equal(inspectEpisode(project, "17").state, "choice_required");
  rmSync(original);
  assert.equal(inspectEpisode(project, "17").state, "choice_required");
});

test("ACC-deliver-05: 同号不同选题需要选择，文案按编号和选题取", (t) => {
  const { project, put } = fixture(t);
  put("成片/08_时空的维度.mp4");
  put("成片/08_从一维到十维.mp4");
  put("成片/文案/发布文案.md", "## 08 时空的维度\n\n另一部的发布文案\n\n## 08 从一维到十维\n\n这一部的发布文案\n\n#科学");

  const result = inspectEpisode(project, "08");
  assert.equal(result.state, "choice_required");
  assert.equal(result.choices.length, 2);
  const chosen = inspectEpisode(project, "08 从一维到十维");
  assert.equal(chosen.manifest.cuts[0].copy.default.body, "这一部的发布文案");
});

test("ACC-deliver-05: 缺封面时省略 cover，仍可交付", (t) => {
  const { project, put } = fixture(t);
  put("成片/02_习得性无助_v3.mp4");

  const result = inspectEpisode(project, "02");
  assert.equal(result.state, "ready");
  assert.equal(result.coverMissing, true);
  assert.equal(Object.hasOwn(result.manifest.cuts[0], "cover"), false);
});

test("ACC-deliver-05: 缺发布文案时等待草稿，字幕只作为参考", (t) => {
  const { project, put } = fixture(t);
  put("成片/21_李白的一生.mp4");
  const cover = put("成片/封面/21_李白的一生_封面.png");
  const subtitle = put("成片/文案/21_李白的一生_文案.txt", "00:00:00 --> 00:00:05\n字幕内容");

  const result = inspectEpisode(project, "21");
  assert.equal(result.state, "missing_copy");
  assert.equal(result.copyFile, join(project, "成片/文案/发布文案.md"));
  assert.equal(result.copyHeading, "## 21 李白的一生");
  assert.equal(result.subtitle, subtitle);
  assert.equal(result.manifest.cuts[0].cover, cover);
  assert.equal(Object.hasOwn(result.manifest.cuts[0], "copy"), false);
  assert.doesNotMatch(JSON.stringify(result.manifest), /字幕内容|_文案\.txt/);
  assert.equal(readFileSync(result.copyFile, "utf8"), copy);
});

async function until(probe) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await wait(100);
  }
  assert.fail("等不到离线投递的预期状态");
}

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("ACC-deliver-05: 离线 vk 登录后用原清单预览并登记，回查同一投递", {
  skip: process.platform === "win32",
  timeout: 25_000,
}, async (t) => {
  const { temp, project, put } = fixture(t);
  // vk 校验文件大小，联调用几个合成字节。解析夹具只需要空文件。
  put("成片/02_习得性无助_v3.mp4", "local fixture");
  const { manifest } = inspectEpisode(project, "02");
  const manifestFile = join(temp, "handoff.json");
  writeFileSync(manifestFile, JSON.stringify(manifest));

  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = createMachineSigner(privateKey.export({ type: "pkcs8", format: "pem" }));
  const relay = createRelayServer({
    dataDir: join(temp, "relay"), machinePublicKey: signer.publicPem, allowLegacyTokens: false,
    freeBytes: () => 5 * 1024 ** 3,
  });
  const relayOrigin = `http://127.0.0.1:${await relay.listen()}`;
  t.after(() => relay.close());
  let allowed = false;
  let loginRole;
  const account = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/api/devices/link") {
      const parts = [];
      for await (const part of req) parts.push(part);
      loginRole = JSON.parse(Buffer.concat(parts)).role;
      res.end(JSON.stringify({ code: "123456", url: `${origin}/link?code=${"a".repeat(32)}`, expiresAt: Date.now() + 60_000, pollToken: "p".repeat(43) }));
    } else if (req.method === "POST" && req.url === "/api/devices/link/poll") {
      if (!allowed) return res.end(JSON.stringify({ state: "waiting" }));
      const credential = signer.issue({
        userId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        role: "maker", relayEnabled: true, capacityBytes: 10 * 1024 ** 3,
      });
      res.end(JSON.stringify({
        state: "linked", role: "maker", email: "local@example.test", relayEnabled: true, relayUrl: relayOrigin,
        refreshToken: "r".repeat(43), ...credential,
      }));
    } else {
      res.writeHead(404).end(JSON.stringify({ message: "unexpected local test request" }));
    }
  });
  const origin = await listen(t, account);
  const opener = join(temp, process.platform === "darwin" ? "open" : "xdg-open");
  writeFileSync(opener, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const env = { ...process.env, VK_HOME: temp, VK_HIFABU_ORIGIN: origin, PATH: `${temp}:${process.env.PATH}` };
  const cli = (...args) => exec(process.execPath, [vk, ...args, "--json"], { env, timeout: 12_000 });
  const json = async (...args) => JSON.parse((await cli(...args)).stdout);
  await cli("init");

  const daemon = spawn(process.execPath, [vk, "serve", "--offline", "--port", "0"], { env, stdio: ["ignore", "ignore", "pipe"] });
  const daemonExit = once(daemon, "exit");
  t.after(async () => {
    daemon.kill("SIGTERM");
    await daemonExit;
  });
  let output = "";
  daemon.stderr.on("data", (value) => { output += value; });
  await until(() => output.includes("守护进程已启动"));

  assert.equal((await json("cloud", "status")).loggedIn, false);
  const login = cli("cloud", "login", "--role", "maker").catch((error) => ({ error }));
  const waiting = await until(async () => {
    const result = await json("cloud", "status");
    return result.state === "waiting" && result;
  });
  assert.equal(loginRole, "maker");
  assert.equal(waiting.code, "123456");
  assert.equal(new URL(waiting.url).origin, origin);
  allowed = true;
  const linked = await login;
  if (linked.error) throw linked.error;
  assert.equal(JSON.parse(linked.stdout).relayEnabled, true);
  assert.match(linked.stderr, /123456/);

  // 新登录的制作机没有默认账号组，传片凭证来自本次 Hifabu 登录。
  const preview = await json("work", "push", manifestFile, "--dry-run", "--group", "南竹");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.group, "南竹");
  assert.deepEqual(preview.rejected, []);
  assert.deepEqual((await json("delivery", "list")).deliveries, []);
  const sent = await json("work", "push", manifestFile, "--group", preview.group);
  assert.equal(sent.state, "pending");
  assert.match(sent.id, /^dl_[a-f0-9]+$/);
  const delivery = await until(async () => {
    const row = await json("delivery", "show", sent.id);
    return row.state === "waiting" && row;
  });
  assert.equal(delivery.title, manifest.title);
  assert.equal((await json("delivery", "list")).deliveries[0].id, sent.id);
});
