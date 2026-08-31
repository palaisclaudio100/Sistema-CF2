# Stage 5 cloud-role gate (staging only)

Temporary, non-production bridge for proving the real cloud path `Drive exact-ID -> RoleInterface -> synthetic Core -> Drive exact-ID`.

- OAuth scope is exactly `drive.file`.
- The request file's baseline revision and Drive's initial `sync` notification are ignored.
- Only `READ_SNAPSHOT`, `COMMAND_SUBMIT`, and `READ_COMMAND_STATUS` are accepted.
- Google `permissionId`, exact file ID, gate instance and watch channel bind server-side to `ACTOR:DIEGO` / `DGA` with `ACTOR_BINDING_SCOPE=STAGING_CHANNEL_ONLY`.
- JSON actor/role/authority claims are rejected.
- Store is an ephemeral SQLite file containing only `ENTITY:STAGE5:SYNTHETIC` and the synthetic task.
- No production database, filesystem, adapter or credential is referenced.
- Drive is transport and evidence, never authority or Core.
- This gate does not prove cryptographic separation between an agent and the underlying human Google identity.

The service starts in `GOOGLE_OAUTH_CLIENT_BOOTSTRAP_REQUIRED` until a staging OAuth web client is provisioned in Render secrets. OAuth redirect URI is `/oauth/google/callback`. After consent, the bridge tries the provisional staging exact IDs; if `drive.file` cannot access them, it creates an app-owned staging folder plus request/response files.
