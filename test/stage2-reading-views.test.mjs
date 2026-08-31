import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreStore } from '../src/core-store.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const fixture=JSON.parse(fs.readFileSync(path.join(here,'fixtures','stage2-reading-views.json'),'utf8'));
const stamp='2026-08-31T08:00:00.000Z'; let sequence=0;
const command=(type,object)=>({command_id:`CMD:STAGE2:${++sequence}`,command_type:type,actor_id:'ACTOR:TEST',actor_role:'TEST',issued_at:stamp,idempotency_key:`stage2-${sequence}`,payload:{object}});
const base=(id,type,status='CURRENT')=>({id,type,status,created_at:stamp,updated_at:stamp,basis_ref:['FIXTURE:STAGE2']});

function setup(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage2-contract-')); const store=new CoreStore(path.join(dir,'core.db'));
  const put=(type,object)=>assert.equal(store.submitCommand(command(type,object)).accepted,true);
  for (const item of fixture.entities) put('UPSERT_ENTITY',{...base(item.id,'ENTITY'),entity_kind:'ARTIST',canonical_name:item.name,aliases:item.aliases});
  put('REGISTER_SURFACE',{...base(fixture.surface.id,'SURFACE'),platform:fixture.surface.platform,surface_kind:'CHANNEL',external_id:fixture.surface.external_id,owner_or_subject_id:fixture.surface.owner});
  put('SET_RELATION',{...base(fixture.active_relation.id,'RELATION'),from_id:fixture.active_relation.from,relation_type:'COLLABORATES_WITH',to_id:fixture.active_relation.to,effective_at:stamp});
  put('RECORD_DECISION',{...base('DECISION:ALFA:OLD','DECISION'),subject_id:'ENTITY:ALFA',decision_key:'DIRECTION',value:'OLD',authority:'DGA_DELEGATED',effective_at:stamp,source_ref:'FIXTURE'});
  put('RECORD_DECISION',{...base('DECISION:ALFA:CURRENT','DECISION'),subject_id:'ENTITY:ALFA',decision_key:'DIRECTION',value:'CURRENT_VALUE',authority:'CLAUDIO_DIRECT',effective_at:stamp,source_ref:'FIXTURE',supersedes:'DECISION:ALFA:OLD'});
  put('RECORD_VERIFICATION',{...base('VERIFICATION:ALFA:CURRENT','VERIFICATION'),subject_id:'ENTITY:ALFA',attribute:'OWNERSHIP',value:true,class:'FIJO',verified_at:stamp,verified_by:'TEST',evidence_ref:'PROOF:CURRENT'});
  put('RECORD_VERIFICATION',{...base('VERIFICATION:ALFA:EXPIRED','VERIFICATION'),subject_id:'ENTITY:ALFA',attribute:'VISIBILITY',value:true,class:'VOLÁTIL',valid_until:'2026-08-31T07:00:00.000Z',verified_at:stamp,verified_by:'TEST',evidence_ref:'PROOF:EXPIRED'});
  put('CREATE_TASK',{...base('TASK:OPEN','TASK','OPEN'),action:'REVIEW',state:'OPEN',responsible_role:'DGA',related_ids:['ENTITY:ALFA']});
  put('CREATE_TASK',{...base('TASK:BLOCKED','TASK','BLOCKED'),action:'WAIT',state:'BLOCKED',responsible_role:'DGA',related_ids:['ENTITY:ZETA']});
  return {store,close(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('Etapa 2 resolves ID, platform external ID, canonical name, then unique alias',()=>{const x=setup();try{
  assert.equal(x.store.resolveEntity('ENTITY:ALFA').matched_by,'ID');
  assert.equal(x.store.resolveSurface({platform:'YOUTUBE',external_id:'alfa-exact'}).matched_by,'PLATFORM_EXTERNAL_ID');
  assert.equal(x.store.resolveEntity('ÁLFA').matched_by,'CANONICAL_NAME');
  assert.equal(x.store.resolveEntity('alias único').matched_by,'ALIAS');
  assert.equal(x.store.resolveEntity('Nombre compartido').status,'AMBIGUOUS');
  assert.equal(x.store.resolveEntity('Sin antecedente').reason_code,'ENTITY_CANDIDATE_NEW');
}finally{x.close();}});

test('Etapa 2 CURRENT excludes superseded and expired, and UNKNOWN is not false',()=>{const x=setup();try{
  assert.deepEqual(x.store.listCurrent('DECISION').map(item=>item.id),['DECISION:ALFA:CURRENT']);
  assert.deepEqual(x.store.listCurrent('VERIFICATION',{at:stamp}).map(item=>item.id),['VERIFICATION:ALFA:CURRENT']);
  assert.equal(x.store.getCurrent('ENTITY:ALFA','MISSING',stamp).status,'UNKNOWN');
  assert.notEqual(x.store.getCurrent('ENTITY:ALFA','MISSING',stamp).status,'FALSE');
  assert.deepEqual(x.store.getHistory('ENTITY:ALFA','DIRECTION').decisions.map(item=>item.id),['DECISION:ALFA:OLD','DECISION:ALFA:CURRENT']);
}finally{x.close();}});

test('Etapa 2 on-demand bundle traverses only direct current links and pertinent verifications',()=>{const x=setup();try{
  const result=x.store.resolveCurrent({name:'Alfa'},{at:stamp});
  assert.equal(result.current.status,'CURRENT');
  assert.deepEqual(result.current.surfaces.map(item=>item.id),['SURFACE:YOUTUBE:ALFA']);
  assert.deepEqual(result.current.decisions.map(item=>item.id),['DECISION:ALFA:CURRENT']);
  assert.deepEqual(result.current.verifications.map(item=>item.id),['VERIFICATION:ALFA:CURRENT']);
  assert.deepEqual(result.current.tasks.map(item=>item.id),['TASK:OPEN']);
  assert.deepEqual(result.current.relations.map(item=>item.id),['RELATION:ALFA:ZETA']);
}finally{x.close();}});

test('Etapa 2 snapshot is small and excludes unrelated entities and narrative corpus',()=>{const x=setup();try{
  const snapshot=x.store.getSnapshot();
  assert.equal(snapshot.active_refs.includes('ENTITY:UNRELATED'),false);
  assert.equal('active_objects' in snapshot,false);
  assert.deepEqual(snapshot.blocked_tasks.map(item=>item.id),['TASK:BLOCKED']);
  assert.equal(JSON.stringify(snapshot).match(/Documento_Maestro|Estado_Sesion|Hist[oó]rico|corpus/iu),null);
}finally{x.close();}});

test('Etapa 2 cards and alphabetical index are compact current projections',()=>{const x=setup();try{
  const card=x.store.getEntityCard('ENTITY:ALFA');
  assert.deepEqual(card.surfaces.map(item=>item.id),['SURFACE:YOUTUBE:ALFA']);
  assert.deepEqual(card.verifications.map(item=>item.id),['VERIFICATION:ALFA:CURRENT']);
  assert.deepEqual(x.store.getAlphabeticalEntityIndex().entries.map(item=>item.canonical_name),['Alfa','Beta','Entidad sin actividad','Zeta']);
}finally{x.close();}});

test('Etapa 2 deleting and regenerating every view preserves Core and logical projections',()=>{const x=setup();try{
  const core=x.store.authoritativeDigest(); x.store.regenerateAllViews(); const before=x.store.derivedViewsDigest();
  assert.ok(x.store.deleteAllViews()>0); assert.equal(x.store.authoritativeDigest(),core); assert.deepEqual(x.store.listDerivedViews(),[]);
  x.store.regenerateAllViews(); assert.equal(x.store.authoritativeDigest(),core); assert.equal(x.store.derivedViewsDigest(),before);
}finally{x.close();}});

test('Etapa 2 stale valid view cannot defeat CURRENT and regeneration repairs it',()=>{const x=setup();try{
  const key='ENTITY:ENTITY:ALFA'; x.store.regenerateEntityView('ENTITY:ALFA'); x.store.corruptView(key,fixture.old_view);
  assert.equal(x.store.readDerivedView(key).status,'VALID');
  assert.equal(x.store.resolveCurrent({name:'Alfa'}).current.subject.canonical_name,'Alfa');
  assert.equal(x.store.readDerivedView(key).body.entity.canonical_name,'Nombre antiguo');
  x.store.regenerateEntityView('ENTITY:ALFA'); assert.equal(x.store.readDerivedView(key).body.entity.canonical_name,'Alfa');
}finally{x.close();}});

test('Etapa 2 read path has no narrative corpus dependency',()=>{
  const source=fs.readFileSync(path.join(here,'..','src','core-store.mjs'),'utf8');
  assert.equal(source.match(/Documento_Maestro|Estado_Sesion|CFOS_STATUS|Hist[oó]rico|sources[\\/]|Google Drive|G:\\|D:\\/iu),null);
  const imports=[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match=>match[1]);
  assert.ok(imports.length>0); assert.equal(imports.every(specifier=>specifier.startsWith('node:')),true);
});
