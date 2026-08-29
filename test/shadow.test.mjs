import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreStore } from '../src/core-store.mjs';
import { ShadowRuntime, SelectiveMigrator, classifyFinding, compareLogical, createMigrationBaseline } from '../src/shadow.mjs';

const stamp='2026-08-29T19:00:00.000Z';let n=0;
function command(object){return {command_id:`CMD:SHADOW:${++n}`,command_type:'UPSERT_ENTITY',actor_id:'ACTOR:CLAUDIO',actor_role:'CLAUDIO',issued_at:stamp,idempotency_key:`shadow-${n}`,payload:{object}};}
function entity(id){return {id,type:'ENTITY',status:'CURRENT',created_at:stamp,updated_at:stamp,basis_ref:['shadow'],entity_kind:'TRACK',canonical_name:id,aliases:[]};}
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-shadow-'));const store=new CoreStore(path.join(dir,'core.db'));return {dir,store,done(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};}

test('baseline seals explicitly supplied source bytes without writing CF1',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-baseline-'));try{const file=path.join(dir,'source.md');fs.writeFileSync(file,'read only baseline');const baseline=createMigrationBaseline({at:stamp,artifacts:[{ref:'CF1:MAESTRO',path:file}],schedulers:[{name:'legacy',state:'DISABLED'}]});assert.equal(baseline.artifacts[0].bytes,18);assert.equal(baseline.schedulers[0].state,'DISABLED');assert.equal(fs.readFileSync(file,'utf8'),'read only baseline');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('selective importer promotes only authoritative current; ambiguity stays non-authoritative',()=>{const x=setup();try{const migrator=new SelectiveMigrator(x.store);const report=migrator.import([{classification:'AUTHORITATIVE_CURRENT',command:command(entity('ENTITY:CURRENT')),evidence_ref:'source:current'},{classification:'CANDIDATE',subject:'ENTITY:ATARAXIA',evidence_ref:'source:ambiguous'},{classification:'UNKNOWN',subject:'ENTITY:NEW'}]);assert.equal(report.imported.length,1);assert.equal(report.candidates.length,1);assert.equal(report.unknown.length,1);assert.equal(x.store.getObject('ENTITY:CURRENT').id,'ENTITY:CURRENT');assert.equal(x.store.getObject('ENTITY:ATARAXIA'),null);}finally{x.done();}});
test('logical comparator distinguishes mismatch from absence without turning it false',()=>{const report=compareLogical({project:'ACTIVE',missing:undefined},{project:'FROZEN'});assert.equal(report.critical,1);assert.equal(report.material,1);assert.equal(report.discrepancies.find(x=>x.object==='missing').CF1.status,'UNKNOWN');});
test('shadow records WOULD_DO while producing zero external side effects',()=>{let tick=0;const shadow=new ShadowRuntime({at:()=>`2026-08-29T19:00:0${tick++}.000Z`});assert.equal(shadow.start().mode,'SHADOW_READ');assert.equal(shadow.observe({baseline:{artifacts:[{sha256:'A'}]},current:{artifacts:[{sha256:'B'}]}}).changed,true);const action=shadow.wouldDo('REPLICATE',{artifact_id:'A'});assert.equal(action.action,'WOULD_REPLICATE');assert.equal(action.no_side_effect,true);assert.equal(shadow.report().would_do.length,1);});
test('invalid classification fails closed',()=>assert.throws(()=>classifyFinding({classification:'FALSE'})));
