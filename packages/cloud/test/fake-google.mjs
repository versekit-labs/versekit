import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

export async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

export async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function fakeGoogle(clock = Date.now) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: "jwk" }), kid: "local-test", use: "sig" };
  const clientId = "fake-local-client";
  const clientSecret = "fake-local-secret";
  const issued = new Map();
  const fixture = { mode: "verified", exchanges: 0, verifiers: [] };
  let origin;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (req.method === "GET" && url.pathname === "/authorize") {
      const params = url.searchParams;
      const code = randomUUID();
      const callback = new URL(params.get("redirect_uri"));
      callback.searchParams.set("state", params.get("state"));
      if (fixture.mode === "cancelled") {
        callback.searchParams.set("error", "access_denied");
        callback.searchParams.set("error_description", "private-upstream-detail");
      } else {
        callback.searchParams.set("code", code);
        issued.set(code, params);
      }
      res.writeHead(302, { Location: callback.href }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      fixture.exchanges += 1;
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const code = params.get("code");
      const attempt = issued.get(code);
      issued.delete(code);
      const verifier = params.get("code_verifier");
      const digest = createHash("sha256").update(verifier ?? "").digest("base64url");
      if (params.get("client_id") !== clientId || params.get("client_secret") !== clientSecret ||
          params.get("grant_type") !== "authorization_code" || !attempt ||
          params.get("redirect_uri") !== attempt.get("redirect_uri") ||
          digest !== attempt.get("code_challenge") || attempt.get("code_challenge_method") !== "S256") {
        res.writeHead(400).end("fake provider rejected request");
        return;
      }
      fixture.verifiers.push(verifier);
      const now = Math.floor(clock() / 1000);
      const claims = {
        iss: fixture.mode === "wrong-issuer" ? "https://wrong.example" : origin,
        aud: fixture.mode === "wrong-audience" ? "other-client" : clientId,
        sub: "test-google-subject",
        nonce: fixture.mode === "wrong-nonce" ? "other-nonce" : attempt.get("nonce"),
        email: "Creator@Example.test",
        email_verified: fixture.mode === "verified-string" ? "true" : fixture.mode !== "unverified",
        iat: now,
        exp: now + (fixture.mode === "expired" ? -1 : 300),
        name: "Private Name",
        picture: "private-avatar",
      };
      const segments = [{ alg: "RS256", kid: key.kid }, claims].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"));
      const payload = segments.join(".");
      const bytes = sign("RSA-SHA256", Buffer.from(payload), privateKey);
      if (fixture.mode === "tampered") bytes[0] ^= 1;
      const token = `${payload}.${bytes.toString("base64url")}`;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id_token: token, access_token: "private-google-access-token" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/keys") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [key] }));
      return;
    }
    res.writeHead(404).end();
  });
  origin = await listen(server);
  return Object.assign(fixture, {
    server,
    origin,
    config: {
      clientId,
      clientSecret,
      endpoints: { authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, keysUrl: `${origin}/keys`, issuers: [origin] },
    },
  });
}
