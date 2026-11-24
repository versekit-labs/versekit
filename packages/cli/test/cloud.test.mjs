import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openControlStore } from "../../cloud/src/control-store.mjs";
import { createCloudServer, machineKeyPath, sessionCookieName } from "../../cloud/src/server.mjs";
import { callCloud } from "../../cloud/src/transport.mjs";
import { close, fakeGoogle, listen } from "../../cloud/test/fake-google.mjs";
import { ping } from "../../relay/src/index.mjs";

const vk = fileURLToPath(new URL("../src/vk.mjs", import.meta.url));
const exec = promisify(execFile);

async function freePort() {
  const socket = createServer();
  await listen(socket);
  const { port } = socket.address();
  await close(socket);
  return port;
}

async function until(probe) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await wait(100);
  }
  assert.fail("等不到离线 vk 的登录状态");
}

test("ACC-cloud-03: vk 和本机 HTTP 共用接入状态，浏览器允许后 CLI 自动继续", {
  skip: process.platform === "win32",
}, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "vk-cl-"));
  let cloud;
  let google;
  let daemon;
  let daemonExit;
  t.after(async () => {
    if (daemon) {
      daemon.kill("SIGTERM");
      await daemonExit;
    }
    if (cloud?.listening) await close(cloud);
    if (google?.server.listening) await close(google.server);
    rmSync(home, { recursive: true, force: true });
  });

  let delta = 0;
  const clock = () => Date.now() + delta;
  google = await fakeGoogle(clock);
  const cloudPort = await freePort();
  const origin = `http://127.0.0.1:${cloudPort}`;
  const signingKeyFile = join(home, "key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(signingKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  cloud = createCloudServer({ origin, google: google.config, signingKeyFile, dataDir: home, clock });
  await listen(cloud, cloudPort);
  const store = openControlStore(join(home, "control.db"), { clock });
  const { token } = store.signIn({ provider: "google", subject: randomUUID(), email: "offline@example.test" });
  store.close();
  const session = { Cookie: `${sessionCookieName}=${token}` };
  const browserPath = join(home, "opened-url");
  const opener = join(home, process.platform === "darwin" ? "open" : "xdg-open");
  writeFileSync(opener, '#!/bin/sh\nprintf "%s" "$1" > "$VK_TEST_BROWSER_OUTPUT"\n', { mode: 0o700 });
  const env = {
    ...process.env, VK_HOME: home, VK_HIFABU_ORIGIN: origin, VK_TEST_BROWSER_OUTPUT: browserPath,
    PATH: `${home}:${process.env.PATH}`,
  };
  const cli = (args) => exec(process.execPath, [vk, ...args], { env, timeout: 20_000 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, body) => {
    const res = await fetch(base + path, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : {});
    return res.json();
  };
  const status = () => request("/api/cloud/status");
  await cli(["demo", "seed"]);
  daemon = spawn(process.execPath, [vk, "serve", "--offline", "--port", String(port)], { env, stdio: "ignore" });
  daemonExit = once(daemon, "exit");
  await until(() => status().catch(() => false));
  assert.equal((await status()).loggedIn, false);

  const login = cli(["cloud", "login", "--role", "maker", "--name", "本地测试制作机"]);
  // Attach a rejection handler while the browser is being exercised.
  const completion = login.then((result) => ({ result }), (error) => ({ error }));
  const pending = await until(async () => {
    const result = await status();
    return result.state === "waiting" && existsSync(browserPath) && result;
  });
  assert.match(pending.code, /^\d{6}$/);
  assert.equal(readFileSync(browserPath, "utf8"), pending.url);
  const code = new URL(pending.url).searchParams.get("code");
  await callCloud(origin, "device.link.decide", { code, decision: "allow" }, session);
  const completed = await completion;
  if (completed.error) throw completed.error;
  const data = JSON.parse(completed.result.stdout);
  assert.equal(data.email, "offline@example.test");
  assert.equal(data.role, "maker");
  assert.equal(data.relayEnabled, false);
  assert.equal(data.loggedIn, true);
  assert.ok(completed.result.stderr.includes(pending.code));
  assert.deepEqual(JSON.parse((await cli(["cloud", "status"])).stdout), await status());
  const credentialFile = join(home, ".config", "versekit", "credentials", "hifabu-machine.json");
  const saved = JSON.parse(readFileSync(credentialFile, "utf8"));
  assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
  assert.ok(saved.machineToken && saved.refreshToken);
  assert.doesNotMatch(completed.result.stdout, /machineToken|refreshToken/);
  await cli(["cloud", "logout"]);
  assert.equal((await status()).loggedIn, false);
  assert.ok(!existsSync(credentialFile));

  const rejected = await request("/api/cloud/login", { name: "拒绝测试", role: "executor" });
  await callCloud(origin, "device.link.decide", { code: new URL(rejected.url).searchParams.get("code"), decision: "deny" }, session);
  await until(async () => (await status()).state === "denied");
  const expiring = await request("/api/cloud/login", { name: "过期测试", role: "executor" });
  assert.equal(expiring.state, "waiting");
  delta += 600_001;
  await until(async () => (await status()).state === "expired");
  assert.ok(!existsSync(credentialFile));
});

