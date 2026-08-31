import crypto from 'node:crypto';

const now=()=>new Date().toISOString();
const READS=new Set(['HEALTH','READ_SNAPSHOT','RESOLVE_ENTITY','RESOLVE_SURFACE','READ_CURRENT','READ_ENTITY_BUNDLE','READ_TASK','READ_TASK_VIEW','READ_COMMAND_STATUS','READ_HISTORY','READ_EVIDENCE','READ_WORKER_HEALTH']);
const COMMANDS=new Set(['UPSERT_ENTITY','REGISTER_SURFACE','CREATE_TASK','TRANSITION_TASK','SET_RELATION','RECORD_DECISION','RECORD_VERIFICATION','INVALIDATE_VERIFICATION','EXPIRE_VERIFICATION']);
const REQUIRED_COMMAND_FIELDS=['command_id','command_type','actor_id','actor_role','issued_at','idempotency_key','payload'];

export const DEV_CREDENTIALS=Object.freeze({
  'dev-credential-claudio':{actor_id:'ACTOR:CLAUDIO',actor_role:'CLAUDIO'},
  'dev-credential-dga':{actor_id:'ACTOR:DIEGO',actor_role:'DGA'},
  'dev-credential-gaby-chat':{actor_id:'ACTOR:GABY_CHAT',actor_role:'GABY_CHAT'},
  'dev-credential-gaby-cw':{actor_id:'ACTOR:GABY_CW',actor_role:'GABY_CW'},
  'dev-credential-productor':{actor_id:'ACTOR:PRODUCTOR_MUSICAL',actor_role:'PRODUCTOR_MUSICAL'},
  'dev-credential-local-worker':{actor_id:'ACTOR:LOCAL_WORKER',actor_role:'LOCAL_WORKER'}
});

