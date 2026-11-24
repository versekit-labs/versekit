import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openControlStore } from "../src/control-store.mjs";
import { tokenHash } from "../src/google.mjs";
import { createMachineTokenVerifier } from "../src/machine-token.mjs";
import { createCloudServer, machineKeyPath, sessionCookieName } from "../src/server.mjs";
import { callCloud, cloudRoute } from "../src/transport.mjs";
import { close, fakeGoogle, listen } from "./fake-google.mjs";

const sessionCookie = (token) => ({ Cookie: `${sessionCookieName}=${token}` });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

test("ACC-cloud-03/04: 接入终态、刷新、账号隔离及退出这台", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vk-device-link-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_790_000_000_000;
  const clock = () => now;
  const google = await fakeGoogle(clock);
  const signingKeyFile = join(directory, "key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(signingKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const origin = "http://127.0.0.1:8791";
  const relayUrl = "http://127.0.0.1:8792";
  const service = createCloudServer({ origin, relayUrl, dataDir: directory, google: google.config, signingKeyFile, clock });
  const base = await listen(service);
  t.after(async () => {
    await close(service);
    await close(google.server);
  });
  const request = (path, options = {}) => fetch(new URL(path, base), { redirect: "manual", ...options });
  const command = (name, args, headers) => callCloud(base, name, args, { Origin: origin, ...headers });
  const start = (role) => command("device.link.start", { name: '书房的 Mac <样例>', os: "macOS", role });
  const poll = (challenge) => command("device.link.poll", {}, bearer(challenge.pollToken));
  const decision = (challenge) => cloudRoute("device.link.decide", { code: new URL(challenge.url).searchParams.get("code") }).path;
  const displayPath = (challenge) => new URL(challenge.url).pathname + new URL(challenge.url).search;

  const challenge = await start("executor");
  assert.match(challenge.code, /^\d{6}$/);
  assert.equal(challenge.expiresAt, now + 600_000);
  const display = displayPath(challenge);
  assert.ok(!display.includes(challenge.pollToken));
  assert.deepEqual(await poll(challenge), { state: "waiting" });
  assert.deepEqual(await command("device.link.poll", {}, bearer("A".repeat(43))), { state: "expired" });
  assert.match(await (await request(display)).text(), /先登录 Hifabu 账号/);

  const authCode = new URL(challenge.url).searchParams.get("code");
  const loginPage = await request(`/login?code=${authCode}`);
  assert.match(await loginPage.text(), /登录后继续接入「书房的 Mac &lt;样例&gt;」。/);
  const begin = await request("/login/google", {
    method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ code: authCode }),
  });
  const provider = await fetch(begin.headers.get("location"), { redirect: "manual" });
  const callback = new URL(provider.headers.get("location"));
  const complete = await request(callback.pathname + callback.search, {
    headers: { Cookie: begin.headers.getSetCookie()[0].split(";")[0] },
  });
  assert.equal(complete.headers.get("location"), display);
  const account = {
    Cookie: complete.headers.getSetCookie().find((cookie) => cookie.startsWith(`${sessionCookieName}=`)).split(";")[0],
  };
  const pendingPage = await (await request(display, { headers: account })).text();
  assert.match(pendingPage, /作为发布机/);
  assert.match(pendingPage, /它能做/);
  assert.match(pendingPage, /它不能做/);
  assert.ok(pendingPage.includes(challenge.code));
  assert.ok(!pendingPage.includes(challenge.pollToken));
  assert.doesNotMatch(pendingPage, /<input/);
  assert.doesNotMatch(pendingPage, /<样例>/);

  const allowForm = { method: "POST", body: new URLSearchParams({ decision: "allow" }) };
  assert.equal((await request(decision(challenge), { ...allowForm, headers: account })).status, 403);
  assert.equal((await request(decision(challenge), { ...allowForm, headers: { Origin: origin } })).status, 401);
  const allow = await request(decision(challenge), { ...allowForm, headers: { ...account, Origin: origin, Accept: "text/html" } });
  assert.equal(allow.status, 303);
  assert.equal(allow.headers.get("location"), display);
  assert.match(await (await request(display, { headers: account })).text(), /接上了/);
  const linked = await poll(challenge);
  assert.equal(linked.state, "linked");
  assert.equal(linked.email, "creator@example.test");
  assert.equal(linked.relayUrl, relayUrl);
  assert.equal(linked.relayEnabled, false);
  assert.equal(linked.expiresAt, now + 3_600_000);
  assert.equal((await poll(challenge)).refreshToken, linked.refreshToken, "网络重试取得同一个刷新凭证");
  const publicPem = await (await request(machineKeyPath)).text();
  assert.match(publicPem, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(publicPem, /PRIVATE KEY/);
  const verify = createMachineTokenVerifier(publicPem, { clock });
  const claims = verify(linked.machineToken);
  assert.equal(claims.role, "executor");
  assert.equal(claims.relayEnabled, false);
  assert.equal(claims.capacityBytes, 10_000_000_000);

  const dbFile = join(directory, "control.db");
  const db = new DatabaseSync(dbFile);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT refresh_token_hash AS hash FROM device").get().hash, tokenHash(linked.refreshToken));
  db.prepare("UPDATE relay_grant SET enabled = 1, capacity_bytes = 2500000000 WHERE user_id = ?").run(claims.sub);
  const renewed = await command("device.refresh", {}, bearer(linked.refreshToken));
  assert.equal(renewed.relayEnabled, true);
  assert.equal(verify(renewed.machineToken).capacityBytes, 2_500_000_000);
  assert.equal(verify(renewed.machineToken).deviceId, claims.deviceId);
  await assert.rejects(command("device.refresh", {}, bearer(challenge.pollToken)), { status: 401, code: "device_inactive" });

  const store = openControlStore(dbFile, { clock });
  const other = store.signIn({ provider: "google", subject: "other", email: "other@example.test" });
  store.close();
  const machine = { deviceId: claims.deviceId };
  await assert.rejects(command("device.revoke", machine, sessionCookie(other.token)), { status: 404 });
  assert.deepEqual(await command("device.list", {}, sessionCookie(other.token)), { machines: [] });
  assert.equal((await request(display, { headers: sessionCookie(other.token) })).status, 410);
  const owned = await command("device.list", {}, account);
  assert.equal(owned.machines.length, 1);
  assert.equal(owned.machines[0].id, claims.deviceId);
  assert.match(await (await request("/account", { headers: account })).text(), /退出这台/);
  assert.deepEqual(await command("device.revoke", machine, account), { revoked: true });
  assert.deepEqual(await command("device.list", {}, account), { machines: [] });
  await assert.rejects(command("device.refresh", {}, bearer(linked.refreshToken)), { status: 401, code: "device_inactive" });
  await assert.rejects(poll(challenge), { status: 401, code: "device_inactive" });
  assert.ok(verify(linked.machineToken), "已经签发的令牌只能等到期");

  const denied = await start("maker");
  const makerPage = await (await request(displayPath(denied), { headers: account })).text();
  assert.match(makerPage, /制作机/);
  const deny = await request(decision(denied), {
    method: "POST", headers: { ...account, Origin: origin, Accept: "text/html" }, body: new URLSearchParams({ decision: "deny" }),
  });
  assert.equal(deny.status, 303);
  assert.deepEqual(await poll(denied), { state: "denied" });
  assert.match(await (await request(displayPath(denied), { headers: account })).text(), /已拒绝/);
  assert.equal((await request(decision(denied), { ...allowForm, headers: { ...account, Origin: origin } })).status, 200);
  assert.deepEqual(await poll(denied), { state: "denied" });

  const expired = await start("executor");
  now += 600_000;
  assert.deepEqual(await poll(expired), { state: "expired" });
  const expiredPage = await request(displayPath(expired), { headers: account });
  assert.equal(expiredPage.status, 410);
  assert.match(await expiredPage.text(), /这次接入过期了/);
  assert.equal((await request(decision(expired), { ...allowForm, headers: { ...account, Origin: origin } })).status, 410);
  now = linked.expiresAt;
  assert.equal(verify(linked.machineToken), null);

  const logsDir = join(directory, "logs");
  const logs = readdirSync(logsDir).map((file) => readFileSync(join(logsDir, file), "utf8")).join("");
  for (const secret of [challenge.code, challenge.pollToken, linked.refreshToken, linked.machineToken]) {
    assert.ok(!logs.includes(secret), "日志不含核对码或凭据");
  }
  for (const event of ["device.link.allowed", "device.link.denied", "device.link.expired", "device.revoked", "device.refresh.failed"]) {
    assert.ok(logs.includes(event), `日志记录 ${event}`);
  }
});
