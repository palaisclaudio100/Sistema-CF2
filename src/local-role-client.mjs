import fs from 'node:fs';
import path from 'node:path';

/** Durable local transport queue. It stores commands, never credentials or Core authority. */
export class LocalCommandQueue {
  constructor(filePath){this.filePath=filePath;fs.mkdirSync(path.dirname(filePath),{recursive:true});if(!fs.existsSync(filePath))fs.writeFileSync(filePath,'[]\n',{mode:0o600});}
  #read(){return JSON.parse(fs.readFileSync(this.filePath,'utf8'));}
  #write(items){fs.writeFileSync(this.filePath,`${JSON.stringify(items,null,2)}\n`,{mode:0o600});}
  enqueue(command){const items=this.#read();if(!items.some(item=>item.command.idempotency_key===command.idempotency_key))items.push({command,status:'PENDING'});this.#write(items);return items.find(item=>item.command.idempotency_key===command.idempotency_key);}
  pending(){return this.#read().filter(item=>item.status==='PENDING');}
  flush(client){const items=this.#read();const results=[];for(const item of items){if(item.status!=='PENDING')continue;const response=client.submitCommand(item.command);results.push(response);if(response.ok||['ACTOR_MISMATCH','ROLE_FORBIDDEN','AUTHORITY_REQUIRED','INVALID_SCHEMA','EVIDENCE_REQUIRED'].includes(response.reason_code)){item.status=response.ok?'DELIVERED':'REJECTED';item.command_id=response.data?.command_id??item.command.command_id;item.reason_code=response.reason_code;}}this.#write(items);return results;}
}
