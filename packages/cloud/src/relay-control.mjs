import { createPublicKey, sign, verify } from "node:crypto";

export const relayAccountId = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ttlSeconds = 30;
const validMethod = (method) => method === "GET" || method === "DELETE";
const message = (method, accountId, expires) =>
  Buffer.from(`versekit relay account control v1\0${method}\0${accountId}\0${expires}`);

export function signRelayControl(privateKey, method, accountId, now) {
  if (!validMethod(method) || !relayAccountId.test(accountId)) throw new Error("传片管理请求不合法。");
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const signature = sign(null, message(method, accountId, expires), privateKey).toString("base64url");
  return `${expires}.${signature}`;
}

export function createRelayControlVerifier(publicPem, clock) {
  const key = createPublicKey(publicPem);
  return (token, method, accountId) => {
    if (!validMethod(method) || !relayAccountId.test(accountId)) return false;
    const fields = /^(\d{1,14})\.([A-Za-z0-9_-]{86})$/.exec(token ?? "");
    if (!fields) return false;
    const expires = Number(fields[1]);
    const now = Math.floor(clock() / 1000);
    // Allow modest clock skew between the account and relay services.
    return expires > now && expires <= now + ttlSeconds * 2 &&
      verify(null, message(method, accountId, expires), key, Buffer.from(fields[2], "base64url"));
  };
}

export function createRelayControl(relayUrl, signer) {
  async function request(method, accountId) {
    if (!relayUrl || !signer) throw new Error("传片服务未配置。");
    const url = new URL(`/v1/control/accounts/${accountId}`, relayUrl);
    const response = await fetch(url, {
      method, redirect: "error", signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${signer.relayControl(method, accountId)}` },
    });
    if (!response.ok) throw Object.assign(new Error("传片服务拒绝了管理请求。"), { status: response.status });
    return response.json();
  }

  return {
    async usage(accountId) {
      const { usedBytes, freeBytes } = await request("GET", accountId);
      if (![usedBytes, freeBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("传片服务返回的用量不合法。");
      }
      return { usedBytes, freeBytes };
    },
    async deleteAccount(accountId) {
      const { deleted } = await request("DELETE", accountId);
      if (deleted !== true) throw new Error("传片服务未确认删除。");
    },
  };
}
