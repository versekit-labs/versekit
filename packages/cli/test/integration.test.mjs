// The end-to-end loop of v0.1, without a platform: a real daemon, the real runner, the real B站
// adapter, and a fake biliup that prints a BV id. This is the smallest proof that "one asset goes
// out on one platform and the database ends up telling the truth" actually holds as wired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-e2e-"));
process.env.VK_HOME = HOME;

const core = await import("../../core/src/index.mjs");
const { loadAdapters, buildHandlers } = await import("../../core/src/adapters.mjs");
const { createCoreHandlers } = await import("../../core/src/handlers.mjs");
const { startDaemon } = await import("../../core/src/daemon.mjs");
const store = await import("../../core/src/store.mjs");

const db = () => core.open();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBiliup({ style = "ok" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vk-fake-biliup-"));
  const bin = join(dir, "biliup");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_BILIUP_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.env.FAKE_BILIUP_STYLE === "auth") { console.error("请先登录：cookie 已失效"); process.exit(1); }
console.log("投稿成功 BV1yy411c7mF");
`,
  );
  chmodSync(bin, 0o755);
  const log = join(dir, "calls.log");
  process.env.VK_BILIUP_BIN = bin;
  process.env.FAKE_BILIUP_LOG = log;
  process.env.FAKE_BILIUP_STYLE = style;
  return { bin, log };
}

async function boot() {
  const adapters = (await loadAdapters()).adapters;
  const handlers = { ...buildHandlers(adapters, { log: () => {} }), ...createCoreHandlers({ adapters, log: () => {} }) };
  const daemon = await startDaemon({ handlers, runQueue: false, port: 0, socketPath: join(HOME, `vk-${Date.now()}.sock`) });
  return { daemon, handlers };
}

async function drain(runner, until, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await runner.tick();
    if (until()) return true;
    await sleep(50);
  }
  return false;
}

test("一条素材从 CLI 到 B站适配器：published + BV 号 + followup + 采集任务", async () => {
  core.migrate();
  const { log } = fakeBiliup();

  const cred = join(HOME, "cookies.json");
  writeFileSync(cred, JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "s" }, { name: "bili_jct", value: "j" }] } }));
  const asset = join(HOME, "ep1.mp4");
  writeFileSync(asset, "fake video");

  const { id: accountId } = store.addAccount({ platform: "bilibili", handle: "@e2e", credentialRef: cred });
  const work = store.createWork({ title: "端到端第一条", assetPath: asset, meta: { description: "描述", tags: ["AI"] } });
  const { id: publishId } = store.createPublish({ workId: work.id, accountId });

  const { daemon } = await boot();
  try {
    const ok = await drain(daemon.runner, () => store.getPublish(publishId).state === "published");
    assert.ok(ok, `发布没有到 published，当前 ${store.getPublish(publishId).state}`);

    const row = store.getPublish(publishId);
    assert.equal(row.external_id, "BV1yy411c7mF");
    assert.match(row.external_url, /bilibili\.com\/video\/BV1yy411c7mF/);

    const followups = db().prepare("SELECT kind FROM followup WHERE publish_id=? ORDER BY kind").all(publishId).map((r) => r.kind);
    assert.deepEqual(followups, ["declare_ai_generated", "upload_captions"]);

    const collect = db().prepare("SELECT run_after, lane FROM run WHERE target_id=? AND kind='collect'").get(publishId);
    assert.ok(collect, "发布成功必须自动排采集");
    assert.equal(collect.lane, accountId);

    const calls = readFileSync(log, "utf8");
    assert.match(calls, /upload/);
    assert.match(calls, /--title 端到端第一条/);
  } finally {
    await daemon.close();
  }
});

test("登录失效时：publish 进 blocked，账号置 expired，事件只发一次", async () => {
  const { daemon } = await boot();
  fakeBiliup({ style: "auth" });

  const cred = join(HOME, "bad-cookies.json");
  writeFileSync(cred, JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "s" }] } }));
  const asset = join(HOME, "ep2.mp4");
  writeFileSync(asset, "fake video");

  const { id: accountId } = store.addAccount({ platform: "bilibili", handle: "@dead", credentialRef: cred });
  const work = store.createWork({ title: "会失效的一条", assetPath: asset });
  const { id: publishId } = store.createPublish({ workId: work.id, accountId });

  try {
    await drain(daemon.runner, () => store.getPublish(publishId).state === "blocked");
    assert.equal(store.getPublish(publishId).state, "blocked");
    assert.equal(db().prepare("SELECT state FROM account WHERE id=?").get(accountId).state, "expired");
    assert.equal(db().prepare("SELECT COUNT(*) n FROM event WHERE type='account.expired' AND publish_id=?").get(publishId).n, 1);
    assert.equal(store.getPublish(publishId).error_code, "auth");
  } finally {
    await daemon.close();
  }
});

test("没有适配器的平台会在第一条发布时明确报错，而不是卡在队列里", async () => {
  core.migrate();
  const { daemon } = await boot();
  const asset = join(HOME, "ep3.mp4");
  writeFileSync(asset, "x");
  const { id: accountId } = store.addAccount({ platform: "youtube", handle: "@yt" });
  const work = store.createWork({ title: "没有适配器", assetPath: asset });
  const { id: publishId } = store.createPublish({ workId: work.id, accountId });
  try {
    await drain(daemon.runner, () => db().prepare("SELECT state FROM run WHERE target_id=?").get(publishId)?.state === "queued");
    const run = db().prepare("SELECT state, last_error, attempts FROM run WHERE target_id=?").get(publishId);
    assert.match(run.last_error, /没有 youtube 适配器/);
    assert.ok(run.attempts >= 1);
    assert.ok(existsSync(join(HOME, ".local", "state", "versekit", "vk.db")));
  } finally {
    await daemon.close();
  }
});
