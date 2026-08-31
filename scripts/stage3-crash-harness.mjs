import { CoreStore } from '../src/core-store.mjs';

const [dbPath,mode]=process.argv.slice(2); const at='2026-08-31T11:00:00.000Z';
if(!dbPath || !mode) process.exit(64);
const store=new CoreStore(dbPath);
if(mode==='COMMIT_BEFORE_CONSUME') store.submitCommand({command_id:'CMD:CRASH:COMMIT',command_type:'UPSERT_ENTITY',actor_id:'ACTOR:HARNESS',actor_role:'TEST',issued_at:at,idempotency_key:'CRASH:COMMIT',payload:{object:{id:'ENTITY:CRASH',type:'ENTITY',status:'CURRENT',created_at:at,updated_at:at,basis_ref:['HARNESS'],entity_kind:'TRACK',canonical_name:'Crash durable',aliases:[]}}});
if(mode==='RUNNING_LEASE') { const job=store.enqueueDevJob({job_type:'NOOP',dedupe_key:'CRASH:RUNNING',at}); store.claimNextJob('WORKER:CRASH',{at,lease_ms:1000,run_id:'RUN:CRASH'}); store.startJob(job.job_id,'WORKER:CRASH',at); }
// Deliberately no close(): process termination models loss of runtime memory.
process.exit(86);
