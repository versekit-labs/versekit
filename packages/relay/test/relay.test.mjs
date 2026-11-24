// 云端中转（ACC-relay-01）与制作机上传（ACC-relay-02 的传输部分）。
// 全部在本机临时目录、127.0.0.1 随机端口：不碰 volc1，不碰任何平台。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRelayServer, hashFile, pushBlob, pushDelivery, downloadBlob, listDeliveries, listDeliveryStatus, getDeliveryStatus, reportState, pullOnce, ping, RETENTION_MS } from "../src/index.mjs";
import { deliveryStatusView } from "../src/status.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "vk-relay-"));
const PUSH = "push-token-for-test";
const PULL = "pull-token-for-test";
const DAY = 864e5;

let clock = Date.now();
let free = 50 * 1024 ** 3;
let relay;
let url;
let dataDir;

before(async () => {
  dataDir = join(ROOT, "data");
  relay = createRelayServer({ dataDir, pushToken: PUSH, pullToken: PULL, now: () => clock, freeBytes: () => free });
  url = `http://127.0.0.1:${await relay.listen({ port: 0 })}`;
});
after(async () => {
  await relay.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
function fileOf(name, bytes) {
  const path = join(ROOT, name);
  writeFileSync(path, bytes);
  return { path, sha256: sha(bytes), size: bytes.length, name };
}
const api = (method, path, { token, body, headers } = {}) =>
  fetch(`${url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body == null ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
const blobs = () => readdirSync(join(dataDir, "blobs"));
const manifest = (f) => ({ title: "作品", cuts: [{ title: "长片", versions: [{ language: "zh", asset: `blob:${f.sha256}` }] }] });

test("ACC-relay-01 只监听 127.0.0.1，由反代提供 HTTPS", () => {
  assert.equal(relay.server.address().address, "127.0.0.1");
});

test("ACC-relay-01 没有 token 或 token 错一律 401，回答一模一样，不泄露有哪些投递；推送 token 拉不了，拉取 token 推不了", async () => {
  const f = fileOf("a.mp4", Buffer.from("video-a"));
  const made = await pushDelivery({ url, token: PUSH, group: "组", manifest: manifest(f), files: [f] });
  const bodies = new Set();
  for (const [method, path, token] of [
    ["GET", "/v1/deliveries", undefined],
    ["GET", "/v1/deliveries", "wrong"],
    ["GET", `/v1/deliveries/${made.id}`, "wrong"],
    ["GET", `/v1/deliveries/dl_000000000000`, "wrong"], // 存在与否看不出来
    ["GET", `/v1/blobs/${f.sha256}`, undefined],
    ["POST", `/v1/deliveries/${made.id}/state`, "wrong"],
    ["GET", "/v1/whatever", undefined],
    ["GET", "/v1/deliveries", PUSH], // 推送 token 不能拉
    ["GET", `/v1/blobs/${f.sha256}`, PUSH],
    ["PUT", `/v1/blobs/${f.sha256}?offset=0&total=7`, PULL], // 拉取 token 不能推
    ["POST", "/v1/deliveries", PULL],
  ]) {
    const res = await api(method, path, { token, body: method === "GET" ? undefined : "{}" });
    assert.equal(res.status, 401, `${method} ${path} (${token})`);
    bodies.add(await res.text());
  }
  assert.equal(bodies.size, 1, "所有 401 的回答完全一样");
  assert.ok(![...bodies][0].includes(made.id));
  assert.equal((await ping({ url, token: PUSH })).role, "push");
  assert.equal((await ping({ url, token: PULL })).role, "pull");
  await assert.rejects(ping({ url, token: "nope" }), (e) => e.status === 401);
});

test("ACC-relay-01 同一个文件按 sha256 只存一份；投递有状态：待拉取 → 已下载 → 已入库", async () => {
  const f = fileOf("same.mp4", Buffer.from("same-bytes-twice"));
  const before = blobs().length;
  const d1 = await pushDelivery({ url, token: PUSH, group: "组", manifest: manifest(f), files: [f] });
  const d2 = await pushDelivery({ url, token: PUSH, group: "组", manifest: manifest(f), files: [f] });
  assert.notEqual(d1.id, d2.id);
  assert.equal(blobs().length - before, 1, "两次投递同一个文件，磁盘上只有一份");
  assert.equal(readFileSync(join(dataDir, "blobs", f.sha256), "utf8"), "same-bytes-twice");

  assert.equal(d1.state, "pending");
  const listed = await listDeliveries({ url, token: PULL });
  assert.ok(listed.some((d) => d.id === d1.id && d.state === "pending"));
  await reportState({ url, token: PULL, id: d1.id, state: "downloaded" });
  assert.equal((await (await api("GET", `/v1/deliveries/${d1.id}`, { token: PUSH })).json()).state, "downloaded");
  await reportState({ url, token: PULL, id: d1.id, state: "ingested" });
  const after = await (await api("GET", `/v1/deliveries/${d1.id}`, { token: PUSH })).json();
  assert.equal(after.state, "ingested");
  assert.ok(!(await listDeliveries({ url, token: PULL })).some((d) => d.id === d1.id), "已入库的不再出现在待拉取里");
  // 回报「已入库」之后重复回报别的状态不倒退
  assert.equal((await reportState({ url, token: PULL, id: d1.id, state: "failed", reason: "x" })).state, "ingested");
  await reportState({ url, token: PULL, id: d2.id, state: "failed", reason: "组不存在" });
  assert.equal((await (await api("GET", `/v1/deliveries/${d2.id}`, { token: PUSH })).json()).state, "failed");
});

test("ACC-relay-01 回报「已入库」满 7 天才清理文件；还被别的未入库投递引用的文件不删", async () => {
  const shared = fileOf("shared.mp4", Buffer.from("shared-between-two"));
  const solo = fileOf("solo.mp4", Buffer.from("only-one-uses-me"));
  const a = await pushDelivery({ url, token: PUSH, group: "组", manifest: manifest(shared), files: [shared, solo] });
  const b = await pushDelivery({ url, token: PUSH, group: "组", manifest: manifest(shared), files: [shared] });
  await reportState({ url, token: PULL, id: a.id, state: "ingested" });

  clock += 7 * DAY - 1000;
  assert.deepEqual(relay.sweep(), { removed: 0, partials: 0 }, "没满 7 天不清理");
  assert.ok(existsSync(join(dataDir, "blobs", solo.sha256)));

  clock += 2000;
  assert.equal(relay.sweep().removed, 1, "满 7 天：独占的文件清掉");
  assert.ok(!existsSync(join(dataDir, "blobs", solo.sha256)));
  assert.ok(existsSync(join(dataDir, "blobs", shared.sha256)), "投递 b 还没入库，共用的文件留着");
  assert.equal((await (await api("GET", `/v1/deliveries/${a.id}`, { token: PUSH })).json()).files_purged, true);

  await reportState({ url, token: PULL, id: b.id, state: "ingested" });
  clock += 7 * DAY + 1000;
  assert.equal(relay.sweep().removed, 1);
  assert.ok(!existsSync(join(dataDir, "blobs", shared.sha256)));
  assert.equal(RETENTION_MS, 7 * DAY);
});

test("ACC-relay-01 磁盘剩余不足 2GB 拒收并说人话，空间回来就能收", async () => {
  const f = fileOf("big.mp4", Buffer.from("needs-space"));
  free = 1.5 * 1024 ** 3;
  try {
    const res = await api("PUT", `/v1/blobs/${f.sha256}?offset=0&total=${f.size}`, { token: PUSH, body: readFileSync(f.path) });
    assert.equal(res.status, 507);
    const msg = (await res.json()).message;
    assert.match(msg, /剩余 1\.5GB/);
    assert.match(msg, /不足 2GB/);
    await assert.rejects(pushBlob({ url, token: PUSH, ...f, file: f.path, retries: 0 }), /不足 2GB/);
    assert.ok(!existsSync(join(dataDir, "blobs", f.sha256)));
  } finally {
    free = 50 * 1024 ** 3;
  }
  await pushBlob({ url, token: PUSH, ...f, file: f.path });
  assert.ok(existsSync(join(dataDir, "blobs", f.sha256)));
});

test("ACC-relay-02 大文件可断点续传：半截留在云端，客户端从云端收到的位置接着传", async () => {
  const bytes = Buffer.alloc(300_000, 7).map((_, i) => (i * 31) % 251);
  const f = fileOf("resume.mp4", bytes);
  // 先手工传前 120000 字节（模拟传到一半断了）
  let res = await api("PUT", `/v1/blobs/${f.sha256}?offset=0&total=${f.size}`, { token: PUSH, body: bytes.subarray(0, 120_000) });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).received, 120_000);
  // 位置不对会被拒并告诉真实位置
  res = await api("PUT", `/v1/blobs/${f.sha256}?offset=0&total=${f.size}`, { token: PUSH, body: bytes });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).received, 120_000);

  const starts = [];
  await pushBlob({ url, token: PUSH, ...f, file: f.path, onProgress: (sent) => starts.push(sent) });
  assert.equal(starts[0], 120_000, "从云端已有的位置开始，不是从 0");
  assert.equal(sha(readFileSync(join(dataDir, "blobs", f.sha256))), f.sha256);
});

test("ACC-relay-02 传完核对 sha256：对不上就丢掉，不留坏文件", async () => {
  const bytes = Buffer.from("these-are-not-the-declared-bytes");
  const fake = sha(Buffer.from("something else"));
  const res = await api("PUT", `/v1/blobs/${fake}?offset=0&total=${bytes.length}`, { token: PUSH, body: bytes });
  assert.equal(res.status, 422);
  assert.ok(!existsSync(join(dataDir, "blobs", fake)));
  assert.ok(!existsSync(join(dataDir, "partial", `${fake}.part`)));
});

test("ACC-deliver-04 多文件上传进度按整个投递统计，同内容只计一次", async () => {
  const video = fileOf("delivery-progress.mp4", Buffer.from("delivery-progress-video"));
  const cover = fileOf("delivery-progress.png", Buffer.from("delivery-progress-cover"));
  const samples = [];
  const total = video.size + cover.size;
  await pushDelivery({
    url, token: PUSH, group: "组", manifest: manifest(video),
    files: [video, cover, video], onProgress: (sample) => samples.push(sample),
  });
  const startCover = samples.find((sample) => sample.name === cover.name);
  assert.equal(startCover.deliverySent, video.size);
  assert.equal(samples.at(-1).deliverySent, total);
  assert.ok(samples.every((sample) => sample.deliveryTotal === total));
});

test("ACC-relay-02 失败自动重试：服务暂时 503 / 断线之后能传完", async () => {
  const f = fileOf("flaky.mp4", Buffer.from("flaky-network-bytes"));
  let hits = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/status") && hits++ < 2) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return realFetch(input, init);
  };
  try {
    await pushBlob({ url, token: PUSH, ...f, file: f.path, backoffMs: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(hits >= 3, "前两次失败后自动重试");
  assert.ok(existsSync(join(dataDir, "blobs", f.sha256)));
  // 401 这类重试没用的错，直接说人话，不重试
  await assert.rejects(pushBlob({ url, token: "bad", ...f, file: f.path, retries: 3, backoffMs: 1 }), /不认这个 token/);
});

test("ACC-relay-03 下载走 Range 续传并核对 sha256；半截文件接着下", async () => {
  const bytes = Buffer.alloc(200_000).map((_, i) => (i * 13) % 253);
  const f = fileOf("dl.mp4", bytes);
  await pushBlob({ url, token: PUSH, ...f, file: f.path });
  const dest = join(ROOT, "dl-out", "dl.mp4");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(ROOT, "dl-out"), { recursive: true });
  writeFileSync(`${dest}.part`, bytes.subarray(0, 50_000));
  const seen = [];
  await downloadBlob({ url, token: PULL, sha256: f.sha256, size: f.size, dest, onProgress: (n) => seen.push(n) });
  assert.equal(seen[0], 50_000, "从已下载的 50000 字节接着下");
  assert.equal(await hashFile(dest), f.sha256);
  assert.ok(!existsSync(`${dest}.part`));
  assert.equal(statSync(dest).size, f.size);
});

test("ACC-relay-06 拉取一轮会逐个报进展：先说共几个，每个开始/结束一条，带作品标题和大小", async () => {
  const f = fileOf("prog.mp4", Buffer.alloc(30_000, 5));
  const d = await pushDelivery({ url, token: PUSH, group: "组", manifest: { ...manifest(f), title: "进度作品" }, files: [f] });
  const expected = (await listDeliveries({ url, token: PULL })).length;
  const events = [];
  const records = new Map();
  const r = await pullOnce({
    url,
    token: PULL,
    inboxDir: join(ROOT, "inbox-prog"),
    getRecord: (id) => records.get(id) ?? null,
    record: (id, rec) => records.set(id, rec),
    ingest: async () => ({ drafts: 2 }),
    onEvent: (e) => events.push(e),
  });
  assert.equal(events[0].type, "round");
  assert.equal(events[0].total, expected);
  const mine = events.filter((e) => e.id === d.id);
  assert.deepEqual(mine.map((e) => e.type), ["begin", "ingested"]);
  assert.equal(mine[0].title, "进度作品");
  assert.equal(mine[0].size, 30_000);
  assert.equal(mine[1].drafts, 2);
  assert.ok(mine[0].index >= 1 && mine[0].index <= expected);
  assert.ok(r.ingested.includes(d.id));
  // 再拉一轮：没有新投递，round.total 为 0，没有 begin
  const again = [];
  await pullOnce({ url, token: PULL, inboxDir: join(ROOT, "inbox-prog"), getRecord: (id) => records.get(id) ?? null, record: () => {}, ingest: async () => ({}), onEvent: (e) => again.push(e) });
  assert.deepEqual(again, [{ type: "round", total: 0 }]);
});

test("ACC-deliver-04 发布机下载进度与六小时离线文案，记住最后来取的时间与最近测速", async () => {
  const config = { dataDir: join(ROOT, "activity-test"), pushToken: PUSH, pullToken: PULL, now: () => clock, freeBytes: () => free };
  let cloud = createRelayServer(config);
  let baseUrl = `http://127.0.0.1:${await cloud.listen()}`;
  const maker = () => ({ url: baseUrl, token: PUSH });
  const publisher = () => ({ url: baseUrl, token: PULL });
  try {
    const file = fileOf("download-progress.mp4", Buffer.alloc(1000, 4));
    const sent = await pushDelivery({ ...maker(), group: "组", manifest: manifest(file), files: [file] });
    const id = sent.id;
    const show = async () => {
      const row = await getDeliveryStatus({ ...maker(), id });
      return deliveryStatusView(row, { ...row, now: clock });
    };
    const waiting = await show();
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.lastPullAt, null);
    assert.match(waiting.message, /还没来取/);
    await assert.rejects(listDeliveryStatus(publisher()), { status: 401 });

    clock += 3000;
    await listDeliveries(publisher());
    const lastPullAt = clock;
    clock += 3 * 60_000;
    assert.match((await show()).message, /上次来取是 3 分钟前/);
    clock = lastPullAt + 6 * 3600e3;
    const offline = await show();
    assert.equal(offline.lastPullAt, lastPullAt, "制作机多次看状态也不算发布机来取");
    assert.equal(offline.offline, true);
    assert.match(offline.message, /已到中转，但发布机 6 小时没来取。打开那台电脑上的 versekit 就会自动下载/);

    await listDeliveries(publisher());
    await reportState({ ...publisher(), id, state: "downloading", progress: { received: 400, bytesPerSecond: 12 } });
    const downloading = await show();
    assert.equal(downloading.state, "downloading");
    assert.equal(downloading.progress.percent, 40);
    assert.equal(downloading.progress.etaSeconds, 50);
    assert.match(downloading.message, /发布机在下载：40%，还要约 50 秒/);
    assert.equal((await listDeliveries(publisher())).find((d) => d.id === id).state, "pending", "旧发布机仍能从原有状态拉取");
    await reportState({ ...publisher(), id, state: "downloaded", downloadBytesPerSecond: 245_000 });
    const summary = { workId: "work_local", drafts: [{ platform: "bilibili", account: "@b", suggestedAt: clock + 60_000 }], rejected: [{ platform: "xiaohongshu", reason: "文案超限" }] };
    await reportState({ ...publisher(), id, state: "ingested", summary });
    await cloud.close();
    cloud = createRelayServer(config);
    baseUrl = `http://127.0.0.1:${await cloud.listen()}`;
    assert.equal((await ping({ ...maker(), details: true })).downloadBytesPerSecond, 245_000);
    assert.equal((await ping({ ...maker(), details: true })).freeBytes, free);
    const list = await listDeliveryStatus(maker());
    assert.equal(list.lastPullAt, clock);
    assert.deepEqual((await show()).summary, summary);
    assert.deepEqual(list.deliveries.find((d) => d.id === id).summary, summary);
  } finally {
    await cloud.close();
  }
});
