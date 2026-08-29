import crypto from 'node:crypto';

const now=()=>new Date().toISOString();
const READS=new Set(['READ_SNAPSHOT','READ_CURRENT','READ_ENTITY_CARD','READ_SURFACE_VIEW','READ_TASK_VIEW','READ_HISTORY','READ_WORKER_HEALTH']);
const COMMANDS=new Set(['UPSERT_ENTITY','REGISTER_SURFACE','CREATE_TASK','TRANSITION_TASK','SET_RELATION','RECORD_DECISION','RECORD_VERIFICATION','INVALIDATE_VERIFICATION','EXPIRE_VERIFICATION']);
const DEFAULT_IDENTITIES={
  'ACTOR:CLAUDIO':'CLAUDIO','ACTOR:DIEGO':'DGA','ACTOR:GABY_CHAT':'GABY_CHAT','ACTOR:GABY_CW':'GABY_CW','ACTOR:PRODUCTOR_MUSICAL':'PRODUCTOR_MUSICAL','ACTOR:LOCAL_WORKER':'LOCAL_WORKER','ACTOR:CODEX_ENGINEER':'CODEX_ENGINEER'
};
const ALL_READS=new Set(READS);
const POLICIES={
  CLAUDIO:{reads:ALL_READS,commands:new Set(COMMANDS)},
  DGA:{reads:ALL_READS,commands:new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_DECISION','RECORD_VERIFICATION'])},
  GABY_CHAT:{reads:new Set(['READ_ENTITY_CARD','READ_SURFACE_VIEW','READ_CURRENT','READ_TASK_VIEW','READ_HISTORY']),commands:new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_VERIFICATION'])},
  GABY_CW:{reads:new Set(['READ_ENTITY_CARD','READ_SURFACE_VIEW','READ_CURRENT','READ_TASK_VIEW','READ_HISTORY']),commands:new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_VERIFICATION'])},
  PRODUCTOR_MUSICAL:{reads:new Set(['READ_ENTITY_CARD','READ_SURFACE_VIEW','READ_CURRENT','READ_TASK_VIEW','READ_HISTORY']),commands:new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_VERIFICATION'])},
  LOCAL_WORKER:{reads:new Set(['READ_WORKER_HEALTH']),commands:new Set(['INVALIDATE_VERIFICATION','EXPIRE_VERIFICATION'])},
  CODEX_ENGINEER:{reads:new Set(['READ_WORKER_HEALTH']),commands:new Set()}
};

export class RoleClient {
  constructor(endpoint,{actor_id,role}={}) { this.endpoint=endpoint; this.actor_id=actor_id; this.role=role; }
  request(operation,data={}) { return this.endpoint.request({request_id:`REQUEST:${crypto.randomUUID()}`,actor_id:this.actor_id,role:this.role,timestamp:now(),operation,...data}); }
}

/** DEV service boundary. Consumers receive RoleClient, never a CoreStore or SQLite path. */
export class RoleInterface {
  #store; #identities;
  constructor(store,{identities=DEFAULT_IDENTITIES}={}) { this.#store=store; this.#identities={...identities}; }
  client(identity) { const role=this.#identities[identity]; if(!role) throw new Error('Unknown DEV identity'); return new RoleClient(this,{actor_id:identity,role}); }
  #reply(request,{ok,reason_code='ACCEPTED',data=null,state_version=null}={}) { return {ok,request_id:request.request_id,actor_id:request.actor_id,role:request.role,operation:request.operation,reason_code,state_version,data}; }
  #audit(request,authorized,reason_code,detail={}) { this.#store.recordAccessAttempt({request_id:request.request_id,timestamp:request.timestamp ?? now(),actor_id:request.actor_id ?? 'UNKNOWN',role:request.role ?? 'UNKNOWN',operation:request.operation ?? 'UNKNOWN',authorized,reason_code,detail}); }
  #deny(request,reason_code='FORBIDDEN_ROLE',detail={}) { this.#audit(request,false,reason_code,detail); return this.#reply(request,{ok:false,reason_code,data:detail,state_version:this.#store.stateVersion()}); }
  #authorized(request) { return this.#identities[request.actor_id]===request.role && Boolean(POLICIES[request.role]); }
  #commandAllowed(request,command) {
    const policy=POLICIES[request.role]; if(!policy.commands.has(command.command_type)) return false;
    if(command.actor_id!==request.actor_id || command.actor_role!==request.role) return false;
    if(command.command_type==='RECORD_DECISION') { if(request.role==='DGA') return command.payload.object.authority==='DGA_DELEGATED'; return request.role==='CLAUDIO'; }
    if(['CREATE_TASK','TRANSITION_TASK'].includes(command.command_type) && ['GABY_CHAT','GABY_CW','PRODUCTOR_MUSICAL'].includes(request.role)) { const task=command.command_type==='CREATE_TASK' ? command.payload.object : this.#store.getObject(command.payload.task_id); return task?.responsible_role===request.role; }
    return true;
  }
  request(request) {
    if(!request?.request_id || !request.operation || !request.actor_id || !request.role) return this.#deny(request ?? {},'FORBIDDEN_ROLE',{error:'identity_or_request_missing'});
    if(!this.#authorized(request)) return this.#deny(request,'FORBIDDEN_ROLE',{error:'identity_role_mismatch'});
    const policy=POLICIES[request.role];
    if(READS.has(request.operation)) {
      if(!policy.reads.has(request.operation)) return this.#deny(request);
      let data; try {
        if(request.operation==='READ_SNAPSHOT') data=this.#store.getSnapshot();
        else if(request.operation==='READ_CURRENT') data=this.#store.getCurrent(request.subject_id,request.property_key,request.at);
        else if(request.operation==='READ_ENTITY_CARD') data=this.#store.getEntityCard(request.entity_id);
        else if(request.operation==='READ_SURFACE_VIEW') data=this.#store.getSurfaceView(request.surface_id);
        else if(request.operation==='READ_TASK_VIEW') data=this.#store.getTaskView();
        else if(request.operation==='READ_HISTORY') data=this.#store.getHistory(request.subject_id,request.property_key);
        else data=this.#store.workerHealth(request.at);
      } catch(error) { return this.#reply(request,{ok:false,reason_code:error.reason_code ?? 'FAIL_CLOSED',state_version:this.#store.stateVersion()}); }
      if(['READ_SNAPSHOT','READ_HISTORY'].includes(request.operation)) this.#audit(request,true,'ACCEPTED',{read:true});
      return this.#reply(request,{ok:true,data,state_version:this.#store.stateVersion()});
    }
    if(request.operation==='REQUEST_LOCAL_A') return this.#reply(request,{ok:false,reason_code:'BLOCKED_LOCAL',data:{local_required:true},state_version:this.#store.stateVersion()});
    if(request.operation==='COMMAND_SUBMIT') {
      const command=request.command; if(!command || !this.#commandAllowed(request,command)) return this.#deny(request,'FORBIDDEN_ROLE',{command_type:command?.command_type});
      const result=this.#store.submitCommand(command); this.#audit(request,result.accepted,result.reason_code,{command_id:command.command_id,command_type:command.command_type});
      return this.#reply(request,{ok:result.accepted,reason_code:result.reason_code,data:result,state_version:result.resulting_state_version ?? this.#store.stateVersion()});
    }
    return this.#deny(request,'FORBIDDEN_ROLE',{error:'unsupported_operation'});
  }
}

export { DEFAULT_IDENTITIES, POLICIES };
