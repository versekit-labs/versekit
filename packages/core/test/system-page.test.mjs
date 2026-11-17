// 系统页（#208）背后的命令：账号表的「今天还能发」、TikTok 应用凭证保存（secret 不外泄）。
// 只用本机临时目录与 TIKTOK_* mock 环境，不碰任何真实平台。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-system-page-"));
process.env.VK_HOME = HOME;
delete process.env.TIKTOK_CLIENT_KEY;
delete process.env.TIKTOK_CLIENT_SECRET;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { startDaemon } = await import("../src/daemon.mjs");
const { findCommand, parseArgs } = await import("../src/commands.mjs");
const { updateConfig } = await import("../src/config.mjs");
const tiktok = (await import("../../adapter-tiktok-api/src/index.mjs")).default;

const logs = [];
const handlers = createCoreHandlers({
  adapters: [{ platform: "tiktok-api", adapter: tiktok }, { platform: "xiaohongshu", adapter: { ready: () => null } }],
  log: (line) => logs.push(String(line)),
});

let seq = 0;
before(() => core.migrate());
const group = () => store.addGroup({ name: `组 ${++seq}` }).id;

function pub(accountId, scheduledAt) {
  const work = store.createWork({ title: `作品 ${++seq}`, assetPath: "/tmp/a.mp4" });
  return store.createPublish({ workId: work.id, accountId, scheduledAt }).id;
}

// ── ACC-v2-sys-02：今天还能发 ─────────────────────────────────────────────

test("今天还能发 = 生效的 daily_cap 减去今天已发和已排；别的日子、已取消的不占", () => {
  const g = group();
  const a = store.addAccount({ platform: "xiaohongshu", handle: "@quota", groupId: g });
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const tomorrow = noon.getTime() + 24 * 3600e3;

  const read = () => handlers["account.list"]({ group: g }).accounts.find((x) => x.id === a.id).quota;
  assert.deepEqual(read(), { cap: 10, used: 0, left: 10 }, "默认每天最多 10 条");

  pub(a.id, noon.getTime());
  pub(a.id, noon.getTime() + 3600e3);
  pub(a.id, tomorrow); // 明天的不算今天
  assert.deepEqual(read(), { cap: 10, used: 2, left: 8 });

  const skipped = pub(a.id, noon.getTime() + 2 * 3600e3);
  store.getPublish(skipped);
  core.open().prepare("UPDATE publish SET state = 'canceled' WHERE id = ?").run(skipped);
  assert.equal(read().used, 2, "已取消的不占名额");

  updateConfig({ plan: { rules: { platforms: { xiaohongshu: { daily_cap: 3, min_gap_minutes: 10 } } } } });
  try {
    assert.deepEqual(read(), { cap: 3, used: 2, left: 1 }, "改过配置就按改过的上限算，不是写死的数字");
  } finally {
    updateConfig({ plan: { rules: { platforms: { xiaohongshu: null } } } });
  }
});

// ── ACC-v2-sys-05：TikTok 应用凭证 ────────────────────────────────────────

const SECRET = "s3cr3t-DO-NOT-LEAK-0123456789";
const KEY = "client-key-abc123";

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

test("命令表里有这条命令（CLI 完整律）：HTTP 由它派生，secret 不进审计", () => {
  const cmd = findCommand("account.credentials");
  assert.ok(cmd, "account.credentials 必须在 commands.mjs 定义");
  assert.deepEqual(cmd.http, { method: "POST", path: "/api/platforms/:platform/credentials" });
  assert.match(cmd.cli.usage, /vk account credentials tiktok/);
  assert.equal(cmd.audit, "never", "audit 会把 args 原样写库，里面有 secret");
  assert.equal(cmd.card, null);
  assert.throws(() => parseArgs(cmd, { platform: "tiktok-api", clientKey: KEY }), /缺少参数：clientSecret/);
});

