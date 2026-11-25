import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCloudServer } from "../../cloud/src/server.mjs";
import { createMachineSigner } from "../../cloud/src/machine-token.mjs";
import { createRelayServer } from "../../relay/src/server.mjs";
import { renderNginx } from "../../../deploy/hifabu/render-nginx.mjs";
import { verifyDeployment } from "../../../deploy/hifabu/verify.mjs";
import { CLOUD_COMMANDS } from "../src/commands.mjs";

const hifabu = new URL("../../../deploy/hifabu/", import.meta.url);
const relayConfig = fileURLToPath(new URL("../../../deploy/volc1/configure-hifabu.mjs", import.meta.url));
const asset = (name) => fileURLToPath(new URL(name, hifabu));
const read = (name) => readFileSync(asset(name), "utf8");
const publicOrigin = "https://hifabu.com";

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "hifabu-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function newSigner() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return { pem, signer: createMachineSigner(pem) };
}

test("ACC-deploy-cloud-01 nginx 仅增加账号服务路径，重复渲染结果一致", () => {
  const snippet = read("nginx-account.conf.snippet");
  const staticSite = "server {\n    listen 127.0.0.1:8081;\n    root /var/www/hifabu;\n    location / { try_files $uri $uri/ =404; }\n}\n";
  const rendered = renderNginx(staticSite, snippet);
  assert.equal(renderNginx(rendered, snippet), rendered);
  assert.equal(rendered.replace(/    # >>> Hifabu[\s\S]*?    # <<< Hifabu[^\n]*\n/, ""), staticSite);
  assert.throws(() => renderNginx(staticSite.replace("127.0.0.1:", ""), snippet), /监听/);
  assert.throws(() => renderNginx(staticSite + staticSite, snippet), /server/);
  assert.throws(() => renderNginx(rendered.replace("# <<< Hifabu", "# missing"), snippet), /标记/);

  const route = new RegExp(/^\s*location ~ (\^.+\$) \{/m.exec(snippet)[1]);
  for (const path of ["/login", "/login/google/callback", "/account", "/admin", "/link",
    "/.well-known/hifabu-machine-key.pem", ...CLOUD_COMMANDS.map((cmd) => cmd.http.path.replace(/:\w+/g, "test-id"))]) {
    assert.match(path, route);
  }
  for (const path of ["/", "/download/index.html", "/admin.html", "/login/other",
    "/api/anything-else", "/api/devices/test-id/unrelated", "/.well-known/another.pem"]) {
    assert.doesNotMatch(path, route);
  }
  assert.match(snippet, /proxy_pass http:\/\/127\.0\.0\.1:8791;/);
});

test("ACC-deploy-cloud-01 systemd 与环境模板覆盖现有服务配置", () => {
  const unit = read("hifabu-cloud.service");
  assert.match(unit, /^User=hifabu-cloud$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/hifabu-cloud\/cloud\.env$/m);
  assert.match(unit, /^ExecStart=.*\/packages\/cloud\/src\/serve\.mjs$/m);
  assert.match(unit, /^StateDirectoryMode=0700$/m);
  const serve = readFileSync(new URL("../../cloud/src/serve.mjs", import.meta.url), "utf8");
  const expected = [...new Set(serve.match(/HIFABU_[A-Z_]+/g))].sort();
  const template = read("cloud.env.example");
  assert.deepEqual([...template.matchAll(/^(HIFABU_[A-Z_]+)=/gm)].map(([, name]) => name).sort(), expected);
  assert.match(template, /^HIFABU_GOOGLE_CLIENT_ID=877087769526-u44jrpc2fie2p3meh6s6b2oto8cuqrv0\.apps\.googleusercontent\.com$/m);
  assert.match(template, /^HIFABU_GOOGLE_CLIENT_SECRET=$/m);
});

test("ACC-deploy-cloud-02 dry-run 可从空目录运行，只执行本地预览命令", (t) => {
  const dir = temp(t);
  symlinkSync("/bin/cat", join(dir, "cat"));
  symlinkSync("/usr/bin/dirname", join(dir, "dirname"));
  const result = spawnSync("/bin/bash", [asset("deploy.sh"), "--dry-run"], {
    cwd: dir, env: { PATH: dir }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(readdirSync(dir).sort(), ["cat", "dirname"]);
  for (const item of ["/etc/hifabu-cloud/cloud.env", "machine-signing-key.pem", "read -rs", "openssl genpkey",
    "/etc/nginx/conf.d/hifabu.conf", "nginx -t", "systemctl reload nginx", "systemctl restart hifabu-cloud.service",
    "https://assurelane.ai/", publicOrigin + "/login/google/callback", asset("cloud.env.example")]) {
    assert.ok(result.stdout.includes(item), item);
  }
});

test("ACC-deploy-cloud-02 部署后自检使用本地账号服务，收到 Google 跳转时不跟随", async (t) => {
  const dir = temp(t);
  const { pem, signer } = newSigner();
  const keyPath = join(dir, "signing.pem");
  writeFileSync(keyPath, pem, { mode: 0o600 });
  const cloud = createCloudServer({
    origin: publicOrigin, dataDir: dir, signingKeyFile: keyPath,
    google: { clientId: "offline-client", clientSecret: "offline-test-only" },
  });
  await new Promise((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => cloud.close(resolve)));
  const local = `http://127.0.0.1:${cloud.address().port}`;
  const seen = [];
  const request = (url, options) => {
    assert.equal(options.redirect, "manual");
    seen.push(url);
    if (url === "https://assurelane.ai/" || url === publicOrigin + "/") return Promise.resolve(new Response("home"));
    return fetch(local + new URL(url).pathname, options);
  };
  await verifyDeployment(signer.publicPem, request);
  assert.deepEqual(seen, ["https://assurelane.ai/", publicOrigin + "/", publicOrigin + "/.well-known/hifabu-machine-key.pem",
    publicOrigin + "/login", publicOrigin + "/login/google"]);
  await assert.rejects(verifyDeployment(newSigner().signer.publicPem, request), /公钥/);
  const wrongCallback = (url, options) => url.endsWith("/login/google") ?
    Promise.resolve(new Response(null, { status: 303, headers: { Location: "https://accounts.google.com/?redirect_uri=https://example.test/" } })) :
    request(url, options);
  await assert.rejects(verifyDeployment(signer.publicPem, wrongCallback), /回调/);
});

test("ACC-deploy-cloud-03 中转合并配置后同时接受两种令牌和账号控制签名", async (t) => {
  const dir = temp(t);
  const { signer } = newSigner();
  const key = join(dir, "key.pem");
  const configFile = join(dir, "config.json");
  writeFileSync(key, signer.publicPem);
  const initial = { unrelated: "keep", relay: { port: 8790, push_token: "test-push", pull_token: "test-pull" } };
  const save = (data) => writeFileSync(configFile, JSON.stringify(data));
  const configure = (keyPath = key) => spawnSync(process.execPath, [relayConfig, configFile, keyPath], { encoding: "utf8" });
  save(initial);
  assert.equal(configure().status, 0);
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const relay = config.relay;
  assert.deepEqual(config, { ...initial, relay: { ...initial.relay, machine_public_key_file: key, allow_legacy_tokens: true } });
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.equal(configure().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), config);
  save({ ...config, relay: { ...relay, allow_legacy_tokens: false } });
  assert.equal(configure().status, 0);
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).relay.allow_legacy_tokens, false);
  const invalidKey = join(dir, "wrong.pem");
  writeFileSync(invalidKey, newSigner().pem);
  assert.notEqual(configure(invalidKey).status, 0);
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).relay.machine_public_key_file, key);

  const server = createRelayServer({
    dataDir: join(dir, "deliveries"),
    machinePublicKey: readFileSync(relay.machine_public_key_file, "utf8"),
    allowLegacyTokens: relay.allow_legacy_tokens, pushToken: relay.push_token, pullToken: relay.pull_token,
  });
  const port = await server.listen({ port: 0 });
  t.after(() => server.close());
  const get = (path, token) => fetch(`http://127.0.0.1:${port}/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const userId = "01HF7YAT00A000000000000001";
  const { machineToken } = signer.issue({
    userId, deviceId: "01HF7YAT00A000000000000002", role: "maker", relayEnabled: true, capacityBytes: 1024,
  });
  for (const [token, role] of [[relay.push_token, "push"], [relay.pull_token, "pull"], [machineToken, "push"]]) {
    const response = await get("/ping", token);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).role, role);
  }
  const control = `/control/accounts/${userId}`;
  assert.equal((await get(control, machineToken)).status, 401);
  const response = await get(control, signer.relayControl("GET", userId));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).usedBytes, 0);
});
