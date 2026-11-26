import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renameRelay } from "../../../deploy/volc1/rename-relay.mjs";
import { createMachineSigner } from "../../cloud/src/machine-token.mjs";
import { createRelayServer } from "../src/server.mjs";

const deploy = (path) => fileURLToPath(new URL(`../../../deploy/${path}`, import.meta.url));
const oldHome = "/var/lib/versekit-relay";
const newHome = "/var/lib/hifabu-relay";
const oldApp = "/opt/versekit";
const newApp = "/opt/hifabu";
const oldUnit = "versekit-relay.service";
const newUnit = "hifabu-relay.service";
const units = "/etc/systemd/system";
const caddy = "/etc/caddy/Caddyfile";
const account = "01HF7YAT00A000000000000001";
const blob = "R7 测试成片";
const hash = createHash("sha256").update(blob).digest("hex");
const deliveryId = "dl_0123456789ab";
const caddyOriginal = `assurelane.test { respond "keep" }

# >>> versekit relay (managed by deploy/volc1) >>>
vk.fangyouxi.cn {
  reverse_proxy 127.0.0.1:8790
}
# <<< versekit relay <<<
`;

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "hifabu-r7-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, commandFailure = () => {}) {
  const dir = temp(t);
  const root = (path) => join(dir, path);
  const put = (path, value, options) => {
    mkdirSync(dirname(root(path)), { recursive: true });
    writeFileSync(root(path), value, options);
  };
  const read = (path) => readFileSync(root(path), "utf8");
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = createMachineSigner(privateKey.export({ type: "pkcs8", format: "pem" }));
  const config = {
    untouched: ["preserve"],
    relay: {
      data_dir: oldHome + "/storage",
      machine_public_key_file: oldHome + "/public.pem",
      allow_legacy_tokens: true,
      push_token: "test-push",
      pull_token: "test-pull",
    },
  };
  put(oldHome + "/.config/versekit/config.json", JSON.stringify(config), { mode: 0o600 });
  put(oldHome + "/public.pem", signer.publicPem);
  put(oldApp + "/marker", "old release");
  put(caddy, caddyOriginal);
  put(join(units, oldUnit), "old service unit\n");
  put(join(units, "unrelated.service"), "untouched\n");
  for (const folder of [oldHome + "/storage", oldHome + "/storage/" + account]) {
    put(join(folder, "deliveries", deliveryId + ".json"), JSON.stringify({
      id: deliveryId, state: "pending", group: "test", manifest: { title: "test content" }, blobs: [{ sha256: hash }],
    }));
    put(join(folder, "blobs", hash), blob);
    put(join(folder, "partial", hash + ".part"), "partial");
  }
  const commands = [];
  const output = [];
  const command = (name, ...args) => {
    commands.push([name, ...args]);
    commandFailure(name, args);
    if (name === "curl") return "401";
    if (args[1] === "--property=FragmentPath") return root(join(units, oldUnit));
    if (args[1] === "--property=UnitFileState") return "enabled";
    return "";
  };
  return { root, read, put, signer, config, commands, output, run: (action) => renameRelay(action, { root, command, log: (line) => output.push(line) }) };
}

