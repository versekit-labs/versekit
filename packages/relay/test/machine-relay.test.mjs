import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { createMachineSigner } from "../../cloud/src/machine-token.mjs";
import { createRelayServer, listDeliveryStatus, getDeliveryStatus, ping, pullOnce, pushDelivery, RETENTION_MS } from "../src/index.mjs";

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PUSH = "legacy-push";
const PULL = "legacy-pull";
const sha = (data) => createHash("sha256").update(data).digest("hex");

async function fixture(t, { legacy = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "vk-machine-relay-"));
  const dataDir = join(home, "relay");
  const now = Date.now();
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = createMachineSigner(privateKey.export({ type: "pkcs8", format: "pem" }), { clock: () => now });
  const options = { dataDir, machinePublicKey: signer.publicPem, pushToken: PUSH, pullToken: PULL, now: () => now, freeBytes: () => 5 * 1024 ** 3 };
  let server;
  let url;
  async function start(allowLegacyTokens) {
    if (server) await server.close();
    server = createRelayServer({ ...options, allowLegacyTokens });
    url = `http://127.0.0.1:${await server.listen()}`;
  }
  t.after(async () => {
    if (server) await server.close();
    rmSync(home, { recursive: true, force: true });
  });
  await start(legacy);
  const issue = (userId, role, capacityBytes = 1000, relayEnabled = true, issuer = signer) => issuer.issue({
    userId, role, capacityBytes, relayEnabled,
    deviceId: `${userId.slice(1)}${role === "maker" ? "X" : "Y"}`,
  }).machineToken;
  const file = (name, data) => {
    const path = join(home, name);
    writeFileSync(path, data);
    return { path, sha256: sha(data), size: Buffer.byteLength(data), name };
  };
  const send = (token, method, path, body, options) => fetch(`${url}/v1${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }, body, ...options,
  });
  const push = (token, group, files, id) => pushDelivery({ url, token, group, manifest: { title: group }, files, id });
  const conn = (token) => ({ url, token });
  return { home, dataDir, now, privateKey, issue, file, send, push, conn, start, sweep: (at) => server.sweep({ at }) };
}

test("ACC-cloud-08 离线验签，拒绝过期、篡改、其他签名方、未开通和用错角色的令牌", async (t) => {
  const { now, privateKey, issue, send, conn } = await fixture(t);
  const maker = issue(A, "maker");
  const executor = issue(A, "executor");
  assert.equal((await ping(conn(maker))).role, "push");
  assert.equal((await ping(conn(executor))).role, "pull");

  const [header, body, signature] = maker.split(".");
  const tampered = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), sub: B })).toString("base64url")}.${signature}`;
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const expired = issue(A, "executor", 1000, true, createMachineSigner(pem, { clock: () => now - 3_600_000 }));
  const anotherPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const wrongKey = issue(A, "executor", 1000, true, createMachineSigner(anotherPem));
  for (const token of [tampered, expired, wrongKey, PUSH, PULL]) {
    const res = await send(token, "GET", "/deliveries");
    assert.equal(res.status, 401);
    assert.match((await res.json()).message, /核对.*登录/);
  }
  const disabled = await send(issue(A, "executor", 1000, false), "GET", "/deliveries");
  assert.equal(disabled.status, 403);
  assert.match((await disabled.json()).message, /还没开通.*申请开通/);
  for (const res of [await send(maker, "GET", "/deliveries"), await send(executor, "POST", "/deliveries", "{}")]) {
    assert.equal(res.status, 401);
  }
});

test("ACC-cloud-08 两个账号同时拉取，只回报自己的投递，文件哈希和活动记录也按账号分", async (t) => {
  const { home, dataDir, issue, file, send, push, conn, sweep, now } = await fixture(t);
  const makerA = issue(A, "maker");
  const makerB = issue(B, "maker");
  const pullA = issue(A, "executor");
  const pullB = issue(B, "executor");
  const shared = file("same.mp4", "两人碰巧使用同一个素材");
  const ownA = file("a.png", "a only");
  const ownB = file("b.png", "b only");
  const [deliveryA, deliveryB] = await Promise.all([push(makerA, "甲组", [shared, ownA]), push(makerB, "乙组", [shared, ownB])]);
  for (const [account, delivery] of [[A, deliveryA], [B, deliveryB]]) {
    assert.equal(JSON.parse(readFileSync(join(dataDir, account, "deliveries", `${delivery.id}.json`))).id, delivery.id);
    assert.deepEqual(readFileSync(join(dataDir, account, "blobs", shared.sha256)), readFileSync(shared.path));
  }
  assert.deepEqual((await listDeliveryStatus(conn(makerA))).deliveries.map((d) => d.id), [deliveryA.id]);
  const wrongAccount = [
    await send(makerB, "GET", `/deliveries/${deliveryA.id}`),
    await send(pullB, "GET", `/deliveries/${deliveryA.id}`),
    await send(pullB, "GET", `/blobs/${ownA.sha256}`),
    await send(pullB, "POST", `/deliveries/${deliveryA.id}/state`, '{"state":"failed"}'),
  ];
  for (const response of wrongAccount) assert.equal(response.status, 404);
  assert.deepEqual(await (await send(makerB, "GET", `/blobs/${ownA.sha256}/status`)).json(), { complete: false, received: 0 });
  assert.equal((await send(makerB, "POST", "/deliveries", JSON.stringify({ id: "dl_000000000001", group: "乙组", manifest: {}, blobs: [ownA] }))).status, 409);
  assert.equal((await getDeliveryStatus({ ...conn(makerA), id: deliveryA.id })).state, "pending");

  const pull = (account, token, group) => pullOnce({
    ...conn(token), inboxDir: join(home, account), getRecord: () => null, record: () => {},
    ingest: (d) => {
      assert.equal(d.group, group, "另一台发布机上没有这个组");
      return { drafts: 1 };
    },
  });
  const [a, b] = await Promise.all([pull(A, pullA, "甲组"), pull(B, pullB, "乙组")]);
  for (const [out, own] of [[a, deliveryA], [b, deliveryB]]) {
    assert.equal(out.seen, 1);
    assert.deepEqual(out.ingested, [own.id]);
    assert.deepEqual(out.failed, []);
  }
  assert.equal((await getDeliveryStatus({ ...conn(makerA), id: deliveryA.id })).state, "ingested");
  assert.equal((await getDeliveryStatus({ ...conn(makerB), id: deliveryB.id })).state, "ingested");
  assert.equal((await listDeliveryStatus(conn(makerA))).lastPullAt, now);
  assert.equal((await listDeliveryStatus(conn(makerB))).lastPullAt, now);

  // 即使投递号完全相同，另一个账号也能独立创建，并保留自己仍要下载的同哈希文件。
  assert.equal((await push(makerB, "乙组", [shared], deliveryA.id)).state, "pending");
  sweep(now + RETENTION_MS);
  assert.equal((await send(pullA, "GET", `/blobs/${shared.sha256}`)).status, 404);
  assert.equal((await send(pullB, "GET", `/blobs/${shared.sha256}`)).status, 200);
});

