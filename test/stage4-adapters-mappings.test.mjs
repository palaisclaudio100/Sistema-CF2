import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreStore } from '../src/core-store.mjs';
import { DeterministicWorker } from '../src/deterministic-worker.mjs';
import { AdapterError, ControlledReplicationCrash, DriveIdAdapter, FileSystemAAdapter, InMemoryDriveStaging, ReplicationService } from '../src/staging-adapters.mjs';

const at='2026-08-31T12:00:00.000Z';
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage4-gate-')),root=path.join(dir,'A');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'fixture.bin'),Buffer.from([0,1,2,3,255]));const store=new CoreStore(path.join(dir,'core.db'));const transport=new InMemoryDriveStaging([{id:'C:STAGING:EXACT',title:'fixture.bin',bytes:'old',mime_type:'application/octet-stream',parent_id:'STAGING',updated_at:'old'},{id:'C:STAGING:HOMONYM',title:'fixture.bin',bytes:'newer homonym',mime_type:'application/octet-stream',parent_id:'STAGING',updated_at:'newer'}]);const sourceA=new FileSystemAAdapter(root),remoteC=new DriveIdAdapter(transport,{authorizedIds:['C:STAGING:EXACT']}),mapping={mapping_id:'MAPPING:GATE',artifact_id:'ARTIFACT:GATE',generation_id:'GEN:GATE:1',A_path:'fixture.bin',C_file_id:'C:STAGING:EXACT',B_path:'B/diagnostic/fixture.bin',replication_mode:'A_TO_C_EXACT_ID',byte_preserving:true,environment:'STAGING',status:'AUTHORIZED',created_at:at,updated_at:at,basis_ref:['STAGE4']};store.registerStagingMapping(mapping);const service=()=>new ReplicationService({registry:store,sourceA,remoteC,clock:()=>at});return{dir,root,store,transport,sourceA,remoteC,mapping,service,done(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};}
function setupFailure(client){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage4-fail-')),root=path.join(dir,'A');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'fixture.bin'),Buffer.from([0,1,2,3,255]));const store=new CoreStore(path.join(dir,'core.db')),mapping={mapping_id:'MAPPING:FAIL',artifact_id:'ARTIFACT:FAIL',generation_id:'GEN:FAIL:1',A_path:'fixture.bin',C_file_id:'C:STAGING:EXACT',B_path:null,replication_mode:'A_TO_C_EXACT_ID',byte_preserving:true,environment:'STAGING',status:'AUTHORIZED',created_at:at,updated_at:at,basis_ref:['STAGE4']};store.registerStagingMapping(mapping);const service=new ReplicationService({registry:store,sourceA:new FileSystemAAdapter(root),remoteC:new DriveIdAdapter(client,{authorizedIds:['C:STAGING:EXACT']}),clock:()=>at});return{store,mapping,service,done(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};}

test('mapping is exact, byte-preserving and changing C ID requires explicit generation',()=>{const x=setup();try{
  assert.deepEqual(x.store.getAuthorizedMapping('ARTIFACT:GATE','GEN:GATE:1'),x.mapping);
  assert.throws(()=>x.store.registerStagingMapping({...x.mapping,mapping_id:'MAPPING:REPLACEMENT',C_file_id:'C:OTHER'}),error=>error.reason_code==='MAPPING_ID_CHANGE_REQUIRES_NEW_GENERATION');
}finally{x.done();}});

test('T13 names, titles and filenames cannot replace an authorized C_file_id',()=>{const x=setup();try{
  assert.throws(()=>x.service().replicate({artifact_id:'fixture.bin',generation_id:'GEN:GATE:1',name:'fixture.bin',title:'fixture.bin'}),error=>error.reason_code==='MAPPING_MISSING');
  const source=fs.readFileSync(path.join(import.meta.dirname,'..','src','staging-adapters.mjs'),'utf8'); assert.equal(source.match(/searchByName|findLatestByName|resolveByFilename/),null);
}finally{x.done();}});

test('T14 proof contains seal, exact-ID write/readback, bytes and hashes',()=>{const x=setup();try{
  const result=x.service().replicate({artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id});
  assert.equal(result.status,'SYNC_VERIFIED'); assert.equal(result.C_file_id,'C:STAGING:EXACT'); assert.equal(result.bytes_A,5); assert.equal(result.bytes_C,5); assert.equal(result.sha256_A,result.sha256_C); assert.ok(result.source_seal_ref&&result.write_result_ref&&result.readback_ref&&result.completed_at); assert.equal(x.transport.writeCount('C:STAGING:EXACT'),1);
}finally{x.done();}});

test('T15 B equality is diagnostic only and cannot produce proof',()=>{const x=setup();try{
  fs.mkdirSync(path.join(x.root,'B'),{recursive:true}); fs.copyFileSync(path.join(x.root,'fixture.bin'),path.join(x.root,'B','same.bin')); const diagnostic=x.service().diagnoseB({accessible:true});
  assert.equal(diagnostic.status,'B_ACCESSIBLE'); assert.equal(diagnostic.can_close_proof,false); assert.equal(x.store.listReplicationProofs().length,0);
}finally{x.done();}});

test('T16 newer homonym is completely ignored',()=>{const x=setup();try{
  const homonym=Buffer.from(x.transport.readById('C:STAGING:HOMONYM').bytes); x.service().replicate({artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id});
  assert.deepEqual(x.transport.readById('C:STAGING:HOMONYM').bytes,homonym); assert.equal(x.transport.writeCount('C:STAGING:HOMONYM'),0); assert.equal(x.transport.writeCount('C:STAGING:EXACT'),1);
}finally{x.done();}});

test('invalid authenticated response is C_READBACK_FAILED, never DIVERGED',()=>{const x=setup();try{
  for(const bad of [{id:'C:STAGING:EXACT',bytes:Buffer.from('<html>login</html>'),mime_type:'text/html',authenticated:false},{id:'C:STAGING:EXACT',bytes:Buffer.from('partial'),mime_type:'text/plain',authenticated:false}]){
    const client={writeById:id=>({id,revision:'W'}),readById:()=>bad,metadataById:id=>({id})}; const service=new ReplicationService({registry:x.store,sourceA:x.sourceA,remoteC:new DriveIdAdapter(client,{authorizedIds:['C:STAGING:EXACT']}),clock:()=>at}); const result=service.replicate({artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id}); assert.equal(result.status,'C_READBACK_FAILED'); assert.equal(result.reason_code,'REMOTE_READ_INVALID');
  }
}finally{x.done();}});

test('fail-closed matrix distinguishes ID, permission, timeout and invalid readback',()=>{const x=setup();try{
  assert.throws(()=>x.remoteC.writeExactId('',Buffer.from('x')),error=>error.reason_code==='C_FILE_ID_MISSING'); assert.throws(()=>x.remoteC.readExactId('C:OTHER'),error=>error.reason_code==='C_FILE_ID_UNAUTHORIZED');
  const scenarios=[
    {error:new AdapterError('PERMISSION_DENIED_WRITE'),phase:'write',status:'C_WRITE_FAILED',reason:'PERMISSION_DENIED_WRITE'},
    {error:new AdapterError('PERMISSION_DENIED_READ'),phase:'read',status:'C_READBACK_FAILED',reason:'PERMISSION_DENIED_READ'},
    {error:new AdapterError('TIMEOUT_WRITE','timeout',{transient:true}),phase:'write',status:'C_WRITE_FAILED',reason:'TIMEOUT_WRITE'}
  ];
  for(const item of scenarios){const client={writeById:id=>{if(item.phase==='write')throw item.error;return{id}},readById:id=>{if(item.phase==='read')throw item.error;return{id,bytes:Buffer.from([0,1,2,3,255]),mime_type:'application/octet-stream',authenticated:true}},metadataById:id=>({id})};const y=setupFailure(client);try{const result=y.service.replicate({artifact_id:y.mapping.artifact_id,generation_id:y.mapping.generation_id});assert.equal(result.status,item.status);assert.equal(result.reason_code,item.reason);}finally{y.done();}}
  const incomplete={writeById:id=>({id}),readById:id=>({id,mime_type:'application/octet-stream',authenticated:true}),metadataById:id=>({id})}; const invalid=new ReplicationService({registry:x.store,sourceA:x.sourceA,remoteC:new DriveIdAdapter(incomplete,{authorizedIds:['C:STAGING:EXACT']}),clock:()=>at}).replicate({artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id}); assert.equal(invalid.reason_code,'REMOTE_READ_INVALID'); assert.equal(invalid.status,'C_READBACK_FAILED');
}finally{x.done();}});

test('crash after C write recovers by readback without duplicate write',()=>{const x=setup();try{
  assert.throws(()=>x.service().replicate({artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id,crash_after:'WRITE'}),error=>error instanceof ControlledReplicationCrash&&error.phase==='WRITE'); assert.equal(x.transport.writeCount('C:STAGING:EXACT'),1);
  const recovered=x.service().replicate({artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id}); assert.equal(recovered.status,'SYNC_VERIFIED'); assert.equal(x.transport.writeCount('C:STAGING:EXACT'),1);
}finally{x.done();}});

test('crash after readback recovers proof without duplicate write',()=>{const x=setup();try{
  assert.throws(()=>x.service().replicate({artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id,crash_after:'READBACK'}),error=>error instanceof ControlledReplicationCrash&&error.phase==='READBACK'); const recovered=x.service().replicate({artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id});
  assert.equal(recovered.status,'SYNC_VERIFIED'); assert.equal(x.transport.writeCount('C:STAGING:EXACT'),1); assert.equal(x.store.listReplicationProofs().length,1);
}finally{x.done();}});

test('Stage 4 replication runs as a durable worker job in DEV',async()=>{const x=setup();try{
  x.store.enqueueDevJob({job_type:'REQUEST_REPLICATION',payload:{artifact_id:x.mapping.artifact_id,generation_id:x.mapping.generation_id},dedupe_key:'REPLICATION:ARTIFACT:GATE:GEN1',causation_id:'EVENT:ARTIFACT_READY',at}); const worker=new DeterministicWorker(x.store,{replication_service:x.service()}); const run=await worker.runOnce({at});
  assert.equal(run.executed,1); assert.equal(x.store.listJobs().find(j=>j.job_type==='REQUEST_REPLICATION').status,'DONE'); assert.equal(x.store.listReplicationProofs().length,1);
}finally{x.done();}});
