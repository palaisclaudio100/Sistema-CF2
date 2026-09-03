import crypto from 'node:crypto';
import {CUTOVER_PRINCIPAL} from './github-oidc.mjs';

export const MINIMUM_SCOPE=Object.freeze(['TASK','VERIFICATION']);
export const CUTOVER_AUTHORITY_REF='AUTHORITY:CLAUDIO_PALAIS:CF2_MINIMUM_CUTOVER:TASK_VERIFICATION';
const allowed=new Set(['CREATE_TASK','TRANSITION_TASK','RECORD_VERIFICATION']);

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
}
