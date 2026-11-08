// 采集节奏是产品承诺的一半：「发完不知道效果」这个痛点，靠的不是抓一次，而是抓对时间点。
// 规则是纯函数，所以可以在这里把 30 天压缩成几行断言。
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-collect-"));

const core = await import("../src/index.mjs");
const { nextCollectAt, COLLECT_WINDOW_MS } = await import("../src/collect-plan.mjs");
const { applyPublishResult } = await import("../src/publish-flow.mjs");
const { buildHandlers } = await import("../src/adapters.mjs");

const H = 3600e3;
const D = 24 * H;
const db = () => core.open();
let n = 0;

// ---------------------------------------------------------------- 纯函数

const T0 = 1_700_000_000_000;
const nextFrom = (ageMs) => nextCollectAt(T0, T0 + ageMs);
const offsetOf = (ageMs) => nextFrom(ageMs) - T0;

test("刚发布：第一个采集点在一小时后", () => {
  assert.equal(offsetOf(0), 1 * H);
});

test("刚抓完 1h：下一个点是 6h，不会因为晚了几毫秒跳过", () => {
  assert.equal(nextCollectAt(T0, T0 + 1 * H + 5e3) - T0, 6 * H);
});

test("2 小时时手动抓过一次，节奏不变：下一个仍是 6h", () => {
  assert.equal(offsetOf(2 * H), 6 * H);
});

test("之后依次是 24h、3d、7d", () => {
  assert.equal(offsetOf(6 * H + 1e3), 24 * H);
  assert.equal(offsetOf(24 * H + 1e3), 3 * D);
  assert.equal(offsetOf(3 * D + 1e3), 7 * D);
});

test("7 天之后进每日档，直到 30 天", () => {
  assert.equal(offsetOf(7 * D + 1e3), 8 * D);
  assert.equal(offsetOf(7 * D + D / 2), 8 * D);
  assert.equal(offsetOf(29 * D), 30 * D);
});

test("30 天窗口之外不再排", () => {
  assert.equal(nextFrom(30 * D + 1e3), null);
  assert.equal(nextFrom(60 * D), null);
  assert.ok(COLLECT_WINDOW_MS === 30 * D);
});

test("没有发布时间就不猜", () => {
  assert.equal(nextCollectAt(null), null);
  assert.equal(nextCollectAt(0), null);
  assert.equal(nextCollectAt("1700000000000"), null);
});

// ---------------------------------------------------------------- 落库与排程

function seed(publishedAt = null, state = "published") {
  const k = ++n;
  db().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?,?,?,?)").run(`w${k}`, `t${k}`, "/tmp/a.mp4", Date.now());
  db().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES (?,?,?,?)").run(`a${k}`, "tiktok", `@h${k}`, Date.now());
  db()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, published_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(`p${k}`, `w${k}`, `a${k}`, state, publishedAt, Date.now(), Date.now());
  return `p${k}`;
}

before(() => core.migrate());

beforeEach(() => {
  db().exec("DELETE FROM snapshot; DELETE FROM followup; DELETE FROM run; DELETE FROM publish; DELETE FROM work; DELETE FROM account;");
});

test("发布成功会盖上 published_at，并排第一次采集", () => {
  const id = seed(null, "auto_running");
  applyPublishResult(id, { id: "v1", url: "https://t.test/v1", visibility: "public", state: "published" });

  const row = db().prepare("SELECT published_at FROM publish WHERE id=?").get(id);
  assert.ok(row.published_at > 0, "没有 published_at，采集节奏就无从起算");

  const run = db().prepare("SELECT run_after FROM run WHERE target_id=? AND kind='collect'").get(id);
  assert.ok(run, "发布后必须自动排第一次采集");
  assert.ok(Math.abs(run.run_after - (row.published_at + H)) < 5e3, "第一个点在一小时后");
});

test("一次采集成功后，自动排下一个点（2h 时抓 → 下次 6h）", async () => {
  const publishedAt = Date.now() - 2 * H;
  const id = seed(publishedAt);

  const handler = buildHandlers([
    {
      platform: "tiktok",
      publish: "web",
      collect: "web",
      visibility: [],
      draft: false,
      requiresQualification: false,
      minScheduleLeadMs: null,
      maxFileSizeMb: null,
      adapter: {
        platform: "tiktok",
        ready: () => null,
        async publish() {},
        async collect() {
          return { source: "intercept", status: "ok", metrics: { play: 12, like: 1 } };
        },
      },
    },
  ]).collect;

  await handler({ target_id: id, kind: "collect" });

  assert.equal(db().prepare("SELECT COUNT(*) n FROM snapshot WHERE publish_id=?").get(id).n, 1);
  const next = db().prepare("SELECT run_after, state FROM run WHERE target_id=? AND kind='collect'").get(id);
  assert.ok(next, "抓完一次必须排下一次");
  assert.equal(next.state, "queued");
  assert.ok(Math.abs(next.run_after - (publishedAt + 6 * H)) < 5e3, `下一个点应是 +6h，实际 ${(next.run_after - publishedAt) / H}h`);
});

test("超过 30 天的作品不再排采集", async () => {
  const id = seed(Date.now() - 31 * D);
  const handler = buildHandlers([
    {
      platform: "tiktok",
      publish: "web",
      collect: "web",
      visibility: [],
      draft: false,
      requiresQualification: false,
      minScheduleLeadMs: null,
      maxFileSizeMb: null,
      adapter: {
        platform: "tiktok",
        ready: () => null,
        async publish() {},
        async collect() {
          return { source: "intercept", status: "ok", metrics: { play: 1 } };
        },
      },
    },
  ]).collect;

  await handler({ target_id: id, kind: "collect" });
  assert.equal(db().prepare("SELECT COUNT(*) n FROM run WHERE target_id=? AND kind='collect'").get(id).n, 0);
});
