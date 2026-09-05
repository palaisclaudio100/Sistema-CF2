import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {CANON_OBJECTS} from './canon-gateway.mjs';
import {ACTORS,sha,strict} from './actor-transport.mjs';
const FILES=Object.freeze({MAESTRO:'Documento_Maestro_chat-CoWork.md',ESTADO:'Estado_Sesion_actual.md'});
export class DirectCanonReader{
  constructor(root){this.root=path.resolve(root);}
  async read(object){
    if(!FILES[object])throw new Error('INVALID_SCHEMA');
    const file=path.join(this.root,FILES[object]);const a=await fs.stat(file),bytes=await fs.readFile(file),b=await fs.stat(file);if(a.size!==b.size||a.mtimeMs!==b.mtimeMs||bytes.length!==b.size||bytes.length>5000000)throw new Error('CANON_NOT_VERIFIED');
    const second=await fs.readFile(file);if(sha(bytes)!==sha(second))throw new Error('CANON_NOT_VERIFIED');const version=sha(bytes);
    return{text:bytes.toString('utf8'),metadata:{object,id:CANON_OBJECTS[object].id,canonical_path:file,version,sha256:version,bytes:bytes.length,verified_at:new Date().toISOString(),source:'ONEDRIVE_CANON_DIRECT',sync_state:'DIRECT_CANON_VERIFIED_MIRROR_NOT_USED',mirror_verification:'NOT_ASSERTED',file_modified_at:b.mtime.toISOString()}};
  }
  async call(operation,args){
    if(operation==='canon_identify'){strict(args,[]);const objects=[];for(const object of Object.keys(FILES))objects.push((await this.read(object)).metadata);return{objects};}
    strict(args,operation==='canon_search'?['object','query','limit']:['object','start_line','end_line','section']);
    const {text,metadata}=await this.read(args.object),lines=text.split(/\r?\n/);
    if(operation==='canon_search'){
      const limit=args.limit??20;if(typeof args.query!=='string'||!args.query||args.query.length>300||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('INVALID_SCHEMA');const matches=[];for(let i=0;i<lines.length;i++)if(lines[i].toLowerCase().includes(args.query.toLowerCase()))matches.push({line:i+1,text:lines[i].slice(0,3000)});return{metadata,matches:matches.slice(0,limit),total_matches:matches.length,truncated:matches.length>limit};
    }
    if(operation!=='canon_read')throw new Error('INVALID_SCHEMA');
    let start=args.start_line??1,end=args.end_line??Math.min(start+79,lines.length);
    if(args.section!=null){if(typeof args.section!=='string'||!args.section||args.start_line!=null||args.end_line!=null)throw new Error('INVALID_SCHEMA');const matches=lines.map((l,i)=>/^#{1,6}\s/.test(l)&&l.includes(args.section)?i:-1).filter(i=>i>=0);if(matches.length!==1)throw new Error('SECTION_AMBIGUOUS_OR_UNKNOWN');start=matches[0]+1;const level=/^#+/.exec(lines[start-1])[0].length;end=lines.length;for(let i=start;i<lines.length;i++)if(/^#{1,6}\s/.test(lines[i])&&/^#+/.exec(lines[i])[0].length<=level){end=i;break;}}
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>lines.length)throw new Error('INVALID_SCHEMA');const actualEnd=Math.min(end,start+199);return{metadata,start_line:start,end_line:actualEnd,total_lines:lines.length,truncated:actualEnd<end,lines:lines.slice(start-1,actualEnd).map((l,i)=>({line:start+i,text:l.slice(0,4000)}))};
  }
}
export class DirectCanonGateway{
  constructor(pool,{onIncident=async()=>{},timeoutMs=60000}={}){this.pool=pool;this.onIncident=onIncident;this.timeoutMs=timeoutMs;}
  async call(principal,operation,args){
    if(!ACTORS.includes(principal?.actor_id)||!['canon_identify','canon_search','canon_read'].includes(operation))throw new Error('AUTH_REJECTED');
    const ready=(await this.pool.query("SELECT 1 FROM canon_bridge_state WHERE singleton=true AND actor_id='ACTOR:CODEX' AND updated_at>now()-interval '30 seconds'")).rowCount;
    if(!ready){await this.onIncident(principal,args.object??'MAESTRO');throw new Error('CANON_NOT_VERIFIED');}
    const request_id=crypto.randomUUID();await this.pool.query('INSERT INTO canon_read_requests(request_id,actor_id,operation,arguments) VALUES($1,$2,$3,$4::jsonb)',[request_id,principal.actor_id,operation,JSON.stringify(args)]);
    const until=Date.now()+this.timeoutMs;
    while(Date.now()<until){const row=(await this.pool.query('SELECT status,response FROM canon_read_requests WHERE request_id=$1',[request_id])).rows[0];if(row?.status==='DONE'){if(row.response?.error_code){if(row.response.error_code==='CANON_NOT_VERIFIED')await this.onIncident(principal,args.object??'MAESTRO');throw new Error(row.response.error_code);}return row.response;}await new Promise(r=>setTimeout(r,250));}
    await this.pool.query("UPDATE canon_read_requests SET status='EXPIRED' WHERE request_id=$1 AND status!='DONE'",[request_id]);await this.onIncident(principal,args.object??'MAESTRO');throw new Error('CANON_NOT_VERIFIED');
  }
  async claim(){
    await this.pool.query("UPDATE canon_read_requests SET status='EXPIRED' WHERE expires_at<=now() AND status IN ('PENDING','RUNNING')");
    const lease=crypto.randomBytes(24).toString('hex');const rows=(await this.pool.query("UPDATE canon_read_requests SET status='RUNNING',lease_token=$1,lease_until=now()+interval '20 seconds' WHERE request_id=(SELECT request_id FROM canon_read_requests WHERE expires_at>now() AND (status='PENDING' OR status='RUNNING' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING request_id,actor_id,operation,arguments,lease_token",[lease])).rows;return rows[0]??null;
  }
  async complete(args){strict(args,['request_id','lease_token','response']);if(!args.response||typeof args.response!=='object'||Buffer.byteLength(JSON.stringify(args.response))>60000)throw new Error('INVALID_SCHEMA');
    const metas=args.response.metadata?[args.response.metadata]:args.response.objects;
    if(!args.response.error_code&&(!Array.isArray(metas)||!metas.length||metas.some(m=>!FILES[m.object]||m.source!=='ONEDRIVE_CANON_DIRECT'||!/^[a-f0-9]{64}$/.test(m.sha256)||m.version!==m.sha256||!Number.isFinite(Date.parse(m.verified_at))||Math.abs(Date.now()-Date.parse(m.verified_at))>60000)))throw new Error('CANON_NOT_VERIFIED');
    const done=await this.pool.query("UPDATE canon_read_requests SET status='DONE',response=$3::jsonb,lease_token=NULL,lease_until=NULL WHERE request_id=$1 AND lease_token=$2 AND status='RUNNING' AND lease_until>now() AND expires_at>now()",[args.request_id,args.lease_token,JSON.stringify(args.response)]);if(done.rowCount!==1)throw new Error('LEASE_REJECTED');return{accepted:true};
  }
}
