import {validDocument} from './executor-policy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sha} from './actor-transport.mjs';

// This registry is installed by engineering, not supplied by a model or a workflow.
// A request names an object; it cannot supply a path, executable or command arguments.
export class ExecutorObjects{
  constructor({objects=[],commands=[],stateRoot,execute}){this.objects=new Map(objects.map(o=>[o.object_id,o]));this.commands=new Map(commands.map(c=>[c.command_id,c]));this.stateRoot=stateRoot;this.execute=execute;this.locks=new Map();}
  async object(actor,id,write=false){
    const o=this.objects.get(id);if(!o||!(write?o.owner===actor:o.readers?.includes(actor)))throw new Error('OBJECT_SCOPE_DENIED');
    if(write&&actor==='ACTOR:GABY_CHAT')throw new Error('CROSS_ROLE_WRITE_DENIED');
    if(o.kind==='canonical'&&(actor!=='ACTOR:GABY_CW'||!o.canonical_write_enabled)&&write)throw new Error('CANON_WRITE_DENIED');
    if(write&&o.kind==='document'&&actor!=='ACTOR:GABY_CW')throw new Error('CROSS_ROLE_WRITE_DENIED');
    if(!o.root||!o.relative_path||path.isAbsolute(o.relative_path)||o.relative_path.split(/[\\/]/).includes('..'))throw new Error('OBJECT_SCOPE_DENIED');
    const root=path.resolve(o.root),file=path.resolve(root,o.relative_path),rel=path.relative(root,file);if(write&&['documento_maestro_chat-cowork.md','estado_sesion_actual.md'].includes(path.basename(file).toLowerCase())&&(actor!=='ACTOR:GABY_CW'||o.kind!=='canonical'||!o.canonical_write_enabled))throw new Error('CANON_WRITE_DENIED');
    if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('OBJECT_SCOPE_DENIED');
    const parent=path.dirname(file),realParent=await fs.realpath(parent),realRoot=await fs.realpath(root);
    if(path.relative(realRoot,realParent).startsWith('..')||path.resolve(realParent).toLowerCase()!==parent.toLowerCase())throw new Error('OBJECT_SYMLINK_DENIED');
    try{if((await fs.lstat(file)).isSymbolicLink())throw new Error('OBJECT_SYMLINK_DENIED');}catch(e){if(e.code!=='ENOENT')throw e;}
    return{...o,file};
  }
  async snapshot(actor,id){const o=await this.object(actor,id);try{const stat=await fs.stat(o.file);if(stat.size>(o.max_bytes??2000000))throw new Error('OBJECT_SIZE_LIMIT');const bytes=await fs.readFile(o.file);return{object_id:id,kind:o.kind,sha256:sha(bytes),bytes:bytes.length,content:bytes.toString('utf8'),verified_at:new Date().toISOString()};}catch(e){if(e.code==='ENOENT')return{object_id:id,kind:o.kind,sha256:null,bytes:0,content:null,verified_at:new Date().toISOString()};throw e;}}
  async writeValidated(context,fence){
    const {actor_id,step,validated_document:doc,message_id}=context;
    if(actor_id!=='ACTOR:GABY_CW'||step.action!=='WRITE_VALIDATED'||!doc?.validated||doc.validated_by!=='ACTOR:GABY_CHAT'||doc.object_id!==step.object_id||!validDocument(doc))throw new Error('CROSS_ROLE_WRITE_DENIED');
    if(this.locks.has(step.object_id))throw new Error('OBJECT_BUSY');this.locks.set(step.object_id,true);
    let lockPath,lockMark;try{
      const o=await this.object(actor_id,step.object_id,true);if(!['document','canonical'].includes(o.kind))throw new Error('CROSS_ROLE_WRITE_DENIED');if(!o.readers?.includes(actor_id))throw new Error('OBJECT_READBACK_SCOPE_REQUIRED');await fs.mkdir(this.stateRoot,{recursive:true});
      lockPath=path.join(this.stateRoot,sha(step.object_id)+'.lock');lockMark=JSON.stringify({pid:process.pid,message_id,nonce:Math.random()});
      // Never steal a persistent lock based on a potentially reused or foreign PID.
      // Recovery requires engineering to quiesce this registered object first.
      try{await fs.writeFile(lockPath,lockMark,{flag:'wx'});}catch(e){lockMark=null;if(e.code==='EEXIST')throw new Error('OBJECT_BUSY');throw e;}
      const failurePath=path.join(this.stateRoot,sha(step.object_id)+'.verification-failures');let failures=0;try{const raw=(await fs.readFile(failurePath,'utf8')).trim();if(!/^[0-9]+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new Error('MATERIAL_VERIFICATION_LOCKED');failures=Number(raw);}catch(e){if(e.code!=='ENOENT')throw e;}if(failures>=2)throw new Error('MATERIAL_VERIFICATION_LOCKED');const receiptPath=path.join(this.stateRoot,sha(message_id)+'.json');let old;
      try{old=JSON.parse(await fs.readFile(receiptPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      const before=await this.snapshot(actor_id,step.object_id);
      if(old){if(old.object_id!==step.object_id||old.validation_sha256!==doc.sha256)throw new Error('MATERIAL_REPLAY_CONFLICT');if(before.sha256===old.after_sha256){await fence();const recovered={...old,status:'COMMITTED',replayed:true,readback_sha256:before.sha256,verified_at:before.verified_at};await fs.writeFile(receiptPath,JSON.stringify(recovered));return recovered;}if(old.status!=='PREPARED'||before.sha256!==old.before_sha256)throw new Error('MATERIAL_REPLAY_CONFLICT');}
      if(before.sha256!==step.expected_sha256)throw new Error('OBJECT_VERSION_CONFLICT');
      const backup=path.join(this.stateRoot,sha(message_id)+'.before');if(before.content!==null){const original=await fs.readFile(o.file);if(sha(original)!==before.sha256)throw new Error('OBJECT_VERSION_CONFLICT');await fs.writeFile(backup,original,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});if(sha(await fs.readFile(backup))!==before.sha256){await fs.writeFile(failurePath,String(failures+1));throw new Error('MATERIAL_BACKUP_VERIFICATION_FAILED');}}
      let content=doc.content;if(o.kind==='canonical'&&doc.mode!=='PATCH')throw new Error('CANON_PATCH_REQUIRED');if(doc.mode==='PATCH'){if(before.content===null)throw new Error('OBJECT_MISSING');content=before.content;for(const edit of doc.edits){const at=content.indexOf(edit.before);if(at<0||content.indexOf(edit.before,at+1)>=0)throw new Error('PATCH_ANCHOR_AMBIGUOUS');content=content.slice(0,at)+edit.after+content.slice(at+edit.before.length);}}const bytes=Buffer.from(content,'utf8'),afterHash=sha(bytes);if(bytes.length>(o.max_bytes??2000000))throw new Error('OBJECT_SIZE_LIMIT');
      const prepared={status:'PREPARED',actor_id,object_id:step.object_id,message_id,before_sha256:before.sha256,after_sha256:afterHash,validation_sha256:doc.sha256,validation_message_id:doc.validation_message_id,backup_available:before.content!==null};await fs.writeFile(receiptPath,JSON.stringify(prepared));const temp=o.file+'.cf2-'+sha(message_id).slice(0,16)+'.tmp';await fs.writeFile(temp,bytes,{flag:'wx'}).catch(async e=>{if(e.code!=='EEXIST'||sha(await fs.readFile(temp))!==afterHash)throw e;});
      let replaced=false;
      try{
        await fence();const current=await this.snapshot(actor_id,step.object_id);if(current.sha256!==before.sha256)throw new Error('OBJECT_VERSION_CONFLICT');
        await fs.rename(temp,o.file);replaced=true;
        const after=await this.snapshot(actor_id,step.object_id);if(after.sha256!==afterHash)throw new Error('MATERIAL_READBACK_FAILED');await fence();
        const receipt={status:'COMMITTED',actor_id,object_id:step.object_id,message_id,before_sha256:before.sha256,after_sha256:after.sha256,readback_sha256:after.sha256,bytes:after.bytes,verified_at:after.verified_at,validation_message_id:doc.validation_message_id,validation_sha256:doc.sha256,backup_available:before.content!==null};
        await fs.writeFile(receiptPath,JSON.stringify(receipt));await fs.writeFile(failurePath,'0');return receipt;
      }catch(error){if(error.message==='MATERIAL_READBACK_FAILED')await fs.writeFile(failurePath,String(failures+1));if(replaced){const current=await this.snapshot(actor_id,step.object_id);if(current.sha256===afterHash){if(before.content===null)await fs.unlink(o.file);else await fs.copyFile(backup,o.file);const restored=await this.snapshot(actor_id,step.object_id);if(restored.sha256!==before.sha256){await fs.writeFile(failurePath,String(failures+1));throw new Error('MATERIAL_ROLLBACK_FAILED');}}}throw error;}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    }finally{if(lockPath&&lockMark){try{if(await fs.readFile(lockPath,'utf8')===lockMark)await fs.unlink(lockPath);}catch(e){if(e.code!=='ENOENT')throw e;}}this.locks.delete(step.object_id);}
  }
  async runRegistered(actor,id,fence){const c=this.commands.get(id);if(!c||!c.actors?.includes(actor)||actor==='ACTOR:GABY_CHAT')throw new Error('COMMAND_SCOPE_DENIED');
    for(const pin of c.pins??[]){if(sha(await fs.readFile(pin.path))!==pin.sha256)throw new Error('COMMAND_VERSION_CONFLICT');}
    await fence();const r=await this.execute(c.executable,c.args??[],'',{cwd:c.cwd,timeoutMs:c.timeout_ms??120000});await fence();
    return{command_id:id,actor_id:actor,definition_sha256:sha(JSON.stringify({executable:c.executable,args:c.args??[],cwd:c.cwd,pins:c.pins??[]})),program:c.executable,pinned_programs:c.pins??[],exit_code:r.exit_code,stdout_sha256:sha(r.stdout),stdout_bytes:Buffer.byteLength(r.stdout),stdout_truncated:r.stdout.length>8000,stdout:r.stdout.slice(0,8000),stderr_sha256:r.stderr_sha256??null,verified_at:new Date().toISOString()};
  }
}
