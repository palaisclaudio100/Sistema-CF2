CREATE TABLE IF NOT EXISTS cutover_domains (
  domain TEXT PRIMARY KEY,
  writer TEXT NOT NULL CHECK (writer IN ('CF1_WRITER','TRANSITION_LOCKED','CF2_WRITER','ROLLBACK_LOCKED')),
  decision_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
INSERT INTO cutover_domains(domain,writer,updated_at) VALUES
  ('TASK','CF1_WRITER',now()),('VERIFICATION','CF1_WRITER',now())
ON CONFLICT(domain) DO NOTHING;
CREATE TABLE IF NOT EXISTS cutover_decisions (
  decision_id TEXT PRIMARY KEY, scope JSONB NOT NULL, authority_ref TEXT NOT NULL,
  effective_at TIMESTAMPTZ, status TEXT NOT NULL, basis JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS cutover_journal (
  journal_id TEXT PRIMARY KEY, event TEXT NOT NULL, detail JSONB NOT NULL,
  actor_id TEXT NOT NULL, authority_ref TEXT, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS cutover_backups (
  backup_id TEXT PRIMARY KEY, snapshot JSONB NOT NULL, digest TEXT NOT NULL,
  counts JSONB NOT NULL, state_version BIGINT NOT NULL, schema_versions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, restore_verified BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE audit ADD COLUMN IF NOT EXISTS authority_ref TEXT;
ALTER TABLE audit ADD COLUMN IF NOT EXISTS evidence_ref TEXT;