test("ACC-brand-08 previews both scripts with only node and dirname on PATH", (t) => {
  const dir = temp(t);
  symlinkSync(process.execPath, join(dir, "node"));
  symlinkSync("/usr/bin/dirname", join(dir, "dirname"));
  for (const name of ["cutover-rename", "rollback-rename"]) {
    const result = spawnSync("/bin/bash", [deploy(name), "--dry-run"], { cwd: dir, env: { PATH: dir }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    for (const item of [oldHome, newHome, oldApp, newUnit, "blob", "Caddy"]) assert.ok(result.stdout.includes(item), item);
  }
  assert.deepEqual(readdirSync(dir).sort(), ["dirname", "node"]);
});

test("ACC-brand-08 Seoul check only reads service status and HTTP endpoints", (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, "systemctl"), `#!/bin/bash
[[ "$1 $2" == "is-active --quiet" ]] || exit 2
[[ "$3" == hifabu-cloud.service || "$3" == nginx.service ]]
`, { mode: 0o700 });
  writeFileSync(join(dir, "curl"), `#!/bin/bash
case "\${!#}" in
  http://127.0.0.1:8791/login|https://hifabu.com/login|https://assurelane.ai/) printf 200 ;;
  https://vk.fangyouxi.cn/v1/ping) printf '%s' "\${RELAY_STATUS:-401}" ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  const run = (relayStatus) => spawnSync("/bin/bash", [deploy("hifabu/check-rename.sh")], {
    cwd: dir, env: { PATH: dir, RELAY_STATUS: relayStatus }, encoding: "utf8", timeout: 5000,
  });
  const healthy = run("401");
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /assurelane\.ai\/：HTTP 200/);
  assert.match(healthy.stdout, /vk\.fangyouxi\.cn\/v1\/ping：HTTP 401/);
  const unavailable = run("502");
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /HTTP 502，预期 401/);
  assert.deepEqual(readdirSync(dir).sort(), ["curl", "systemctl"]);
});

test("ACC-brand-08 moves data and code, retains old clients and rolls back with later deliveries", async (t) => {
  const { root, read, put, signer, config, commands, output, run } = fixture(t);
  const initial = statSync(root(oldHome));
  await run("cutover");
  const moved = statSync(root(newHome));
  assert.equal(moved.ino, initial.ino);
  assert.equal(moved.uid, initial.uid);
  assert.equal(readlinkSync(root(oldHome)), root(newHome));
  assert.equal(read(newApp + "/marker"), "old release");
  assert.equal(existsSync(root(oldApp)), false);
  assert.equal(existsSync(root(join(units, oldUnit))), false);
  assert.match(read(join(units, newUnit)), /HIFABU_HOME=\/var\/lib\/hifabu-relay/);
  assert.equal(read(caddy), caddyOriginal.replaceAll("versekit relay", "hifabu relay"));
  assert.equal(read(join(units, "unrelated.service")), "untouched\n");
  assert.ok(commands.some(([name, action, unit]) => name === "systemctl" && action === "stop" && unit === oldUnit));
  assert.ok(commands.some(([name, action, unit]) => name === "systemctl" && action === "enable" && unit === newUnit));
  const movedConfigPath = newHome + "/.config/versekit/config.json";
  const movedConfig = JSON.parse(read(movedConfigPath));
  assert.deepEqual(movedConfig, { ...config, relay: { ...config.relay, data_dir: newHome + "/storage", machine_public_key_file: newHome + "/public.pem" } });
  assert.equal(statSync(root(movedConfigPath)).mode & 0o777, 0o600);
  const perRoot = { deliveries: 1, blobs: 1 };
  const expected = { total: { deliveries: 2, blobs: 2 }, legacy: perRoot, accounts: { [account]: perRoot } };
  await run("counts");
  assert.equal(output.length, 4);
  for (const line of output) assert.deepEqual(JSON.parse(line.slice(line.indexOf("{"))), expected);

  const { relay } = movedConfig;
  const server = createRelayServer({
    dataDir: root(relay.data_dir), machinePublicKey: read(relay.machine_public_key_file),
    allowLegacyTokens: relay.allow_legacy_tokens, pushToken: relay.push_token, pullToken: relay.pull_token,
  });
  const port = await server.listen();
  try {
    const { machineToken } = signer.issue({
      userId: account, deviceId: "01HF7YAT00A000000000000002", role: "executor", relayEnabled: true, capacityBytes: 1024,
    });
    // The older GET pull and blob endpoints remain usable for fixed and account tokens.
    for (const token of [relay.pull_token, machineToken]) {
      const headers = { Authorization: `Bearer ${token}` };
      const list = await fetch(`http://127.0.0.1:${port}/v1/deliveries`, { headers });
      assert.equal(list.status, 200);
      assert.equal((await list.json()).deliveries[0].id, deliveryId);
      const response = await fetch(`http://127.0.0.1:${port}/v1/blobs/${hash}`, { headers });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), blob);
    }
  } finally {
    await server.close();
  }

  // Retire the one-week link and simulate new data and an unrelated Caddy edit.
  unlinkSync(root(oldHome));
  put(newHome + "/storage/deliveries/dl_999999999999.json", "{}");
  const otherSite = "\nother.test { respond 200 }\n";
  put(caddy, read(caddy) + otherSite);
  await run("rollback");
  assert.equal(read(caddy), caddyOriginal + otherSite);
  assert.equal(statSync(root(oldHome)).ino, initial.ino);
  assert.equal(existsSync(root(newHome)), false);
  assert.equal(read(oldHome + "/storage/deliveries/dl_999999999999.json"), "{}");
  assert.deepEqual(JSON.parse(read(oldHome + "/.config/versekit/config.json")), config);
  assert.equal(read(oldApp + "/marker"), "old release");
  assert.equal(read(join(units, oldUnit)), "old service unit\n");
  assert.equal(existsSync(root(join(units, newUnit))), false);
  assert.equal(existsSync(root(join(units, ".hifabu-relay-rename.json"))), false);
  assert.ok(commands.some(([name, action, unit]) => name === "systemctl" && action === "enable" && unit === oldUnit));
});

test("ACC-brand-08 can roll back after the new service fails to start", async (t) => {
  const { root, read, run } = fixture(t, (name, args) => {
    if (name === "systemctl" && args[0] === "start" && args[1] === newUnit) throw new Error("simulated failure");
  });
  await assert.rejects(run("cutover"), /simulated failure/);
  assert.equal(readlinkSync(root(oldHome)), root(newHome));
  assert.equal(read(caddy), caddyOriginal);
  await run("rollback");
  assert.equal(read(caddy), caddyOriginal);
  assert.equal(read(oldHome + "/storage/blobs/" + hash), blob);
  assert.equal(existsSync(root(newHome)), false);
  assert.equal(read(join(units, oldUnit)), "old service unit\n");
});
