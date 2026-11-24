import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRelayServer } from "../../relay/src/server.mjs";
import { openControlStore } from "../src/control-store.mjs";
import { loadMachineSigner, createMachineTokenVerifier } from "../src/machine-token.mjs";
import { createCloudServer, sessionCookieName } from "../src/server.mjs";
import { callCloud, cloudRoute } from "../src/transport.mjs";
import { close, fakeGoogle, listen } from "./fake-google.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const exec = promisify(execFile);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const cookie = (token) => ({ Cookie: `${sessionCookieName}=${token}` });

test("ACC-cloud-05/06: 公开下载、传片申请、按账号统计、所有者开关和隐私删除", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hifabu-account-"));
  const dataDir = join(root, "cloud");
  const relayDir = join(root, "relay");
  const dbFile = join(dataDir, "control.db");
  const keyFile = join(root, "signing.pem");
  let now = Date.UTC(2026, 10, 24, 9);
  const clock = () => now;
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const signer = loadMachineSigner(keyFile, { clock });
  const verify = createMachineTokenVerifier(signer.publicPem, { clock });
  const relayEvents = [];
  const relayOptions = {
    dataDir: relayDir, machinePublicKey: signer.publicPem, allowLegacyTokens: true,
    pushToken: "local-legacy-push", pullToken: "local-legacy-pull", now: clock,
    freeBytes: () => 33_000_000_000, log: (entry) => relayEvents.push(entry),
  };
  const relay = createRelayServer(relayOptions);
  const relayPort = await relay.listen();
  const relayOrigin = `http://127.0.0.1:${relayPort}`;
  const google = await fakeGoogle(clock);
  const releases = createServer((req, res) => res.end(req.url === "/hifabu.dmg" ? "local Mac installer" : ""));
  const downloadUrl = `${await listen(releases)}/hifabu.dmg`;
  const listener = createServer();
  const origin = await listen(listener);
  const cloud = createCloudServer({
    origin, dataDir, clock, google: google.config, ownerEmail: " OWNER@example.test ",
    signingKeyFile: keyFile, relayUrl: relayOrigin, downloadUrl,
  });
  listener.on("request", (req, res) => cloud.emit("request", req, res));
  listener.once("close", () => cloud.emit("close"));
  t.after(async () => {
    await Promise.all([close(listener), close(google.server), close(releases), relay.server.listening ? relay.close() : null]);
    rmSync(root, { recursive: true, force: true });
  });

  const store = openControlStore(dbFile, { clock });
  const owner = store.signIn({ provider: "google", subject: "owner", email: "owner@example.test" });
  const creator = store.signIn({ provider: "google", subject: "creator", email: "creator@example.test" });
  const secondSession = store.signIn({ provider: "email", subject: "creator-email", email: creator.user.email });
  const other = store.signIn({ provider: "google", subject: "another", email: "another@example.test" });
  store.close();
  const id = creator.user.id;
  const account = cookie(creator.token);
  const ownerCookie = cookie(owner.token);
  const grant = { accountId: id };
  const cmd = (name, args, headers) => callCloud(origin, name, args, headers);
  const req = (path, headers, options) => fetch(new URL(path, origin), { headers, redirect: "manual", ...options });
  const html = async (path, headers) => {
    const res = await req(path, { Accept: "text/html", ...headers });
    assert.equal(res.status, 200);
    return res.text();
  };
  const cliCommand = async (args, token = owner.token) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], {
      env: { ...process.env, HIFABU_ORIGIN: origin, HIFABU_SESSION_TOKEN: token },
    });
    return JSON.parse(stdout);
  };
  const relayRequest = (method, path, token, body) => fetch(`${relayOrigin}${path}`, { method, headers: auth(token), body });

  await t.test("下载链接可匿名打开，账号专属内容需先登录", async () => {
    const page = await html("/account");
    assert.ok(page.includes(`href="${downloadUrl}"`));
    assert.doesNotMatch(page, /给 Claude 装插件|我的机器|申请开通/);
    assert.equal(await (await fetch(downloadUrl)).text(), "local Mac installer");
    const signedIn = await html("/account", account);
    assert.match(signedIn, /帮我安装 Hifabu 插件，地址是 hifabu\.com\/plugin/);
    assert.match(signedIn, /还没有机器/);
    assert.match(signedIn, /申请开通/);
    assert.doesNotMatch(signedIn, /另一个账号|排期|作品库|管理<\/a>|传片已被关闭/);
    assert.equal((await req("/admin")).status, 403);
    assert.equal((await req("/admin", account)).status, 403);
    assert.equal((await req(`/admin?delete=${id}`, account)).status, 403);
    await assert.rejects(cmd("user.list", {}, account), { status: 403, code: "owner_required" });
    await assert.rejects(cmd("relay.grant.set", { ...grant, state: "on" }, account), { status: 403, code: "owner_required" });
    await assert.rejects(cmd("user.delete", { ...grant, confirmEmail: creator.user.email }, account), { status: 403, code: "owner_required" });
    assert.deepEqual(await cmd("relay.grant.status", {}, account), {
      enabled: false, requestedAt: null, closedAt: null, capacityBytes: 10_000_000_000, usedBytes: null,
    });
  });

  const challenge = await cmd("device.link.start", { name: "制作 Mac <本地>", role: "maker" });
  const code = new URL(challenge.url).searchParams.get("code");
  await cmd("device.link.decide", { code, decision: "allow" }, account);
  const linked = await cmd("device.link.poll", {}, auth(challenge.pollToken));
  assert.equal(verify(linked.machineToken).relayEnabled, false);

  let enabledMachine;
  await t.test("同一个账号只记一条申请，开通后新签机器令牌带开关与容量", async () => {
    const requestPath = cloudRoute("relay.grant.request").path;
    assert.equal((await req(requestPath, account, { method: "POST" })).status, 403);
    assert.equal((await req(requestPath, { ...account, Origin: origin, Accept: "text/html" }, { method: "POST" })).status, 303);
    const requestedAt = now;
    now += 3 * 60_000;
    assert.equal((await cliCommand(["relay", "grant", "request"], creator.token)).requestedAt, requestedAt);
    const waiting = await html("/account", account);
    assert.match(waiting, /已经申请，等开通/);
    assert.match(waiting, /制作 Mac &lt;本地&gt;.*制作机/);
    assert.match(waiting, /3\s*分钟前<\/time>在线/);
    assert.doesNotMatch(await html("/account", cookie(other.token)), /制作 Mac/);
    const admin = await html("/admin", ownerCookie);
    assert.match(admin, /1 条待处理申请/);
    assert.match(admin, /class="pending"/);
    assert.match(admin, /申请了/);
    assert.match(admin, /value="10"/);
    assert.doesNotMatch(admin, /制作 Mac|platform|作品库|排期/);
    await assert.rejects(cmd("relay.grant.set", { ...grant, capacityGb: -1 }, ownerCookie), { status: 400 });
    await assert.rejects(cmd("relay.grant.set", { ...grant, state: "unexpected" }, ownerCookie), { status: 400 });
    assert.equal(await cliCommand(["relay", "grant", "set", id, "keep", "0.0000001"]).then((x) => x.requestedAt), requestedAt);
    const grantPath = cloudRoute("relay.grant.set", grant).path;
    const enabled = await req(grantPath, { ...ownerCookie, Origin: origin, Accept: "text/html" }, {
      method: "POST", body: new URLSearchParams({ state: "on" }),
    });
    assert.equal(enabled.status, 303);
    assert.equal(enabled.headers.get("Location"), "/admin");
    enabledMachine = await cmd("device.refresh", {}, auth(linked.refreshToken));
    assert.equal(verify(enabledMachine.machineToken).relayEnabled, true);
    assert.equal(verify(enabledMachine.machineToken).capacityBytes, 100);
    const listing = await cliCommand(["user", "list"]);
    assert.equal(listing.freeBytes, 33_000_000_000);
    assert.deepEqual(new Set(listing.users.map(({ email }) => email)), new Set([owner.user.email, creator.user.email, other.user.email]));
    assert.equal(listing.users.find((user) => user.id === id).requestedAt, null);
  });

  const relayPath = `/v1/control/accounts/${id}`;
  await t.test("每个账号用量对应真实上传，快满显示黄色，满了显示红色", async () => {
    const upload = async (count) => {
      const body = Buffer.alloc(count, count);
      const sha = createHash("sha256").update(body).digest("hex");
      const res = await relayRequest("PUT", `/v1/blobs/${sha}?total=${count}`, enabledMachine.machineToken, body);
      assert.equal(res.status, 201);
    };
    await upload(13);
    assert.match(await html("/account", account), /<meter class="good" value="0\.13"/);
    await upload(78);
    assert.match(await html("/account", account), /<meter class="warn" value="0\.91"/);
    await upload(9);
    assert.match(await html("/account", account), /<meter class="bad" value="1"/);
    assert.equal((await cmd("relay.grant.status", {}, account)).usedBytes, 100);
    const list = (await cmd("user.list", {}, ownerCookie)).users;
    assert.equal(list.find((user) => user.id === id).usedBytes, 100);
    assert.equal(list.find((user) => user.id === other.user.id).usedBytes, 0);
    assert.equal(existsSync(join(relayDir, other.user.id)), false, "只读用量不会创建账号目录");

    assert.equal((await cliCommand(["relay", "grant", "set", id, "off"])).closedAt, now);
    const closed = await cmd("device.refresh", {}, auth(linked.refreshToken));
    assert.equal(verify(closed.machineToken).relayEnabled, false);
    assert.equal(existsSync(join(relayDir, id)), true);
    const closedPage = await html("/account", account);
    assert.match(closedPage, /传片已被关闭/);
    assert.match(closedPage, /申请开通/);
    now += 1000;
    const reopened = await cmd("relay.grant.request", {}, account);
    assert.equal(reopened.requestedAt, now);
    const waiting = await html("/account", account);
    assert.match(waiting, /已经申请，等开通/);
    assert.doesNotMatch(waiting, /传片已被关闭/);
  });

  await t.test("确认前不删除，CLI 删除四类账号数据和文件，旧机器无法重建目录", async () => {
    const preview = await html(`/admin?delete=${id}`, ownerCookie);
    assert.match(preview, /确认删除/);
    assert.ok(preview.includes(creator.user.email));
    assert.equal((await relayRequest("GET", relayPath, enabledMachine.machineToken)).status, 401);
    assert.equal((await relayRequest("DELETE", relayPath, enabledMachine.machineToken)).status, 401);
    assert.equal((await relayRequest("DELETE", relayPath, relayOptions.pushToken)).status, 401);
    assert.equal((await relayRequest("DELETE", relayPath, signer.relayControl("GET", id))).status, 401);
    assert.equal((await relayRequest("DELETE", relayPath, signer.relayControl("DELETE", other.user.id))).status, 401);
    assert.equal((await relayRequest("GET", "/v1/ping", signer.relayControl("GET", id))).status, 401);
    const expired = signer.relayControl("DELETE", id);
    now += 30_000;
    assert.equal((await relayRequest("DELETE", relayPath, expired)).status, 401);
    await assert.rejects(cmd("user.delete", grant, ownerCookie), /confirmEmail/);
    await assert.rejects(cmd("user.delete", { ...grant, confirmEmail: other.user.email }, ownerCookie),
      { status: 400, code: "delete_confirmation_invalid" });
    assert.equal(existsSync(join(relayDir, id)), true);

    const incoming = Promise.withResolvers();
    relay.server.once("request", incoming.resolve);
    let uploadBody;
    const inFlight = fetch(`${relayOrigin}/v1/deliveries`, {
      method: "POST", duplex: "half", headers: auth(enabledMachine.machineToken),
      body: new ReadableStream({ start(controller) {
        uploadBody = controller;
        controller.enqueue(Buffer.from("{"));
      } }),
    });
    try {
      await incoming.promise;
      await assert.rejects(cmd("user.delete", { ...grant, confirmEmail: creator.user.email }, ownerCookie),
        { status: 409, code: "account_relay_busy" });
      assert.equal(existsSync(join(relayDir, id)), true);
    } finally {
      uploadBody.enqueue(Buffer.from("}"));
      uploadBody.close();
      assert.equal((await inFlight).status, 400);
    }

    const anotherMachine = signer.issue({
      userId: other.user.id, deviceId: other.user.id, role: "executor", relayEnabled: true, capacityBytes: 100,
    });
    assert.equal((await relayRequest("GET", "/v1/ping", anotherMachine.machineToken)).status, 200);
    const control = openControlStore(dbFile, { clock });
    control.beginLogin(code);
    control.beginLogin("unrelated");
    control.close();
    assert.deepEqual(await cliCommand(["user", "delete", id, creator.user.email]), { deleted: true });
    assert.equal(existsSync(join(relayDir, id)), false);
    assert.equal(existsSync(join(relayDir, other.user.id)), true);
    assert.equal((await relayRequest("GET", "/v1/ping", enabledMachine.machineToken)).status, 401);
    assert.equal(existsSync(join(relayDir, id)), false, "旧令牌不能重建已删除目录");
    const reading = new DatabaseSync(dbFile, { readOnly: true });
    try {
      assert.equal(reading.prepare("SELECT count(*) AS n FROM user WHERE id = ?").get(id).n, 0);
      for (const table of ["identity", "session", "device", "relay_grant"]) {
        assert.equal(reading.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).get(id).n, 0, table);
      }
      assert.deepEqual(reading.prepare("SELECT link_code FROM login_code").all().map((row) => row.link_code), ["unrelated"]);
    } finally {
      reading.close();
    }
    for (const token of [creator.token, secondSession.token]) {
      assert.deepEqual(await cmd("session.get", {}, cookie(token)), { user: null });
    }
    await assert.rejects(cmd("device.refresh", {}, auth(linked.refreshToken)), { status: 401 });
    assert.deepEqual(await cmd("device.link.poll", {}, auth(challenge.pollToken)), { state: "expired" });
    assert.equal((await relayRequest("DELETE", relayPath, signer.relayControl("DELETE", id))).status, 200, "中转删除可幂等重试");
    assert.ok(relayEvents.some((event) => event.includes("account.deleted")));
    assert.deepEqual(await cmd("session.get", {}, cookie(other.token)).then((result) => result.user.email), other.user.email);

    const logs = readdirSync(join(dataDir, "logs")).map((file) => readFileSync(join(dataDir, "logs", file), "utf8")).join("");
    assert.equal(logs.match(/relay\.grant\.requested/g).length, 2);
    assert.match(logs, /account\.deleted/);
    assert.match(logs, /delete_confirmation_invalid/);
    assert.ok(!logs.includes(creator.user.email) && !logs.includes(linked.refreshToken));

    await relay.close();
    const restarted = createRelayServer(relayOptions);
    try {
      const ping = `http://127.0.0.1:${await restarted.listen()}/v1/ping`;
      assert.equal((await fetch(ping, { headers: auth(enabledMachine.machineToken) })).status, 401);
      assert.equal(existsSync(join(relayDir, id)), false);
      assert.equal((await fetch(ping, { headers: auth(anotherMachine.machineToken) })).status, 200);
    } finally {
      await restarted.close();
    }

    const missingRelay = await req(cloudRoute("user.delete", { accountId: other.user.id }).path,
      { ...ownerCookie, Origin: origin, Accept: "text/html" }, {
        method: "POST", body: new URLSearchParams({ confirmEmail: other.user.email }),
      });
    assert.equal(missingRelay.status, 502);
    assert.match(await missingRelay.text(), /账号已保留/);
    assert.equal((await cmd("session.get", {}, cookie(other.token))).user.email, other.user.email);
  });
});
