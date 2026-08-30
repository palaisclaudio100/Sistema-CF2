const endpoint = process.env.CF2_HEALTH_URL ?? 'https://cf2-prod-core.onrender.com/health';
const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`CF2_HEALTH_HTTP_${response.status}`);

const health = await response.json();
const requiredDisabledFlags = ['production_cutover_enabled', 'external_adapters_enabled', 'role_cutover_enabled'];
if (health.database !== 'UP') throw new Error('CF2_DATABASE_NOT_UP');
if (!Number.isInteger(health.state_version) || !Number.isInteger(health.outbox_pending)) throw new Error('CF2_HEALTH_SHAPE_INVALID');
if (requiredDisabledFlags.some(flag => health.flags?.[flag] !== false)) throw new Error('CF2_PRODUCTION_FLAGS_NOT_FAIL_CLOSED');

console.log(JSON.stringify({ service: health.service, release_id: health.release_id, database: health.database, postgres_version: health.postgres_version, state_version: health.state_version, outbox_pending: health.outbox_pending, flags: health.flags }));
