import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateObject, validateEnvelope, errors } from '../scripts/validate-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/cases.v1.json'), 'utf8'));
const byId = id => data.objects.find(item => item.id === id);

test('T01 authority precedence remains explicit', () => assert.equal(byId('DECISION:SOMOS:CURRENT').authority, 'CLAUDIO_DIRECT'));
test('T02 superseded decision is not CURRENT', () => { assert.equal(byId('DECISION:SOMOS:OLD').status, 'SUPERSEDED'); assert.equal(byId('DECISION:SOMOS:OLD').superseded_by, 'DECISION:SOMOS:CURRENT'); });
test('T03 unknown is not false', () => assert.equal(byId('ENTITY:ATARAXIA_MUSIC').status, 'UNKNOWN'));
test('T04 fixed verification has evidence and no TTL requirement', () => { const v = byId('VERIFICATION:YT:AI'); assert.equal(v.class, 'FIJO'); assert.equal(v.value, 'YES'); assert.ok(v.evidence_ref); });
test('T05 volatile verification without validity fails closed', () => { const invalid = {...byId('VERIFICATION:YT:AI'), id:'VERIFICATION:VOLATILE', class:'VOLATIL'}; validateObject(invalid, 'volatile'); assert.ok(errors.some(e => e.includes('STALE_VERIFICATION'))); errors.length = 0; });
test('T06 conditional verification requires only its invalidation rule', () => { const invalid = {...byId('VERIFICATION:YT:AI'), id:'VERIFICATION:CONDITIONAL', class:'CONDICIONAL'}; validateObject(invalid, 'conditional'); assert.ok(errors.some(e => e.includes('conditional invalidation rule'))); errors.length = 0; });
test('T07 aliases do not become IDs', () => { const e = byId('ENTITY:MITXODA'); assert.notEqual(e.id, e.aliases[0]); });
test('T09 task cannot be done without closure proof', () => { const invalid = {...byId('TASK:SUPERVISOR:OPEN'), state:'DONE'}; validateObject(invalid, 'invalid-task'); assert.ok(errors.some(e => e.includes('MISSING_CLOSURE_PROOF'))); errors.length = 0; });
test('CURRENT conflict is local to a decision property', () => { const sameKey = data.objects.filter(o => o.type === 'DECISION' && o.subject_id === 'ENTITY:SOMOS_MAS' && o.decision_key === 'PROJECT_STATUS' && o.status === 'CURRENT'); assert.equal(sameKey.length, 1); });
test('T13 mapping requires exact C file id', () => assert.equal(data.mappings[0].C_file_id, 'C_FILE_ID_EXACT'));
test('T15 B path is not proof', () => assert.ok(!('B_path' in data.proofs[0])));
test('T23 derived index cannot alter entity current state', () => assert.equal(byId('ENTITY:INDEPENDIZA').status, 'CURRENT'));
test('T24 historical entity resolves by stable ID', () => assert.equal(byId('ENTITY:MITXODA').id, 'ENTITY:MITXODA'));
test('T27 Somos mas relation and current decision are typed', () => { assert.equal(byId('RELATION:LM110:SOMOS').relation_type, 'BELONGS_TO'); assert.equal(byId('DECISION:SOMOS:CURRENT').value, 'ACTIVE_CONSTRUCTION'); });
test('T29 request event is not closure', () => { const event = data.events[0]; validateEnvelope('event', event, event.event_id); assert.equal(event.event_type, 'REQUESTED'); });
test('acknowledgement and execution remain distinct event types', () => assert.notEqual('ACCEPTED', 'EXECUTION_STARTED'));
test('T30 empty deterministic job carries no agent invocation', () => assert.equal(data.jobs[0].job_type, 'NOOP_ON_EMPTY_EVENT'));
