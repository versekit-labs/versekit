import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { componentBinary, installComponent, listComponents, removeComponent } from "../src/components.mjs";
import { loadAdapters, buildHandlers } from "../src/adapters.mjs";
import { createCoreHandlers } from "../src/handlers.mjs";
import { close, migrate, open } from "../src/index.mjs";
import { deliverPending } from "../src/notify.mjs";
import { createRunner, queuePublish } from "../src/runner.mjs";
import { getFeishuDelivery } from "../src/store.mjs";
import feishu from "../../channel-feishu/src/index.mjs";

test("ACC-release-04：只安装校验通过的锁定文件，已有组件无需下载，移除只动私有目录", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vk-component-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prefix = join(dir, "install");
  const manifestPath = join(dir, "manifest.json");
  const env = {
    HIFABU_PREFIX: prefix, HIFABU_RELEASE_MANIFEST: manifestPath,
    HIFABU_BILIUP_BIN: "", HIFABU_LARK_BIN: "", PATH: "/usr/bin:/bin",
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }

  const archive = (name, version, compression) => {
    const path = join(dir, name + ".tar");
    const folder = join(dir, "bundle");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, name), `#!/bin/sh\nprintf '%s\\n' '${name} ${version}'\n`, { mode: 0o755 });
    execFileSync("tar", [compression, path, "-C", dir, `bundle/${name}`]);
    return readFileSync(path);
  };
  const packages = {
    biliup: archive("biliup", "0.2.4", "-cJf"),
    "lark-cli": archive("lark-cli", "1.0.97", "-czf"),
  };
  const requests = [];
  const server = createServer((req, res) => {
    const name = req.url.slice(1);
    requests.push(name);
    if (!Object.hasOwn(packages, name)) return res.writeHead(404).end();
    res.end(packages[name]);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));

  const makeAsset = (name, version) => ({
    version,
    files: {
      [`${process.platform}-${process.arch}`]: {
        url: `http://127.0.0.1:${server.address().port}/${name}`,
        upstream: "https://github.com/example/release",
        size: packages[name].length,
        sha256: createHash("sha256").update(packages[name]).digest("hex"),
      },
    },
  });
  const manifest = { schema: "hifabu.release/1", components: { biliup: makeAsset("biliup", "v0.2.4"), "lark-cli": makeAsset("lark-cli", "1.0.97") } };
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  const lark = Object.values(manifest.components["lark-cli"].files)[0];
  const goodLarkDigest = lark.sha256;
  lark.sha256 = "0".repeat(64);
  await assert.rejects(installComponent("biliup"), { code: "manifest_missing" });
  writeFileSync(manifestPath, "{}");
  await assert.rejects(installComponent("biliup"), { code: "manifest_invalid" });
  save();

  const initial = (await listComponents()).components;
  assert.deepEqual(requests, []);
  assert.equal(initial[0].installed, false);
  assert.equal(initial[0].lockedVersion, "v0.2.4");
  assert.equal(initial[0].size, packages.biliup.length);
  assert.equal(initial[0].source, "biliup/biliup-rs");

  const installed = await Promise.all([installComponent("biliup", { offline: true }), installComponent("biliup", { offline: true })]);
  assert.equal(installed[0].installed, true);
  assert.deepEqual(installed[0], installed[1]);
  const binary = join(prefix, "bin", "biliup");
  assert.equal(componentBinary("biliup"), binary);
  assert.equal((await listComponents()).components[0].installedVersion, "v0.2.4");
  const before = readFileSync(binary);
  assert.equal((await installComponent("biliup")).already, true);
  assert.deepEqual(readFileSync(binary), before);
  assert.deepEqual(requests, ["biliup"]);

  await assert.rejects(installComponent("lark-cli"), { code: "component_checksum" });
  assert.deepEqual(readdirSync(join(prefix, "bin")), ["biliup"]);
  const original = lark.url;
  lark.url = lark.upstream;
  save();
  await assert.rejects(installComponent("lark-cli", { offline: true }), { code: "offline_mode" });
  assert.deepEqual(requests, ["biliup", "lark-cli"]);
  lark.url = original;
  lark.sha256 = goodLarkDigest;
  save();
  assert.equal((await installComponent("lark-cli", { offline: true })).installed, true);
  assert.equal((await listComponents()).components[1].installedVersion, "1.0.97");

  assert.equal((await removeComponent("biliup")).removed, true);
  assert.equal((await removeComponent("biliup")).removed, false);
  assert.equal(existsSync(binary), false);
  assert.equal(componentBinary("biliup"), null);
  const external = join(dir, "external-biliup");
  writeFileSync(external, before, { mode: 0o755 });
  process.env.HIFABU_BILIUP_BIN = external;
  assert.equal((await installComponent("biliup")).already, true);
  await assert.rejects(removeComponent("biliup"), { code: "component_external" });
  assert.deepEqual(readFileSync(external), before);
  await assert.rejects(installComponent("../node"), { code: "component_unknown" });
});

