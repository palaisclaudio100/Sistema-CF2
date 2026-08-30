import http from 'node:http';
import { PostgresStore } from './postgres-store.mjs';

const config = Object.freeze({ release_id: process.env.CF2_RELEASE_ID, database_url: process.env.CF2_DATABASE_URL, port: Number(process.env.PORT ?? 10000), production_cutover_enabled: false, external_adapters_enabled: false, role_cutover_enabled: false });
if (!config.release_id || !config.database_url) throw new Error('CF2_RELEASE_ID_AND_DATABASE_URL_REQUIRED');
const store = new PostgresStore({ connectionString: config.database_url });
await store.migrate();
const server = http.createServer(async (request, response) => { if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404).end(); return; } try { const health = await store.health(); response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ service: 'cf2-core', release_id: config.release_id, ...health, flags: { production_cutover_enabled: config.production_cutover_enabled, external_adapters_enabled: config.external_adapters_enabled, role_cutover_enabled: config.role_cutover_enabled } })); } catch { response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ service: 'cf2-core', database: 'DOWN' })); } });
server.listen(config.port);
