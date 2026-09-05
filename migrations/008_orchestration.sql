-- Additive, isolated from TASK/VERIFICATION ownership and the Core outbox.
CREATE TABLE IF NOT EXISTS actor_threads (
  thread_id TEXT PRIMARY KEY,
  body JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS actor_threads_status ON actor_threads ((body->>'state'));
CREATE TABLE IF NOT EXISTS actor_transport_keys (
  key_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  capabilities JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS actor_runtime_heartbeats (
  actor_id TEXT PRIMARY KEY,
  body JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
