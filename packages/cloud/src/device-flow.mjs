import { createHash, randomBytes, randomInt } from "node:crypto";
import { randomToken, tokenHash } from "./google.mjs";
import { isMachineRole } from "./machine-token.mjs";

const linkTtlMs = 10 * 60_000;
const maxActiveLinks = 2000;
const cleanLabel = (value) => typeof value === "string" && !/[\p{Cc}\p{Cf}]/u.test(value);

// The browser handle, the six digits, and the machine credential serve distinct purposes.
// The machine presents its long secret again to recover the same refresh credential on a retry.
function refreshFor(pollToken) {
  return createHash("sha256").update("hifabu device refresh v1\0").update(pollToken).digest("base64url");
}

export class DeviceFlowError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function linkPath(id, pathname = "/link") {
  return `${pathname}?${new URLSearchParams({ code: id })}`;
}

export function createDeviceFlow({ store, signer, relayUrl, origin, clock = Date.now }) {
  const byId = new Map();
  const byPollHash = new Map();

  function find(id) {
    const link = byId.get(id);
    return link && link.expiresAt > clock() ? link : null;
  }

  function refresh(refreshToken) {
    const machine = store.refreshMachine(refreshToken);
    if (!machine) throw new DeviceFlowError("device_inactive", 401);
    const { email, role, relayEnabled } = machine;
    return { email, role, relayEnabled, relayUrl, ...signer.issue(machine) };
  }

  return {
    find,
    refresh,

    start({ name, role, os = "" }) {
      if (!cleanLabel(name) || !name.trim() || name.length > 100 ||
          !isMachineRole(role) || !cleanLabel(os) || os.length > 100) {
        throw new DeviceFlowError("device_link_invalid", 400);
      }
      const now = clock();
      const usedCodes = new Set();
      for (const [id, link] of byId) {
        if (link.expiresAt <= now) {
          byId.delete(id);
          byPollHash.delete(link.pollHash);
        } else {
          usedCodes.add(link.code);
        }
      }
      if (byId.size >= maxActiveLinks) throw new DeviceFlowError("device_link_busy", 429);
      let code;
      do { code = String(randomInt(1_000_000)).padStart(6, "0"); } while (usedCodes.has(code));
      const id = randomBytes(24).toString("base64url");
      const pollToken = randomToken();
      const pollHash = tokenHash(pollToken);
      const expiresAt = now + linkTtlMs;
      byId.set(id, {
        name: name.trim(), os: os.trim(), role, code, pollHash, expiresAt, state: "waiting",
        refreshTokenHash: tokenHash(refreshFor(pollToken)),
      });
      byPollHash.set(pollHash, id);
      return { code, pollToken, expiresAt, url: new URL(linkPath(id), origin).href };
    },

    decide(id, userId, decision) {
      if (decision !== "allow" && decision !== "deny") throw new DeviceFlowError("device_link_invalid", 400);
      const link = find(id);
      if (!link || (link.userId && link.userId !== userId)) {
        throw new DeviceFlowError("device_link_expired", 410);
      }
      if (link.state === "waiting") {
        if (decision === "allow") store.addMachine(userId, link);
        link.userId = userId;
        link.state = decision === "allow" ? "linked" : "denied";
      }
      return link.state;
    },

    poll(pollToken) {
      const id = byPollHash.get(tokenHash(pollToken));
      const link = find(id);
      if (!link) return { state: "expired" };
      if (link.state !== "linked") return { state: link.state };
      const refreshToken = refreshFor(pollToken);
      return { state: "linked", refreshToken, ...refresh(refreshToken) };
    },
  };
}
