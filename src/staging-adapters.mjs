import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const iso=()=>new Date().toISOString();
const id=prefix=>`${prefix}:${crypto.randomUUID()}`;
export class AdapterError extends Error { constructor(reason_code,message=reason_code,{transient=false}={}) { super(message); this.reason_code=reason_code; this.transient=transient; } }
export class ControlledReplicationCrash extends Error { constructor(phase) { super(`CONTROLLED_CRASH:${phase}`); this.phase=phase; } }

/** A: DEV-only filesystem boundary. It accepts explicit paths relative to one isolated root. */
export class FileSystemAAdapter {
  constructor(stagingRoot) { this.root=path.resolve(stagingRoot); fs.mkdirSync(this.root,{recursive:true}); }
  #path(relativePath) { if(typeof relativePath!=='string'||!relativePath||path.isAbsolute(relativePath)) throw new AdapterError('INVALID_A_PATH'); const candidate=path.resolve(this.root,relativePath); if(candidate===this.root||!candidate.startsWith(`${this.root}${path.sep}`)) throw new AdapterError('INVALID_A_PATH'); return candidate; }
  metadata(relativePath) { const target=this.#path(relativePath); if(!fs.existsSync(target)) throw new AdapterError('A_NOT_FOUND'); const stat=fs.statSync(target); if(!stat.isFile()) throw new AdapterError('INVALID_A_PATH'); return {A_path:relativePath,bytes:stat.size,mtime:stat.mtime.toISOString()}; }
  read(relativePath) { const target=this.#path(relativePath); if(!fs.existsSync(target)) throw new AdapterError('A_NOT_FOUND'); return fs.readFileSync(target); }
  seal({artifact_id,generation_id,generation,A_path,at=iso()}) { const bytes=this.read(A_path); const metadata=this.metadata(A_path); const actualGeneration=generation_id??generation; if(!actualGeneration) throw new AdapterError('GENERATION_REQUIRED'); return {source_seal_ref:id('A_SEAL'),artifact_id,generation_id:actualGeneration,A_path,bytes_A:bytes.length,sha256_A:sha256(bytes),sealed_at:at,mtime:metadata.mtime}; }
  verifySeal(seal) { const bytes=this.read(seal.A_path); return {same:bytes.length===seal.bytes_A&&sha256(bytes)===seal.sha256_A,bytes_A:bytes.length,sha256_A:sha256(bytes)}; }
}

/** C boundary: exact authorized ID only. No name/folder/latest lookup exists. */
export class DriveIdAdapter {
  constructor(client,{authorizedIds=[],expectedMimeTypes=['text/plain','application/octet-stream']}={}) { this.client=client; this.authorizedIds=new Set(authorizedIds); this.expectedMimeTypes=new Set(expectedMimeTypes); }
  #assert(idValue) { if(!idValue) throw new AdapterError('C_FILE_ID_MISSING'); if(!this.authorizedIds.has(idValue)) throw new AdapterError('C_FILE_ID_UNAUTHORIZED'); }
  metadataExactId(idValue) { this.#assert(idValue); return this.client.metadataById(idValue); }
  writeExactId(idValue,bytes) { this.#assert(idValue); let result; try{result=this.client.writeById(idValue,Buffer.from(bytes));}catch(error){if(error.reason_code) throw error; throw new AdapterError('C_WRITE_FAILED',error.message,{transient:error.transient===true});} if(!result||result.id!==idValue) throw new AdapterError('C_WRITE_INVALID_RESPONSE'); return {id:idValue,write_result_ref:result.revision??id('C_WRITE')}; }
  readExactId(idValue) { this.#assert(idValue); let result; try{result=this.client.readById(idValue);}catch(error){if(error.reason_code) throw error; throw new AdapterError('C_READBACK_FAILED',error.message,{transient:error.transient===true});} if(!result||result.id!==idValue||!Buffer.isBuffer(result.bytes)||result.authenticated!==true||!this.expectedMimeTypes.has(result.mime_type)||result.bytes.length===0) throw new AdapterError('REMOTE_READ_INVALID'); return {id:idValue,bytes:Buffer.from(result.bytes),mime_type:result.mime_type,readback_ref:result.revision??id('C_READBACK')}; }
}

/** DEV transport. It intentionally has no search-by-name method. */
export class InMemoryDriveStaging {
  constructor(entries=[]) { this.byId=new Map(entries.map(entry=>[entry.id,{authenticated:true,...entry,bytes:Buffer.from(entry.bytes),revision:entry.revision??'REV:0',writes:0}])); }
  metadataById(idValue) { const item=this.byId.get(idValue); if(!item) throw new AdapterError('C_FILE_ID_INVALID'); return {id:item.id,mime_type:item.mime_type,parent_id:item.parent_id,bytes:item.bytes.length,revision:item.revision}; }
  writeById(idValue,bytes) { const item=this.byId.get(idValue); if(!item) throw new AdapterError('C_FILE_ID_INVALID'); item.bytes=Buffer.from(bytes); item.writes++; item.revision=`REV:${item.writes}`; return {id:idValue,revision:item.revision}; }
  readById(idValue) { const item=this.byId.get(idValue); if(!item) throw new AdapterError('C_FILE_ID_INVALID'); return {id:idValue,bytes:Buffer.from(item.bytes),mime_type:item.mime_type,authenticated:item.authenticated,revision:item.revision}; }
  writeCount(idValue) { return this.byId.get(idValue)?.writes??0; }
}

export class ReplicationService {
  constructor({registry,sourceA,remoteC,clock=iso}={}) { this.registry=registry; this.sourceA=sourceA; this.remoteC=remoteC; this.clock=clock; }
  #attempt(mapping,seal,status,reason_code,extra={}) { const attempt={attempt_id:id('REPLICATION_ATTEMPT'),mapping_id:mapping.mapping_id,artifact_id:mapping.artifact_id,generation:mapping.generation_id??mapping.generation,A_path:mapping.A_path,C_file_id:mapping.C_file_id,result:status,reason_code,status,source_seal_ref:seal.source_seal_ref,bytes_A:seal.bytes_A,sha256_A:seal.sha256_A,sealed_at:seal.sealed_at,created_at:this.clock(),...extra}; return this.registry.saveReplicationAttempt(attempt); }
  #latest(mapping) { return this.registry.listReplicationAttempts().filter(item=>item.mapping_id===mapping.mapping_id&&item.generation===(mapping.generation_id??mapping.generation)).at(-1)??null; }
  #fail(mapping,seal,status,reason,error,extra={}) { return this.#attempt(mapping,seal,status,reason,{error:error?String(error.message??error):undefined,retryable:error?.transient===true,...extra}); }
  #proof(mapping,seal,write,readback) { const completed_at=this.clock(); const proof={proof_id:`REPLICATION_PROOF:${sha256(Buffer.from(`${mapping.mapping_id}:${seal.generation_id}:${seal.sha256_A}`))}`,attempt_id:id('REPLICATION_ATTEMPT'),mapping_id:mapping.mapping_id,artifact_id:mapping.artifact_id,generation:mapping.generation_id??mapping.generation,A_path:mapping.A_path,C_file_id:mapping.C_file_id,result:'SYNC_VERIFIED',reason_code:'SYNC_VERIFIED',status:'SYNC_VERIFIED',source_seal_ref:seal.source_seal_ref,write_result_ref:write.write_result_ref,readback_ref:readback.readback_ref,bytes_A:seal.bytes_A,sha256_A:seal.sha256_A,bytes_C:readback.bytes.length,sha256_C:sha256(readback.bytes),sealed_at:seal.sealed_at,completed_at,created_at:completed_at}; this.registry.saveReplicationAttempt(proof); return this.registry.saveReplicationProof(proof); }
  replicate({artifact_id,generation_id,generation,crash_after=null}) {
    const wantedGeneration=generation_id??generation; const mapping=this.registry.getAuthorizedMapping(artifact_id,wantedGeneration); if(!mapping) throw new AdapterError('MAPPING_MISSING');
    if(mapping.byte_preserving!==true||mapping.replication_mode!=='A_TO_C_EXACT_ID') throw new AdapterError('MAPPING_NOT_BYTE_PRESERVING');
    const seal=this.sourceA.seal({...mapping,generation_id:wantedGeneration,at:this.clock()}); this.#attempt(mapping,seal,'A_SEALED','A_SEALED');
    const latest=this.#latest(mapping); let write={write_result_ref:latest?.write_result_ref}; let readback;
    try {
      const previous=this.registry.listReplicationAttempts().filter(item=>item.mapping_id===mapping.mapping_id&&item.generation===wantedGeneration);
      const remotelyWritten=previous.findLast(item=>['C_WRITE_PENDING','C_READBACK_VERIFIED'].includes(item.status)&&item.write_result_ref);
      if(remotelyWritten){ write={write_result_ref:remotelyWritten.write_result_ref}; try{readback=this.remoteC.readExactId(mapping.C_file_id);}catch{readback=null;} }
      if(!readback){ this.#attempt(mapping,seal,'C_WRITE_PENDING','C_WRITE_PENDING'); write=this.remoteC.writeExactId(mapping.C_file_id,this.sourceA.read(mapping.A_path)); this.#attempt(mapping,seal,'C_WRITE_PENDING','WRITE_CONFIRMED',write); if(crash_after==='WRITE') throw new ControlledReplicationCrash('WRITE'); readback=this.remoteC.readExactId(mapping.C_file_id); }
      const bytes_C=readback.bytes.length,sha256_C=sha256(readback.bytes); this.#attempt(mapping,seal,'C_READBACK_VERIFIED','READBACK_VERIFIED',{...write,readback_ref:readback.readback_ref,bytes_C,sha256_C}); if(crash_after==='READBACK') throw new ControlledReplicationCrash('READBACK');
      if(!this.sourceA.verifySeal(seal).same) return this.#attempt(mapping,seal,'SUPERSEDED_GENERATION','SUPERSEDED_GENERATION',{...write,readback_ref:readback.readback_ref,bytes_C,sha256_C});
      if(bytes_C!==seal.bytes_A||sha256_C!==seal.sha256_A) return this.#attempt(mapping,seal,'DIVERGED','HASH_MISMATCH',{...write,readback_ref:readback.readback_ref,bytes_C,sha256_C});
      const proof=this.#proof(mapping,seal,write,readback); return {...proof,proof};
    } catch(error) {
      if(error instanceof ControlledReplicationCrash) throw error;
      const reason=error.reason_code??'FAIL_CLOSED'; const status=reason.startsWith('C_WRITE')||reason.startsWith('C_FILE_ID')||['PERMISSION_DENIED_WRITE','TIMEOUT_WRITE'].includes(reason)?'C_WRITE_FAILED':'C_READBACK_FAILED'; return this.#fail(mapping,seal,status,reason,error,write);
    }
  }
  diagnoseB({accessible=null,error=null}={}) { if(error) return {status:'B_ERROR',authoritative:false,can_close_proof:false}; if(accessible===true) return {status:'B_ACCESSIBLE',authoritative:false,can_close_proof:false}; if(accessible===false) return {status:'B_UNAVAILABLE',authoritative:false,can_close_proof:false}; return {status:'B_UNKNOWN',authoritative:false,can_close_proof:false}; }
}
