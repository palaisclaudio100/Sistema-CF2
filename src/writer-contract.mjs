import crypto from 'node:crypto';

export const ACTING_ROLES=Object.freeze(['DGA','PRODUCTOR_MUSICAL']);
export const TASK_STATES=Object.freeze(['OPEN','READY','IN_PROGRESS','BLOCKED','DONE','CANCELLED']);
export const TERMINAL_TASK_STATES=Object.freeze(['DONE','CANCELLED']);
export const VERIFICATION_CLASSES=Object.freeze(['FIJO','VOLÁTIL','CONDICIONAL']);

const commandBase={
  command_id:{type:'string',minLength:1,maxLength:200},
  idempotency_key:{type:'string',minLength:1,maxLength:200},
  expected_state_version:{type:'integer',minimum:0},
  authority_ref:{type:'string',minLength:1},
  evidence_ref:{type:'string',minLength:1},
  correlation_id:{type:'string',minLength:1},
  subject_id:{type:'string',minLength:1}
};
const commandOptional=['expected_state_version','authority_ref','evidence_ref','correlation_id','subject_id'];
const commonObject={
  id:{type:'string',pattern:'^[A-Z][A-Z0-9_:-]+$'},
  type:{type:'string'},
  status:{type:'string',minLength:1},
  created_at:{type:'string',format:'date-time'},
  updated_at:{type:'string',format:'date-time'},
  basis_ref:{type:'array',items:{type:'string',minLength:1},minItems:1},
  superseded_by:{type:'string',minLength:1}
};
const taskObject={type:'object',additionalProperties:false,required:['id','type','status','created_at','updated_at','basis_ref','action','state','responsible_role','related_ids'],properties:{...commonObject,type:{const:'TASK'},action:{type:'string',minLength:1},state:{enum:TASK_STATES},responsible_role:{type:'string',minLength:1},related_ids:{type:'array',items:{type:'string'}},due_at:{type:'string',format:'date-time'},closure_ref:{type:'string',minLength:1},requires_local_capability:{type:'boolean'},block_reason:{type:'string'},non_productive:{type:'boolean'}}};
const verificationObject={type:'object',additionalProperties:false,required:['id','type','status','created_at','updated_at','basis_ref','subject_id','attribute','value','class','verified_at','evidence_ref'],properties:{...commonObject,type:{const:'VERIFICATION'},subject_id:{type:'string',minLength:1},attribute:{type:'string',minLength:1},value:{},class:{enum:VERIFICATION_CLASSES},verified_at:{type:'string',format:'date-time'},verified_by:{type:'string',description:'Accepted for compatibility and overwritten with the authenticated actor_id.'},evidence_ref:{type:'string',minLength:1},valid_until:{type:'string',format:'date-time'},invalidation_rule:{type:'string',minLength:1}}};
const commandSchema=(command_type,payload)=>({type:'object',additionalProperties:false,required:['command_id','command_type','idempotency_key','payload'],properties:{...commandBase,command_type:{const:command_type},payload}});
const createTaskCommand=commandSchema('CREATE_TASK',{type:'object',additionalProperties:false,required:['object'],properties:{object:taskObject}});
const transitionTaskCommand=commandSchema('TRANSITION_TASK',{type:'object',additionalProperties:false,required:['task_id','state'],properties:{task_id:{type:'string',minLength:1},state:{enum:TASK_STATES},closure_ref:{type:'string',minLength:1}}});
const verificationCommand=commandSchema('RECORD_VERIFICATION',{type:'object',additionalProperties:false,required:['object'],properties:{object:verificationObject}});
const toolSchema=command=>({type:'object',additionalProperties:false,required:['acting_role','command'],properties:{acting_role:{enum:ACTING_ROLES},command}});

export const SUBMIT_TASK_COMMAND_SCHEMA=Object.freeze(toolSchema({oneOf:[createTaskCommand,transitionTaskCommand]}));
export const SUBMIT_VERIFICATION_SCHEMA=Object.freeze(toolSchema(verificationCommand));

