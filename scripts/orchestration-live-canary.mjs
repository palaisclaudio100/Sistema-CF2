import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {PostgresStore} from '../src/postgres-store.mjs';
import {ACTORS,sha} from '../src/actor-transport.mjs';
const base=process.env.RENDER_EXTERNAL_URL??'https://cf2-prod-core.onrender.com';
if(base!=='https://cf2-prod-core.onrender.com')throw new Error('SERVICE_MISMATCH');
const url=process.env.CF2_DATABASE_URL??process.env.DATABASE_URL;
const store=new PostgresStore({connectionString:url,ssl:{rejectUnauthorized:!/^dpg-[a-z0-9]+-a$/.test(new URL(url).hostname)}});
const tokens=new Map(),threads=[],trace=[],stamp=new Date().toISOString().replaceAll(/[^0-9]/g,'');
let result={transport:'NOT_RUN',canon_guard:'NOT_RUN',role_executors:'NOT_RUN',RESULT:'INCOMPLETE'};
async function call(actor_id,operation,args={}){const r=await fetch(`${base}/internal/actor-runtime`,{method:'POST',headers:{Authorization:`Bearer ${tokens.get(actor_id)}`,'content-type':'application/json'},body:JSON.stringify({operation,args}),signal:AbortSignal.timeout(90000)});const value=await r.json();trace.push({actor_id,operation,http:r.status,result:value.result,error_code:value.error_code??null,thread_id:args.thread_id??value.data?.thread_id??null});if(!r.ok)throw new Error(value.error_code);return value.data;}
try{
  const before=await store.health();assert.equal(before.outbox_pending,0);
  for(const actor_id of ACTORS){const token=crypto.randomBytes(32).toString('hex');tokens.set(actor_id,token);await store.pool.query('INSERT INTO actor_transport_keys(key_hash,actor_id,capabilities,expires_at) VALUES($1,$2,$3::jsonb,now()+interval \'15 minutes\')',[sha(token),actor_id,JSON.stringify([actor_id==='ACTOR:DIEGO'?'canary':'worker'])]);}
  const thread_id=`THREAD:CANARY:ORCHESTRATION:${stamp}:TRANSPORT`;
  await call('ACTOR:DIEGO','start_workflow',{thread_id,stages:['ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX'],payload:{operation:'CANON_CLOSURE_REVIEW',external_effects:0,test_scope:'TRANSPORT_ONLY_SYNTHETIC_RESPONSES'}});threads.push(thread_id);
  for(const actor_id of ['ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX']){
    const claims=await Promise.all([call(actor_id,'claim'),call(actor_id,'claim')]);assert.equal(claims.filter(Boolean).length,1);const request=claims.find(Boolean);assert.equal(request.thread_id,thread_id);
    const args={thread_id,message_id:request.message_id,lease_token:request.lease_token,type:'RESPONSE',payload:{result:'TRANSPORT_TEST_ONLY',executor:'SYNTHETIC_NO_MODEL',external_effects:0}};
    await call(actor_id,'complete',args);await call(actor_id,'complete',args);
  }
  let t=await call('ACTOR:DIEGO','control_workflow',{thread_id,operation:'CLOSE'});assert.equal(t.state,'CLOSED');assert.deepEqual(t.messages.filter(m=>m.type==='RESPONSE').map(m=>m.sender),['ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX']);assert.ok(t.messages.filter(m=>m.type==='RESPONSE').every(m=>m.recipient==='ACTOR:DIEGO'));result.transport='PASS';
  const negative_id=`THREAD:CANARY:ORCHESTRATION:${stamp}:CANON_GUARD`;
  await call('ACTOR:DIEGO','start_workflow',{thread_id:negative_id,stages:['ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX'],payload:{operation:'CANON_CLOSURE_REVIEW',external_effects:0}});threads.push(negative_id);
  const request=await call('ACTOR:GABY_CHAT','claim');assert.equal(request.thread_id,negative_id);
  let canonError=null;try{await call('ACTOR:GABY_CHAT','canon_identify');}catch(e){canonError=e.message;}
  if(canonError){assert.equal(canonError,'CANON_NOT_VERIFIED');await call('ACTOR:GABY_CHAT','complete',{thread_id:negative_id,message_id:request.message_id,lease_token:request.lease_token,type:'OBJECTION',payload:{error_code:canonError,result:'BLOCKED',external_effects:0}});result.canon_guard='PASS_FAIL_CLOSED';result.END_TO_END_CANARY='BLOCKED_CANON_NOT_VERIFIED';}
  else{result.canon_guard='VERIFIED';result.END_TO_END_CANARY='ROLE_EXECUTORS_NOT_RUN';}
  t=await call('ACTOR:DIEGO','control_workflow',{thread_id:negative_id,operation:'CANCEL'});assert.equal(t.messages.filter(m=>['PENDING','RUNNING'].includes(m.state)).length,0);
  // Actual technical incident is delivered to Codex, without a Claudio handoff.
  const incident=await call('ACTOR:CODEX','claim');if(incident){assert.equal(incident.payload.operation,'CANON_INCIDENT');await call('ACTOR:CODEX','complete',{thread_id:incident.thread_id,message_id:incident.message_id,lease_token:incident.lease_token,type:'RESPONSE',payload:{result:'BLOCKED',technical_owner:'ACTOR:CODEX',error_code:'CANON_NOT_VERIFIED',external_effects:0}});result.technical_incident=incident.thread_id;}
  for(const tid of threads){const row=(await store.pool.query('SELECT body FROM actor_threads WHERE thread_id=$1',[tid])).rows[0];assert.ok(['CLOSED','CANCELLED'].includes(row.body.state));assert.equal(row.body.messages.filter(m=>['PENDING','RUNNING'].includes(m.state)).length,0);}
  const after=await store.health();assert.equal(after.outbox_pending,0);assert.equal(after.state_version,before.state_version);
  result={...result,threads,outbox_pending:after.outbox_pending,core_state_version_unchanged:true,trace,CLAUDIO_MANUAL_HANDOFFS_CANARY:0,CLAUDIO_FILE_TRANSPORTS_CANARY:0,CLAUDIO_ACTOR_SWITCHES_REQUIRED_CANARY:0,metric_scope:'TRANSPORT_TEST_AND_FAILED_CANON_GATE_ONLY'};
}catch(error){result={...result,RESULT:'FAIL',error_code:error.message,trace};process.exitCode=1;}
finally{
  for(const tid of threads){try{const t=await call('ACTOR:DIEGO','read_thread',{thread_id:tid});if(!['CLOSED','CANCELLED'].includes(t.state))await call('ACTOR:DIEGO','control_workflow',{thread_id:tid,operation:'CANCEL'});}catch{result.cleanup='FAILED';process.exitCode=1;}}
  for(const token of tokens.values())await store.pool.query('UPDATE actor_transport_keys SET revoked_at=now() WHERE key_hash=$1',[sha(token)]);
  result.credentials='REVOKED';console.log('ORCHESTRATION_CANARY='+JSON.stringify(result));await store.close();
}
