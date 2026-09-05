import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ExecutorObjects} from '../src/executor-objects.mjs';
import {validateOrdinaryDispatch,executionContext,validateOrdinaryCompletion} from '../src/executor-policy.mjs';
import {sha} from '../src/actor-transport.mjs';
const D='ACTOR:DIEGO',G='ACTOR:GABY_CHAT',W='ACTOR:GABY_CW',X='ACTOR:CODEX',A='ACTOR:CLAUDE_CODE';
const payload=()=>({operation:'ORDINARY_WORK',brief:'Prepare an operational guide',source_reference:'Claudio order',steps:{[G]:{action:'ANALYZE_DRAFT_VALIDATE',object_id:'doc'},[W]:{action:'WRITE_VALIDATED',object_id:'doc',expected_sha256:null},[X]:{action:'TECHNICAL_RUN',input_objects:['doc']},[A]:{action:'AUXILIARY_REVIEW'}}});
const ctx=()=>({actor_id:W,message_id:'msg',step:payload().steps[W],validated_document:{object_id:'doc',validated:true,validated_by:G,validation_message_id:'validation',content:'# Guide\nActual useful content',sha256:sha('# Guide\nActual useful content')}});
async function setup(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'cf2-ordinary-'));try{const store=new ExecutorObjects({objects:[{object_id:'doc',root,relative_path:'guide.md',owner:W,kind:'document',readers:[G,W,X,A]}],stateRoot:path.join(root,'receipts'),execute:async()=>({stdout:'ok',exit_code:0})});await fn(store,root);}finally{assert.ok(!path.relative(os.tmpdir(),root).startsWith('..'));await fs.rm(root,{recursive:true,force:true});}}
test('ordinary activation is Diego-only, with fixed cross-role action boundaries',()=>{for(const actor_id of [G,W,X,A])assert.throws(()=>validateOrdinaryDispatch({actor_id},payload(),[X]),/EXECUTOR_SCOPE_DENIED/);const p=payload();p.steps[G].action='WRITE_VALIDATED';assert.throws(()=>validateOrdinaryDispatch({actor_id:D},p,[G]),/EXECUTOR_SCOPE_DENIED/);p.steps[G]={action:'ANALYZE_DRAFT_VALIDATE',path:'C:/arbitrary'};assert.throws(()=>validateOrdinaryDispatch({actor_id:D},p,[G]),/INVALID_SCHEMA/);});
test('server context binds lease, actor, object and authentic Chat validation',()=>{const p=payload();p.previous_response='validation';const thread={state:'OPEN',thread_id:'t',messages:[{message_id:'validation',sender:G,type:'RESPONSE',payload:{result:'PASS',document:ctx().validated_document}},{message_id:'msg',recipient:W,sender:D,state:'RUNNING',lease_token:'lease',lease_until:100,payload:p}]};assert.equal(executionContext({actor_id:W},thread,{thread_id:'t',message_id:'msg',lease_token:'lease'},50).validated_document.validated_by,G);assert.throws(()=>executionContext({actor_id:X},thread,{thread_id:'t',message_id:'msg',lease_token:'lease'},50),/EXECUTOR_SCOPE_DENIED/);assert.throws(()=>executionContext({actor_id:W},thread,{thread_id:'t',message_id:'msg',lease_token:'lease'},101),/EXECUTOR_SCOPE_DENIED/);thread.messages[0].sender=X;assert.throws(()=>executionContext({actor_id:W},thread,{thread_id:'t',message_id:'msg',lease_token:'lease'},50),/EXECUTOR_SCOPE_DENIED/);});
test('material write is faithful, read back and idempotent by request identity',()=>setup(async(store,root)=>{const c=ctx();const r=await store.writeValidated(c,async()=>{});assert.equal(r.after_sha256,c.validated_document.sha256);assert.equal(r.readback_sha256,sha(await fs.readFile(path.join(root,'guide.md'))));assert.equal((await store.writeValidated(c,async()=>{})).replayed,true);await assert.rejects(store.writeValidated({...c,validated_document:{...c.validated_document,content:'different',sha256:sha('different')}},async()=>{}),/MATERIAL_REPLAY_CONFLICT/);}));
test('Chat, Codex, unvalidated material and unknown paths cannot write documentary objects',()=>setup(async(store)=>{await assert.rejects(store.object(G,'doc',true),/OBJECT_SCOPE_DENIED/);await assert.rejects(store.object(X,'doc',true),/OBJECT_SCOPE_DENIED/);await assert.rejects(store.object(W,'../doc',true),/OBJECT_SCOPE_DENIED/);await assert.rejects(store.writeValidated({...ctx(),actor_id:G},async()=>{}),/CROSS_ROLE_WRITE_DENIED/);await assert.rejects(store.writeValidated({...ctx(),validated_document:{...ctx().validated_document,validated:false}},async()=>{}),/CROSS_ROLE_WRITE_DENIED/);}));
test('version conflict protects a concurrently edited object',()=>setup(async(store,root)=>{await fs.writeFile(path.join(root,'guide.md'),'other editor');await assert.rejects(store.writeValidated(ctx(),async()=>{}),/OBJECT_VERSION_CONFLICT/);assert.equal(await fs.readFile(path.join(root,'guide.md'),'utf8'),'other editor');}));
test('cancelled authority before commit leaves no material write',()=>setup(async(store,root)=>{await assert.rejects(store.writeValidated(ctx(),async()=>{throw new Error('CANCELLED');}),/CANCELLED/);await assert.rejects(fs.stat(path.join(root,'guide.md')),/ENOENT/);}));
test('loss of authority after write rolls back only this write',()=>setup(async(store,root)=>{await fs.writeFile(path.join(root,'guide.md'),'before');const c=ctx();c.step.expected_sha256=sha('before');let n=0;await assert.rejects(store.writeValidated(c,async()=>{if(++n===2)throw new Error('CANCELLED');}),/CANCELLED/);assert.equal(await fs.readFile(path.join(root,'guide.md'),'utf8'),'before');}));
test('registered commands reject cross-role callers and modified pinned programs',()=>setup(async(store,root)=>{const script=path.join(root,'job.mjs');await fs.writeFile(script,'original');store.commands.set('test',{actors:[X],pins:[{path:script,sha256:sha('original')}],executable:'node',args:[],cwd:root});await assert.rejects(store.runRegistered(W,'test',async()=>{}),/COMMAND_SCOPE_DENIED/);await fs.writeFile(script,'modified');await assert.rejects(store.runRegistered(X,'test',async()=>{}),/COMMAND_VERSION_CONFLICT/);}));
test('server rejects fabricated material evidence and final verification by Claude',()=>{const p=payload();p.previous_response='validation';const t={messages:[{message_id:'validation',sender:G,payload:{document:ctx().validated_document}},{message_id:'msg',payload:p}]};assert.throws(()=>validateOrdinaryCompletion({actor_id:W},t,{message_id:'msg',type:'EVIDENCE',payload:{result:'PASS',canon:[{},{}],material:{object_id:'doc',actor_id:W,after_sha256:'fake'}}}),/EXECUTOR_SCOPE_DENIED/);assert.throws(()=>validateOrdinaryCompletion({actor_id:A},t,{message_id:'msg',type:'EVIDENCE',payload:{result:'PASS',canon:[{},{}]}}),/EXECUTOR_SCOPE_DENIED/);});
test('canonical edits require a unique validated patch and preserve unrelated bytes',()=>setup(async(store,root)=>{
 const original='# Original\nKeep this entire paragraph\nReplace this exact phrase\n# Last\nKeep last';
 await fs.writeFile(path.join(root,'guide.md'),original);
 const o=store.objects.get('doc');o.kind='canonical';o.canonical_write_enabled=true;
 const c=ctx();c.step.expected_sha256=sha(original);
 await assert.rejects(store.writeValidated(c,async()=>{}),/CANON_PATCH_REQUIRED/);
 c.validated_document={...c.validated_document,mode:'PATCH',edits:[{before:'Replace this exact phrase',after:'Approved replacement'}]};
 c.validated_document.sha256=sha(JSON.stringify(c.validated_document.edits));
 const r=await store.writeValidated(c,async()=>{});
 assert.equal(await fs.readFile(path.join(root,'guide.md'),'utf8'),original.replace('Replace this exact phrase','Approved replacement'));
 assert.equal(r.readback_sha256,sha(original.replace('Replace this exact phrase','Approved replacement')));
}));
test('a verification lock survives executor reconstruction',()=>setup(async(store,root)=>{
 await fs.mkdir(store.stateRoot,{recursive:true});
 await fs.writeFile(path.join(store.stateRoot,sha('doc')+'.verification-failures'),'2');
 await assert.rejects(store.writeValidated(ctx(),async()=>{}),/MATERIAL_VERIFICATION_LOCKED/);
 await assert.rejects(fs.stat(path.join(root,'guide.md')),/ENOENT/);
}));
test('independent broker instances serialize writes to the same registered object',()=>setup(async(store)=>{
 const other=new ExecutorObjects({objects:[...store.objects.values()],stateRoot:store.stateRoot,execute:store.execute});
 let entered,release;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);let count=0;
 const running=store.writeValidated(ctx(),async()=>{if(++count===1){entered();await wait;}});
 await ready;await assert.rejects(other.writeValidated({...ctx(),message_id:'second'},async()=>{}),/OBJECT_BUSY/);
 release();await running;
}));
test('a prepared receipt recovers a committed write after interruption without rewriting',()=>setup(async(store,root)=>{
 const c=ctx();await fs.mkdir(store.stateRoot,{recursive:true});await fs.writeFile(path.join(root,'guide.md'),c.validated_document.content);
 await fs.writeFile(path.join(store.stateRoot,sha(c.message_id)+'.json'),JSON.stringify({status:'PREPARED',actor_id:W,object_id:'doc',message_id:c.message_id,before_sha256:null,after_sha256:c.validated_document.sha256,validation_sha256:c.validated_document.sha256,validation_message_id:'validation'}));
 const recovered=await store.writeValidated(c,async()=>{});assert.equal(recovered.status,'COMMITTED');assert.equal(recovered.replayed,true);assert.equal(recovered.readback_sha256,c.validated_document.sha256);
}));
