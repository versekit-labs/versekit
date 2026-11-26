import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { hashFile } from "../../relay/src/client.mjs";
import { localFixture } from "../../../test/plugin/transport-fixture.mjs";

const maker = fileURLToPath(new URL("../../../plugins/hifabu/bin/hifabu", import.meta.url));
const exec = promisify(execFile);
const mib = 1024 ** 2;

async function makeAssets(directory, size, { withSmallFile = false } = {}) {
  const names = withSmallFile ? ["first.mp4", "fixture.mp4"] : ["fixture.mp4"];
  const file = join(directory, names.at(-1));
  writeFileSync(file, "");
  truncateSync(file, size);
  if (withSmallFile) writeFileSync(join(directory, names[0]), "fixture first file");
  const manifest = join(directory, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ title: "离线上传测试", cuts: names.map((asset, i) => ({
    title: `成片 ${i + 1}`, versions: [{ asset, language: "zh" }],
  })) }));
  const hashes = await Promise.all(names.map((name) => hashFile(join(directory, name))));
  return { manifest, hashes };
}

function pidOf(lock) {
  try {
    return Number(readFileSync(lock, "utf8").trim());
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return 0;
  }
}

function processLine(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch (err) {
    if (err.status !== 1) throw err;
    return "";
  }
}

function caffeinateFor(pid) {
  return execFileSync("ps", ["ax", "-o", "command="], { encoding: "utf8" })
    .split("\n").some((line) => line.trim().endsWith(`/usr/bin/caffeinate -i -w ${pid}`));
}

async function eventually(probe) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await wait(30);
  }
  assert.fail("等待上传进程或本机中转超时");
}

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "hf-uploader-"));
  const fixture = await localFixture(directory, { maker });
  t.after(async () => {
    const pid = pidOf(fixture.lock);
    if (pid && processLine(pid).includes(" _uploader ")) process.kill(pid, "SIGKILL");
    await fixture.close();
    rmSync(directory, { force: true, recursive: true });
  });
  return { directory, fixture };
}

