// Store rules that the CLI relies on: one publish per work+account, creating a publish also queues
// it, and a bad value fails with a sentence rather than a constraint error.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-store-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");

const db = () => core.open();

let groupId = null;

before(() => {
  core.migrate();
  groupId = store.addGroup({ name: "store 测试组" }).id;
  store.addAccount({ platform: "tiktok", handle: "@main", groupId });
  store.addAccount({ platform: "bilibili", handle: "@b", groupId });
});

test("creating a publish also queues it, on the account's lane", () => {
  const work = store.createWork({ title: "第一条", assetPath: "/tmp/a.mp4" });
  const { id } = store.createPublish({ workId: work.id, accountId: store.listAccounts()[0].id });
  const run = db().prepare("SELECT * FROM run WHERE target_id=?").get(id);
  assert.equal(run.kind, "publish");
  assert.equal(run.state, "queued");
  assert.ok(run.lane, "lane 决定同账号串行");
});

test("the same work cannot be published twice to the same account", () => {
  const work = store.createWork({ title: "重复", assetPath: "/tmp/a.mp4" });
  const account = store.listAccounts()[0];
  store.createPublish({ workId: work.id, accountId: account.id });
  assert.throws(() => store.createPublish({ workId: work.id, accountId: account.id }), /只能有一条发布/);
});

test("mode and visibility are validated, not stored blindly", () => {
  const work = store.createWork({ title: "校验", assetPath: "/tmp/a.mp4" });
  const account = store.listAccounts()[0];
  assert.throws(() => store.createPublish({ workId: work.id, accountId: account.id, mode: "yolo" }), /发布模式/);
  assert.throws(() => store.createPublish({ workId: work.id, accountId: account.id, visibility: "unlisted" }), /可见性/);
});

test("a scheduled publish is queued but not runnable before its time", () => {
  const work = store.createWork({ title: "定时", assetPath: "/tmp/a.mp4" });
  const at = Date.now() + 3600e3;
  const { id } = store.createPublish({ workId: work.id, accountId: store.listAccounts()[0].id, scheduledAt: at });
  const run = db().prepare("SELECT run_after FROM run WHERE target_id=?").get(id);
  assert.equal(run.run_after, at);
});

test("manual mode does not queue work — nobody asked the machine to do anything", () => {
  const work = store.createWork({ title: "手动", assetPath: "/tmp/a.mp4" });
  const { id, queued } = store.createPublish({ workId: work.id, accountId: store.listAccounts()[0].id, mode: "manual" });
  assert.equal(queued, false);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM run WHERE target_id=?").get(id).n, 0);
});

test("accountsForPlatforms reports what is missing instead of silently skipping it", () => {
  const { accounts, missing } = store.accountsForPlatforms(["tiktok", "youtube"]);
  assert.equal(accounts.length, 1);
  assert.deepEqual(missing, ["youtube"]);
});

test("stats returns the latest snapshot per publish, with source and status", () => {
  const work = store.createWork({ title: "数据", assetPath: "/tmp/a.mp4" });
  const account = store.listAccounts()[0];
  const { id } = store.createPublish({ workId: work.id, accountId: account.id });
  core.transitionPublish(id, "auto_running");
  core.transitionPublish(id, "published");
  db().prepare("INSERT INTO snapshot (id, publish_id, captured_at, source, status, metrics_json) VALUES ('s1',?,'1000','intercept','ok','{\"play\":1}')").run(id);
  db().prepare("INSERT INTO snapshot (id, publish_id, captured_at, source, status, metrics_json) VALUES ('s2',?,'2000','intercept','partial','{\"play\":9}')").run(id);

  const [row] = store.listStats({ publishId: id });
  assert.equal(row.latest.capturedAt, 2000);
  assert.equal(row.latest.metrics.play, 9);
  assert.equal(row.latest.status, "partial");
});

test("adding the same account twice is idempotent, not a crash", () => {
  const otherGroup = store.addGroup({ name: "store 幂等组" }).id;
  const first = store.addAccount({ platform: "tiktok", handle: "@again", groupId: otherGroup });
  const second = store.addAccount({ platform: "tiktok", handle: "@again", groupId: otherGroup });
  assert.equal(first.id, second.id);
  assert.equal(second.existed, true);
});

test("range parsing rejects nonsense instead of returning everything", () => {
  assert.throws(() => store.rangeCutoff("last-year"), /时间范围/);
  assert.equal(store.rangeCutoff("all"), 0);
});
