import {ACTORS,sha,strict} from './actor-transport.mjs';
const str={type:'string',minLength:1,maxLength:200};
const obj={type:'object',additionalProperties:true};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
export const orchestrationTools=[
  ['start_workflow','Persist a workflow; multi-actor dispatch and Claude Code activation require Diego.',schema({thread_id:str,payload:obj,stages:{type:'array',items:{enum:ACTORS},minItems:1,maxItems:20},task_id:str,command_id:str},['thread_id','payload','stages'])],
  ['send_to_actor','Send a typed message on an authorized thread; sender is server-bound.',schema({thread_id:str,recipient:{enum:ACTORS},type:{enum:['REQUEST','RESPONSE','OBJECTION','DECISION','EVIDENCE','ACK']},payload:obj,idempotency_key:str,task_id:str,command_id:str},['thread_id','recipient','type','payload','idempotency_key'])],
  ['read_inbox','Read the authenticated actor inbox.',schema({limit:{type:'integer',minimum:1,maximum:100}})],
  ['read_thread','Read an authorized thread and its audit trail.',schema({thread_id:str},['thread_id'])],
  ['reply_to_message','Return to the immutable original sender and thread.',schema({thread_id:str,message_id:str,type:{enum:['RESPONSE','OBJECTION','EVIDENCE','ACK']},payload:obj},['thread_id','message_id','type','payload'])],
  ['get_thread_status','Read complete authorized workflow state and metrics.',schema({thread_id:str},['thread_id'])],
  ['control_workflow','Diego: close, cancel, resolve an objection or request a reserved Claudio decision.',schema({thread_id:str,operation:{enum:['CLOSE','CANCEL','RESOLVE_OBJECTION','CLAUDIO_DECISION_REQUIRED']},reason:str,payload:obj},['thread_id','operation'])],
  ['canon_identify','Identify current canon objects only through a verified Control.',schema({})],
  ['canon_search','Literal search with verification metadata; fail closed on unverified canon.',schema({object:{enum:['MAESTRO','ESTADO']},query:str,limit:{type:'integer',minimum:1,maximum:100}},['object','query'])],
  ['canon_read','Read line ranges or an unambiguous section with verification metadata.',schema({object:{enum:['MAESTRO','ESTADO']},start_line:{type:'integer',minimum:1},end_line:{type:'integer',minimum:1},section:str},['object'])]
].map(([name,description,inputSchema])=>({name,description,inputSchema}));
export class OrchestrationApi{
  constructor(transport,canon,{pool,workerKeys={},clock=()=>Date.now()}={}){this.transport=transport;this.canon=canon;this.pool=pool;this.keys=workerKeys;this.clock=clock;}
  async call(principal,name,args){
    if(!ACTORS.includes(principal?.actor_id))throw new Error('AUTH_REJECTED');
    if(name.startsWith('canon_'))return this.canon.call(principal,name,args);
    if(name==='start_workflow')return this.transport.public(await this.transport.start(principal,args));
    if(name==='send_to_actor')return this.transport.send(principal,args);
    if(name==='read_inbox')return this.transport.inbox(principal,args);
    if(['read_thread','get_thread_status'].includes(name)){strict(args,['thread_id']);return this.transport.read(principal,args.thread_id);}
    if(name==='reply_to_message')return this.transport.reply(principal,args);
    if(name==='control_workflow')return this.transport.control(principal,args);
    throw new Error('METHOD_NOT_FOUND');
  }
  async authenticateWorker(request){const raw=request.headers.authorization??'';if(!raw.startsWith('Bearer '))return null;const hash=sha(raw.slice(7));let key=this.keys[hash];if(!key&&this.pool){const row=(await this.pool.query('SELECT actor_id,capabilities,expires_at FROM actor_transport_keys WHERE key_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[hash])).rows[0];if(row)key={actor_id:row.actor_id,expires_at:new Date(row.expires_at).toISOString(),canary_only:row.capabilities.includes('canary')};}if(!key||!ACTORS.includes(key.actor_id)||!Number.isFinite(Date.parse(key.expires_at))||Date.parse(key.expires_at)<=this.clock())return null;return{actor_id:key.actor_id,worker:true,canary_only:key.canary_only===true};}
  async worker(principal,operation,args){
    if(principal.canary_only){if(!['start_workflow','read_thread','get_thread_status','control_workflow'].includes(operation)||!args.thread_id?.startsWith('THREAD:CANARY:ORCHESTRATION:'))throw new Error('ROLE_FORBIDDEN');if(operation==='start_workflow'&&(args.payload?.operation!=='CANON_CLOSURE_REVIEW'||args.payload?.external_effects!==0))throw new Error('ROLE_FORBIDDEN');return this.call(principal,operation,args);}
    if(principal.actor_id==='ACTOR:DIEGO')throw new Error('ROLE_FORBIDDEN');
    if(operation==='claim'){strict(args,[]);return this.transport.claim(principal);}
    if(operation==='complete')return this.transport.reply(principal,args,{leaseRequired:true});
    if(operation==='heartbeat'){strict(args,['runtime','version','status']);if(!['READY','BLOCKED'].includes(args.status)||typeof args.runtime!=='string'||args.runtime.length>100||typeof args.version!=='string'||args.version.length>100)throw new Error('INVALID_SCHEMA');await this.pool.query('INSERT INTO actor_runtime_heartbeats(actor_id,body) VALUES($1,$2::jsonb) ON CONFLICT(actor_id) DO UPDATE SET body=EXCLUDED.body,updated_at=now()',[principal.actor_id,JSON.stringify(args)]);return{accepted:true};}
    if(['canon_identify','canon_search','canon_read','read_thread'].includes(operation))return this.call(principal,operation,args);
    throw new Error('ROLE_FORBIDDEN');
  }
}
