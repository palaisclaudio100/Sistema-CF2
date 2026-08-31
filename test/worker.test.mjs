import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreStore } from '../src/core-store.mjs';
import { DeterministicWorker } from '../src/deterministic-worker.mjs';

const T0='2026-08-29T10:00:00.000Z';
let sequence=0;
function setup(reopenPath) {
  const dir=reopenPath ? path.dirname(reopenPath) : fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage3-'));
  const dbPath=reopenPath ?? path.join(dir,'core.db'); const store=new CoreStore(dbPath);
  return {dir,dbPath,store,worker:new DeterministicWorker(store),done(){store.close(); if(!reopenPath) fs.rmSync(dir,{recursive:true,force:true});}};
}
function command(command_type,payload,{key,expected_state_version}={}) { const i=++sequence; return {command_id:`CMD:WORKER:${i}`,command_type,actor_id:'ACTOR:TEST',actor_role:'TEST',issued_at:T0,idempotency_key:key ?? `worker-${i}`,...(expected_state_version===undefined?{}:{expected_state_version}),payload}; }
function entity(id='ENTITY:WORKER') { return {id,type:'ENTITY',status:'CURRENT',created_at:T0,updated_at:T0,basis_ref:['test'],entity_kind:'TRACK',canonical_name:id,aliases:[]}; }
function verification(id,attribute,klass,extra={}) { return {id,type:'VERIFICATION',status:'CURRENT',created_at:T0,updated_at:T0,basis_ref:['test'],subject_id:'SURFACE:TEST',attribute,value:'YES',class:klass,verified_at:T0,verified_by:'TEST',evidence_ref:'proof:test',...extra}; }

test('T10: repeated command/event has one logical mutation and one outbox effect',async()=>{const x=setup();try {
  const c=command('UPSERT_ENTITY',{object:entity('ENTITY:T10')},{key:'T10:ONE'}); assert.deepEqual(x.store.submitCommand(c),x.store.submitCommand(c));
  await x.worker.runOnce({at:T0}); await x.worker.runOnce({at:'2026-08-29T10:00:01.000Z'});
  assert.equal(x.store.getAudit().length,1); assert.equal(x.store.getOutbox().length,1); assert.equal(x.store.listJobs().length,1); assert.equal(x.store.listJobs()[0].status,'DONE');
}finally{x.done();}});

test('T11: committed pending outbox survives restart and is consumed once',async()=>{const x=setup();const db=x.dbPath;try {
  x.store.submitCommand(command('UPSERT_ENTITY',{object:entity('ENTITY:T11')})); x.store.close();
  const restarted=setup(db); try { const result=await restarted.worker.runOnce({at:T0}); assert.equal(result.dispatched,1); assert.equal(restarted.store.listJobs().filter(j=>j.job_type==='OUTBOX_EVENT').length,1); assert.equal(restarted.store.listJobs()[0].status,'DONE'); } finally { restarted.store.close(); }
} finally { fs.rmSync(x.dir,{recursive:true,force:true}); }});

test('T12: obsolete expected version is rejected with no partial write',()=>{const x=setup();try {
  assert.equal(x.store.submitCommand(command('UPSERT_ENTITY',{object:entity('ENTITY:T12-A')})).accepted,true);
  const before=x.store.authoritativeDigest(); const result=x.store.submitCommand(command('UPSERT_ENTITY',{object:entity('ENTITY:T12-B')},{expected_state_version:0}));
  assert.equal(result.reason_code,'VERSION_CONFLICT'); assert.equal(x.store.authoritativeDigest(),before); assert.equal(x.store.resolveEntity('ENTITY:T12-B').status,'UNKNOWN');
}finally{x.done();}});

test('orphaned lease is recovered after expiry without duplicate logical effect',async()=>{const x=setup();try {
  x.store.enqueueDevJob({job_type:'NOOP',dedupe_key:'LEASE:ONE',at:T0}); const claimed=x.worker.claimWithoutExecuting(T0); assert.equal(claimed.status,'CLAIMED');
  const afterLease='2026-08-29T10:00:31.000Z'; const result=await x.worker.runOnce({at:afterLease}); const job=x.store.listJobs()[0];
  assert.equal(result.leases,1); assert.equal(job.status,'DONE'); assert.equal(job.attempt,2); assert.equal(x.store.getJobAttempts(job.job_id).filter(a=>a.status==='DONE').length,1);
}finally{x.done();}});

