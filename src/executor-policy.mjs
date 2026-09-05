import {sha,strict} from './actor-transport.mjs';

export const EXECUTOR_ACTIONS=Object.freeze({
  'ACTOR:GABY_CHAT':['ANALYZE_DRAFT_VALIDATE'],
  'ACTOR:GABY_CW':['WRITE_VALIDATED','AUDIOVISUAL_RUN'],
  'ACTOR:CODEX':['TECHNICAL_RUN'],
  'ACTOR:CLAUDE_CODE':['AUXILIARY_REVIEW']
});
export const documentDigest=d=>sha(d.mode==='PATCH'?JSON.stringify(d.edits.map(({before,after})=>({before,after}))):d.content);
export function validDocument(d){return d?.validated===true&&(d.mode==='PATCH'?Array.isArray(d.edits)&&d.edits.length>0&&d.edits.length<=20&&d.edits.every(e=>typeof e.before==='string'&&e.before.length>=10&&typeof e.after==='string')&&JSON.stringify(d.edits).length<=18000:typeof d.content==='string'&&d.content.trim().length>0&&d.content.length<=18000)&&d.sha256===documentDigest(d);}
const deny=()=>{throw new Error('EXECUTOR_SCOPE_DENIED');};
const identifier=s=>typeof s==='string'&&s.length>0&&s.length<=200;
export function validateOrdinaryDispatch(principal,payload,stages){
  if(payload?.operation!=='ORDINARY_WORK')return;
  if(principal.actor_id!=='ACTOR:DIEGO')deny();
  strict(payload,['operation','brief','steps','source_reference','previous_response','previous_result','resolution']);
  if(typeof payload.brief!=='string'||!payload.brief.trim()||payload.brief.length>8000||!payload.steps||!identifier(payload.source_reference))deny();
  if(Object.keys(payload.steps).some(a=>!EXECUTOR_ACTIONS[a]))deny();
  for(const actor of stages){const step=payload.steps[actor];if(!step||!EXECUTOR_ACTIONS[actor]?.includes(step.action))deny();
    strict(step,['action','object_id','expected_sha256','input_objects','command_ids','instructions']);
    if(step.instructions!=null&&(typeof step.instructions!=='string'||step.instructions.length>4000))deny();
    for(const key of ['input_objects','command_ids'])if(step[key]!=null&&(!Array.isArray(step[key])||step[key].length>8||step[key].some(x=>!identifier(x))))deny();
    if(step.object_id!=null&&!identifier(step.object_id))deny();
    if(step.action==='WRITE_VALIDATED'&&(!identifier(step.object_id)||!(step.expected_sha256===null||/^[a-f0-9]{64}$/.test(step.expected_sha256))))deny();
  }
}
export function executionContext(principal,thread,args,now=Date.now()){
  strict(args,['thread_id','message_id','lease_token']);
  const request=thread.messages.find(m=>m.message_id===args.message_id);
  if(thread.state!=='OPEN'||!request||request.recipient!==principal.actor_id||request.sender!=='ACTOR:DIEGO'||request.state!=='RUNNING'||request.lease_token!==args.lease_token||request.lease_until<=now)deny();
  validateOrdinaryDispatch({actor_id:request.sender},request.payload,[principal.actor_id]);
  if(request.payload.operation!=='ORDINARY_WORK')deny();
  const step=request.payload.steps[principal.actor_id];let validated_document=null;
  if(step.action==='WRITE_VALIDATED'){
    const previous=thread.messages.find(m=>m.message_id===request.payload.previous_response);
    const doc=previous?.payload?.document;
    if(previous?.sender!=='ACTOR:GABY_CHAT'||previous.type!=='RESPONSE'||previous.payload.result!=='PASS'||!validDocument(doc)||doc.object_id!==step.object_id)deny();
    validated_document={...doc,validated_by:previous.sender,validation_message_id:previous.message_id};
  }
  return{thread_id:thread.thread_id,message_id:request.message_id,actor_id:principal.actor_id,ordered_by:request.sender,step,validated_document,source_reference:request.payload.source_reference};
}
export function validateOrdinaryCompletion(principal,thread,args){
  const request=thread.messages.find(m=>m.message_id===args.message_id);
  if(request?.payload?.operation!=='ORDINARY_WORK'||args.type==='OBJECTION')return;
  const step=request.payload.steps[principal.actor_id],result=args.payload;
  if(result?.result!=='PASS'||!Array.isArray(result.canon)||result.canon.length<2)deny();
  if(step.action==='ANALYZE_DRAFT_VALIDATE'&&step.object_id){const d=result.document;if(!validDocument(d)||d.object_id!==step.object_id)deny();}
  if(step.action==='WRITE_VALIDATED'){
    const prev=thread.messages.find(m=>m.message_id===request.payload.previous_response),d=prev?.payload?.document,e=result.material;
    if(args.type!=='EVIDENCE'||prev?.sender!=='ACTOR:GABY_CHAT'||!d?.validated||!e||e.object_id!==step.object_id||e.actor_id!==principal.actor_id||e.before_sha256!==step.expected_sha256||e.validation_sha256!==d.sha256||e.after_sha256!==e.readback_sha256||!/^[a-f0-9]{64}$/.test(e.after_sha256)||e.validation_message_id!==prev.message_id)deny();
  }
  if(step.action==='TECHNICAL_RUN'&&(!Array.isArray(result.technical)||result.technical.length===0))deny();
  if(principal.actor_id==='ACTOR:CLAUDE_CODE'&&args.type==='EVIDENCE')deny();
}
