import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreStore } from './core-store.mjs';
import { RoleInterface } from './role-interface.mjs';

export const PRODUCTION_CUTOVER_DISABLED = true;
export const MINIMUM_OPERATIONAL_CUTOVER_SCOPE = Object.freeze(['TASK','VERIFICATION']);
export const WRITERS = Object.freeze({ CF1: 'CF1_WRITER', LOCKED: 'TRANSITION_LOCKED', CF2: 'CF2_WRITER', ROLLBACK: 'ROLLBACK_LOCKED' });
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const canonical = value => JSON.stringify(value, Object.keys(value ?? {}).sort());
const keyOf = object => object.id;

export class CutoverError extends Error { constructor(reason_code, message = reason_code) { super(message); this.reason_code = reason_code; } }

export class CutoverJournal {
  constructor({ at = now } = {}) { this.at = at; this.entries = []; }
  append(event, detail = {}) { const entry = Object.freeze({ journal_id: `JOURNAL:${crypto.randomUUID()}`, at: this.at(), event, detail: clone(detail) }); this.entries.push(entry); return entry; }
  export() { return this.entries.map(clone); }
}

export function calculateDelta(baseline = {}, current = {}) {
  const before = new Map((baseline.objects ?? []).map(item => [keyOf(item), item]));
  const after = new Map((current.objects ?? []).map(item => [keyOf(item), item]));
  const entries = [];
  for (const [id, item] of after) { if (!before.has(id)) entries.push({ id, kind: 'NEW', current: clone(item) }); else if (canonical(before.get(id)) !== canonical(item)) entries.push({ id, kind: item.type === 'TASK' && item.state === 'DONE' ? 'TASK_CLOSED' : 'CHANGED', before: clone(before.get(id)), current: clone(item) }); }
  for (const [id, item] of before) if (!after.has(id)) entries.push({ id, kind: 'MISSING_FROM_CURRENT', before: clone(item) });
  return { kind: 'FINAL_DELTA', entries: entries.sort((a, b) => a.id.localeCompare(b.id)), counts: Object.fromEntries(['NEW', 'TASK_CLOSED', 'CHANGED', 'MISSING_FROM_CURRENT'].map(kind => [kind, entries.filter(x => x.kind === kind).length])) };
}

