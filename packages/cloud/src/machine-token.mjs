import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { signRelayControl } from "./relay-control.mjs";
import { isMachineRole } from "./transport.mjs";

export { isMachineRole };

const ttlSeconds = 3600;
export const machineTokenTtlMs = ttlSeconds * 1000;
const audience = "versekit-relay";
const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
const idPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function validClaims(claims) {
  return claims && claims.aud === audience &&
    typeof claims.sub === "string" && idPattern.test(claims.sub) &&
    typeof claims.deviceId === "string" && idPattern.test(claims.deviceId) &&
    isMachineRole(claims.role) && typeof claims.relayEnabled === "boolean" &&
    Number.isSafeInteger(claims.capacityBytes) && claims.capacityBytes >= 0 &&
    Number.isSafeInteger(claims.iat) && claims.exp === claims.iat + ttlSeconds;
}

export function loadMachineSigner(filename, options) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Hifabu 签名私钥必须是权限 600 的普通文件。");
    }
    return createMachineSigner(readFileSync(fd), options);
  } finally {
    closeSync(fd);
  }
}

export function createMachineSigner(privatePem, { clock = Date.now } = {}) {
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Hifabu 签名私钥必须是 Ed25519。");
  const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" });

  return {
    publicPem,
    relayControl: (method, accountId) => signRelayControl(privateKey, method, accountId, clock()),
    issue({ userId, deviceId, role, relayEnabled, capacityBytes }) {
      const iat = Math.floor(clock() / 1000);
      const exp = iat + ttlSeconds;
      const claims = { aud: audience, sub: userId, deviceId, role, relayEnabled, capacityBytes, iat, exp };
      if (!validClaims(claims)) throw new Error("无法签发机器令牌：资料不完整。");
      const body = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      const signature = sign(null, Buffer.from(body), privateKey).toString("base64url");
      return { machineToken: `${body}.${signature}`, expiresAt: exp * 1000 };
    },
  };
}

export function createMachineTokenVerifier(publicPem, { clock = Date.now } = {}) {
  const publicKey = createPublicKey(publicPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Hifabu 验签公钥必须是 Ed25519。");
  return (token) => {
    if (typeof token !== "string" || token.length > 2048) return null;
    const fields = token.split(".");
    if (fields.length !== 3 || fields[0] !== header) return null;
    const [protectedHeader, payload, encodedSignature] = fields;
    const signature = Buffer.from(encodedSignature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== encodedSignature) return null;
    if (!verify(null, Buffer.from(`${protectedHeader}.${payload}`), publicKey, signature)) return null;
    try {
      const bytes = Buffer.from(payload, "base64url");
      if (bytes.toString("base64url") !== payload) return null;
      const claims = JSON.parse(bytes.toString("utf8"));
      const now = Math.floor(clock() / 1000);
      return validClaims(claims) && claims.iat <= now && claims.exp > now ? claims : null;
    } catch {
      return null;
    }
  };
}
