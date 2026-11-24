import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openControlStore } from "../../cloud/src/control-store.mjs";
import { createCloudServer, sessionCookieName } from "../../cloud/src/server.mjs";
import { callCloud } from "../../cloud/src/transport.mjs";
import { close, fakeGoogle, listen } from "../../cloud/test/fake-google.mjs";

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