test("没有凭证时平台清单说没配；保存后写进 config.json（权限 600），状态里不带 secret", () => {
  const before = handlers["platform.list"]().platforms.find((p) => p.platform === "tiktok-api");
  assert.equal(before.credentials.configured, false);
  assert.match(before.ready, /未配置/);

  const saved = handlers["account.credentials"]({ platform: "tiktok-api", clientKey: KEY, clientSecret: SECRET });
  assert.equal(saved.configured, true);
  assert.equal(saved.clientKey, KEY);
  assert.equal(saved.hasSecret, true);
  assert.equal(saved.source, "config");

  const file = core.paths().configFile;
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(cfg.tiktok.client_key, KEY);
  assert.equal(cfg.tiktok.client_secret, SECRET);
  assert.equal(statSync(file).mode & 0o777, 0o600, "config.json 必须是 600");

  const after = handlers["platform.list"]().platforms.find((p) => p.platform === "tiktok-api");
  assert.equal(after.credentials.configured, true);
  assert.equal(after.ready, null, "保存后适配器就绪，可以直接 Connect");
});

test("保存之后任何 API 响应、日志、事件、审计、数据库里都没有 secret", async () => {
  const d = await startDaemon({ runQueue: false, port: 0, socketPath: join(HOME, "vk.sock"), handlers });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const seen = [];
    const call = async (method, path, body) => {
      const res = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      seen.push(text);
      return { status: res.status, body: JSON.parse(text) };
    };

    const ok = await call("POST", "/api/platforms/tiktok-api/credentials", { platform: "tiktok-api", clientKey: KEY, clientSecret: SECRET });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.configured, true);

    // 写错的请求：错误信息里也不带 secret。
    const bad = await call("POST", "/api/platforms/xiaohongshu/credentials", { platform: "xiaohongshu", clientKey: KEY, clientSecret: SECRET });
    assert.equal(bad.status, 400);
    const spaced = await call("POST", "/api/platforms/tiktok-api/credentials", { platform: "tiktok-api", clientKey: KEY, clientSecret: `${SECRET} extra` });
    assert.equal(spaced.status, 400);

    await call("GET", "/api/platforms");
    await call("GET", "/api/bootstrap");
    await call("GET", "/api/accounts");
    await call("GET", "/api/events");

    for (const text of seen) assert.ok(!text.includes(SECRET), `响应里出现了 secret：${text.slice(0, 120)}`);
    for (const line of logs) assert.ok(!line.includes(SECRET), `日志里出现了 secret：${line}`);

    const db = core.open();
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM command_audit").all(),
      db.prepare("SELECT * FROM event").all(),
      db.prepare("SELECT * FROM account").all(),
    ]);
    assert.ok(!dump.includes(SECRET), "库里（审计/事件/账号）不能有 secret");
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM event WHERE type = 'account.credentials_saved'").get().n >= 1, "保存留一条不含凭证的事件");

    // 除了 config.json 本身，状态目录下没有任何文件含 secret（包括 sqlite 文件与 wal）。
    for (const f of filesUnder(HOME)) {
      if (f === core.paths().configFile) continue;
      if (!statSync(f).isFile()) continue;
      assert.ok(!readFileSync(f).includes(SECRET), `${f} 里出现了 secret`);
    }
  } finally {
    await d.close?.();
  }
});

test("环境变量仍优先：状态里的 source 说清楚", () => {
  process.env.TIKTOK_CLIENT_KEY = "env-key";
  process.env.TIKTOK_CLIENT_SECRET = "env-secret";
  try {
    const st = handlers["platform.list"]().platforms.find((p) => p.platform === "tiktok-api").credentials;
    assert.equal(st.source, "env");
    assert.equal(st.clientKey, "env-key");
  } finally {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
  }
});

test("不需要应用凭证的平台说人话，不崩；空值拒绝", () => {
  assert.throws(() => handlers["account.credentials"]({ platform: "xiaohongshu", clientKey: "k", clientSecret: "s" }), /不需要应用凭证/);
  assert.throws(() => handlers["account.credentials"]({ platform: "tiktok-api", clientKey: "  ", clientSecret: "s" }), /都要填/);
});

after(() => {});
