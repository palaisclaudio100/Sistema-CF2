import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CoreStore } from '../src/core-store.mjs';
import { DeterministicWorker } from '../src/deterministic-worker.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)); const T0='2026-08-31T11:00:00.000Z'; let sequence=0;
const entity=id=>({id,type:'ENTITY',status:'CURRENT',created_at:T0,updated_at:T0,basis_ref:['STAGE3'],entity_kind:'TRACK',canonical_name:id,aliases:[]});
const command=(id,expected_state_version)=>({command_id:`CMD:STAGE3:${++sequence}`,command_type:'UPSERT_ENTITY',actor_id:'ACTOR:TEST',actor_role:'TEST',issued_at:T0,idempotency_key:id,...(expected_state_version===undefined?{}:{expected_state_version}),payload:{object:entity(id)}});
function workspace(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage3-gate-'));return {dir,db:path.join(dir,'core.db'),close(store){store?.close();fs.rmSync(dir,{recursive:true,force:true});}};}
function crash(db,mode){return spawnSync(process.execPath,[path.join(here,'..','scripts','stage3-crash-harness.mjs'),db,mode],{encoding:'utf8'});}

test('T10 duplicates before, during restart and after DONE have one logical effect',async()=>{const w=workspace();let store;try{
  store=new CoreStore(w.db); const c=command('ENTITY:T10:ALL'); const first=store.submitCommand(c); for(let i=0;i<5;i++) assert.deepEqual(store.submitCommand(c),first);
  const event=store.getOutbox()[0]; store.enqueueDevJob({job_type:'OUTBOX_EVENT',event_id:'EVENT:ALTERNATE',causation_id:event.event_id,payload:JSON.parse(event.payload),dedupe_key:`EVENT:${event.event_id}`,at:T0}); store.close();
  store=new CoreStore(w.db); const worker=new DeterministicWorker(store); await worker.runOnce({at:T0}); await worker.runOnce({at:'2026-08-31T11:01:00.000Z'});
  assert.equal(store.getAudit().length,1); assert.equal(store.getOutbox().length,1); assert.equal(store.listJobs().length,1); assert.equal(store.listJobs()[0].status,'DONE');
}finally{w.close(store);}});

test('T11 real process crash after commit preserves outbox and restart consumes once',async()=>{const w=workspace();let store;try{
  const child=crash(w.db,'COMMIT_BEFORE_CONSUME'); assert.equal(child.status,86);
  store=new CoreStore(w.db); assert.equal(store.getOutbox()[0].status,'PENDING'); const result=await new DeterministicWorker(store).runOnce({at:T0});
  assert.equal(result.dispatched,1); assert.equal(store.getOutbox()[0].status,'DISPATCHED'); assert.equal(store.listJobs().filter(j=>j.status==='DONE').length,1); assert.equal(store.getAudit().length,1);
}finally{w.close(store);}});

test('T11 real process crash with RUNNING lease is recovered after expiry',async()=>{const w=workspace();let store;try{
  const child=crash(w.db,'RUNNING_LEASE'); assert.equal(child.status,86); store=new CoreStore(w.db); assert.equal(store.listJobs()[0].status,'RUNNING');
  const result=await new DeterministicWorker(store).runOnce({at:'2026-08-31T11:00:02.000Z'}); const job=store.listJobs()[0];
  assert.equal(result.leases,1); assert.equal(job.status,'DONE'); assert.equal(job.attempt,2); assert.equal(store.getJobAttempts(job.job_id).filter(a=>a.status==='DONE').length,1);
}finally{w.close(store);}});

test('T12 stale version conflicts locally while an independent current operation can proceed',()=>{const w=workspace();let store;try{
  store=new CoreStore(w.db); assert.equal(store.submitCommand(command('ENTITY:T12:WIN',0)).accepted,true); const events=store.getOutbox().length;
  assert.equal(store.submitCommand(command('ENTITY:T12:STALE',0)).reason_code,'VERSION_CONFLICT'); assert.equal(store.getOutbox().length,events);
  assert.equal(store.submitCommand(command('ENTITY:T12:INDEPENDENT',store.stateVersion())).accepted,true); assert.equal(store.getObject('ENTITY:T12:STALE'),null);
}finally{w.close(store);}});

test('timer overdue during downtime fires once and expires only its verification',async()=>{const w=workspace();let store;try{
  store=new CoreStore(w.db); store.submitCommand({command_id:'CMD:TIMER',command_type:'RECORD_VERIFICATION',actor_id:'ACTOR:TEST',actor_role:'TEST',issued_at:T0,idempotency_key:'TIMER:CREATE',payload:{object:{id:'VERIFICATION:TIMER',type:'VERIFICATION',status:'CURRENT',created_at:T0,updated_at:T0,basis_ref:['STAGE3'],subject_id:'SURFACE:TIMER',attribute:'VISIBILITY',value:true,class:'VOLÁTIL',valid_until:'2026-08-31T11:01:00.000Z',verified_at:T0,verified_by:'TEST',evidence_ref:'PROOF:TIMER'}}}); store.close();
  store=new CoreStore(w.db); const worker=new DeterministicWorker(store); await worker.runOnce({at:'2026-08-31T11:02:00.000Z'}); await worker.runOnce({at:'2026-08-31T11:03:00.000Z'});
  assert.equal(store.getCurrent('SURFACE:TIMER','VISIBILITY','2026-08-31T11:03:00.000Z').status,'UNKNOWN'); assert.equal(store.listTimers().filter(t=>t.timer_type==='TTL_EXPIRE'&&t.status==='FIRED').length,1); assert.equal(store.listJobs().filter(j=>j.job_type==='TTL_EXPIRE').length,1);
}finally{w.close(store);}});

test('durable conditional invalidation timer survives restart and fires once',async()=>{const w=workspace();let store;try{
  store=new CoreStore(w.db); store.submitCommand({command_id:'CMD:COND',command_type:'RECORD_VERIFICATION',actor_id:'ACTOR:TEST',actor_role:'TEST',issued_at:T0,idempotency_key:'COND:CREATE',payload:{object:{id:'VERIFICATION:COND:TIMER',type:'VERIFICATION',status:'CURRENT',created_at:T0,updated_at:T0,basis_ref:['STAGE3'],subject_id:'SURFACE:COND',attribute:'ACCESS',value:true,class:'CONDICIONAL',invalidation_rule:'ACCESS_REVOKED',verified_at:T0,verified_by:'TEST',evidence_ref:'PROOF:COND'}}});
  store.scheduleTimer({timer_type:'CONDITIONAL_INVALIDATION',due_at:'2026-08-31T11:01:00.000Z',dedupe_key:'INVALIDATE:COND:TIMER',payload:{subject_id:'SURFACE:COND',attribute:'ACCESS',invalidation_rule:'ACCESS_REVOKED'},at:T0}); store.close();
  store=new CoreStore(w.db); const worker=new DeterministicWorker(store); await worker.runOnce({at:'2026-08-31T11:02:00.000Z'}); await worker.runOnce({at:'2026-08-31T11:03:00.000Z'});
  assert.equal(store.getCurrent('SURFACE:COND','ACCESS').status,'UNKNOWN'); assert.equal(store.listTimers().find(t=>t.dedupe_key==='INVALIDATE:COND:TIMER').status,'FIRED'); assert.equal(store.listJobs().filter(j=>j.job_type==='INVALIDATE_CONDITIONAL').length,1);
}finally{w.close(store);}});

test('transient failures use durable bounded backoff; permanent failures are actionable once',async()=>{const w=workspace();let store;try{
  store=new CoreStore(w.db); const worker=new DeterministicWorker(store,{max_attempts:2,jitter_bound_ms:50}); store.enqueueDevJob({job_type:'DEV_FAIL_ONCE',payload:{fail_attempts:1},dedupe_key:'TRANSIENT',at:T0}); await worker.runOnce({at:T0});
  let transient=store.listJobs()[0]; assert.equal(transient.status,'RETRY_WAIT'); assert.equal(store.listTimers().filter(t=>t.timer_type==='JOB_RETRY').length,1); await worker.runOnce({at:transient.next_attempt_at}); assert.equal(store.listJobs()[0].status,'DONE');
  store.enqueueDevJob({job_type:'DEV_PERMANENT_FAILURE',dedupe_key:'PERMANENT',at:T0}); await worker.runOnce({at:T0}); const permanent=store.listJobs().find(j=>j.dedupe_key==='PERMANENT'); assert.equal(permanent.status,'FAILED_ACTIONABLE'); assert.equal(store.listTimers().filter(t=>t.payload.job_id===permanent.job_id).length,0); await worker.runOnce({at:'2026-08-31T12:00:00.000Z'}); assert.equal(store.listJobs().find(j=>j.job_id===permanent.job_id).attempt,1);
}finally{w.close(store);}});

test('observability and source graph prove durable runtime has no agent-session dependency',async()=>{const w=workspace();let store;try{
  store=new CoreStore(w.db); const worker=new DeterministicWorker(store); await worker.runOnce({at:T0}); const health=store.workerHealth(T0);
  assert.equal(health.state_version,0); assert.equal(health.outbox_pending,0); assert.equal(health.timers_due,0); assert.ok('FAILED_ACTIONABLE' in health.jobs===false);
  const source=fs.readFileSync(path.join(here,'..','src','deterministic-worker.mjs'),'utf8'); assert.equal(source.match(/Claude|Codex|Gaby|conversation|session/iu),null); assert.deepEqual([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m=>m[1]),['node:crypto']);
}finally{w.close(store);}});
