# P0 orchestration cutover — implementation status

Authority: direct Claudio Palais instruction, 2026-09-05. Base: production
87cf007ea959f465a736447e8939a523bf4d90ca (Claude Code assignment ACL).

## Architecture and reuse

The existing Render `cf2-prod-core`, PostgreSQL, Remote MCP OAuth identities and
RoleInterface are reused. Migration `008_orchestration.sql` adds isolated tables
for threads, expiring runtime credential hashes and runtime heartbeats. No TASK
writer, verification writer, ownership rule, Core outbox, artistic authority,
canon document, Drive permission or disabled legacy Windows task is changed.

Messages carry thread/message IDs, server-bound sender, recipient, type,
payload, optional TASK/COMMAND correlation, timestamps and states. The aggregate
is updated transactionally under a PostgreSQL advisory lock. Claims have random
leases and bounded attempts; expired workers cannot complete a reassigned job.
Responses route to the immutable original sender. Every transition leaves an
audit entry. Replay fingerprints prevent divergent double completions.

Diego can start workflows, dispatch stages, forward messages, resolve objections,
read participating workflows and close/cancel. He receives orchestration powers,
not another role's material writer powers. Only Diego can REQUEST Claude Code.
CLAUDIO_DECISION_REQUIRED accepts only the six reserved decision categories.
Technical deficiencies return objections and canon incidents go to Codex.

The gateway identifies fixed canon IDs, verifies the latest Control before and
after reading the mirror, and checks full bytes plus SHA-256. It provides literal
search and line/section reads with revision and verification metadata. It never
repairs or publishes a mirror. Missing Control authentication, changed revisions,
or divergent bytes produce CANON_NOT_VERIFIED without serving canon content.

## Runtime scope and current blocker

`scripts/actor-runtime.mjs` is a local runner for existing Codex and Claude Code
executables. It receives credentials through stdin, keeps them out of child
environments, executes without shell interpolation and returns through a fenced
claim. Claude Code is spawned only for a Diego-requested job and exits afterward.
No Claude process is kept resident.

This initial runtime only implements CANON_CLOSURE_REVIEW (read-only) and the
technical canon incident response. It is NOT a complete replacement for Gaby CW's
material documentary/audiovisual runtime. Other operations explicitly return
RUNTIME_CAPABILITY_UNAVAILABLE. The runner is not installed as a resident task.

Production has no persistent authenticated read credential for the private
Control document. The existing Google OAuth configuration has only login scopes;
it cannot be repurposed as Drive content authorization. The user's connector can
read the Control in this conversation, but its credential is not exposed to the
service. Public Control export returns HTTP 401. Public Maestro bytes match the
latest Control. This blocks the real role canary; it is not a reason to ask
Claudio to paste a document or to expand file sharing.

Required credential configuration: a read-only OAuth grant able to read the
fixed Control, stored as CF2_CANON_CLIENT_ID, CF2_CANON_CLIENT_SECRET and
CF2_CANON_REFRESH_TOKEN. Runtime tokens must have explicit actor binding and
expiry; table entries can be revoked independently. No tokens are checked in.

## Validation and honest result semantics

Unit tests cover actor spoofing, cross-thread ACL, Claude activation, immutable
return paths, replay conflicts, lease expiry/reclaim, objections, cancellation,
reserved decision categories, canon mismatch and revision races.

`scripts/orchestration-live-canary.mjs` is a deployed HTTP/PG integration test.
It labels synthetic responses TRANSPORT_TEST_ONLY / SYNTHETIC_NO_MODEL, tests
concurrent claims and replay, and separately exercises the real canon guard.
It cancels incomplete canary threads and revokes its temporary credentials in
finally. It verifies zero pending canary requests, no Core state-version changes
and Core outbox zero. A transport test PASS is NEVER the P0 result.

The three zero manual-transport metrics apply only to the exercised automated
path. They do not establish that the ordinary actor workflow is operational.
P0 remains INCOMPLETE until authenticated canon access, complete role runtimes,
persistent activation and a real DIEGO→GABY_CHAT→GABY_CW→CODEX→DIEGO canary pass.

## Recovery

Redeploy production base 87cf007ea959f465a736447e8939a523bf4d90ca to disable new
routes while preserving existing identities and data. The additive tables can
remain for evidence; no destructive down migration is required. Revoke runtime
credential rows and cancel open workflow threads before an operational rollback.

Official runtime references checked 2026-09-05:
- https://developers.openai.com/codex/noninteractive/
- https://code.claude.com/docs/en/headless

## Direct operational-canon path (second implementation stage)

The original missing-Control-OAuth blocker applies to the mirror adapter. The
user explicitly allows direct access to the operational OneDrive canon. A second
path therefore uses authenticated reverse requests in PostgreSQL: every actor
requests canon data through CF2, a fixed-path local read-only bridge answers from
physical OneDrive bytes, and the service delivers the response to the requesting
actor. There is no published cache, user file transport, new role, public share,
Control write or claim that the Drive mirror is current. Metadata explicitly says
ONEDRIVE_CANON_DIRECT / DIRECT_CANON_VERIFIED_MIRROR_NOT_USED.

Migration 009_direct_canon.sql adds expiring requests and a bridge heartbeat.
The bridge credential is bound to existing ACTOR:CODEX and only claim/complete
for canon requests; it cannot claim or execute model work. Work credentials are
bound separately to the same four existing executor actors. All credentials can
be independently revoked. Requests expire and completions use fenced leases.
The original Google mirror adapter remains fail-closed without verified Control.

Runtimes and direct-canon end-to-end validation are pending for this stage; the
previous INCOMPLETE result must not be replaced until live evidence exists.