test("ACC-release-04：biliup 被移除后，到点发布转失败并留下 component_missing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vk-component-run-"));
  const prefix = join(dir, "install");
  t.after(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [key, value] of Object.entries({
    HIFABU_HOME: dir, HIFABU_PREFIX: prefix, HIFABU_BILIUP_BIN: "", PATH: "/usr/bin:/bin",
    HIFABU_RELEASE_MANIFEST: join(dir, "missing.json"),
    HIFABU_LARK_BIN: join(dir, "missing-lark"),
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  migrate();
  const db = open();
  const { adapters, errors } = await loadAdapters({ only: ["bilibili"] });
  assert.deepEqual(errors, []);
  const [bilibili] = adapters;
  const attempt = t.mock.method(bilibili.adapter, "publish", () => assert.fail("缺组件时不能调用 B 站适配器"));
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "biliup"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(bilibili.adapter.ready(), null);
  const handlers = createCoreHandlers({ adapters, offline: true });

  const scheduled = Date.now() + 60_000;
  db.prepare("INSERT INTO account (id, platform, handle, state, created_at) VALUES (?, ?, ?, ?, ?)").run("a_bili", "bilibili", "演示账号", "ok", scheduled);
  db.prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?, ?, ?, ?)").run("w_bili", "演示稿", join(dir, "unused.mp4"), scheduled);
  db.prepare("INSERT INTO publish (id, work_id, account_id, state, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("p_bili", "w_bili", "a_bili", "queued", scheduled, scheduled, scheduled);
  const run = queuePublish({ id: "p_bili", accountId: "a_bili" }, { runAfter: scheduled });
  t.mock.timers.enable({ apis: ["Date"], now: scheduled - 1 });
  const runner = createRunner({ handlers: buildHandlers(adapters) });
  assert.equal(await runner.tick(), 0);
  await handlers["component.remove"]({ name: "biliup" });
  assert.match(bilibili.adapter.ready(), /没有装/);
  t.mock.timers.tick(1);
  assert.equal(await runner.tick(), 1);
  assert.equal(attempt.mock.callCount(), 0);
  const publish = db.prepare("SELECT state, error_code, error_message FROM publish WHERE id = 'p_bili'").get();
  const status = db.prepare("SELECT state, attempts FROM run WHERE id = ?").get(run);
  const event = db.prepare("SELECT type, publish_id, payload_json FROM event WHERE type = 'component_missing'").get();
  assert.equal(publish.state, "failed");
  assert.equal(publish.error_code, "component_missing");
  assert.match(publish.error_message, /组件.*重试/);
  assert.equal(status.state, "failed");
  assert.equal(status.attempts, 1);
  assert.equal(event.publish_id, "p_bili");
  const payload = JSON.parse(event.payload_json);
  assert.equal(payload.error_code, "component_missing");
  assert.equal(payload.message, publish.error_message);
  assert.equal(db.prepare("SELECT state FROM account WHERE id = 'a_bili'").get().state, "ok");
  if (process.env.HIFABU_TEST_COMPONENT_EVIDENCE === "1") console.log(JSON.stringify({ publish, run: status, event: { type: event.type, publish_id: event.publish_id, payload } }));

  // 真实飞书通道发现本机文件已被删，进程无法启动，投递失败记录仍供系统页读取。
  const delivery = await deliverPending({ channel: feishu, binding: { external_user_id: "ou_fixture" } });
  assert.deepEqual(delivery, { sent: 0, considered: 1 });
  assert.match(getFeishuDelivery().failure.reason, /飞书组件找不到了/);

  await assert.rejects(handlers["component.install"]({ name: "biliup" }), { code: "manifest_missing" });
  writeFileSync(process.env.HIFABU_RELEASE_MANIFEST, "{}");
  await assert.rejects(handlers["component.install"]({ name: "biliup" }), { code: "manifest_invalid" });
  const failures = db.prepare("SELECT payload_json FROM event WHERE type = 'component.failed' ORDER BY rowid").all();
  assert.deepEqual(failures.map(({ payload_json }) => JSON.parse(payload_json).error_code), ["manifest_missing", "manifest_invalid"]);
});
