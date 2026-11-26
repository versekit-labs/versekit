import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, type } from "node:os";
import { join } from "node:path";
import { readEnv } from "../../core/src/env.mjs";
import { callCloud, isLoopback, isMachineRole, publicOrigin } from "../../cloud/src/transport.mjs";
import { RelayError } from "../../relay/src/client.mjs";

const pollIntervalMs = 1500;
const refreshAheadMs = 60_000;
const refreshRetryMs = 30_000;
const statusCheckMs = 60_000;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const defaultOrigin = "https://hifabu.com";
const error = (code, message) => Object.assign(new Error(message), { code });
const accountIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const machineAccountId = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url")).sub;

function removeFile(filename) {
  try {
    unlinkSync(filename);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function credentialFrom(data, origin, refreshToken, checkedAt) {
  if (typeof data?.email !== "string" || !isMachineRole(data.role) || typeof data.relayEnabled !== "boolean" ||
      typeof data.machineToken !== "string" || !Number.isSafeInteger(data.expiresAt) || !secretPattern.test(refreshToken)) {
    throw error("cloud_response_invalid", "Hifabu 账号服务返回的登录资料不完整，请重新登录。");
  }
  return {
    origin, refreshToken, checkedAt, email: data.email, role: data.role, relayEnabled: data.relayEnabled,
    relayUrl: data.relayUrl, machineToken: data.machineToken, expiresAt: data.expiresAt,
  };
}

function readCredential(filename, persistMachineToken) {
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) throw new Error();
    const data = JSON.parse(readFileSync(fd, "utf8"));
    const origin = publicOrigin(data.origin);
    if (persistMachineToken) return credentialFrom(data, origin, data.refreshToken, data.checkedAt);
    if (typeof data.email !== "string" || !isMachineRole(data.role) || typeof data.relayEnabled !== "boolean" ||
        !secretPattern.test(data.refreshToken) || typeof data.accountId !== "string" || !accountIdPattern.test(data.accountId)) throw new Error();
    return { ...data, origin, machineToken: null, expiresAt: 0 };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw error("cloud_credential_unreadable", "无法读取这台机器的 Hifabu 登录资料。请退出登录后重新接入。");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeCredential(filename, data) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    renameSync(temporary, filename);
  } finally {
    removeFile(temporary);
  }
}

const signedOut = { state: "logged_out", loggedIn: false, email: null, role: null, relayEnabled: false };
const signedIn = (data, reachable) => ({
  state: "linked", loggedIn: true, email: data.email, role: data.role, relayEnabled: data.relayEnabled,
  lastCheckedAt: data.checkedAt, reachable,
});
const browserChallenge = ({ role, code, url, expiresAt }) => ({ ...signedOut, state: "waiting", role, code, url, expiresAt });
const system = () => process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : type();

function validChallenge(challenge, origin, now) {
  if (!URL.canParse(challenge?.url)) return false;
  const url = new URL(challenge.url);
  return url.origin === origin && !url.username && !url.password && !url.hash && url.pathname === "/link" &&
    /^\?code=[A-Za-z0-9_-]{32}$/.test(url.search) &&
    /^\d{6}$/.test(challenge.code) && secretPattern.test(challenge.pollToken) &&
    Number.isSafeInteger(challenge.expiresAt) && challenge.expiresAt > now;
}

