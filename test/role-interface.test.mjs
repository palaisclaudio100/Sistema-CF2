import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreStore } from '../src/core-store.mjs';
import { DeterministicWorker } from '../src/deterministic-worker.mjs';
import { RoleInterface } from '../src/role-interface.mjs';

const stamp='2026-08-29T18:00:00.000Z'; let sequence=0;
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage5-'));const store=new CoreStore(path.join(dir,'core.db'));const api=new RoleInterface(store);return {dir,store,api,client:actor=>api.client(actor),done(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};}
function cmd(actor,role,command_type,payload){const i=++sequence;return {command_id:`CMD:ROLE:${i}`,command_type,actor_id:actor,actor_role:role,issued_at:stamp,idempotency_key:`role-${i}`,payload};}
function task(id,responsible_role,related_ids=[]){return {id,type:'TASK',status:'OPEN',created_at:stamp,updated_at:stamp,basis_ref:['test'],action:'REVIEW',state:'OPEN',responsible_role,related_ids};}
function decision(id,authority){return {id,type:'DECISION',status:'CURRENT',created_at:stamp,updated_at:stamp,basis_ref:['test'],subject_id:'ENTITY:ROLE',decision_key:`KEY:${id}`,value:'VALUE',authority,effective_at:stamp,source_ref:'test'};}
function entity(){return {id:'ENTITY:ROLE',type:'ENTITY',status:'CURRENT',created_at:stamp,updated_at:stamp,basis_ref:['test'],entity_kind:'TRACK',canonical_name:'Role entity',aliases:[]};}

test('authorized DGA read obtains snapshot and CURRENT through the interface',()=>{const x=setup();try{x.store.submitCommand(cmd('ACTOR:CLAUDIO','CLAUDIO','UPSERT_ENTITY',{object:entity()}));const dga=x.client('ACTOR:DIEGO');const snapshot=dga.request('READ_SNAPSHOT');const current=dga.request('READ_CURRENT',{subject_id:'ENTITY:ROLE',property_key:'MISSING'});assert.equal(snapshot.ok,true);assert.equal(snapshot.data.kind,'STARTUP_SNAPSHOT');assert.equal(current.data.status,'UNKNOWN');assert.ok(x.store.getAccessAudit().some(a=>a.actor_id==='ACTOR:DIEGO'&&a.operation==='READ_SNAPSHOT'));}finally{x.done();}});

test('DGA issues delegated task and decision with actor, authority and audit',()=>{const x=setup();try{const dga=x.client('ACTOR:DIEGO');const created=dga.request('COMMAND_SUBMIT',{command:cmd('ACTOR:DIEGO','DGA','CREATE_TASK',{object:task('TASK:DGA','DGA')})});const decided=dga.request('COMMAND_SUBMIT',{command:cmd('ACTOR:DIEGO','DGA','RECORD_DECISION',{object:decision('DECISION:DGA','DGA_DELEGATED')})});assert.equal(created.ok,true);assert.equal(decided.ok,true);assert.equal(x.store.getObject('DECISION:DGA').authority,'DGA_DELEGATED');assert.equal(x.store.getAudit().at(-1).actor_id,'ACTOR:DIEGO');}finally{x.done();}});

test('Gaby Chat command reaches Core directly without Claudio relay',()=>{const x=setup();try{const chat=x.client('ACTOR:GABY_CHAT');const response=chat.request('COMMAND_SUBMIT',{command:cmd('ACTOR:GABY_CHAT','GABY_CHAT','CREATE_TASK',{object:task('TASK:CHAT','GABY_CHAT')})});assert.equal(response.ok,true);assert.equal(x.store.getObject('TASK:CHAT').responsible_role,'GABY_CHAT');assert.equal(x.store.getAudit().at(-1).actor_id,'ACTOR:GABY_CHAT');assert.equal(x.store.getAccessAudit().at(-1).role,'GABY_CHAT');}finally{x.done();}});

