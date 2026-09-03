CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  actor_id TEXT NOT NULL CHECK (actor_id IN ('ACTOR:DIEGO','ACTOR:GABY_CHAT','ACTOR:GABY_CW')),
  code_challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mcp_oauth_sessions (
  session_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id),
  actor_id TEXT NOT NULL CHECK (actor_id IN ('ACTOR:DIEGO','ACTOR:GABY_CHAT','ACTOR:GABY_CW')),
  resource TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE CHECK (access_token_hash ~ '^[a-f0-9]{64}$'),
  refresh_token_hash TEXT NOT NULL UNIQUE CHECK (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_oauth_sessions_access_idx ON mcp_oauth_sessions(access_token_hash);
CREATE INDEX IF NOT EXISTS mcp_oauth_sessions_refresh_idx ON mcp_oauth_sessions(refresh_token_hash);
