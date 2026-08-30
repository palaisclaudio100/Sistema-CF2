import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');

test('Render blueprint keeps every production mutation flag disabled', () => {
  const blueprint = read('render.yaml');
  assert.match(blueprint, /CF2_PRODUCTION_WRITER_ENABLED[\s\S]*value: "false"/);
  assert.match(blueprint, /CF2_EXTERNAL_ADAPTERS_ENABLED[\s\S]*value: "false"/);
  assert.match(blueprint, /CF2_ROLE_CUTOVER_ENABLED[\s\S]*value: "false"/);
  assert.match(blueprint, /name: cf2-prod-postgres/);
  assert.match(blueprint, /name: cf2-prod-core/);
});

test('production code has no embedded connection string or secret material', () => {
  const service = read('src/prod-service.mjs');
  const store = read('src/postgres-store.mjs');
  assert.match(service, /CF2_DATABASE_URL/);
  assert.doesNotMatch(`${service}\n${store}`, /postgres(?:ql)?:\/\/[^$\s]/i);
});