test('retry observes deterministic backoff and preserves failed first attempt',async()=>{const x=setup();try {
  x.store.enqueueDevJob({job_type:'DEV_FAIL_ONCE',payload:{fail_attempts:1},dedupe_key:'RETRY:ONE',at:T0});
  const first=await x.worker.runOnce({at:T0}); let job=x.store.listJobs()[0]; assert.equal(first.retried,1); assert.equal(job.status,'RETRY_WAIT'); assert.ok(job.next_attempt_at>'2026-08-29T10:00:01.000Z' && job.next_attempt_at<'2026-08-29T10:00:01.250Z');
  const early=await x.worker.runOnce({at:'2026-08-29T10:00:00.500Z'}); assert.equal(early.executed,0); assert.equal(x.store.listJobs()[0].attempt,1);
  await x.worker.runOnce({at:job.next_attempt_at}); job=x.store.listJobs()[0]; assert.equal(job.status,'DONE'); assert.equal(job.attempt,2); assert.ok(x.store.getJobAttempts(job.job_id).some(a=>a.status==='RETRY_WAIT')); assert.equal(x.store.listTimers()[0].status,'FIRED');
}finally{x.done();}});

test('TTL expires only the due volatile verification and does not invoke an agent',async()=>{const x=setup();try {
  x.store.submitCommand(command('RECORD_VERIFICATION',{object:verification('VERIFICATION:TTL','VOL','VOLÁTIL',{valid_until:'2026-08-29T09:59:00.000Z'})}));
  x.store.submitCommand(command('RECORD_VERIFICATION',{object:verification('VERIFICATION:FIXED','FIXED','FIJO')}));
  const result=await x.worker.runOnce({at:T0}); assert.equal(result.agent_invocations,0); assert.equal(x.store.getCurrent('SURFACE:TEST','VOL',T0).status,'UNKNOWN'); assert.equal(x.store.getCurrent('SURFACE:TEST','FIXED',T0).status,'CURRENT');
}finally{x.done();}});

test('conditional invalidation affects only the targeted attribute',async()=>{const x=setup();try {
  x.store.submitCommand(command('RECORD_VERIFICATION',{object:verification('VERIFICATION:COND-A','A','CONDICIONAL',{invalidation_rule:'RULE-A'})}));
  x.store.submitCommand(command('RECORD_VERIFICATION',{object:verification('VERIFICATION:COND-B','B','CONDICIONAL',{invalidation_rule:'RULE-B'})}));
  x.store.enqueueDevJob({job_type:'INVALIDATE_CONDITIONAL',payload:{subject_id:'SURFACE:TEST',attribute:'A',invalidation_rule:'RULE-A'},dedupe_key:'INVALIDATE:A',at:T0}); await x.worker.runOnce({at:T0});
  assert.equal(x.store.getCurrent('SURFACE:TEST','A',T0).status,'UNKNOWN'); assert.equal(x.store.getCurrent('SURFACE:TEST','B',T0).status,'CURRENT');
}finally{x.done();}});

test('empty queue makes no job and records no agent invocation',async()=>{const x=setup();try {
  const result=await x.worker.runOnce({at:T0}); assert.equal(result.executed,0); assert.equal(result.agent_invocations,0); assert.equal(x.store.listJobs().length,0); assert.equal(x.store.workerHealth(T0).metrics.idle_runs,1);
}finally{x.done();}});

test('startup reconciliation does not recreate completed jobs',async()=>{const x=setup();try {
  x.store.enqueueDevJob({job_type:'NOOP',dedupe_key:'DONE:ONE',at:T0}); await x.worker.runOnce({at:T0}); const before=x.store.listJobs(); await x.worker.runOnce({at:'2026-08-29T10:01:00.000Z'}); const after=x.store.listJobs();
  assert.equal(before.length,1); assert.equal(after.length,1); assert.equal(after[0].status,'DONE');
}finally{x.done();}});

test('observability exposes status, pending outbox, attempts and last work',async()=>{const x=setup();try {
  x.store.enqueueDevJob({job_type:'NOOP',dedupe_key:'OBS:ONE',at:T0}); await x.worker.runOnce({at:T0}); const health=x.store.workerHealth(T0); const job=x.store.listJobs()[0];
  assert.equal(health.worker_health,'DEV_MANUAL'); assert.equal(health.jobs.DONE,1); assert.equal(health.outbox_pending,0); assert.ok(health.last_work_at); assert.equal(health.time_since_last_work_ms,0); assert.deepEqual(health.last_errors,[]); assert.equal(x.store.getJobAttempts(job.job_id).length,3);
}finally{x.done();}});