if (process.argv[2] === "--interactive-fixture") {
  const directory = process.argv[3];
  const fixture = await localFixture(directory, { maker, interactive: true });
  const size = 220 * mib;
  const { manifest, hashes: [sha] } = await makeAssets(directory, size);
  console.log(`FIXTURE ${fixture.origin} bytes=${size} sha256=${sha}`);
  console.log("RUN " + [maker, ...fixture.args, "work", "push", manifest, "--group", "本地测试"].map(JSON.stringify).join(" "));
} else {
  test("ACC-maker-06/07: parent SIGKILL, partial upload retry, one delivery, worker and caffeinate exit", {
    skip: process.platform === "win32", timeout: 30_000,
  }, async (t) => {
    const { directory, fixture } = await setup(t);
    const size = 96 * mib;
    const { manifest, hashes: [smallSha, sha] } = await makeAssets(directory, size, { withSmallFile: true });
    // Use a live PID with a stale heartbeat to exercise both parts of the lease.
    writeFileSync(fixture.lock, String(process.pid));
    const stale = new Date(Date.now() - 61_000);
    utimesSync(fixture.lock, stale, stale);
    const gate = Promise.withResolvers();
    let disconnectedAt = 0;
    fixture.interrupt = async (file, blob, req) => {
      if (file !== sha || disconnectedAt || blob.received < mib) return false;
      await gate.promise;
      disconnectedAt = blob.received;
      req.destroy();
      return true;
    };

    const metering = join(directory, "measure-hash.mjs");
    const measurements = join(directory, "hash-ms");
    writeFileSync(metering, `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      if (process.argv.includes("work") && process.argv.includes("push")) {
        const createReadStream = fs.createReadStream;
        fs.createReadStream = (path, ...args) => {
          const started = performance.now();
          const stream = createReadStream(path, ...args);
          stream.on("close", () => fs.appendFileSync(${JSON.stringify(measurements)}, String(performance.now() - started) + "\\n"));
          return stream;
        };
        syncBuiltinESMExports();
      }
    `);
    execFileSync(maker, [...fixture.args, "--help"]);
    const parent = spawn(process.execPath, ["-e", `
      const { spawnSync } = require("node:child_process");
      const started = performance.now();
      const [command, ...args] = process.argv.slice(1);
      const result = spawnSync(command, args, { encoding: "utf8" });
      process.send({ status: result.status, stdout: result.stdout, elapsed: Math.round(performance.now() - started) });
      setInterval(() => {}, 1000);
    `, maker, ...fixture.args, "work", "push", manifest, "--group", "测试"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=" + pathToFileURL(metering)].filter(Boolean).join(" ") },
    });
    const parentExit = once(parent, "exit");
    t.after(() => parent.kill("SIGKILL"));
    const [{ status, stdout, elapsed }] = await once(parent, "message");
    assert.equal(status, 0, stdout);
    const { id, state } = JSON.parse(stdout);
    assert.equal(state, "pending");
    const hashMs = Math.round(readFileSync(measurements, "utf8").trim().split("\n").reduce((sum, ms) => sum + Number(ms), 0));
    assert.ok(elapsed - hashMs < 1000, `96 MiB work push took ${elapsed} ms, including ${hashMs} ms for SHA-256`);
    const pid = await eventually(() => pidOf(fixture.lock) !== process.pid && pidOf(fixture.lock));
    assert.match(processLine(pid), / _uploader /);
    if (process.platform === "darwin") await eventually(() => caffeinateFor(pid));
    assert.equal(fixture.deliveries.size, 0);
    parent.kill("SIGKILL");
    assert.deepEqual(await parentExit, [null, "SIGKILL"]);
    gate.resolve();

    await eventually(() => fixture.deliveries.has(id) && !existsSync(fixture.lock));
    assert.equal(fixture.deliveries.size, 1);
    assert.equal(fixture.blobs.get(sha).sha, sha);
    assert.deepEqual(fixture.blobs.get(sha).offsets, [0, disconnectedAt]);
    assert.ok(disconnectedAt >= mib);
    assert.deepEqual(fixture.blobs.get(smallSha).offsets, [0], "completed blob must not be sent again");
    await eventually(() => !processLine(pid));
    if (process.platform === "darwin") await eventually(() => !caffeinateFor(pid));
    t.diagnostic(`work push pending in ${elapsed} ms including ${hashMs} ms for SHA-256; parent=${parent.pid} SIGKILL; worker=${pid} exited`);
    t.diagnostic(`PUT offsets [0,${disconnectedAt}]; completed blob offsets [0]; deliveries=1 id=${id} SHA-256=${sha}`);
  });

  test("ACC-maker-08: delivery list takes over after uploader SIGKILL and reports persisted progress", {
    skip: process.platform === "win32", timeout: 30_000,
  }, async (t) => {
    const { directory, fixture } = await setup(t);
    const { manifest, hashes: [sha] } = await makeAssets(directory, 32 * mib);
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    let resumedAt;
    fixture.interrupt = async (_file, blob) => {
      if (blob.offsets.length === 1 && blob.received >= mib) {
        await first.promise;
        return true;
      }
      if (blob.offsets.length === 2 && blob.received >= resumedAt + mib) await second.promise;
      return false;
    };
    const { id, state } = await fixture.run("work", "push", manifest, "--group", "测试");
    assert.equal(state, "pending");
    await eventually(() => fixture.blobs.get(sha)?.received >= mib);
    const before = pidOf(fixture.lock);
    resumedAt = fixture.blobs.get(sha).received;
    process.kill(before, "SIGKILL");
    await eventually(() => !processLine(before));
    first.resolve();
    assert.ok(existsSync(fixture.lock), "SIGKILL leaves a stale lock");

    await Promise.all(Array.from({ length: 6 }, () => fixture.run("delivery", "list")));
    const after = await eventually(() => pidOf(fixture.lock) !== before && pidOf(fixture.lock));
    const running = await eventually(async () => {
      const view = await fixture.run("delivery", "show", id);
      if (view.state === "uploading" && view.progress.bytes > resumedAt && view.progress.percent < 100) return view;
    });
    assert.ok(running.progress.etaSeconds > 0);
    assert.equal(pidOf(fixture.lock), after);
    assert.deepEqual(fixture.blobs.get(sha).offsets, [0, resumedAt]);
    second.resolve();

    await eventually(() => fixture.deliveries.has(id) && !existsSync(fixture.lock));
    assert.equal(fixture.deliveries.size, 1);
    assert.equal(fixture.blobs.get(sha).sha, sha);
    assert.equal((await fixture.run("delivery", "show", id)).state, "waiting");
    t.diagnostic(`uploader ${before} SIGKILL; delivery list started ${after}; resumed offset=${resumedAt}; local bytes=${running.progress.bytes}, ETA=${running.progress.etaSeconds}s; remote state=waiting`);
  });

  test("maker records invalid relay group with a local error and event before uploading", {
    skip: process.platform === "win32", timeout: 15_000,
  }, async (t) => {
    const { directory, fixture } = await setup(t);
    const { manifest, hashes: [sha256] } = await makeAssets(directory, 1024);
    const group = "不存在的组";
    writeFileSync(manifest, JSON.stringify({
      schema: "hifabu.delivery/1", work: { key: "offline/invalid-group", title: "分组检查" },
      cuts: [{ video: { name: "fixture.mp4", size: 1024, sha256 } }], target: { group }, from: { client: "maker-test" },
    }));
    fixture.groupSnapshot = { groups: [{ name: "已有组", accounts: [] }] };
    const { id, state } = await fixture.run("work", "push", manifest);
    assert.equal(state, "pending");
    const failed = await eventually(async () => {
      const view = await fixture.run("delivery", "show", id);
      return view.state === "failed" && view;
    });
    assert.equal(failed.errorCode, "group_not_found");
    assert.match(failed.reason, /已有组/);
    assert.match(failed.nextStep, /重新交付/);
    const record = JSON.parse(readFileSync(join(directory, "maker", "queue", id + ".json"), "utf8"));
    assert.deepEqual(record.event, { type: "delivery.upload_failed", at: record.failure.updatedAt, error_code: failed.errorCode });
    assert.equal(fixture.blobs.size, 0);
    await eventually(() => !existsSync(fixture.lock));
  });
}
