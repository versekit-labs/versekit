// #180 · ACC-harness-offline-01
// 离线服务模式：假 driver / 假适配器（被调用就记录）+ 一轮 daemon tick，断言零次触网。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "vk-offline-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const { startDaemon, offlineHandlers } = await import("../src/daemon.mjs");
const { buildHandlers } = await import("../src/adapters.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");

const calls = [];
const record = (name) => (...a) => {
  calls.push(name);
  return { ok: true, loggedIn: true };
};
const fakeAdapter = {
  platform: "xiaohongshu",
  publish: "web",
  adapter: {
    platform: "xiaohongshu",
    capabilities: {},
    ready: () => null,
    check: record("check"),
    publish: record("publish"),
    collect: record("collect"),
    login: record("login"),
    connect: record("connect"),
  },
};

let daemon;
const post = (path) =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: daemon.socketPath, path, method: "POST" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end();
  });

before(async () => {
  core.migrate();
  const db = core.open();
  // last_checked_at 为空的账号 + 一条到点的已确认平台稿：在线模式下 tick 会体检、会发。
  db.prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a1','xiaohongshu','@x',1)").run();
  db.prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES ('w1','t','/tmp/a.mp4',1)").run();
  db.prepare("INSERT INTO publish (id, work_id, account_id, state, scheduled_at, created_at, updated_at) VALUES ('p1','w1','a1','queued',1,1,1)").run();
  core.enqueue({ kind: "publish", targetType: "publish", targetId: "p1", lane: "a1", priority: 100 });

  const adapters = [fakeAdapter];
  const handlers = {
    ...buildHandlers(adapters),
    ...createCoreHandlers({ adapters }),
    "account.check": record("account.check"),
  };
  daemon = await startDaemon({ offline: true, port: 0, socketPath: join(HOME, "vk.sock"), handlers, channels: [{ channel: "feishu", ready: record("channel.ready"), start: record("channel.start") }] });
});

after(async () => {
  await daemon.close();
  core.close();
});

test("--offline：跑一轮 tick 后没有任何体检、发布、采集、登录或通道调用", async () => {
  await new Promise((r) => setTimeout(r, 1500)); // 在线模式下 runner / 体检排单 / 通道都会在这段时间里动起来
  assert.deepEqual(calls, [], "适配器和 driver 一次都不该被调用");
  const db = core.open();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM run WHERE kind='check'").get().n, 0, "没有排任何账号体检");
  assert.equal(db.prepare("SELECT state FROM run WHERE kind='publish'").get().state, "queued", "发布队列没有被消费");
});

test("--offline：account.check / 发布 / 采集 / 登录 返回 offline_mode 和人话", async () => {
  for (const path of ["/api/accounts/a1/check", "/api/accounts/a1/login/open", "/api/accounts/a1/connect", "/api/collect/now"]) {
    const res = await post(path);
    if (res.status === 404 || res.status === 405) continue; // 路径以 commands.mjs 为准，没有的路由不算
    assert.equal(res.body.error?.code, "offline_mode", `${path} → ${JSON.stringify(res.body)}`);
    assert.match(res.body.error.message, /离线模式：不会访问任何平台/);
  }
  const check = await post("/api/accounts/a1/check");
  assert.equal(check.status, 400);
  assert.equal(check.body.error.code, "offline_mode");
  assert.deepEqual(calls, []);
});

test("offlineHandlers：队列 kind 和登录类 handler 被拦，只改库的动作原样保留", () => {
  const kept = () => "kept";
  const wrapped = offlineHandlers({ publish: record("publish"), check: record("check"), collect: record("collect"), "account.login.qr": record("qr"), "publish.confirm": kept, "schedule.move": kept });
  for (const name of ["publish", "check", "collect", "account.login.qr", "account.check", "account.login.verify"]) {
    assert.throws(() => wrapped[name]({}), (e) => e.code === "offline_mode", name);
  }
  assert.equal(wrapped["publish.confirm"](), "kept");
  assert.equal(wrapped["schedule.move"](), "kept");
  assert.deepEqual(calls, []);
});
