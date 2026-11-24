CREATE TABLE user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE identity (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
) STRICT;
CREATE INDEX identity_user ON identity(user_id);

CREATE TABLE session (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX session_user ON session(user_id);
CREATE INDEX session_expiry ON session(expires_at);

-- An OAuth attempt is bound to a browser and consumed before the provider exchange.
CREATE TABLE login_code (
  state_hash TEXT PRIMARY KEY,
  verifier_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  link_code TEXT,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX login_code_expiry ON login_code(expires_at);

CREATE TABLE device (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('maker', 'executor')),
  name TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE INDEX device_user ON device(user_id);

CREATE TABLE relay_grant (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  requested_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  capacity_bytes INTEGER NOT NULL DEFAULT 10000000000 CHECK (capacity_bytes >= 0),
  closed_at INTEGER
) STRICT;
