import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomToken, tokenHash } from "./google.mjs";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const applicationId = 0x48494641; // HIFA
const schemaVersion = 1;
const loginTtlMs = 10 * 60_000;
export const sessionTtlMs = 30 * 86_400_000;
const defaultCapacityBytes = 10_000_000_000;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32(value, length) {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

function ulid(timestamp) {
  const suffix = BigInt(`0x${randomBytes(10).toString("hex")}`);
  return base32(BigInt(timestamp), 10) + base32(suffix, 16);
}

function transaction(db, run) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reservePrivateFile(filename) {
  if (filename === ":memory:") return;
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(filename, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (!lstatSync(filename).isFile()) throw new Error("Hifabu 控制库必须是普通文件。");
}

export function openControlStore(filename, { clock = Date.now } = {}) {
  reservePrivateFile(filename);
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    transaction(db, () => {
      const { application_id: id } = db.prepare("PRAGMA application_id").get();
      const { user_version: version } = db.prepare("PRAGMA user_version").get();
      if (id === applicationId && version === schemaVersion) {
        const columns = db.prepare("PRAGMA table_info(relay_grant)").all();
        // The nullable column is additive. Older cloud binaries can still open this database.
        if (!columns.some(({ name }) => name === "closed_at")) db.exec("ALTER TABLE relay_grant ADD COLUMN closed_at INTEGER");
        return;
      }
      const hasObjects = db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (id !== 0 || version !== 0 || hasObjects) throw new Error("文件不是受支持的 Hifabu 控制库。");
      db.exec(`${schema}\nPRAGMA application_id = ${applicationId}; PRAGMA user_version = ${schemaVersion};`);
    });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

    const addAttempt = db.prepare(`
      INSERT INTO login_code (state_hash, verifier_hash, nonce, link_code, expires_at) VALUES (?, ?, ?, ?, ?)
    `);
    const deleteExpiredAttempts = db.prepare("DELETE FROM login_code WHERE expires_at <= ?");
    const deleteAttemptsForLink = db.prepare("DELETE FROM login_code WHERE link_code = ?");
    const consumeAttempt = db.prepare(`
      DELETE FROM login_code WHERE state_hash = ? AND verifier_hash = ? AND expires_at > ?
      RETURNING nonce, link_code
    `);
    const userForIdentity = db.prepare(`
      SELECT u.id, u.email FROM identity i JOIN user u ON u.id = i.user_id
      WHERE i.provider = ? AND i.subject = ?
    `);
    const userForEmail = db.prepare("SELECT id, email FROM user WHERE email = ?");
    const addUser = db.prepare("INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)");
    const addIdentity = db.prepare("INSERT INTO identity (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)");
    const addSession = db.prepare("INSERT INTO session (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)");
    const deleteExpiredSessions = db.prepare("DELETE FROM session WHERE expires_at <= ?");
    const findSession = db.prepare(`
      SELECT u.id, u.email, s.expires_at FROM session s JOIN user u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `);
    const deleteSession = db.prepare("DELETE FROM session WHERE token_hash = ?");
    const ensureGrant = db.prepare("INSERT INTO relay_grant (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING");
    const findGrant = db.prepare(`
      SELECT requested_at AS requestedAt, closed_at AS closedAt, coalesce(enabled, 0) AS enabled,
        coalesce(capacity_bytes, ?) AS capacityBytes
      FROM user LEFT JOIN relay_grant ON relay_grant.user_id = user.id WHERE user.id = ?
    `);
    const requestGrant = db.prepare(`
      UPDATE relay_grant SET requested_at = ? WHERE user_id = ? AND enabled = 0 AND requested_at IS NULL
    `);
    const updateGrant = db.prepare(`
      UPDATE relay_grant SET enabled = coalesce($enabled, enabled), capacity_bytes = coalesce($capacity, capacity_bytes),
        requested_at = CASE WHEN $enabled IS NULL THEN requested_at ELSE NULL END,
        closed_at = CASE WHEN $enabled = 0 AND enabled = 1 THEN $now WHEN $enabled = 1 THEN NULL ELSE closed_at END
      WHERE user_id = $userId
    `);
    const findUser = db.prepare("SELECT id, email FROM user WHERE id = ?");
    const listUsers = db.prepare(`
      SELECT u.id, u.email, g.requested_at AS requestedAt, g.closed_at AS closedAt, coalesce(g.enabled, 0) AS enabled,
        coalesce(g.capacity_bytes, ?) AS capacityBytes,
        (SELECT group_concat(DISTINCT provider) FROM identity WHERE user_id = u.id) AS providers,
        (SELECT count(*) FROM device WHERE user_id = u.id AND revoked_at IS NULL) AS machines,
        max(u.created_at,
            coalesce((SELECT max(last_seen_at) FROM device WHERE user_id = u.id), 0),
            coalesce((SELECT max(created_at) FROM session WHERE user_id = u.id), 0)) AS lastActivityAt
      FROM user u LEFT JOIN relay_grant g ON g.user_id = u.id
      ORDER BY (g.requested_at IS NULL), g.requested_at, u.email
    `);
    const deleteUser = db.prepare("DELETE FROM user WHERE id = ?");
    const addDevice = db.prepare(`
      INSERT INTO device (id, user_id, role, name, refresh_token_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const touchDevice = db.prepare(`
      UPDATE device SET last_seen_at = ?
      WHERE refresh_token_hash = ? AND revoked_at IS NULL
      RETURNING id, user_id, role
    `);
    const machineAccount = db.prepare(`
      SELECT u.email, g.enabled, g.capacity_bytes FROM user u JOIN relay_grant g ON g.user_id = u.id
      WHERE u.id = ?
    `);
    const revokeDevice = db.prepare(`
      UPDATE device SET revoked_at = coalesce(revoked_at, ?)
      WHERE user_id = ? AND id = ? RETURNING id
    `);
    const revokeByRefreshHash = db.prepare(`
      UPDATE device SET revoked_at = coalesce(revoked_at, ?)
      WHERE refresh_token_hash = ? RETURNING id
    `);
    const listDevices = db.prepare(`
      SELECT id, name, role, created_at AS createdAt, last_seen_at AS lastSeenAt
      FROM device WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id
    `);
    const relayGrant = (userId) => {
      const row = findGrant.get(defaultCapacityBytes, userId);
      return row ? { ...row, enabled: Boolean(row.enabled) } : null;
    };
    deleteExpiredAttempts.run(clock());
    deleteExpiredSessions.run(clock());

    return {
      beginLogin(linkCode = null) {
        const now = clock();
        const state = randomToken();
        const verifier = randomToken();
        const nonce = randomToken();
        deleteExpiredAttempts.run(now);
        addAttempt.run(tokenHash(state), tokenHash(verifier), nonce, linkCode, now + loginTtlMs);
        return { state, verifier, nonce, maxAge: loginTtlMs / 1000 };
      },

      consumeLogin(state, verifier) {
        return consumeAttempt.get(tokenHash(state), tokenHash(verifier), clock()) ?? null;
      },

      // Callers supply only an already verified provider identity.
      signIn({ provider, subject, email }, previousToken) {
        const normalizedEmail = email.trim().toLowerCase();
        return transaction(db, () => {
          const now = clock();
          let user = userForIdentity.get(provider, subject);
          if (!user) {
            user = userForEmail.get(normalizedEmail);
            if (!user) {
              user = { id: ulid(now), email: normalizedEmail };
              addUser.run(user.id, user.email, now);
            }
            addIdentity.run(provider, subject, user.id, now);
          }
          const token = randomToken();
          deleteExpiredSessions.run(now);
          if (previousToken) deleteSession.run(tokenHash(previousToken));
          addSession.run(tokenHash(token), user.id, now, now + sessionTtlMs);
          return { token, user };
        });
      },

      session(token) {
        return token ? findSession.get(tokenHash(token), clock()) ?? null : null;
      },

      revokeSession(token) {
        if (token) deleteSession.run(tokenHash(token));
      },

      addMachine(userId, { name, role, refreshTokenHash }) {
        return transaction(db, () => {
          const now = clock();
          const deviceId = ulid(now);
          ensureGrant.run(userId);
          addDevice.run(deviceId, userId, role, name, refreshTokenHash, now);
          return deviceId;
        });
      },

      refreshMachine(refreshToken) {
        return transaction(db, () => {
          const device = touchDevice.get(clock(), tokenHash(refreshToken));
          if (!device) return null;
          const account = machineAccount.get(device.user_id);
          return {
            userId: device.user_id, deviceId: device.id, role: device.role,
            email: account.email, relayEnabled: account.enabled === 1, capacityBytes: account.capacity_bytes,
          };
        });
      },

      revokeMachine(userId, deviceId) {
        return Boolean(revokeDevice.get(clock(), userId, deviceId));
      },

      revokeOwnMachine(refreshToken) {
        return Boolean(revokeByRefreshHash.get(clock(), tokenHash(refreshToken)));
      },

      listMachines(userId) {
        return listDevices.all(userId);
      },

      relayGrant,

      requestRelay(userId) {
        return transaction(db, () => {
          if (!findUser.get(userId)) return null;
          ensureGrant.run(userId);
          const { changes } = requestGrant.run(clock(), userId);
          return { grant: relayGrant(userId), changed: changes > 0 };
        });
      },

      setRelayGrant(userId, { enabled, capacityBytes }) {
        return transaction(db, () => {
          if (!findUser.get(userId)) return null;
          ensureGrant.run(userId);
          const flag = enabled == null ? null : Number(enabled);
          updateGrant.run({ $enabled: flag, $capacity: capacityBytes ?? null, $now: clock(), $userId: userId });
          return relayGrant(userId);
        });
      },

      findUser(userId) {
        return findUser.get(userId) ?? null;
      },

      listUsers() {
        return listUsers.all(defaultCapacityBytes).map(({ providers, enabled, ...row }) => ({
          ...row, enabled: Boolean(enabled), providers: providers ? providers.split(",") : [],
        }));
      },

      deleteUser(userId, linkIds) {
        transaction(db, () => {
          for (const id of linkIds) deleteAttemptsForLink.run(id);
          deleteUser.run(userId);
        });
      },

      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
