import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const iso=()=>new Date().toISOString();
export class AdapterError extends Error { constructor(reason_code,message=reason_code) { super(message); this.reason_code=reason_code; } }

/** A: staging-only filesystem adapter. Paths are relative to its explicit root. */
export class FileSystemAAdapter {
  constructor(stagingRoot) { this.root=path.resolve(stagingRoot); fs.mkdirSync(this.root,{recursive:true}); }
  #path(relativePath) { if(typeof relativePath!=='string' || path.isAbsolute(relativePath)) throw new AdapterError('FAIL_CLOSED'); const candidate=path.resolve(this.root,relativePath); if(candidate!==this.root && !candidate.startsWith(`${this.root}${path.sep}`)) throw new AdapterError('FAIL_CLOSED'); return candidate; }
  metadata(relativePath) { const target=this.#path(relativePath); if(!fs.existsSync(target)) throw new AdapterError('UNKNOWN'); const stat=fs.statSync(target); if(!stat.isFile()) throw new AdapterError('FAIL_CLOSED'); return {A_path:relativePath,bytes:stat.size,generation_local:`${stat.size}:${stat.mtimeMs}`,modified_at:stat.mtime.toISOString()}; }
  read(relativePath) { const target=this.#path(relativePath); if(!fs.existsSync(target)) throw new AdapterError('UNKNOWN'); return fs.readFileSync(target); }
  seal({artifact_id,generation,A_path,C_file_id,at=iso()}) { const bytes=this.read(A_path); const metadata=this.metadata(A_path); return {seal_id:`SEAL:${crypto.randomUUID()}`,artifact_id,generation,A_path,C_file_id,bytes_A:bytes.length,sha256_A:sha256(bytes),timestamp:at,generation_local:metadata.generation_local}; }
}

/** C: ID-only boundary. The injected client may be a test double or a future credentialed staging transport. */
export class DriveIdAdapter {
  constructor(client,{authorizedIds=[]}={}) { this.client=client; this.authorizedIds=new Set(authorizedIds); }
  #assert(id) { if(!id || !this.authorizedIds.has(id)) throw new AdapterError('UNAUTHORIZED_C_ID'); }
  metadataById(id) { this.#assert(id); return this.client.metadataById(id); }
  writeById(id,bytes) { this.#assert(id); const result=this.client.writeById(id,Buffer.from(bytes)); if(!result || result.id!==id) throw new AdapterError('REMOTE_NOT_PROVEN'); return result; }
  readById(id) { this.#assert(id); const result=this.client.readById(id); if(!result || result.id!==id || !Buffer.isBuffer(result.bytes)) throw new AdapterError('REMOTE_NOT_PROVEN'); if(result.bytes.length===0) throw new AdapterError('READBACK_EMPTY'); return result; }
}

/** DEV/STAGING test transport only. It deliberately exposes no name lookup operation. */
export class InMemoryDriveStaging {
  constructor(entries=[]) { this.byId=new Map(entries.map(entry=>[entry.id,{...entry,bytes:Buffer.from(entry.bytes)}])); }
  metadataById(id) { const item=this.byId.get(id); if(!item) throw new AdapterError('REMOTE_NOT_PROVEN'); return {id:item.id,mime_type:item.mime_type,parent_id:item.parent_id,bytes:item.bytes.length}; }
  writeById(id,bytes) { const item=this.byId.get(id); if(!item) throw new AdapterError('REMOTE_NOT_PROVEN'); item.bytes=Buffer.from(bytes); item.updated_at=iso(); return {id}; }
  readById(id) { const item=this.byId.get(id); if(!item) throw new AdapterError('REMOTE_NOT_PROVEN'); return {id,bytes:Buffer.from(item.bytes),mime_type:item.mime_type}; }
}

export class ReplicationService {
  constructor({registry,sourceA,remoteC,clock=iso}={}) { this.registry=registry; this.sourceA=sourceA; this.remoteC=remoteC; this.clock=clock; }
  #result(mapping,seal,{result,reason_code,bytes_C=null,sha256_C=null,readback_at=null,error=null}={}) { const attempt={attempt_id:`REPLICATION_ATTEMPT:${crypto.randomUUID()}`,mapping_id:mapping.mapping_id,artifact_id:mapping.artifact_id,generation:mapping.generation,A_path:mapping.A_path,C_file_id:mapping.C_file_id,bytes_A:seal.bytes_A,sha256_A:seal.sha256_A,bytes_C,sha256_C,sealed_at:seal.timestamp,replicated_at:this.clock(),readback_at,result,reason_code,created_at:this.clock(),...(error?{error}: {})}; this.registry.saveReplicationAttempt(attempt); if(result!=='SYNC_VERIFIED') return {...attempt,retryable:true}; const proof={...attempt,proof_id:`REPLICATION_PROOF:${crypto.createHash('sha256').update(`${mapping.mapping_id}:${seal.sha256_A}`).digest('hex')}`}; return {...attempt,proof:this.registry.saveReplicationProof(proof)}; }
  replicate({artifact_id,generation}) {
    const mapping=this.registry.getAuthorizedMapping(artifact_id,generation); if(!mapping) throw new AdapterError('MAPPING_MISSING');
    const seal=this.sourceA.seal({...mapping,at:this.clock()});
    try {
      this.remoteC.writeById(mapping.C_file_id,this.sourceA.read(mapping.A_path));
      const readback=this.remoteC.readById(mapping.C_file_id); const bytes_C=readback.bytes.length; const sha256_C=sha256(readback.bytes); const finalSeal=this.sourceA.seal({...mapping,at:this.clock()});
      if(finalSeal.sha256_A!==seal.sha256_A || finalSeal.bytes_A!==seal.bytes_A) return this.#result(mapping,seal,{result:'NO_SYNC',reason_code:'SUPERSEDED_GENERATION',bytes_C,sha256_C,readback_at:this.clock()});
      if(bytes_C!==seal.bytes_A || sha256_C!==seal.sha256_A) return this.#result(mapping,seal,{result:'NO_SYNC',reason_code:'HASH_MISMATCH',bytes_C,sha256_C,readback_at:this.clock()});
      return this.#result(mapping,seal,{result:'SYNC_VERIFIED',reason_code:'SYNC_VERIFIED',bytes_C,sha256_C,readback_at:this.clock()});
    } catch(error) { const reason=error.reason_code ?? 'FAIL_CLOSED'; return this.#result(mapping,seal,{result:'NO_SYNC',reason_code:reason,error:String(error)}); }
  }
  diagnoseB() { return {result:'NO_SYNC',reason_code:'REPLICATION_NOT_PROVEN',authoritative:false}; }
}
