CREATE TABLE IF NOT EXISTS canon_read_requests (
  request_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  arguments JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  response JSONB,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '90 seconds'
);
CREATE INDEX IF NOT EXISTS canon_read_pending ON canon_read_requests(status,created_at);
CREATE TABLE IF NOT EXISTS canon_bridge_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  actor_id TEXT NOT NULL CHECK(actor_id='ACTOR:CODEX'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
