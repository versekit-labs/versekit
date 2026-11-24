import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMachineSigner, createMachineTokenVerifier, loadMachineSigner } from "../src/machine-token.mjs";

const { privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const machine = {
  userId: "01JJZZZZZZZZZZZZZZZZZZZZZZ",
  deviceId: "01JMZZZZZZZZZZZZZZZZZZZZZZ",
  role: "executor",
  relayEnabled: true,
  capacityBytes: 10_000_000_000,
};

test("机器令牌由 Ed25519 签发，公开密钥可离线验签，满一小时过期", () => {
  let now = 1_790_000_000_000;
  const clock = () => now;
  const signer = createMachineSigner(privatePem, { clock });
  const verify = createMachineTokenVerifier(signer.publicPem, { clock });
  const { machineToken, expiresAt } = signer.issue(machine);
  assert.equal(expiresAt, now + 3_600_000);
  assert.deepEqual(verify(machineToken), {
    aud: "versekit-relay", sub: machine.userId, deviceId: machine.deviceId, role: "executor",
    relayEnabled: true, capacityBytes: machine.capacityBytes, iat: now / 1000, exp: expiresAt / 1000,
  });
  const [header, payload, sig] = machineToken.split(".");
  const changed = { ...JSON.parse(Buffer.from(payload, "base64url")), capacityBytes: Number.MAX_SAFE_INTEGER };
  assert.equal(verify(`${header}.${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${sig}`), null);
  assert.equal(verify(`${header}.${payload}.${sig}=`), null);
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.equal(createMachineTokenVerifier(other, { clock })(machineToken), null);
  now = expiresAt - 1;
  assert.ok(verify(machineToken));
  now = expiresAt;
  assert.equal(verify(machineToken), null);
});

test("签名私钥文件必须是权限 600 的 Ed25519 PEM", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vk-cloud-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "signing.pem");
  writeFileSync(filename, privatePem, { mode: 0o644 });
  assert.throws(() => loadMachineSigner(filename), /权限 600/);
  chmodSync(filename, 0o600);
  assert.match(loadMachineSigner(filename).publicPem, /BEGIN PUBLIC KEY/);
  const other = generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(filename, other);
  assert.throws(() => loadMachineSigner(filename), /Ed25519/);
});
