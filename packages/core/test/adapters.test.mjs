// Adapter discovery + wiring: a real package on disk must be found, validated, and its publish
// handler must be reachable through the runner. This is the seam where a bad package would
// otherwise take down the whole daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-adapter-"));

const core = await import("../src/index.mjs");
const { loadAdapters, buildHandlers } = await import("../src/adapters.mjs");
const { createRunner } = await import("../src/runner.mjs");

function fakePackage(root, name, source) {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports: { ".": { import: "./src/index.mjs" } } }));
  writeFileSync(join(dir, "src", "index.mjs"), source);
}

test("a valid adapter package is discovered and exposed", async () => {
  const root = mkdtempSync(join(tmpdir(), "vk-pkg-"));
  fakePackage(root, "adapter-fake", `
    export default {
      platform: "fake",
      capabilities: { publish: "web", collect: "web" },
      ready: () => null,
      async publish() { globalThis.__published = true; },
      async collect() { return {}; },
    };`);
  const { adapters, errors } = await loadAdapters({ root });
  assert.deepEqual(errors, []);
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0].platform, "fake");
  assert.equal(adapters[0].publish, "web");
});

test("a broken adapter is reported, not fatal", async () => {
  const root = mkdtempSync(join(tmpdir(), "vk-pkg-"));
  fakePackage(root, "adapter-bad", `export default { platform: "bad" };`);
  const { adapters, errors } = await loadAdapters({ root });
  assert.equal(adapters.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ready/);
});

test("publish handler routes to the adapter of the publish's platform", async () => {
  core.migrate();
  const db = core.open();
  db.prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a9','fake','@f',1)").run();
  db.prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES ('w9','t','/tmp/a.mp4',1)").run();
  db.prepare("INSERT INTO publish (id, work_id, account_id, created_at, updated_at) VALUES ('p9','w9','a9',1,1)").run();

  const root = mkdtempSync(join(tmpdir(), "vk-pkg-"));
  fakePackage(root, "adapter-fake", `
    export default {
      platform: "fake",
      capabilities: { publish: "web", collect: "web" },
      ready: () => null,
      async publish({ publishId }) { globalThis.__seen = publishId; return { id: "vid1", url: "https://t.test/vid1", visibility: "public", state: "published" }; },
      async collect() { return {}; },
    };`);
  const { adapters } = await loadAdapters({ root });
  const handlers = buildHandlers(adapters);

  core.enqueue({ kind: "publish", targetType: "publish", targetId: "p9", lane: "a9" });
  const runner = createRunner({ handlers, log: () => {} });
  await runner.tick();

  assert.equal(globalThis.__seen, "p9");
  assert.equal(db.prepare("SELECT state FROM run WHERE target_id='p9'").get().state, "done");
  const row = db.prepare("SELECT state, external_id, external_url FROM publish WHERE id='p9'").get();
  assert.equal(row.state, "published");
  assert.equal(row.external_id, "vid1");
  assert.match(row.external_url, /vid1$/);
});

test("a publish with no installed adapter fails with a readable reason", async () => {
  core.migrate();
  const db = core.open();
  db.prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a8','douyin','@d',1)").run();
  db.prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES ('w8','t','/tmp/a.mp4',1)").run();
  db.prepare("INSERT INTO publish (id, work_id, account_id, created_at, updated_at) VALUES ('p8','w8','a8',1,1)").run();

  const root = mkdtempSync(join(tmpdir(), "vk-pkg-"));
  fakePackage(root, "adapter-fake", `export default { platform: "fake", ready: () => null, async publish() {} };`);
  const { adapters } = await loadAdapters({ root });
  const handlers = buildHandlers(adapters);
  core.enqueue({ kind: "publish", targetType: "publish", targetId: "p8", lane: "a8" });
  const runner = createRunner({ handlers, log: () => {} });
  await runner.tick();

  const row = db.prepare("SELECT state, last_error FROM run WHERE target_id='p8'").get();
  assert.equal(row.state, "queued", "第一次失败应退避重试，而不是直接判死");
  assert.match(row.last_error, /没有 douyin 适配器/);
});
