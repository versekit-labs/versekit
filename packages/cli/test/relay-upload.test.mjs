import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRelayServer, hashFile, listDeliveryStatus } from "../../relay/src/index.mjs";

const VK = fileURLToPath(new URL("../src/vk.mjs", import.meta.url));
const exec = promisify(execFile);
const PUSH = "test-maker-token";

async function until(check, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  assert.fail(`等不到${description}`);
}

test("ACC-deliver-03 CLI 退出、断网、服务重启后继续上传，丢回执也只建一次投递", { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "vk402-"));
  const cleanup = [() => rmSync(home, { recursive: true, force: true })];
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose(); });
  const env = { ...process.env, HIFABU_HOME: home };
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [VK, ...args], { env, timeout: 8000 })).stdout);
  const dataDir = join(home, "relay");
  let freeBytes = 10 * 1024 ** 3;
  const relay = createRelayServer({ dataDir, pushToken: PUSH, pullToken: "test-publisher-token", freeBytes: () => freeBytes });
  const relayUrl = `http://127.0.0.1:${await relay.listen()}`;
  cleanup.push(() => relay.close());

  function manifest(name, bytes) {
    const asset = `${name}.mp4`;
    writeFileSync(join(home, asset), bytes);
    const path = join(home, `${name}.json`);
    writeFileSync(path, JSON.stringify({ title: name, cuts: [{ title: name, versions: [{ language: "zh", asset }] }] }));
    return path;
  }
  const bytes = Buffer.alloc(512_000, 12);
  bytes.fill(37, 92_000);
  const path = manifest("交付测试", bytes);
  const sha = await hashFile(join(home, "交付测试.mp4"));
  const partial = join(dataDir, "partial", `${sha}.part`);
  const cutoff = 120_000;
  const putOffsets = [];
  const postStatuses = [];
  const interrupted = Promise.withResolvers();
  let online = true;
  let cutNextUpload = false;
  const proxy = createServer((req, res) => {
    if (!online) return req.socket.destroy();
    const put = req.method === "PUT";
    const post = req.method === "POST" && req.url === "/v1/deliveries";
    if (put) putOffsets.push(Number(new URL(req.url, relayUrl).searchParams.get("offset")));
    const upstream = request(new URL(req.url, relayUrl), { method: req.method, headers: req.headers }, (reply) => {
      if (post) {
        postStatuses.push(reply.statusCode);
        if (postStatuses.length === 1) {
          reply.once("end", () => res.destroy());
          reply.resume();
          return;
        }
      }
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    if (!put || !cutNextUpload) return req.pipe(upstream);

    cutNextUpload = false;
    let forwarded = 0;
    req.on("data", (data) => {
      if (forwarded === cutoff) return;
      const chunk = data.subarray(0, cutoff - forwarded);
      upstream.write(chunk);
      forwarded += chunk.length;
      if (forwarded === cutoff) {
        until(() => statSync(partial, { throwIfNoEntry: false })?.size === cutoff, "中转收到半截文件")
          .then(() => {
            online = false;
            req.socket.destroy();
            upstream.destroy();
            interrupted.resolve();
          }, interrupted.reject);
      }
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  cleanup.push(() => new Promise((resolve) => {
    proxy.close(resolve);
    proxy.closeAllConnections();
  }));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  await cli("init");
  const daemonFile = join(home, ".local", "state", "versekit", "daemon.json");
  async function serve() {
    const child = spawn(process.execPath, [VK, "serve", "--offline", "--port", "0"], { env, stdio: ["ignore", "ignore", "pipe"] });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    cleanup.push(async () => { child.kill("SIGKILL"); await exited; });
    const url = await until(() => {
      assert.equal(child.exitCode, null, stderr);
      if (!stderr.includes("守护进程已启动")) return null;
      return `http://127.0.0.1:${JSON.parse(readFileSync(daemonFile, "utf8")).port}`;
    }, "离线服务启动");
    return { child, exited, url };
  }

  let daemon = await serve();
  await cli("relay", "connect", proxyUrl, "--push", "--token", PUSH, "--group", "主号组");
  online = false;
  const submitted = await cli("work", "push", path);
  assert.match(submitted.id, /^dl_[a-f0-9]+$/);
  assert.match(submitted.message, /已登记/);
  assert.equal(submitted.bytes, bytes.length);
  const waiting = await until(async () => {
    const row = await cli("delivery", "show", submitted.id);
    return row.errorCode === "unreachable" && row;
  }, "断网任务排队");
  assert.equal(waiting.state, "queued");
  assert.match(waiting.message, /网通了会自动接着传/);
  assert.deepEqual(putOffsets, []);

  // CLI 子进程已经结束，只有服务在运行。网恢复后自动开始传，传到中途再次断开。
  cutNextUpload = true;
  online = true;
  await Promise.race([interrupted.promise, until(() => !online, "上传中途断开")]);
  assert.deepEqual(readFileSync(partial), bytes.subarray(0, cutoff));
  assert.equal((await listDeliveryStatus({ url: relayUrl, token: PUSH })).deliveries.length, 0);

  daemon.child.kill("SIGKILL");
  await daemon.exited;
  daemon = await serve();
  assert.equal((await cli("delivery", "list")).deliveries[0].id, submitted.id);
  online = true;
  await until(async () => (await cli("delivery", "show", submitted.id)).state === "waiting", "续传完成并等发布机来取");
  assert.deepEqual(putOffsets, [0, cutoff]);
  assert.deepEqual(postStatuses, [201, 200], "中转建投递后丢回执，重试取到原投递");
  assert.equal(await hashFile(join(dataDir, "blobs", sha)), sha);
  assert.deepEqual((await listDeliveryStatus({ url: relayUrl, token: PUSH })).deliveries.map(({ id }) => id), [submitted.id]);

  // HTTP 使用同一登记逻辑，永久失败留投递状态和事件。
  freeBytes = 1024 ** 3;
  const http = await fetch(`${daemon.url}/api/works/push`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: manifest("磁盘不足测试", "新文件") }),
  });
  assert.equal(http.status, 200);
  const { id } = await http.json();
  const failed = await until(async () => {
    const row = await cli("delivery", "show", id);
    return row.state === "failed" && row;
  }, "后台上传留下永久失败");
  assert.equal(failed.errorCode, "disk_low");
  assert.match(failed.nextStep, /清出中转空间/);
  const event = (await cli("events")).rows.find((row) => row.type === "delivery.failed");
  assert.ok(event);
});
