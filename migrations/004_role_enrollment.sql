CREATE TABLE IF NOT EXISTS role_gateway_enrollments (
  enrollment_id TEXT PRIMARY KEY CHECK (enrollment_id IN ('ENROLLMENT:GABY_CHAT','ENROLLMENT:GABY_CW')),
  actor_id TEXT NOT NULL CHECK (actor_id IN ('ACTOR:GABY_CHAT','ACTOR:GABY_CW')),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('PENDING','CONSUMED','EXPIRED')),
  human_fingerprint TEXT CHECK (human_fingerprint IS NULL OR human_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS role_gateway_sessions (
  session_id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES role_gateway_enrollments(enrollment_id),
  actor_id TEXT NOT NULL CHECK (actor_id IN ('ACTOR:GABY_CHAT','ACTOR:GABY_CW')),
  access_jti_hash TEXT NOT NULL UNIQUE CHECK (access_jti_hash ~ '^[a-f0-9]{64}$'),
  refresh_token_hash TEXT NOT NULL UNIQUE CHECK (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS role_gateway_enrollment_audit (
  event_id TEXT PRIMARY KEY,
  enrollment_id TEXT,
  session_id TEXT,
  actor_id TEXT,
  operation TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  reason_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