test("ACC-cloud-08 容量计入完整、半截和同时上传的成片，续传与清理后可复用容量", async (t) => {
  const { issue, file, send, push, sweep, now } = await fixture(t);
  const token = issue(A, "maker", 10);
  const complete = file("first.mp4", "12345");
  const second = file("second.mp4", "67890");
  const delivery = await push(token, "甲组", [complete]);
  await push(token, "甲组", [complete]); // 相同 sha 不重复占容量。

  const body = new TransformStream();
  const writer = body.writable.getWriter();
  const put = (file, offset, data, options) => send(token, "PUT", `/blobs/${file.sha256}?total=${file.size}&offset=${offset}`, data, options);
  const pending = put(second, 0, body.readable, { duplex: "half", signal: AbortSignal.timeout(3000) });
  await writer.write(Buffer.from("67"));
  const extra = file("extra.mp4", "!");
  let seen = 0;
  for (let attempt = 0; attempt < 100 && !seen; attempt++) {
    seen = (await (await send(token, "GET", `/blobs/${second.sha256}/status`)).json()).received;
    if (!seen) await wait(10);
  }
  assert.equal(seen, 2);
  const blockedDuringUpload = await put(extra, 0, "!");
  assert.equal(blockedDuringUpload.status, 413);
  assert.equal((await blockedDuringUpload.json()).remainingBytes, 0);
  await writer.close();
  assert.equal((await pending).status, 202);

  const blockedByPartial = await put(file("big.mp4", "1234"), 0, "1234");
  assert.equal(blockedByPartial.status, 413);
  const quota = await blockedByPartial.json();
  assert.equal(quota.error, "quota_exceeded");
  assert.equal(quota.remainingBytes, 3);
  assert.match(quota.message, /还剩 3 字节/);
  assert.equal((await put(second, 2, "890")).status, 201);
  assert.equal((await send(issue(B, "maker", 1), "PUT", `/blobs/${extra.sha256}?total=1`, "!")).status, 201);

  const pull = issue(A, "executor");
  for (const d of (await (await send(pull, "GET", "/deliveries")).json()).deliveries) {
    assert.equal((await send(pull, "POST", `/deliveries/${d.id}/state`, '{"state":"ingested"}')).status, 200);
  }
  assert.match(delivery.id, /^dl_/);
  sweep(now + RETENTION_MS);
  const tooLarge = await put(extra, 0, new Blob(["!!"]).stream(), { duplex: "half" });
  assert.equal(tooLarge.status, 422);
  assert.equal((await put(extra, 0, "!")).status, 201);
});

test("ACC-cloud-08 并行迁移时旧令牌只看旧目录，关闭后旧令牌失效且账号投递可领取", async (t) => {
  const { issue, file, push, start, send, conn } = await fixture(t, { legacy: true });
  const fixed = await push(PUSH, "旧组", [file("legacy.mp4", "legacy")]);
  const machine = await push(issue(A, "maker"), "新组", [file("new.mp4", "machine")]);
  const pending = async (token) => (await (await send(token, "GET", "/deliveries")).json()).deliveries.map((d) => d.id);
  assert.deepEqual(await pending(PULL), [fixed.id]);
  assert.deepEqual(await pending(issue(A, "executor")), [machine.id]);
  await start(false);
  await assert.rejects(ping(conn(PUSH)), { status: 401 });
  await assert.rejects(ping(conn(PULL)), { status: 401 });
  assert.deepEqual(await pending(issue(A, "executor")), [machine.id]);
  await start(true);
  assert.deepEqual(await pending(PULL), [fixed.id]);
});
