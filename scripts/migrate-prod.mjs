import { PostgresStore } from '../src/postgres-store.mjs';

if (!process.env.CF2_DATABASE_URL) throw new Error('CF2_DATABASE_URL_REQUIRED');

const store = new PostgresStore({ connectionString: process.env.CF2_DATABASE_URL });
try {
  await store.migrate();
  const health = await store.health();
  process.stdout.write(`${JSON.stringify({ migration: 'PASS', ...health })}\n`);
} finally {
  await store.close();
}
