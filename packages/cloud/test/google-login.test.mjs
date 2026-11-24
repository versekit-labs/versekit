import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COMMANDS, CLOUD_COMMANDS } from "../../core/src/commands.mjs";
import { ROUTES } from "../../core/src/routes.mjs";
import { createCloudServer, sessionCookieName } from "../src/server.mjs";
import { close, fakeGoogle, listen } from "./fake-google.mjs";

const origin = "http://127.0.0.1:8791";
const fetchOptions = { redirect: "manual" };
const machineName = '书房的 Mac <示例 onclick="x">';
const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function getCookie(response, name) {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.match(header, /; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  return header.split(";")[0];
}

test("ACC-cloud-02: Google login over local HTTP with PKCE, verified identity, session and origin checks", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "hifabu-oauth-"));
  let google;
  let cloud;
  t.after(async () => {
    try {
      if (cloud?.listening) await close(cloud);
      if (google?.server.listening) await close(google.server);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  let now = Date.UTC(2026, 10, 24, 10);
  const clock = () => now;
  google = await fakeGoogle(clock);
  cloud = createCloudServer({
    origin,
    dataDir,
    clock,
    google: google.config,
    resolveLink: (code) => code === "123456" ? machineName : null,
  });
  const base = await listen(cloud);
  const request = (path, options) => fetch(new URL(path, base), { ...fetchOptions, ...options });
  const loginCookieName = "__Host-hifabu-login";
  const startPath = "/login/google";
  const sessionPath = "/api/session";
  const revokePath = "/api/session/revoke";
  async function cli(args, token) {
    const env = { ...process.env, HIFABU_ORIGIN: base, HIFABU_SESSION_TOKEN: token ?? "" };
    return (await exec(process.execPath, [cliPath, ...args], { env })).stdout.trim();
  }

  async function begin(linkCode, previous) {
    const body = new URLSearchParams(linkCode ? { code: linkCode } : {});
    const start = await request(startPath, { method: "POST", headers: { Origin: origin, ...(previous && { Cookie: previous }) }, body });
    assert.equal(start.status, 303);
    const authorization = new URL(start.headers.get("Location"));
    assert.equal(authorization.origin, google.origin);
    assert.equal(authorization.searchParams.get("scope"), "openid email");
    assert.equal(authorization.searchParams.get("response_type"), "code");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("client_secret"), null);
    const provider = await fetch(authorization, fetchOptions);
    assert.equal(provider.status, 302);
    const callback = new URL(provider.headers.get("Location"));
    assert.equal(callback.origin, origin);
    return { callback, cookie: getCookie(start, loginCookieName), state: authorization.searchParams.get("state") };
  }

  function finish(attempt, cookie = attempt.cookie) {
    return request(attempt.callback.pathname + attempt.callback.search, { headers: cookie ? { Cookie: cookie } : {} });
  }

  let accountToken;
  let authorizationCode;
  let state;
  let email;
  await t.test("projects cloud commands into vk-cloud without adding local vk commands", async () => {
    const help = await cli(["--help"]);
    for (const command of CLOUD_COMMANDS) {
      assert.ok(help.includes(command.cli.usage));
      assert.ok(!COMMANDS.some(({ name }) => name === command.name));
    }
    assert.deepEqual(JSON.parse(await cli(["session", "create"])), { loginUrl: `${base}/login` });
    assert.deepEqual(JSON.parse(await cli(["session", "get"])), { user: null });
  });

  await t.test("opens registration on the first Google login and rotates a signed-in browser session", async () => {
    const login = await request("/login");
    assert.equal(login.status, 200);
    const page = await login.text();
    assert.match(page, /用 Google 继续/);
    assert.match(page, /href="\/privacy\//);
    assert.doesNotMatch(page, /验证码|邀请|找回密码/);
    assert.equal(login.headers.get("Referrer-Policy"), "strict-origin");
    assert.equal(login.headers.get("Cache-Control"), "no-store");
    assert.match(login.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
    assert.equal((await request("/account")).headers.get("Location"), "/login");
    assert.deepEqual(await (await request(sessionPath)).json(), { user: null });
    for (const url of [startPath, sessionPath, revokePath]) {
      assert.ok(!ROUTES.some((route) => route.path === url), `${url} belongs only to the cloud service`);
    }

    const attempt = await begin();
    authorizationCode = attempt.callback.searchParams.get("code");
    state = attempt.state;
    const result = await finish(attempt);
    assert.equal(result.status, 303);
    assert.equal(result.headers.get("Location"), "/account");
    assert.match(result.headers.getSetCookie()[0], /Max-Age=0/);
    const firstCookie = getCookie(result, sessionCookieName);
    const session = await (await request(sessionPath, { headers: { Cookie: firstCookie } })).json();
    assert.equal(session.user.email, "creator@example.test");
    email = session.user.email;
    assert.deepEqual(Object.keys(session.user).sort(), ["email", "id"]);
    assert.equal(google.exchanges, 1);
    assert.ok((await (await request("/account", { headers: { Cookie: firstCookie } })).text()).includes(email));
    const db = new DatabaseSync(join(dataDir, "control.db"), { readOnly: true });
    try {
      assert.deepEqual({ ...db.prepare("SELECT provider, subject, user_id FROM identity").get() }, {
        provider: "google", subject: "test-google-subject", user_id: session.user.id,
      });
      assert.deepEqual({ ...db.prepare("SELECT id, email FROM user").get() }, session.user);
    } finally {
      db.close();
    }

    const repeat = await begin();
    const rotated = await finish(repeat, `${repeat.cookie}; ${firstCookie}`);
    accountToken = getCookie(rotated, sessionCookieName);
    assert.notEqual(accountToken, firstCookie);
    assert.deepEqual(await (await request(sessionPath, { headers: { Cookie: firstCookie } })).json(), { user: null });
    const second = await (await request(sessionPath, { headers: { Cookie: accountToken } })).json();
    assert.deepEqual(second.user, session.user);
    assert.deepEqual(JSON.parse(await cli(["session", "get"], accountToken.split("=")[1])), second);
  });

  await t.test("rejects a foreign or missing Origin before starting login or revoking a session", async () => {
    for (const Origin of [undefined, "https://elsewhere.invalid", "null"]) {
      const headers = { Cookie: accountToken, ...(Origin && { Origin }) };
      for (const path of [startPath, revokePath]) {
        const result = await request(path, { method: "POST", headers, body: new URLSearchParams() });
        assert.equal(result.status, 403);
        assert.equal((await result.json()).error_code, "origin_forbidden");
      }
    }
    const liveSession = await (await request(sessionPath, { headers: { Cookie: accountToken } })).json();
    assert.equal(liveSession.user.email, email);
    const revoked = await request(revokePath, { method: "POST", headers: { Origin: origin, Cookie: accountToken } });
    assert.equal(revoked.status, 200);
    assert.match(revoked.headers.getSetCookie()[0], /Max-Age=0/);
    assert.deepEqual(await (await request(sessionPath, { headers: { Cookie: accountToken } })).json(), { user: null });
  });

  await t.test("rejects mismatched state, other browsers, expiry and replay before calling Google", async () => {
    const attempt = await begin();
    const originalState = attempt.callback.searchParams.get("state");
    const exchanged = google.exchanges;
    attempt.callback.searchParams.set("state", "x".repeat(43));
    assert.equal((await finish(attempt)).status, 403);
    attempt.callback.searchParams.set("state", originalState);
    assert.equal((await finish(attempt, null)).status, 403);
    assert.equal((await finish(attempt, `${loginCookieName}=${"x".repeat(43)}`)).status, 403);
    assert.equal(google.exchanges, exchanged);
    assert.equal((await finish(attempt)).status, 303);
    assert.equal((await finish(attempt)).status, 403);
    assert.equal(google.exchanges, exchanged + 1);

    const expired = await begin();
    now += 10 * 60_000;
    assert.equal((await finish(expired)).status, 403);
    assert.equal(google.exchanges, exchanged + 1);
  });

  await t.test("rejects absent verification and invalid ID token claims or signature", async () => {
    for (const mode of ["unverified", "verified-string", "wrong-audience", "wrong-issuer", "wrong-nonce", "expired", "tampered"]) {
      google.mode = mode;
      const result = await finish(await begin());
      assert.equal(result.status, 403, mode);
      assert.equal(result.headers.getSetCookie().length, 1, mode);
      const message = mode === "unverified" || mode === "verified-string" ? /邮箱还没有验证/ : /无法确认 Google 登录身份/;
      assert.match(await result.text(), message);
    }
  });

  await t.test("renders a cancellation and trusted machine name, then resumes the same machine request after login", async () => {
    const landing = await (await request("/login?code=123456&name=spoofed")).text();
    assert.match(landing, /登录后继续接入「书房的 Mac &lt;示例 onclick=&quot;x&quot;&gt;」。/);
    assert.doesNotMatch(landing, /spoofed|<示例/);
    assert.doesNotMatch(await (await request("/login?code=000000&name=spoofed")).text(), /登录后继续接入|spoofed/);
    google.mode = "cancelled";
    const cancelled = await finish(await begin("123456"));
    assert.equal(cancelled.status, 200);
    const page = await cancelled.text();
    assert.match(page, /取消了 Google 登录/);
    assert.match(page, /name="code" value="123456"/);
    assert.doesNotMatch(page, /private-upstream-detail/);
    google.mode = "verified";
    const success = await finish(await begin("123456"));
    assert.equal(success.status, 303);
    assert.equal(success.headers.get("Location"), "/link?code=123456");
    getCookie(success, sessionCookieName);
    const untrusted = await finish(await begin("https://elsewhere.invalid"));
    assert.equal(untrusted.headers.get("Location"), "/account");
  });

  const logsDir = join(dataDir, "logs");
  const logged = readdirSync(logsDir).map((name) => readFileSync(join(logsDir, name), "utf8")).join("");
  for (const privateValue of [authorizationCode, state, "123456", accountToken.split("=")[1], google.config.clientId,
    google.config.clientSecret, ...google.verifiers, email, "private-google-access-token", "private-upstream-detail", "Private Name", "private-avatar"]) {
    assert.ok(!logged.includes(privateValue), "activity logs must not contain request data or credentials");
  }
  const entries = logged.trim().split("\n").map((line) => JSON.parse(line));
  for (const error of ["origin_forbidden", "google_state_invalid", "google_email_unverified", "google_cancelled"]) {
    assert.ok(entries.some((entry) => entry.error_code === error && entry.event && entry.message));
  }
});