const ALL_READS=new Set(READS);
export const POLICIES=Object.freeze({
  CLAUDIO:{reads:ALL_READS,commands:new Set(COMMANDS)},
  DGA:{reads:ALL_READS,commands:new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_DECISION','RECORD_VERIFICATION'])},
  GABY_CHAT:{reads:new Set(['HEALTH','READ_SNAPSHOT','RESOLVE_ENTITY','RESOLVE_SURFACE','READ_CURRENT','READ_ENTITY_BUNDLE','READ_TASK','READ_TASK_VIEW','READ_COMMAND_STATUS','READ_HISTORY','READ_EVIDENCE']),commands:new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_DECISION','RECORD_VERIFICATION'])},
  GABY_CW:{reads:new Set(['HEALTH','READ_SNAPSHOT','RESOLVE_ENTITY','RESOLVE_SURFACE','READ_CURRENT','READ_ENTITY_BUNDLE','READ_TASK','READ_TASK_VIEW','READ_COMMAND_STATUS','READ_HISTORY','READ_EVIDENCE']),commands:new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_VERIFICATION'])},
  PRODUCTOR_MUSICAL:{reads:new Set(['HEALTH','READ_SNAPSHOT','RESOLVE_ENTITY','RESOLVE_SURFACE','READ_CURRENT','READ_ENTITY_BUNDLE','READ_TASK','READ_TASK_VIEW','READ_COMMAND_STATUS','READ_HISTORY','READ_EVIDENCE']),commands:new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_DECISION','RECORD_VERIFICATION'])},
  LOCAL_WORKER:{reads:new Set(['HEALTH','READ_WORKER_HEALTH','READ_COMMAND_STATUS']),commands:new Set(['INVALIDATE_VERIFICATION','EXPIRE_VERIFICATION'])}
});

export class CredentialAuthenticator {
  #credentials;
  constructor(credentials=DEV_CREDENTIALS){this.#credentials=new Map(Object.entries(credentials).map(([credential,principal])=>[credential,Object.freeze({...principal})]));}
  authenticate(credential){return typeof credential==='string'?this.#credentials.get(credential)??null:null;}
}

export class RoleClient {
  #endpoint; #credential;
  constructor(endpoint,{credential}={}){this.#endpoint=endpoint;this.#credential=credential;}
  request(operation,data={}){return this.#endpoint.request({request_id:`REQUEST:${crypto.randomUUID()}`,timestamp:now(),operation,...data},{credential:this.#credential});}
  submitCommand(command){return this.request('COMMAND_SUBMIT',{command});}
}

/** DEV boundary: credentials resolve server-side; clients never receive CoreStore or its path. */
export class RoleInterface {
  #store; #authenticator; #localAvailable; #version;
  constructor(store,{authenticator=new CredentialAuthenticator(),localAvailable=true,version='stage5-dev'}={}){this.#store=store;this.#authenticator=authenticator;this.#localAvailable=localAvailable;this.#version=version;}
  client(credential){return new RoleClient(this,{credential});}
  #reply(request,principal,{ok,reason_code=ok?'ACCEPTED':'FAIL_CLOSED',data=null,state_version=this.#store.stateVersion()}={}){return {ok,request_id:request.request_id??null,actor_id:principal?.actor_id??null,actor_role:principal?.actor_role??null,operation:request.operation??null,reason_code,state_version,correlation_id:request.command?.correlation_id??request.correlation_id??null,data};}
  #audit(request,principal,authorized,reason_code,detail={}){this.#store.recordAccessAttempt({request_id:request.request_id??`REQUEST:${crypto.randomUUID()}`,timestamp:request.timestamp??now(),actor_id:principal?.actor_id??'UNAUTHENTICATED',role:principal?.actor_role??'UNAUTHENTICATED',operation:request.operation??'UNKNOWN',authorized,reason_code,detail:{...detail,correlation_id:request.command?.correlation_id??request.correlation_id??null}});}
  #deny(request,principal,reason_code,detail={}){this.#audit(request,principal,false,reason_code,detail);return this.#reply(request,principal,{ok:false,reason_code,data:detail});}
  #validateCommand(command,principal){
    if(!command||REQUIRED_COMMAND_FIELDS.some(field=>!(field in command))||!COMMANDS.has(command.command_type))return {ok:false,reason_code:'INVALID_SCHEMA'};
    if(command.actor_id!==principal.actor_id||command.actor_role!==principal.actor_role)return {ok:false,reason_code:'ACTOR_MISMATCH'};
    const policy=POLICIES[principal.actor_role];
    if(!policy?.commands.has(command.command_type))return {ok:false,reason_code:'ROLE_FORBIDDEN'};
    const object=command.payload?.object;
    if(command.command_type==='RECORD_DECISION'){
      if(principal.actor_role==='CLAUDIO')return object?.authority==='CLAUDIO_DIRECT'||object?.authority==='CLAUDIO_PERSISTED'?{ok:true}:{ok:false,reason_code:'AUTHORITY_REQUIRED'};
      const domains={DGA:'DGA_DELEGATED',GABY_CHAT:'MARKETING',PRODUCTOR_MUSICAL:'ARTISTIC_PRODUCTION'};
      const domain=domains[principal.actor_role];
      if(!domain||!command.authority_ref||command.payload?.authority_domain!==domain||object?.authority!=='DGA_DELEGATED')return {ok:false,reason_code:'AUTHORITY_REQUIRED'};
    }
    if(command.command_type==='RECORD_VERIFICATION'&&!object?.evidence_ref)return {ok:false,reason_code:'EVIDENCE_REQUIRED'};
    if(['CREATE_TASK','TRANSITION_TASK'].includes(command.command_type)&&['GABY_CHAT','GABY_CW','PRODUCTOR_MUSICAL'].includes(principal.actor_role)){
      const task=command.command_type==='CREATE_TASK'?object:this.#store.getObject(command.payload?.task_id);
      if(!task||task.responsible_role!==principal.actor_role)return {ok:false,reason_code:'ROLE_FORBIDDEN'};
    }
    return {ok:true};
  }
  #read(request){
    const op=request.operation;
    if(op==='HEALTH')return {service:'CF2_ROLE_INTERFACE',version:this.#version,status:'UP',state_version:this.#store.stateVersion()};
    if(op==='READ_SNAPSHOT')return this.#store.getSnapshot();
    if(op==='RESOLVE_ENTITY')return this.#store.resolveEntity(request.query);
    if(op==='RESOLVE_SURFACE')return this.#store.resolveSurface(request.query);
    if(op==='READ_CURRENT')return this.#store.getCurrent(request.subject_id,request.property_key,request.at);
    if(op==='READ_ENTITY_BUNDLE')return this.#store.getCurrentBundle(request.subject_id,{at:request.at});
    if(op==='READ_TASK'){const task=this.#store.getObject(request.task_id);return !task||task.type!=='TASK'?{status:'UNKNOWN'}:task;}
    if(op==='READ_TASK_VIEW')return this.#store.getTaskView();
    if(op==='READ_HISTORY')return this.#store.getHistory(request.subject_id,request.property_key);
    if(op==='READ_EVIDENCE'){const object=this.#store.getObject(request.subject_id);return object?{subject_id:object.id,basis_ref:object.basis_ref??[],evidence_ref:object.evidence_ref??null}:{status:'UNKNOWN'};}
    if(op==='READ_WORKER_HEALTH')return this.#store.workerHealth(request.at);
    if(op==='READ_COMMAND_STATUS'){const row=this.#store.getAccessAudit().filter(item=>item.detail?.command_id===request.command_id).at(-1);return row?{command_id:request.command_id,status:row.authorized?'ACCEPTED':'REJECTED',reason_code:row.reason_code,correlation_id:row.detail.correlation_id??null}:{command_id:request.command_id,status:'UNKNOWN'};}
    throw Object.assign(new Error('unsupported read'),{reason_code:'INVALID_SCHEMA'});
  }
  request(request,context={}){
    const principal=this.#authenticator.authenticate(context.credential);
    if(!principal)return this.#deny(request??{},null,'AUTHENTICATION_REQUIRED');
    if(request?.actor_id||request?.actor_role)return this.#deny(request,principal,'ACTOR_MISMATCH',{error:'client_identity_declaration_forbidden'});
    if(!request?.request_id||!request.operation)return this.#deny(request??{},principal,'INVALID_SCHEMA');
    const policy=POLICIES[principal.actor_role];
    if(READS.has(request.operation)){
      if(!policy?.reads.has(request.operation))return this.#deny(request,principal,'ROLE_FORBIDDEN');
      try{const data=this.#read(request);this.#audit(request,principal,true,'ACCEPTED',{read:true});return this.#reply(request,principal,{ok:true,data});}catch(error){return this.#deny(request,principal,error.reason_code??'FAIL_CLOSED');}
    }
    if(request.operation==='REQUEST_LOCAL_CAPABILITY'){const reason_code=this.#localAvailable?'ACCEPTED':'BLOCKED_LOCAL_CAPABILITY';this.#audit(request,principal,this.#localAvailable,reason_code,{local_available:this.#localAvailable});return this.#reply(request,principal,{ok:this.#localAvailable,reason_code,data:{local_available:this.#localAvailable}});}
    if(request.operation!=='COMMAND_SUBMIT')return this.#deny(request,principal,'INVALID_SCHEMA');
    const validation=this.#validateCommand(request.command,principal);
    if(!validation.ok)return this.#deny(request,principal,validation.reason_code,{command_id:request.command?.command_id,command_type:request.command?.command_type,authority_ref:request.command?.authority_ref??null,evidence_ref:request.command?.evidence_ref??request.command?.payload?.object?.evidence_ref??null});
    let result;try{result=this.#store.submitCommand(request.command);}catch(error){return this.#deny(request,principal,error.reason_code??'INVALID_SCHEMA',{command_id:request.command.command_id});}
    const accepted=Boolean(result.accepted);const reason_code=accepted?'ACCEPTED':(result.reason_code??'FAIL_CLOSED');
    this.#audit(request,principal,accepted,reason_code,{command_id:request.command.command_id,command_type:request.command.command_type,authority_ref:request.command.authority_ref??null,evidence_ref:request.command.evidence_ref??request.command.payload?.object?.evidence_ref??null});
    return this.#reply(request,principal,{ok:accepted,reason_code,data:{command_id:request.command.command_id,accepted,command_status:accepted?'ACCEPTED':'REJECTED',result,task_ref:request.command.payload?.object?.type==='TASK'?request.command.payload.object.id:request.command.payload?.task_id??null,event_ref:accepted?this.#store.getOutbox().at(-1)?.event_id??null:null,job_ref:null,closure_ref:request.command.payload?.closure_ref??null},state_version:result.resulting_state_version??this.#store.stateVersion()});
  }
}

export {READS,COMMANDS};