test("ACC-cloud-08: 关掉固定令牌后，制作机队列与发布机后台拉取都用刷新后的机器令牌", { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "vk398-"));
  const children = [];
  let google;
  let cloud;
  t.after(async () => {
    for (const { child, exited } of children.reverse()) {
      child.kill("SIGTERM");
      await exited;
    }
    if (cloud?.listening) await close(cloud);
    if (google?.server.listening) await close(google.server);
    rmSync(home, { recursive: true, force: true });
  });
  const cli = async (role, ...args) => JSON.parse((await exec(process.execPath, [vk, ...args], {
    env: { ...process.env, VK_HOME: join(home, role) }, timeout: 10_000,
  })).stdout);
  async function serve(role, args, ready) {
    const child = spawn(process.execPath, [vk, ...args], {
      env: { ...process.env, VK_HOME: join(home, role), VERSEKIT_RELAY_START_DELAY_MS: "100" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    children.push({ child, exited });
    let logs = "";
    child.stderr.on("data", (chunk) => { logs += chunk; });
    await until(() => {
      assert.equal(child.exitCode, null, logs);
      return logs.includes(ready);
    });
  }

  const relayHome = join(home, "r");
  const port = await freePort();
  const relayUrl = `http://127.0.0.1:${port}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const signingKeyFile = join(home, "private.pem");
  writeFileSync(signingKeyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  google = await fakeGoogle();
  cloud = createCloudServer({ origin, google: google.config, signingKeyFile, dataDir: home, relayUrl });
  await listen(cloud, Number(new URL(origin).port));
  const controlDb = join(home, "control.db");
  const store = openControlStore(controlDb);
  const { token, user } = store.signIn({ provider: "google", subject: randomUUID(), email: "relay@example.test" });
  store.close();
  const session = { Cookie: `${sessionCookieName}=${token}` };
  const publicKey = await fetch(origin + machineKeyPath);
  assert.equal(publicKey.status, 200);
  const keyFile = join(home, "public.pem");
  writeFileSync(keyFile, await publicKey.text());
  const relayConfigDir = join(relayHome, ".config", "versekit");
  mkdirSync(relayConfigDir, { recursive: true });
  writeFileSync(join(relayConfigDir, "config.json"), JSON.stringify({ relay: {
    machine_public_key_file: keyFile, allow_legacy_tokens: false, push_token: "legacy-push", pull_token: "legacy-pull",
  } }));
  await serve("r", ["relay", "serve", "--port", String(port)], `监听 127.0.0.1:${port}`);
  await assert.rejects(ping({ url: relayUrl, token: "legacy-push" }), { status: 401 });
  await assert.rejects(ping({ url: relayUrl, token: "legacy-pull" }), { status: 401 });

  async function prepare(name, role) {
    const challenge = await callCloud(origin, "device.link.start", { role, name });
    const code = new URL(challenge.url).searchParams.get("code");
    await callCloud(origin, "device.link.decide", { code, decision: "allow" }, session);
    const linked = await callCloud(origin, "device.link.poll", {}, { Authorization: `Bearer ${challenge.pollToken}` });
    assert.equal(linked.state, "linked");
    await cli(name, "init");
    const configDir = join(home, name, ".config", "versekit");
    const configFile = join(configDir, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.relay = { url: relayUrl, default_group: "测试账号组", interval_minutes: 0.003,
      [role === "maker" ? "push_token" : "pull_token"]: role === "maker" ? "legacy-push" : "legacy-pull" };
    writeFileSync(configFile, JSON.stringify(config));
    const credentials = join(configDir, "credentials", "hifabu-machine.json");
    // 模拟重启时本机留有到期前缓存，账号服务此时已经开通传片。
    writeFileSync(credentials, JSON.stringify({ ...linked, origin, checkedAt: Date.now(), expiresAt: Date.now() - 1000 }), { mode: 0o600 });
    return { credentials, linked };
  }
  const maker = await prepare("m", "maker");
  const executor = await prepare("e", "executor");
  const db = new DatabaseSync(controlDb);
  try {
    db.prepare("UPDATE relay_grant SET enabled = 1 WHERE user_id = ?").run(user.id);
  } finally {
    db.close();
  }
  await serve("m", ["serve", "--offline", "--port", "0"], "守护进程已启动");
  const asset = "video.mp4";
  writeFileSync(join(home, asset), "local video");
  const manifest = join(home, "work.json");
  writeFileSync(manifest, JSON.stringify({ title: "本地测试", cuts: [{ title: "成片", versions: [{ language: "zh", asset }] }] }));
  const { id } = await cli("m", "work", "push", manifest);
  await until(async () => (await cli("m", "delivery", "list")).deliveries.some((d) => d.id === id && d.state === "waiting"));
  assert.notEqual(JSON.parse(readFileSync(maker.credentials)).machineToken, maker.linked.machineToken);

  await serve("e", ["serve", "--offline", "--port", "0"], "守护进程已启动");
  // 此处故意未建组，验证发布机确实下载并回报了入库错误。
  const failed = await until(async () => {
    const row = await cli("m", "delivery", "show", id);
    return row.state === "failed" && row;
  });
  assert.match(failed.reason, /没有账号组「测试账号组」/);
  const status = await until(async () => {
    const state = await cli("e", "relay", "status");
    return state.lastPullAt && state;
  });
  assert.equal(status.url, relayUrl);
  assert.equal(status.configured, true);
  assert.equal(status.failures[0].id, id);
  assert.notEqual(JSON.parse(readFileSync(executor.credentials)).machineToken, executor.linked.machineToken);
  const { ingested, failed: failures, pending } = await cli("e", "relay", "pull");
  assert.deepEqual({ ingested, failures, pending }, { ingested: [], failures: [], pending: [] });
});
