// The daemon is the only writer, so its contract is worth pinning: wrong verb ≠ missing route,
// bad args are 400 not 500, and the unix socket behaves exactly like the loopback port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "vk-daemon-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const { startDaemon, coerceArgs } = await import("../src/daemon.mjs");
const { findCommand } = await import("../src/commands.mjs");

let daemon;
let base;

const unix = (method, path, body) =>
  new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(
      {
        socketPath: daemon.socketPath,
        path,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

before(async () => {
  core.migrate();
  const db = core.open();
  db.prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a1','tiktok','@x',1)").run();
  db.prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES ('w1','t','/tmp/a.mp4',1)").run();
  db.prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES ('p1','w1','a1','failed',1,1)").run();

  daemon = await startDaemon({
    runQueue: false,
    port: 0,
    socketPath: join(HOME, "vk.sock"),
    handlers: {
      now: () => ({ accounts: { total: 1 }, queue: { queued: 0, running: 0, failed: 0 } }),
      "publish.retry": ({ publishId }) => ({ publishId, state: "queued" }),
      "stats.works": ({ range }) => ({ range, rows: [] }),
    },
  });
  base = `http://127.0.0.1:${daemon.port}`;
});

after(async () => {
  await daemon?.close();
});

test("GET /api/now returns the handler's shape", async () => {
  const res = await fetch(`${base}/api/now`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.total, 1);
});

test("an unknown path is 404, a known path with the wrong verb is 405", async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/now`, { method: "POST" })).status, 405);
});

test("bad args are a 400 with a readable reason, not a 500", async () => {
  const res = await fetch(`${base}/api/publishes/p1/retry`, { method: "POST", body: JSON.stringify({ publishId: "x" }) });
  // parseArgs merges path params, so this one succeeds; use an unknown field to provoke a rejection
  assert.equal(res.status, 200);
  const bad = await fetch(`${base}/api/stats/works?range=7d&nope=1`);
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.match(body.error.message, /nope/);
});

test("query strings reach the handler as declared types", async () => {
  const res = await fetch(`${base}/api/stats/works?range=7d`);
  const body = await res.json();
  assert.equal(body.range, "7d");
});

test("a command with no handler is 501, not a silent 200", async () => {
  const res = await fetch(`${base}/api/doctor`);
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error.code, "not_implemented");
});

test("the unix socket serves the same dispatcher as loopback", async () => {
  const viaSocket = await unix("GET", "/api/now");
  assert.equal(viaSocket.status, 200);
  assert.equal(viaSocket.body.accounts.total, 1);
});

test("a mutating command over the socket is audited", async () => {
  const before = core.open().prepare("SELECT COUNT(*) n FROM command_audit WHERE name='publish.retry'").get().n;
  const res = await unix("POST", "/api/publishes/p1/retry", {});
  assert.equal(res.status, 200);
  assert.equal(res.body.state, "queued");
  const rows = core.open().prepare("SELECT * FROM command_audit WHERE name='publish.retry' ORDER BY created_at").all();
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].result, "ok");
  assert.equal(rows[0].origin, "cli");
});

test("coerceArgs only converts types the command declares", () => {
  const collect = findCommand("collect.now");
  assert.deepEqual(coerceArgs(collect, { publishId: "p1" }), { publishId: "p1" });
  const create = findCommand("publish.create");
  const out = coerceArgs(create, { to: "tiktok,bilibili", dryRun: "false", schedule: "1700000000000" });
  assert.deepEqual(out.to, ["tiktok", "bilibili"]);
  assert.equal(out.dryRun, false);
  assert.equal(out.schedule, 1700000000000);
});

// ---------------------------------------------------------------- 静态页与资产上传

test("本地控制台首页能打开，静态资源带了正确类型", async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(await index.text(), /versekit/);

  const css = await fetch(`${base}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);

  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
});

test("静态目录之外的文件一律 404（不许用 .. 读仓库）", async () => {
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/nope.html`)).status, 404);
});

test("资产上传落到 state/assets，文件名被清洗，内容是原样", async () => {
  const res = await fetch(`${base}/api/assets`, {
    method: "POST",
    headers: { "x-vk-filename": encodeURIComponent("../我的 视频.mp4"), "content-type": "application/octet-stream" },
    body: Buffer.from("video-bytes"),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.path.includes("/assets/"), body.path);
  assert.ok(!body.path.includes(".."), "文件名里的 .. 必须被清掉");
  assert.ok(existsSync(body.path));
  assert.equal(readFileSync(body.path, "utf8"), "video-bytes");
});

test("空文件上传会被拒绝，而不是留下一个 0 字节素材", async () => {
  const res = await fetch(`${base}/api/assets`, { method: "POST", headers: { "x-vk-filename": "empty.mp4" }, body: Buffer.alloc(0) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "empty_asset");
});

test("GET /api/stream 推实时状态，第一帧就带队列与通道", async () => {
  const res = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: daemon.port, path: "/api/stream", headers: { accept: "text/event-stream" } }, resolve);
    req.on("error", reject);
    req.end();
  });
  assert.match(res.headers["content-type"], /text\/event-stream/);

  const dataLine = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`3 秒内没有收到 data 帧：${buf.slice(0, 120)}`)), 3000);
    res.on("data", (chunk) => {
      buf += chunk.toString();
      const line = buf.split("\n").find((l) => l.startsWith("data: "));
      if (!line) return;
      clearTimeout(timer);
      resolve(line.slice(6));
    });
  });

  const frame = JSON.parse(dataLine);
  assert.ok(frame.status.queue && typeof frame.status.queue.queued === "number");
  assert.ok(Array.isArray(frame.publishes));
  assert.ok(Array.isArray(frame.runs));
  res.destroy();
});