test('Gaby Chat cannot alter normative decisions and failure does not mutate Core',()=>{const x=setup();try{const chat=x.client('ACTOR:GABY_CHAT');const before=x.store.authoritativeDigest();const response=chat.request('COMMAND_SUBMIT',{command:cmd('ACTOR:GABY_CHAT','GABY_CHAT','RECORD_DECISION',{object:decision('DECISION:FORBIDDEN','CLAUDIO_DIRECT')})});assert.equal(response.ok,false);assert.equal(response.reason_code,'FORBIDDEN_ROLE');assert.equal(x.store.authoritativeDigest(),before);assert.equal(x.store.getAccessAudit().at(-1).authorized,false);}finally{x.done();}});

test('Gaby CW and Productor Musical are limited to their own operational tasks',()=>{const x=setup();try{const cw=x.client('ACTOR:GABY_CW');const producer=x.client('ACTOR:PRODUCTOR_MUSICAL');assert.equal(cw.request('COMMAND_SUBMIT',{command:cmd('ACTOR:GABY_CW','GABY_CW','CREATE_TASK',{object:task('TASK:CW','GABY_CW')})}).ok,true);assert.equal(producer.request('COMMAND_SUBMIT',{command:cmd('ACTOR:PRODUCTOR_MUSICAL','PRODUCTOR_MUSICAL','CREATE_TASK',{object:task('TASK:PRODUCER','PRODUCTOR_MUSICAL')})}).ok,true);const denied=cw.request('COMMAND_SUBMIT',{command:cmd('ACTOR:GABY_CW','GABY_CW','CREATE_TASK',{object:task('TASK:BAD','GABY_CHAT')})});assert.equal(denied.reason_code,'FORBIDDEN_ROLE');}finally{x.done();}});

test('role client exposes no physical SQLite path or Core store',()=>{const x=setup();try{const client=x.client('ACTOR:GABY_CHAT');assert.equal(Object.prototype.hasOwnProperty.call(client,'store'),false);assert.equal(Object.prototype.hasOwnProperty.call(client,'dbPath'),false);assert.equal(client.request('READ_TASK_VIEW').ok,true);}finally{x.done();}});

test('Codex offline does not affect DEV interface, worker, outbox or views',async()=>{const x=setup();try{x.store.submitCommand(cmd('ACTOR:CLAUDIO','CLAUDIO','UPSERT_ENTITY',{object:entity()}));const worker=new DeterministicWorker(x.store);const result=await worker.runOnce({at:stamp});assert.equal(result.executed>0,true);assert.equal(x.client('ACTOR:DIEGO').request('READ_SNAPSHOT').ok,true);assert.equal(x.store.readDerivedView('SNAPSHOT:DEFAULT').status,'VALID');}finally{x.done();}});

test('cloud role can read and submit allowed command while local-only work blocks locally',()=>{const x=setup();try{const cloud=x.client('ACTOR:GABY_CHAT');assert.equal(cloud.request('READ_TASK_VIEW').ok,true);assert.equal(cloud.request('COMMAND_SUBMIT',{command:cmd('ACTOR:GABY_CHAT','GABY_CHAT','CREATE_TASK',{object:task('TASK:CLOUD','GABY_CHAT')})}).ok,true);const local=cloud.request('REQUEST_LOCAL_A');assert.equal(local.reason_code,'BLOCKED_LOCAL');assert.equal(x.store.getObject('TASK:CLOUD').id,'TASK:CLOUD');}finally{x.done();}});

test('local worker resumes pending job without duplicating DONE work',async()=>{const x=setup();try{x.store.enqueueDevJob({job_type:'NOOP',dedupe_key:'ROLE:RESUME',at:stamp});const local=x.client('ACTOR:LOCAL_WORKER');assert.equal(local.request('READ_WORKER_HEALTH').ok,true);const worker=new DeterministicWorker(x.store);await worker.runOnce({at:stamp});await worker.runOnce({at:'2026-08-29T18:01:00.000Z'});assert.equal(x.store.listJobs().length,1);assert.equal(x.store.listJobs()[0].status,'DONE');}finally{x.done();}});
