CREATE TABLE IF NOT EXISTS role_gateway_objects (
  object_id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('TASK','VERIFICATION')),
  body JSONB NOT NULL,
  actor_id TEXT NOT NULL,
  acting_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS role_gateway_audit (
  event_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  acting_role TEXT,
  operation TEXT NOT NULL,
  authorized BOOLEAN NOT NULL,
  reason_code TEXT NOT NULL,
  object_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