export function applyDelta(shadow = {}, delta = {}) {
  const objects = new Map((shadow.objects ?? []).map(item => [item.id, clone(item)]));
  for (const entry of delta.entries ?? []) { if (entry.kind === 'MISSING_FROM_CURRENT') objects.delete(entry.id); else objects.set(entry.id, clone(entry.current)); }
  return { objects: [...objects.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

export function logicalEquality(cf1 = {}, cf2 = {}, scope = []) {
  if (!Array.isArray(cf1.objects) || !Array.isArray(cf2.objects)) return { result: 'UNKNOWN', reason_code: 'UNKNOWN', differences: [] };
  const types = new Set(scope);
  const select = value => Object.fromEntries(value.objects.filter(item => types.has(item.type)).map(item => [item.id, item]));
  const left = select(cf1); const right = select(cf2); const differences = [];
  for (const id of new Set([...Object.keys(left), ...Object.keys(right)])) if (!left[id] || !right[id]) differences.push({ id, classification: 'BLOCKING', reason_code: 'UNKNOWN' }); else if (canonical(left[id]) !== canonical(right[id])) differences.push({ id, classification: 'BLOCKING', reason_code: 'CONFLICT_OBSERVATION' });
  return { result: differences.some(x => x.classification === 'BLOCKING') ? 'BLOCKING_DIFF' : 'EQUAL', differences };
}

export class SingleWriterBarrier {
  constructor({ environment = 'STAGING', journal = new CutoverJournal() } = {}) { if (environment === 'PRODUCTION') throw new CutoverError('PRODUCTION_CUTOVER_DISABLED'); this.environment = environment; this.journal = journal; this.domains = new Map(); }
  register(scope) { for (const domain of scope) { if (this.domains.has(domain)) throw new CutoverError('CONFLICT'); this.domains.set(domain, WRITERS.CF1); this.journal.append('DOMAIN_REGISTERED', { domain, writer: WRITERS.CF1 }); } }
  writer(domain) { if (!this.domains.has(domain)) throw new CutoverError('UNKNOWN'); return this.domains.get(domain); }
  lock(domain) { if (this.writer(domain) !== WRITERS.CF1) throw new CutoverError('FAIL_CLOSED'); this.domains.set(domain, WRITERS.LOCKED); this.journal.append('WRITER_LOCKED', { domain, previous_writer: WRITERS.CF1 }); }
  handoffToCF2(domain, decision) { if (this.writer(domain) !== WRITERS.LOCKED || !decision.scope.includes(domain) || decision.status !== 'APPROVED_NOT_EXECUTED_SIMULATION' || decision.environment === 'PRODUCTION') throw new CutoverError('AUTHORITY_DENIED'); this.domains.set(domain, WRITERS.CF2); this.journal.append('WRITER_HANDOFF', { domain, new_writer: WRITERS.CF2, decision_id: decision.decision_id }); }
  assertCanWrite(domain, writer) { if (this.writer(domain) !== writer) throw new CutoverError('FAIL_CLOSED'); }
  rollbackR0(domain) { if (this.writer(domain) !== WRITERS.LOCKED) throw new CutoverError('FAIL_CLOSED'); this.domains.set(domain, WRITERS.CF1); this.journal.append('ROLLBACK_R0', { domain, reconciled: false, writer: WRITERS.CF1 }); }
  rollbackR1(domain, reconciliation = []) { if (this.writer(domain) !== WRITERS.CF2) throw new CutoverError('FAIL_CLOSED'); this.domains.set(domain, WRITERS.ROLLBACK); this.journal.append('ROLLBACK_R1_LOCK', { domain }); this.domains.set(domain, WRITERS.CF1); this.journal.append('ROLLBACK_R1', { domain, reconciled: clone(reconciliation), writer: WRITERS.CF1 }); }
  rollbackR2(domain, { backup_ref, audit_ref, outbox_ref, restored_digest }) { if (this.writer(domain) !== WRITERS.CF2) throw new CutoverError('FAIL_CLOSED'); if (![backup_ref, audit_ref, outbox_ref, restored_digest].every(Boolean)) throw new CutoverError('MISSING_EVIDENCE'); this.domains.set(domain, WRITERS.ROLLBACK); this.journal.append('ROLLBACK_R2_RESTORE', { domain, backup_ref, audit_ref, outbox_ref, restored_digest }); this.domains.set(domain, WRITERS.CF1); this.journal.append('ROLLBACK_R2', { domain, writer: WRITERS.CF1 }); }
}

export function createCutoverDecision(input = {}) {
  const required = ['decision_id', 'scope', 'effective_at', 'baseline_id', 'release_id', 'approved_by', 'previous_writer', 'new_writer', 'equality_check_ref', 'rollback_plan_ref', 'status', 'environment'];
  if (required.some(field => input[field] === undefined)) throw new CutoverError('MISSING_EVIDENCE');
  if (input.environment === 'PRODUCTION' || input.status === 'EXECUTED') throw new CutoverError('PRODUCTION_CUTOVER_DISABLED');
  if (input.approved_by !== 'CLAUDIO_PALAIS_SIMULATION' || !['READY', 'APPROVED_NOT_EXECUTED_SIMULATION'].includes(input.status)) throw new CutoverError('AUTHORITY_DENIED');
  return Object.freeze(clone(input));
}

/** Restore an isolated Core store from a verified staging backup for R2. */
export function restoreR2Store({ store, backup_path, expected_digest, audit_ref, outbox_ref }) {
  if (!store || !backup_path || !expected_digest || !audit_ref || !outbox_ref) throw new CutoverError('MISSING_EVIDENCE');
  store.restoreFrom(backup_path);
  const restored_digest = store.authoritativeDigest();
  if (restored_digest !== expected_digest) throw new CutoverError('FAIL_CLOSED');
  return { backup_ref: backup_path, audit_ref, outbox_ref, restored_digest };
}

export function runStagingDrill({ at = now } = {}) {
  const journal = new CutoverJournal({ at }); const scope = ['TASK', 'DECISION', 'RELATION']; const barrier = new SingleWriterBarrier({ environment: 'STAGING', journal }); barrier.register(scope);
  const baseline = { objects: [{ id: 'TASK:BASE', type: 'TASK', state: 'OPEN' }] };
  const cf1Current = { objects: [{ id: 'TASK:BASE', type: 'TASK', state: 'DONE' }, { id: 'DECISION:NEW', type: 'DECISION', status: 'CURRENT', value: 'X' }] };
  const delta = calculateDelta(baseline, cf1Current); const shadow = applyDelta(baseline, delta); const equality = logicalEquality(cf1Current, shadow, scope);
  if (equality.result !== 'EQUAL') throw new CutoverError('CONFLICT');
  const decision = createCutoverDecision({ decision_id: 'CUTOVER_DECISION:STAGING:DRILL', scope, effective_at: at(), baseline_id: 'BASELINE:STAGING', release_id: 'RELEASE:DRILL', approved_by: 'CLAUDIO_PALAIS_SIMULATION', previous_writer: WRITERS.CF1, new_writer: WRITERS.CF2, equality_check_ref: 'EQUALITY:DRILL', rollback_plan_ref: 'RUNBOOK:R0-R2', status: 'APPROVED_NOT_EXECUTED_SIMULATION', environment: 'STAGING' });
  barrier.lock('DECISION'); barrier.rollbackR0('DECISION'); barrier.lock('TASK'); barrier.handoffToCF2('TASK', decision); barrier.rollbackR1('TASK', ['MUTATION:TASK:SIMULATED']);
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'cf2-stage7-r2-')); let r2;
  try {
    const store = new CoreStore(path.join(lab, 'core.db')); const entity = { id: 'ENTITY:STAGE7', type: 'ENTITY', status: 'CURRENT', created_at: at(), updated_at: at(), basis_ref: ['STAGING_DRILL'], entity_kind: 'DRILL', canonical_name: 'Stage 7', aliases: [] };
    store.submitCommand({ command_id: 'COMMAND:STAGE7:R2:BASE', command_type: 'UPSERT_ENTITY', actor_id: 'CODEX_STAGE7', actor_role: 'CODEX', issued_at: at(), idempotency_key: 'stage7-r2-base', payload: { object: entity } });
    const expected_digest = store.authoritativeDigest(); const backup = store.backupTo(path.join(lab, 'before-r2.db'));
    store.submitCommand({ command_id: 'COMMAND:STAGE7:R2:MUTATION', command_type: 'UPSERT_ENTITY', actor_id: 'CODEX_STAGE7', actor_role: 'CODEX', issued_at: at(), idempotency_key: 'stage7-r2-mutation', payload: { object: { ...entity, id: 'ENTITY:STAGE7:MUTATION', canonical_name: 'Mutated' } } });
    const restored = restoreR2Store({ store, backup_path: backup.backupPath, expected_digest, audit_ref: 'AUDIT:STAGING:R2', outbox_ref: 'OUTBOX:STAGING:R2' }); r2 = { ...restored, backup_ref: 'BACKUP:STAGING:EPHEMERAL_VERIFIED', backup_sha256: backup.sha256, backup_bytes: backup.bytes }; store.close();
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
  barrier.lock('RELATION'); barrier.handoffToCF2('RELATION', decision); barrier.rollbackR2('RELATION', r2);
  return { kind: 'STAGING_CUTOVER_DRILL', environment: 'STAGING', production_cutover_disabled: PRODUCTION_CUTOVER_DISABLED, delta, equality, decision, r2_restore: r2, writers: Object.fromEntries(scope.map(domain => [domain, barrier.writer(domain)])), journal: journal.export(), zero_production_side_effect: true };
}

/** Staging-only rehearsal of the first relay-free capability: command, task, verification and closure. */
export function runMinimumOperationalRehearsal({ at = now } = {}) {
  const journal=new CutoverJournal({at}),scope=[...MINIMUM_OPERATIONAL_CUTOVER_SCOPE],barrier=new SingleWriterBarrier({environment:'STAGING',journal});barrier.register(scope);
  const decision=createCutoverDecision({decision_id:'CUTOVER_DECISION:STAGING:MINIMUM',scope,effective_at:at(),baseline_id:'BASELINE:STAGING:MINIMUM',release_id:'RELEASE:STAGING:MINIMUM',approved_by:'CLAUDIO_PALAIS_SIMULATION',previous_writer:WRITERS.CF1,new_writer:WRITERS.CF2,equality_check_ref:'EQUALITY:STAGING:MINIMUM',rollback_plan_ref:'RUNBOOK:R0-R2',status:'APPROVED_NOT_EXECUTED_SIMULATION',environment:'STAGING'});
  for(const domain of scope){barrier.lock(domain);barrier.handoffToCF2(domain,decision);}
  const lab=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage7-minimum-'));try{const store=new CoreStore(path.join(lab,'core.db')),roles=new RoleInterface(store,{version:'stage7-staging'}),stamp=at(),taskId='TASK:STAGE7:MINIMUM';
    store.submitCommand({command_id:'COMMAND:STAGE7:SEED',command_type:'UPSERT_ENTITY',actor_id:'ACTOR:STAGING',actor_role:'STAGING',issued_at:stamp,idempotency_key:'stage7-seed',payload:{object:{id:'ENTITY:STAGE7:MINIMUM',type:'ENTITY',status:'CURRENT',created_at:stamp,updated_at:stamp,basis_ref:['STAGING'],entity_kind:'DRILL',canonical_name:'Minimum cutover',aliases:[]}}});
    const gabyChat=roles.client('dev-credential-gaby-chat'),gabyCw=roles.client('dev-credential-gaby-cw'),dga=roles.client('dev-credential-dga');
    const task=gabyChat.submitCommand({command_id:'COMMAND:STAGE7:TASK',command_type:'CREATE_TASK',actor_id:'ACTOR:GABY_CHAT',actor_role:'GABY_CHAT',issued_at:stamp,idempotency_key:'stage7-task',payload:{object:{id:taskId,type:'TASK',status:'OPEN',created_at:stamp,updated_at:stamp,basis_ref:['STAGING'],action:'STAGING_ROLE_GATE',state:'OPEN',responsible_role:'GABY_CHAT',related_ids:['ENTITY:STAGE7:MINIMUM']}}});
    const verification=gabyCw.submitCommand({command_id:'COMMAND:STAGE7:VERIFY',command_type:'RECORD_VERIFICATION',actor_id:'ACTOR:GABY_CW',actor_role:'GABY_CW',issued_at:stamp,idempotency_key:'stage7-verification',payload:{object:{id:'VERIFICATION:STAGE7:CLOSURE',type:'VERIFICATION',status:'CURRENT',created_at:stamp,updated_at:stamp,basis_ref:['STAGING'],subject_id:taskId,attribute:'CLOSURE_EVIDENCE',value:true,class:'FIJO',verified_at:stamp,verified_by:'ACTOR:GABY_CW',evidence_ref:'PROOF:STAGE7:CLOSURE'}}});
    const premature=gabyChat.submitCommand({command_id:'COMMAND:STAGE7:DONE:PREMATURE',command_type:'TRANSITION_TASK',actor_id:'ACTOR:GABY_CHAT',actor_role:'GABY_CHAT',issued_at:stamp,idempotency_key:'stage7-done-premature',payload:{task_id:taskId,state:'DONE',closure_ref:'PROOF:STAGE7:CLOSURE'}});
    store.registerDevProof('PROOF:STAGE7:CLOSURE',{staging_only:true});const done=gabyChat.submitCommand({command_id:'COMMAND:STAGE7:DONE',command_type:'TRANSITION_TASK',actor_id:'ACTOR:GABY_CHAT',actor_role:'GABY_CHAT',issued_at:stamp,idempotency_key:'stage7-done',payload:{task_id:taskId,state:'DONE',closure_ref:'PROOF:STAGE7:CLOSURE'}});const status=dga.request('READ_COMMAND_STATUS',{command_id:'COMMAND:STAGE7:DONE'});
    const result={kind:'MINIMUM_OPERATIONAL_CUTOVER_REHEARSAL',environment:'STAGING',scope,decision,role_path:{task,verification,premature,done,status},claudio_relay_required:false,codex_runtime_required:false,no_side_effect:true,production_cutover_disabled:PRODUCTION_CUTOVER_DISABLED};store.close();for(const domain of scope)barrier.rollbackR1(domain,['STAGING_ONLY']);return {...result,writers:Object.fromEntries(scope.map(domain=>[domain,barrier.writer(domain)])),journal:journal.export()};
  }finally{fs.rmSync(lab,{recursive:true,force:true});}
}
