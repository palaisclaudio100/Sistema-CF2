import crypto from 'node:crypto';
import {CUTOVER_PRINCIPAL} from './github-oidc.mjs';
import {canaryIsolationValid,TERMINAL_TASK_STATES,validateWriterToolArgs} from './writer-contract.mjs';

export const MINIMUM_SCOPE=Object.freeze(['TASK','VERIFICATION']);
export const CUTOVER_AUTHORITY_REF='AUTHORITY:CLAUDIO_PALAIS:CF2_MINIMUM_CUTOVER:TASK_VERIFICATION';
const allowed=new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_VERIFICATION']);
const operationalRoles=Object.freeze({
  'ACTOR:DIEGO':Object.freeze(['DGA','PRODUCTOR_MUSICAL']),
  'ACTOR:GABY_CHAT':Object.freeze(['GABY_CHAT']),
  'ACTOR:GABY_CW':Object.freeze(['GABY_CW_AUDIOVISUAL','GABY_CW_DOCUMENTAL']),
  'ACTOR:CODEX':Object.freeze(['CODEX']),
  'ACTOR:CLAUDE_CODE':Object.freeze(['CLAUDE_CODE'])
});

export class ProductionRoleInterface{
  constructor(store,{productionEnabled=false,roleEnabled=false}={}){this.store=store;this.productionEnabled=productionEnabled;this.roleEnabled=roleEnabled;}
  async submit({principal,authority_ref,scope,command}){
    if(principal?.actor_id!==CUTOVER_PRINCIPAL.actor_id||principal?.actor_role!==CUTOVER_PRINCIPAL.actor_role)return{accepted:false,reason_code:'AUTH_REJECTED'};
    if(authority_ref!==CUTOVER_AUTHORITY_REF||JSON.stringify(scope)!==JSON.stringify(MINIMUM_SCOPE))return{accepted:false,reason_code:'AUTHORITY_REQUIRED'};
    if(command?.actor_id||command?.actor_role)return{accepted:false,reason_code:'ACTOR_MISMATCH'};
    if(!allowed.has(command?.command_type))return{accepted:false,reason_code:'ROLE_FORBIDDEN'};
    if(!this.productionEnabled||!this.roleEnabled)return{accepted:false,reason_code:'CUTOVER_DISABLED'};
    const domain=command.command_type==='RECORD_VERIFICATION'?'VERIFICATION':'TASK';
    if(await this.store.writer(domain)!=='CF2_WRITER')return{accepted:false,reason_code:'WRITER_NOT_AUTHORIZED'};
    return this.store.submitCommand({...command,actor_id:principal.actor_id,actor_role:principal.actor_role,issued_at:new Date().toISOString(),authority_ref});
  }
  async status(command_id){return this.store.commandStatus(command_id);}
  async readTask(task_id){return this.store.getObject(task_id);}
  async submitRoleCommand({principal,acting_role,command}){
    if(!principal?.actor_id||!operationalRoles[principal.actor_id]?.includes(acting_role)||!principal.allowed_roles?.includes(acting_role))return{accepted:false,reason_code:'ROLE_FORBIDDEN'};
    if(!command||command.actor_id||command.actor_role||command.acting_role||command.payload?.object?.actor_id||command.payload?.object?.actor_role)return{accepted:false,reason_code:'ACTOR_MISMATCH'};
    if(!allowed.has(command.command_type))return{accepted:false,reason_code:'ROLE_FORBIDDEN'};
    if(['CODEX','CLAUDE_CODE'].includes(acting_role)&&command.command_type==='RECORD_VERIFICATION')return{accepted:false,reason_code:'ROLE_FORBIDDEN'};
    const tool=command.command_type==='RECORD_VERIFICATION'?'submit_verification':'submit_task_command';
    if(!validateWriterToolArgs(tool,{acting_role,command},principal.allowed_roles))return{accepted:false,reason_code:'INVALID_SCHEMA'};
    if(!canaryIsolationValid(command))return{accepted:false,reason_code:'CANARY_NAMESPACE_VIOLATION'};
    const object=command.payload?.object;
    const secured={...command,actor_id:principal.actor_id,actor_role:acting_role,issued_at:new Date().toISOString(),payload:{...command.payload,...(object?{object:{...object,...(command.command_type==='RECORD_VERIFICATION'?{verified_by:principal.actor_id}:{})}}:{})}};
    if(command.command_type==='CREATE_TASK'){
      const diegoAssignsClaudeCode=principal.actor_id==='ACTOR:DIEGO'&&acting_role==='DGA'&&object.responsible_role==='CLAUDE_CODE';
      if(object.responsible_role!==acting_role&&!diegoAssignsClaudeCode)return{accepted:false,reason_code:'ROLE_FORBIDDEN'};
    }
    const replay=await this.store.replayCommand?.(secured);if(replay)return{...replay,command_id:secured.command_id,actor_id:principal.actor_id,acting_role};
    if(command.command_type==='CREATE_TASK'){
      if(await this.store.getObject(object.id))return{accepted:false,reason_code:'OBJECT_ALREADY_EXISTS'};
      if(object.state==='DONE'&&!(await this.store.hasProof(object.closure_ref)))return{accepted:false,reason_code:'MISSING_CLOSURE_PROOF'};
    }
    if(command.command_type==='TRANSITION_TASK'){
      const task=await this.store.getObject(command.payload.task_id);
      if(!task||task.type!=='TASK')return{accepted:false,reason_code:'UNKNOWN_SUBJECT'};
      if(task.responsible_role!==acting_role)return{accepted:false,reason_code:'ROLE_FORBIDDEN'};
      if(TERMINAL_TASK_STATES.includes(task.state)&&task.state!==command.payload.state)return{accepted:false,reason_code:'INVALID_STATE_TRANSITION'};
      if(command.payload.state==='DONE'&&!(await this.store.hasProof(command.payload.closure_ref)))return{accepted:false,reason_code:'MISSING_CLOSURE_PROOF'};
    }
    if(command.command_type==='RECORD_VERIFICATION'){
      if(await this.store.getObject(object.id))return{accepted:false,reason_code:'OBJECT_ALREADY_EXISTS'};
      if(!(await this.store.hasProof(object.evidence_ref)))return{accepted:false,reason_code:'PROOF_NOT_FOUND'};
      const subject=await this.store.getObject(object.subject_id);
      if(!subject)return{accepted:false,reason_code:'UNKNOWN_SUBJECT'};
      if(subject.type==='TASK'&&subject.responsible_role!==acting_role)return{accepted:false,reason_code:'ROLE_FORBIDDEN'};
      if(principal.actor_id!=='ACTOR:DIEGO'&&subject.type!=='TASK')return{accepted:false,reason_code:'ROLE_FORBIDDEN'};
    }
    for(const domain of [command.command_type==='RECORD_VERIFICATION'?'VERIFICATION':'TASK'])if(await this.store.writer(domain)!=='CF2_WRITER')return{accepted:false,reason_code:'WRITER_NOT_AUTHORIZED'};
    const result=await this.store.submitCommand(secured);return{...result,replay:false,command_id:secured.command_id,actor_id:principal.actor_id,acting_role};
  }
}
