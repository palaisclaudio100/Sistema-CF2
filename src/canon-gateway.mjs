import {sha,strict} from './actor-transport.mjs';

export const CANON_OBJECTS=Object.freeze({
  MAESTRO:{id:'1pUpFiYaKukRZkv75B9pV1klR36jjprJ5',name:'Documento Maestro'},
  ESTADO:{id:'1mXHlh7DexD8us94Guzhw_lgYp1TiJqB_',name:'Estado de Sesion'}
});
export const CONTROL_ID='1jz7loOCOvXggTA3HcwFltTfv_xY3R3FGuymb4QOmviE';
const error=()=>{throw new Error('CANON_NOT_VERIFIED');};
export function parseControl(text){
  const current=text.split(/CORRIDA ANTERIOR HIST[ÓO]RICA/)[0];
  if(!current.includes('CONTROL: VIGENTE')||!current.includes('CONTROL_PERSISTIDO_VERIFICADO')||!current.includes('SINCRONIZADO_VERIFICADO')||!current.includes('OBJETO BASE: CANON LOCAL'))error();
  const run=/ID NUEVO DE CORRIDA:\s*(\S+)/.exec(current)?.[1];
  const time=run&&/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-IDT$/.exec(run);
  if(!time)error();
  // Run ID records the measured operating timestamp; visual date chips are not timestamps.
  const verified_at=`${time[1]}-${time[2]}-${time[3]}T${time[4]}:${time[5]}:${time[6]}+03:00`;
  if(!Number.isFinite(Date.parse(verified_at)))error();
  const objects={};
  for(const [name,meta] of Object.entries(CANON_OBJECTS)){
    const line=current.split(/\r?\n/).find(l=>l.includes(meta.id));
    const hash=line&&/SHA-256\s+([a-f0-9]{64})/i.exec(line)?.[1];
    const bytes=line&&/;\s*(\d+) B;/.exec(line)?.[1];
    if(!hash||!bytes)error();
    objects[name]={...meta,sha256:hash.toLowerCase(),bytes:Number(bytes)};
  }
  return{run,verified_at,control_sha256:sha(current),objects};
}
const flatten=node=>{if(!node||typeof node!=='object')return '';if(node.textRun?.content)return node.textRun.content;return Object.values(node).filter(v=>typeof v==='object').map(v=>Array.isArray(v)?v.map(flatten).join(''):flatten(v)).join('');};
export class GoogleCanonSource{
  constructor({fetchImpl=fetch,env=process.env}={}){this.fetch=fetchImpl;this.env=env;}
  async token(){
    const e=this.env;
    if(!e.CF2_CANON_REFRESH_TOKEN||!e.CF2_CANON_CLIENT_ID||!e.CF2_CANON_CLIENT_SECRET)error();
    const r=await this.fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:e.CF2_CANON_REFRESH_TOKEN,client_id:e.CF2_CANON_CLIENT_ID,client_secret:e.CF2_CANON_CLIENT_SECRET}),signal:AbortSignal.timeout(15000)});
    if(!r.ok)error();const value=await r.json();if(!value.access_token)error();return value.access_token;
  }
  async control(){const token=await this.token();const r=await this.fetch(`https://docs.googleapis.com/v1/documents/${CONTROL_ID}?includeTabsContent=true`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});if(!r.ok)error();const doc=await r.json();if(doc.documentId!==CONTROL_ID||!doc.revisionId)error();return{text:flatten(doc),version:doc.revisionId,id:doc.documentId};}
  async bytes(object){const url=`https://drive.google.com/uc?export=download&id=${CANON_OBJECTS[object].id}`;const r=await this.fetch(url,{signal:AbortSignal.timeout(20000)});if(!r.ok)error();if(Number(r.headers.get('content-length'))>5000000)error();const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>5000000)error();return bytes;}
}
export class CanonGateway{
  constructor(source,{clock=()=>Date.now(),onIncident=async()=>{}}={}){this.source=source;this.clock=clock;this.onIncident=onIncident;}
  async verified(principal,object){
    if(!CANON_OBJECTS[object])throw new Error('INVALID_SCHEMA');
    try{
      const before=await this.source.control(),control=parseControl(before.text),bytes=await this.source.bytes(object),after=await this.source.control();
      if(before.version!==after.version||before.id!==CONTROL_ID||after.id!==CONTROL_ID||sha(before.text)!==sha(after.text))error();
      const expected=control.objects[object];if(bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)error();
      return{text:bytes.toString('utf8'),metadata:{object,...expected,version:expected.sha256,verified_at:control.verified_at,read_verified_at:new Date(this.clock()).toISOString(),sync_state:'SINCRONIZADO_VERIFICADO',source:'GOOGLE_DRIVE_VERIFIED_MIRROR',control_id:CONTROL_ID,control_version:before.version,control_run:control.run,control_sha256:control.control_sha256}};
    }catch{await this.onIncident(principal,object);error();}
  }
  async call(principal,name,args){
    if(name==='canon_identify'){strict(args,[]);const objects=[];for(const object of Object.keys(CANON_OBJECTS))objects.push((await this.verified(principal,object)).metadata);return{objects};}
    strict(args,name==='canon_search'?['object','query','limit']:['object','start_line','end_line','section']);
    const {text,metadata}=await this.verified(principal,args.object),lines=text.split(/\r?\n/);
    if(name==='canon_search'){if(typeof args.query!=='string'||!args.query.trim()||args.query.length>300)throw new Error('INVALID_SCHEMA');const limit=args.limit??20;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('INVALID_SCHEMA');const found=[];for(let i=0;i<lines.length;i++)if(lines[i].toLocaleLowerCase().includes(args.query.toLocaleLowerCase()))found.push({line:i+1,text:lines[i].slice(0,2000)});return{metadata,matches:found.slice(0,limit),total_matches:found.length,truncated:found.length>limit};}
    let start=args.start_line??1,end=args.end_line??Math.min(start+79,lines.length);
    if(args.section!=null){if(typeof args.section!=='string'||!args.section||args.section.length>300||args.start_line!=null||args.end_line!=null)throw new Error('INVALID_SCHEMA');const matches=lines.map((l,i)=>/^#{1,6}\s/.test(l)&&l.includes(args.section)?i:-1).filter(i=>i>=0);if(matches.length!==1)throw new Error('SECTION_AMBIGUOUS_OR_UNKNOWN');start=matches[0]+1;const level=/^#+/.exec(lines[start-1])[0].length;end=lines.length;for(let i=start;i<lines.length;i++)if(/^#{1,6}\s/.test(lines[i])&&/^#+/.exec(lines[i])[0].length<=level){end=i;break;}}
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>lines.length)throw new Error('INVALID_SCHEMA');const actualEnd=Math.min(end,start+199);return{metadata,start_line:start,end_line:actualEnd,total_lines:lines.length,truncated:actualEnd<end,lines:lines.slice(start-1,actualEnd).map((l,i)=>({line:start+i,text:l.slice(0,4000)}))};
  }
}
