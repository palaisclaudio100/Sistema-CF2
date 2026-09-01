import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { CoreStore } from '../src/core-store.mjs';

const root=path.resolve(import.meta.dirname,'..');
const digest='a'.repeat(64);
const stamp='2026-09-01T00:00:00.000Z';
const write=(dir,name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value));return file;};
const run=(ledger,store)=>spawnSync(process.execPath,['scripts/stage6-resolve-unknowns.mjs',`--ledger=${ledger}`,`--store=${store}`],{cwd:root,encoding:'utf8'});

test('review ledger imports only reviewed authoritative commands and never self-closes F7',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage6-ledger-'));try{const store=path.join(dir,'core.db');const ledger=write(dir,'ledger.json',{kind:'STAGE6_REVIEW_LEDGER',baseline_digest:digest,coverage:{entities:'AUTHORITATIVE_CURRENT'},records:[{classification:'AUTHORITATIVE_CURRENT',evidence_ref:'CF1:MASTER#L1',command:{command_id:'CMD:LEDGER:1',command_type:'UPSERT_ENTITY',actor_id:'ACTOR:MIGRATOR',actor_role:'MIGRATOR',issued_at:stamp,idempotency_key:'ledger-1',payload:{object:{id:'ENTITY:LEDGER',type:'ENTITY',status:'CURRENT',created_at:stamp,updated_at:stamp,basis_ref:['CF1:MASTER#L1'],entity_kind:'PROJECT',canonical_name:'Ledger',aliases:[]}}}},{classification:'UNKNOWN',evidence_ref:'CF1:MASTER#L2',subject_id:'TASK:UNPROVEN'}]});const result=run(ledger,store);assert.equal(result.status,0,result.stderr);const body=JSON.parse(result.stdout);assert.equal(body.report.imported.length,1);assert.equal(body.report.unknown.length,1);assert.equal(body.f7.result,'NOT_EVALUATED');const core=new CoreStore(store);assert.equal(core.getObject('ENTITY:LEDGER').canonical_name,'Ledger');core.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('review ledger rejects unclassified or unsealed inputs',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage6-ledger-'));try{const ledger=write(dir,'bad.json',{kind:'STAGE6_REVIEW_LEDGER',baseline_digest:'bad',records:[]});const result=run(ledger,path.join(dir,'core.db'));assert.equal(result.status,2);assert.match(result.stderr,/INVALID_STAGE6_REVIEW_LEDGER/);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
