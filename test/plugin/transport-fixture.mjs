import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { cloudRoute } from "../../packages/cloud/src/transport.mjs";

const exec = promisify(execFile);
const refreshPath = cloudRoute("device.refresh", {}).path;
const revokePath = cloudRoute("device.revoke.self", {}).path;
const accountId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const refreshToken = "r".repeat(43);
const email = "maker@example.test";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function localFixture(directory, { maker, interactive = false, dataDir = join(directory, "maker") } = {}) {
  const lock = join(dataDir, "uploader.lock");
  const blobs = new Map();
  const deliveries = new Map();
  const credentialPath = join(dataDir, "device.json");
  let revoked = false;
  const log = (message) => { if (interactive) console.log(new Date().toISOString(), message); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const authorized = req.headers.authorization === "Bearer " + refreshToken;
      if (url.pathname === revokePath && authorized) {
        fixture.credentialPresentAtRevoke = existsSync(credentialPath);
        revoked = true;
        return send(res, 200, { revoked });
      }
      if (url.pathname === refreshPath && authorized && !revoked) {
        const machineToken = "fake." + Buffer.from(JSON.stringify({ sub: accountId })).toString("base64url") + ".fake";
        return send(res, 200, { email, role: "maker", relayEnabled: true, relayUrl: origin, machineToken, expiresAt: Date.now() + 3600_000 });
      }
      if (url.pathname === "/v1/ping") {
        return send(res, 200, { accepts: fixture.accepts, freeBytes: 20 * 1024 ** 3 });
      }
      if (url.pathname === "/v1/group-snapshot" && fixture.groupSnapshot) {
        return send(res, 200, { snapshot: fixture.groupSnapshot });
      }
      const match = /^\/v1\/blobs\/([0-9a-f]{64})(\/status)?$/.exec(url.pathname);
      if (match) {
        const [, sha, status] = match;
        if (!blobs.has(sha)) blobs.set(sha, { received: 0, complete: false, digest: createHash("sha256"), offsets: [] });
        const blob = blobs.get(sha);
        const { received, complete } = blob;
        if (status && req.method === "GET") return send(res, 200, { received, complete });
        if (req.method === "PUT") {
          const offset = Number(url.searchParams.get("offset"));
          const total = Number(url.searchParams.get("total"));
          blob.offsets.push(offset);
          if (offset !== received) return send(res, 409, { error: "offset_mismatch" });
          if (interactive) {
            log(`PUT START offset=${offset} total=${total}`);
            await wait(40_000);
          }
          for await (const chunk of req) {
            blob.digest.update(chunk);
            blob.received += chunk.length;
            if (await fixture.interrupt?.(sha, blob, req)) return;
          }
          blob.sha = blob.digest.copy().digest("hex");
          blob.complete = blob.received === total && sha === blob.sha;
          log(`PUT END bytes=${blob.received} sha256=${blob.sha}`);
          return send(res, 201, { complete: blob.complete, received: blob.received });
        }
      }
      if (url.pathname === "/v1/deliveries") {
        if (req.method === "GET") return send(res, 200, { deliveries: [...deliveries.values()] });
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        if (!body.blobs.every(({ sha256 }) => blobs.get(sha256)?.complete)) return send(res, 409, { error: "missing_blobs" });
        if (!deliveries.has(body.id)) {
          deliveries.set(body.id, { ...body, state: "pending", created_at: Date.now(), updated_at: Date.now() });
          log(`DELIVERY ${body.id} state=pending count=${deliveries.size}`);
        }
        return send(res, 201, deliveries.get(body.id));
      }
      const delivery = deliveries.get(url.pathname.split("/").at(-1));
      return delivery ? send(res, 200, delivery) : send(res, 404, { message: "找不到投递" });
    } catch (err) {
      if (!req.destroyed) send(res, 500, { message: err.message });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(credentialPath, JSON.stringify({ origin, refreshToken, checkedAt: Date.now(),
    email, role: "maker", relayEnabled: true, relayUrl: origin, accountId }), { mode: 0o600 });
  const args = ["--offline", "--data", dataDir, "--json"];
  const fixture = {
    lock, origin, blobs, deliveries, args, dataDir, credentialPath,
    accepts: ["hifabu.delivery/1"],
    useFakeKeychain() {
      const bin = join(directory, "fake-system-bin");
      const secret = join(directory, "fake-keychain-refresh");
      mkdirSync(bin);
      writeFileSync(secret, refreshToken, { mode: 0o600 });
      writeFileSync(join(bin, "security"), `#!/bin/sh
case "$1" in
  find-generic-password) /bin/cat "$HIFABU_FIXTURE_KEYCHAIN";;
  delete-generic-password) /bin/rm "$HIFABU_FIXTURE_KEYCHAIN";;
  *) exit 1;;
esac
`, { mode: 0o700 });
      writeFileSync(credentialPath, JSON.stringify({ origin, checkedAt: Date.now(), email, role: "maker",
        relayEnabled: true, relayUrl: origin, accountId, deviceId: accountId, credentialStorage: "keychain" }), { mode: 0o600 });
      return {
        env: { PATH: bin + ":" + process.env.PATH, HIFABU_FIXTURE_KEYCHAIN: secret },
        exists: () => existsSync(secret),
      };
    },
    async run(...words) {
      return JSON.parse((await exec(maker, [...args, ...words], { timeout: 15_000 })).stdout);
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
  return fixture;
}
