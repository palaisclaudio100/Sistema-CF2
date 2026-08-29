import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const contracts = read('schemas/v1/contracts.json');
const lifecycle = read('schemas/v1/lifecycle.json');
const reasons = read('reason-codes.v1.json');
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const errors = [];

function requireFields(object, fields, label) {
  for (const field of fields) if (!(field in object)) errors.push(`${label}: missing ${field}`);
}
function validateObject(object, label = object.id ?? 'object') {
  const kind = object.type;
  const spec = contracts.types[kind];
  if (!spec) return errors.push(`${label}: invalid type ${kind}`);
  requireFields(object, contracts.common.required, label);
  requireFields(object, spec.required, label);
  if (!Array.isArray(object.basis_ref) || object.basis_ref.length === 0) errors.push(`${label}: basis_ref required`);
  if (!iso(object.created_at) || !iso(object.updated_at)) errors.push(`${label}: invalid timestamps`);
  if (kind === 'TASK' && object.state === 'DONE' && !object.closure_ref) errors.push(`${label}: MISSING_CLOSURE_PROOF`);
  if (kind === 'VERIFICATION' && object.class === 'VOLÁTIL' && !object.valid_until) errors.push(`${label}: STALE_VERIFICATION policy missing`);
  if (kind === 'VERIFICATION' && object.class === 'CONDICIONAL' && !object.invalidation_rule) errors.push(`${label}: conditional invalidation rule missing`);
  if (kind === 'DECISION' && !['CLAUDIO_DIRECT','CLAUDIO_PERSISTED','DGA_DELEGATED','ROLE_DELEGATED'].includes(object.authority)) errors.push(`${label}: invalid authority`);
}
function validateEnvelope(kind, object, label) {
  const spec = lifecycle[kind];
  requireFields(object, spec.required, label);
  for (const [key, value] of Object.entries(spec.properties)) {
    if (value.enum && key in object && !value.enum.includes(object[key])) errors.push(`${label}: invalid ${key}`);
  }
}
const fixture = read('fixtures/cases.v1.json');
for (const item of fixture.objects) validateObject(item, item.id);
for (const entry of fixture.commands) validateEnvelope('command', entry, entry.command_id);
for (const entry of fixture.events) validateEnvelope('event', entry, entry.event_id);
for (const entry of fixture.jobs) validateEnvelope('job', entry, entry.job_id);
for (const entry of fixture.mappings) validateEnvelope('mapping', entry, entry.artifact_id);
for (const entry of fixture.proofs) validateEnvelope('proof', entry, entry.artifact_id);
if (new Set(reasons.codes).size !== reasons.codes.length) errors.push('reason-codes: duplicate code');
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`validated ${fixture.objects.length} objects, ${fixture.commands.length} commands, ${fixture.events.length} events, ${fixture.jobs.length} jobs, ${fixture.mappings.length} mappings, ${fixture.proofs.length} proofs`);

export { validateObject, validateEnvelope, errors };