export function createCloudHandlers({
  offline, openBrowser, log, credentialsDir, credentialName = "hifabu-machine.json",
  persistMachineToken = true, defaultRole = "executor",
}) {
  const credentialFile = join(credentialsDir, credentialName);
  let credential;
  let pending;
  let loginRequest;
  let loginGeneration = 0;
  let pollTimer;
  let refreshTimer;
  let refreshRequest;
  let logoutRequest;
  let terminal;
  let reachable = true;
  let nextStatusCheckAt = 0;

  function request(origin, command, args, token) {
    if (offline && !isLoopback(new URL(origin))) {
      throw error("offline_mode", "离线模式无法连接 Hifabu。");
    }
    return callCloud(origin, command, args, token ? { Authorization: `Bearer ${token}` } : {});
  }

  function currentCredential() {
    if (credential === undefined) credential = readCredential(credentialFile, persistMachineToken);
    return credential;
  }

  function clearCredential() {
    removeFile(credentialFile);
    clearTimeout(refreshTimer);
    refreshTimer = null;
    credential = null;
    reachable = true;
  }

  function scheduleRefresh(data, delay = Math.max(0, data.expiresAt - Date.now() - refreshAheadMs)) {
    clearTimeout(refreshTimer);
    if (offline && !isLoopback(new URL(data.origin))) return;
    refreshTimer = setTimeout(() => refresh().catch(() => {
      log("[cloud] cloud_credential_unreadable 无法更新这台机器的登录资料。");
    }), delay).unref();
  }

  function save(data, { linking = false } = {}) {
    if (linking || persistMachineToken) {
      const { machineToken, expiresAt, ...details } = data;
      const accountId = persistMachineToken ? null : machineAccountId(machineToken);
      if (!persistMachineToken && (typeof accountId !== "string" || !accountIdPattern.test(accountId))) {
        throw error("cloud_response_invalid", "Hifabu 账号服务返回的机器标识有误。");
      }
      mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
      writeCredential(credentialFile, persistMachineToken ? data : { ...details, accountId });
    }
    credential = data;
    reachable = true;
    nextStatusCheckAt = data.checkedAt + statusCheckMs;
    scheduleRefresh(data);
  }

  async function renew(data) {
    try {
      const response = await request(data.origin, "device.refresh", {}, data.refreshToken);
      if (credential !== data) return;
      const updated = credentialFrom(response, data.origin, data.refreshToken, Date.now());
      if (updated.role !== data.role || updated.expiresAt <= Date.now() + refreshAheadMs) {
        throw error("cloud_response_invalid", "Hifabu 账号服务返回的登录资料有误。");
      }
      save(updated);
    } catch (err) {
      if (credential !== data) return;
      if (err.code === "device_inactive") {
        clearCredential();
        log("[cloud] device_inactive 这台机器已退出 Hifabu。");
      } else {
        reachable = false;
        nextStatusCheckAt = Date.now() + refreshRetryMs;
        scheduleRefresh(data, refreshRetryMs);
        log("[cloud] cloud_refresh_failed 暂时无法核对 Hifabu 登录，会自动重试。");
      }
    }
  }

  async function refresh() {
    if (refreshRequest) return refreshRequest;
    const data = currentCredential();
    if (!data) return;
    const operation = renew(data);
    refreshRequest = operation;
    try {
      await operation;
    } finally {
      if (refreshRequest === operation) refreshRequest = null;
    }
  }

  function relayConnection() {
    const saved = currentCredential();
    if (!saved) return null;
    let url;
    let accountId;
    try {
      url = saved.relayUrl == null ? null : publicOrigin(saved.relayUrl);
      // 这里只为本机续传和队列取稳定的账号标识，服务端始终独立验签。
      accountId = saved.accountId ?? machineAccountId(saved.machineToken);
      if (typeof accountId !== "string" || !accountIdPattern.test(accountId)) throw new Error();
    } catch {
      throw error("cloud_credential_unreadable", "Hifabu 登录资料里的传片配置有误，请退出后重新接入。");
    }
    const token = async () => {
      if (offline && (!url || !isLoopback(new URL(url)))) {
        throw new RelayError("离线模式只能连接本机中转。", { code: "offline_mode" });
      }
      const stillConnected = () => credential?.refreshToken === saved.refreshToken && credential.relayUrl === saved.relayUrl;
      if (stillConnected()) {
        if (refreshRequest) await refreshRequest;
        else if (!refreshTimer) {
          if (credential.expiresAt - Date.now() <= refreshAheadMs) await refresh();
          else scheduleRefresh(credential);
        }
      }
      if (!stillConnected()) {
        throw new RelayError("Hifabu 登录或中转地址已变更，恢复此连接后会继续传片。", { code: "cloud_connection_changed", retryable: true });
      }
      if (credential.expiresAt <= Date.now()) {
        throw new RelayError("Hifabu 机器令牌已过期，连上账号服务后会自动更新。", { code: "cloud_token_expired", retryable: true });
      }
      return credential.machineToken;
    };
    return { role: saved.role, url, accountId, token };
  }

  function schedulePoll(attempt) {
    pollTimer = setTimeout(() => void poll(attempt), Math.max(0, Math.min(pollIntervalMs, attempt.expiresAt - Date.now()))).unref();
  }

  function finish(attempt, state, failure) {
    if (pending !== attempt) return;
    pending = null;
    terminal = { ...signedOut, state, role: attempt.role, ...failure };
    if (failure) log(`[cloud] ${failure.error_code} ${failure.message}`);
  }

  async function poll(attempt) {
    try {
      const result = Date.now() >= attempt.expiresAt ? { state: "expired" }
        : await request(attempt.origin, "device.link.poll", {}, attempt.pollToken);
      if (pending !== attempt) return;
      if (result.state === "waiting") return schedulePoll(attempt);
      if (result.state === "denied") {
        return finish(attempt, "denied", { error_code: "device_link_denied", message: "这次接入已拒绝。" });
      }
      if (result.state === "expired") {
        return finish(attempt, "expired", { error_code: "device_link_expired", message: "这次接入过期了。请重新登录 Hifabu。" });
      }
      const data = credentialFrom(result, attempt.origin, result.refreshToken, Date.now());
      if (result.state !== "linked" || data.role !== attempt.role || data.expiresAt <= Date.now() + refreshAheadMs) {
        throw error("cloud_response_invalid", "Hifabu 账号服务返回的登录资料有误。");
      }
      save(data, { linking: true });
      finish(attempt, "linked");
    } catch (err) {
      if (pending !== attempt) return;
      if (err.code === "cloud_unavailable" || err.status >= 500) return schedulePoll(attempt);
      finish(attempt, "error", {
        error_code: err.code === "device_inactive" ? "device_inactive" : "cloud_login_failed",
        message: "无法完成 Hifabu 登录，请重新登录或在我的 Hifabu 查看这台机器。",
      });
    }
  }

  async function start({ name = hostname().replace(/\.local$/i, ""), role = defaultRole }, generation) {
    if (!isMachineRole(role)) throw error("cloud_role_invalid", "机器角色应为制作机（maker）或发布机（executor）。");
    const origin = publicOrigin(readEnv("HIFABU_ORIGIN") ?? defaultOrigin);
    const challenge = await request(origin, "device.link.start", { name, role, os: system() });
    if (generation !== loginGeneration) return signedOut;
    if (!validChallenge(challenge, origin, Date.now())) {
      throw error("cloud_response_invalid", "Hifabu 账号服务返回的接入地址有误，请重试。");
    }
    const { code, url, expiresAt, pollToken } = challenge;
    pending = { code, url, expiresAt, pollToken, origin, role };
    terminal = null;
    schedulePoll(pending);
    openBrowser(url);
    return browserChallenge(pending);
  }

  async function logout() {
    loginGeneration++;
    loginRequest = null;
    clearTimeout(pollTimer);
    clearTimeout(refreshTimer);
    pending = null;
    terminal = null;
    let warning;
    try {
      const saved = currentCredential();
      credential = null; // An in-flight refresh must never restore credentials during logout.
      if (saved) {
        const result = await request(saved.origin, "device.revoke.self", {}, saved.refreshToken);
        if (result?.revoked !== true) throw error("cloud_response_invalid", "Hifabu 未确认注销。");
      }
    } catch (err) {
      const code = err.code ?? "cloud_revoke_failed";
      const message = "服务端没能注销这台设备，到 hifabu.com 的「我的 Hifabu」里手动移除。";
      log(`[cloud] ${code} ${message}`);
      warning = { code, message };
    } finally {
      clearCredential();
    }
    return warning ? { ...signedOut, warning, message: warning.message } : signedOut;
  }

  return {
    relayConnection,
    async "cloud.login"(args) {
      if (logoutRequest) await logoutRequest;
      const saved = currentCredential();
      if (saved) return signedIn(saved, reachable);
      if (pending) return browserChallenge(pending);
      if (loginRequest) return loginRequest;
      const operation = start(args, loginGeneration);
      loginRequest = operation;
      try {
        return await operation;
      } finally {
        if (loginRequest === operation) loginRequest = null;
      }
    },
    async "cloud.logout"() {
      if (logoutRequest) return logoutRequest;
      logoutRequest = logout();
      try {
        return await logoutRequest;
      } finally {
        logoutRequest = null;
      }
    },
    async "cloud.status"() {
      const saved = currentCredential();
      if (!saved) return pending ? browserChallenge(pending) : terminal ?? signedOut;
      if (offline && !isLoopback(new URL(saved.origin))) return signedIn(saved, false);
      // 状态核对也更新传片开通状态，不必等机器令牌临近到期。
      if (Date.now() >= nextStatusCheckAt) await refresh();
      return credential ? signedIn(credential, reachable) : signedOut;
    },
  };
}