const allowedCommandKeys=new Set(['command_id','command_type','idempotency_key','payload',...commandOptional]);
const taskKeys=new Set(['id','type','status','created_at','updated_at','basis_ref','superseded_by','action','state','responsible_role','related_ids','due_at','closure_ref','requires_local_capability','block_reason','non_productive']);
const verificationKeys=new Set(['id','type','status','created_at','updated_at','basis_ref','superseded_by','subject_id','attribute','value','class','verified_at','verified_by','evidence_ref','valid_until','invalidation_rule']);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value,allowed)=>isObject(value)&&Object.keys(value).every(key=>allowed.has(key));
const string=value=>typeof value==='string'&&value.length>0;
const timestamp=value=>string(value)&&!Number.isNaN(Date.parse(value));
const commonValid=object=>isObject(object)&&string(object.id)&&string(object.status)&&timestamp(object.created_at)&&timestamp(object.updated_at)&&Array.isArray(object.basis_ref)&&object.basis_ref.length>0&&object.basis_ref.every(string);

function commandBaseValid(command){
  return isObject(command)&&exactKeys(command,allowedCommandKeys)&&string(command.command_id)&&string(command.idempotency_key)&&(!('expected_state_version' in command)||(Number.isInteger(command.expected_state_version)&&command.expected_state_version>=0))&&commandOptional.filter(key=>key!=='expected_state_version').every(key=>!(key in command)||string(command[key]));
}

export function validateWriterToolArgs(tool,args,allowedRoles=ACTING_ROLES){
  if(!isObject(args)||!exactKeys(args,new Set(['acting_role','command']))||!allowedRoles.includes(args.acting_role)||!commandBaseValid(args.command))return false;
  const command=args.command;
  if(tool==='submit_task_command'&&command.command_type==='CREATE_TASK'){
    const payload=command.payload,object=payload?.object;
    return exactKeys(payload,new Set(['object']))&&exactKeys(object,taskKeys)&&commonValid(object)&&object.type==='TASK'&&string(object.action)&&TASK_STATES.includes(object.state)&&string(object.responsible_role)&&Array.isArray(object.related_ids)&&object.related_ids.every(item=>typeof item==='string')&&(!('due_at' in object)||timestamp(object.due_at))&&(!(object.state==='DONE')||string(object.closure_ref));
  }
  if(tool==='submit_task_command'&&command.command_type==='TRANSITION_TASK'){
    const payload=command.payload;
    return exactKeys(payload,new Set(['task_id','state','closure_ref']))&&string(payload.task_id)&&TASK_STATES.includes(payload.state)&&(!('closure_ref' in payload)||string(payload.closure_ref))&&(payload.state!=='DONE'||string(payload.closure_ref));
  }
  if(tool==='submit_verification'&&command.command_type==='RECORD_VERIFICATION'){
    const payload=command.payload,object=payload?.object;
    if(!exactKeys(payload,new Set(['object']))||!exactKeys(object,verificationKeys)||!commonValid(object)||object.type!=='VERIFICATION'||!string(object.subject_id)||!string(object.attribute)||!('value' in object)||!VERIFICATION_CLASSES.includes(object.class)||!timestamp(object.verified_at)||('verified_by' in object&&!string(object.verified_by))||!string(object.evidence_ref))return false;
    if(object.class==='VOLÁTIL'&&!timestamp(object.valid_until))return false;
    if(object.class==='CONDICIONAL'&&(!string(object.invalidation_rule)||!object.invalidation_rule.trim()))return false;
    return !('valid_until' in object)||timestamp(object.valid_until);
  }
  return false;
}

export const isCanaryId=value=>typeof value==='string'&&value.split(':').includes('CANARY');

export function canaryIsolationValid(command){
  const commandCanary=isCanaryId(command?.command_id),type=command?.command_type,payload=command?.payload??{};
  const targets=type==='CREATE_TASK'?[payload.object?.id]:type==='TRANSITION_TASK'?[payload.task_id]:type==='RECORD_VERIFICATION'?[payload.object?.id,payload.object?.subject_id]:[];
  return targets.filter(Boolean).every(id=>isCanaryId(id)===commandCanary);
}

const canonical=value=>Array.isArray(value)?value.map(canonical):isObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function commandFingerprint(command){
  const relevant=Object.fromEntries(Object.entries(command).filter(([key])=>!['actor_id','actor_role','issued_at'].includes(key)));
  return crypto.createHash('sha256').update(JSON.stringify(canonical(relevant))).digest('hex');
}

export function storedIdempotencyResponse(response,fingerprint){return{...response,_request_fingerprint:fingerprint};}
export function replayIdempotencyResponse(stored,fingerprint){
  if(!stored||stored._request_fingerprint!==fingerprint)return{accepted:false,reason_code:'IDEMPOTENCY_CONFLICT'};
  const {_request_fingerprint,...response}=stored;return{...response,replay:true};
}
