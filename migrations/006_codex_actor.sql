ALTER TABLE role_gateway_enrollments DROP CONSTRAINT IF EXISTS role_gateway_enrollments_enrollment_id_check;
ALTER TABLE role_gateway_enrollments ADD CONSTRAINT role_gateway_enrollments_enrollment_id_check CHECK (enrollment_id IN ('ENROLLMENT:GABY_CHAT','ENROLLMENT:GABY_CW','ENROLLMENT:CODEX'));
ALTER TABLE role_gateway_enrollments DROP CONSTRAINT IF EXISTS role_gateway_enrollments_actor_id_check;
ALTER TABLE role_gateway_enrollments ADD CONSTRAINT role_gateway_enrollments_actor_id_check CHECK (actor_id IN ('ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX'));

ALTER TABLE role_gateway_sessions DROP CONSTRAINT IF EXISTS role_gateway_sessions_actor_id_check;
ALTER TABLE role_gateway_sessions ADD CONSTRAINT role_gateway_sessions_actor_id_check CHECK (actor_id IN ('ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX'));

ALTER TABLE mcp_oauth_codes DROP CONSTRAINT IF EXISTS mcp_oauth_codes_actor_id_check;
ALTER TABLE mcp_oauth_codes ADD CONSTRAINT mcp_oauth_codes_actor_id_check CHECK (actor_id IN ('ACTOR:DIEGO','ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX'));
ALTER TABLE mcp_oauth_sessions DROP CONSTRAINT IF EXISTS mcp_oauth_sessions_actor_id_check;
ALTER TABLE mcp_oauth_sessions ADD CONSTRAINT mcp_oauth_sessions_actor_id_check CHECK (actor_id IN ('ACTOR:DIEGO','ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX'));
