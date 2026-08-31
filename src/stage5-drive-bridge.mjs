import crypto from 'node:crypto';

export const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.file';
const MAX_ENVELOPE_NAME=240;
const COMMAND_ID='COMMAND:STAGE5:CLOUD:DGA:001';
const IDEMPOTENCY_KEY='IDEMP:STAGE5:CLOUD:001';
const iso=()=>new Date().toISOString();
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(value);

export function validateChannel(headers,expected){
  const get=name=>headers[String(name).toLowerCase()]??headers[name]??null;
  if(get('x-goog-channel-id')!==expected.channelId)return {ok:false,code:'CHANNEL_ID_INVALID'};
  if(get('x-goog-channel-token')!==expected.channelToken)return {ok:false,code:'CHANNEL_TOKEN_INVALID'};
  if(get('x-goog-resource-id')!==expected.resourceId)return {ok:false,code:'RESOURCE_ID_INVALID'};
  const state=get('x-goog-resource-state');
  if(state==='sync')return {ok:false,ignored:true,code:'INITIAL_SYNC_IGNORED'};
  if(state!=='update')return {ok:false,ignored:true,code:'RESOURCE_STATE_IGNORED'};
  return {ok:true,messageNumber:get('x-goog-message-number')??null};
}

export function parseMetadataEnvelope(name,gateInstanceId){
  if(typeof name!=='string'||name.length>MAX_ENVELOPE_NAME)return {ok:false,code:'INVALID_METADATA_ENVELOPE'};
  const match=/^CF2S5__([0-9a-f-]{36})__(READ|COMMAND|STATUS|REPLAY)__([A-Za-z0-9:_-]{1,80})__([A-Za-z0-9_-]{8,80})\.gate$/.exec(name);
  if(!match)return {ok:false,code:'INVALID_METADATA_ENVELOPE'};
  const [,gate,operation,request_id,nonce]=match;
  if(gate!==gateInstanceId)return {ok:false,code:'GATE_INSTANCE_MISMATCH'};
  return {ok:true,value:{operation,request_id,nonce}};
}

export class GoogleDriveClient {
  constructor({clientId,clientSecret,redirectUri,fetchImpl=fetch}){this.clientId=clientId;this.clientSecret=clientSecret;this.redirectUri=redirectUri;this.fetch=fetchImpl;this.tokens=null;}
  authorizationUrl({state,codeChallenge}){const q=new URLSearchParams({client_id:this.clientId,redirect_uri:this.redirectUri,response_type:'code',scope:DRIVE_SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:codeChallenge,code_challenge_method:'S256'});return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;}
  async exchange(code,codeVerifier){const body=new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,code,code_verifier:codeVerifier,redirect_uri:this.redirectUri,grant_type:'authorization_code'});const res=await this.fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});if(!res.ok)throw new Error('OAUTH_EXCHANGE_FAILED');this.tokens=await res.json();return this.tokens;}
  async #accessToken(){if(!this.tokens?.access_token)throw new Error('OAUTH_REQUIRED');return this.tokens.access_token;}
  async api(path,{method='GET',body,media=false,headers={}}={}){const token=await this.#accessToken();const res=await this.fetch(`https://www.googleapis.com${path}`,{method,headers:{authorization:`Bearer ${token}`,...(body&&!media?{'content-type':'application/json'}:{}),...headers},body:body?(media?body:JSON.stringify(body)):undefined});if(!res.ok)throw new Error(`DRIVE_HTTP_${res.status}`);return media?Buffer.from(await res.arrayBuffer()):await res.json();}
  about(){return this.api('/drive/v3/about?fields=user(permissionId)');}
  metadata(id){return this.api(`/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,parents,version,headRevisionId,lastModifyingUser(permissionId)&supportsAllDrives=true`);}
  update(id,bytes){return this.api(`/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id,version,headRevisionId&supportsAllDrives=true`,{method:'PATCH',body:Buffer.from(bytes),media:true,headers:{'content-type':'text/plain; charset=utf-8'}}).then(raw=>JSON.parse(raw.toString('utf8')));}
  async createStaging(){const folder=await this.api('/drive/v3/files?fields=id',{method:'POST',body:{name:'CF2_STAGE5_GATE_NO_PRODUCTIVO',mimeType:'application/vnd.google-apps.folder'}});const create=async name=>this.api('/drive/v3/files?fields=id,parents,version,headRevisionId',{method:'POST',body:{name,mimeType:'text/plain',parents:[folder.id]}});return {folderId:folder.id,requestId:(await create('STAGE5_GATE_REQUEST.json')).id,responseId:(await create('STAGE5_GATE_RESPONSE.json')).id};}
  watch(id,{channelId,channelToken,address,expiration}){return this.api(`/drive/v3/files/${encodeURIComponent(id)}/watch?supportsAllDrives=true`,{method:'POST',body:{id:channelId,type:'web_hook',address,token:channelToken,expiration:String(expiration)}});}
}

export class Stage5DriveBridge {
  constructor({drive,roleInterface,gateInstanceId=crypto.randomUUID(),clock=()=>Date.now()}){this.drive=drive;this.roles=roleInterface;this.gateInstanceId=gateInstanceId;this.clock=clock;this.channel=null;this.files=null;this.baseline=null;this.principalPermissionId=null;this.seen=new Set();this.nonces=new Set();this.audit=[];this.envelopes=null;}
  async bootstrap({folderId,requestId,responseId,webhookUrl,watchHours=12}){
    const about=await this.drive.about();this.principalPermissionId=about.user?.permissionId??null;if(!this.principalPermissionId)throw new Error('ACTOR_BINDING_UNPROVEN');
    let files={folderId,requestId,responseId};try{await this.#validateFiles(files);}catch(error){if(!String(error.message).startsWith('DRIVE_HTTP_'))throw error;files=await this.drive.createStaging();await this.#validateFiles(files);}
    const requestMeta=await this.drive.metadata(files.requestId);this.files=files;this.baseline={name:requestMeta.name,version:requestMeta.version,headRevisionId:requestMeta.headRevisionId??null};this.envelopes=this.#envelopes();
    const channelId=crypto.randomUUID(),channelToken=crypto.randomBytes(32).toString('base64url'),expiration=this.clock()+watchHours*3600_000;
    const watched=await this.drive.watch(files.requestId,{channelId,channelToken,address:webhookUrl,expiration});this.channel={channelId,channelToken,resourceId:watched.resourceId,expiration:Number(watched.expiration??expiration)};return this.readiness();
  }
  #envelopes(){const name=(operation,request_id)=>`CF2S5__${this.gateInstanceId}__${operation}__${request_id}__${crypto.randomBytes(12).toString('hex')}.gate`;return {READ:name('READ','REQ_STAGE5_META_READ_001'),COMMAND:name('COMMAND','REQ_STAGE5_META_COMMAND_001'),STATUS:name('STATUS','REQ_STAGE5_META_STATUS_001'),REPLAY:name('REPLAY','REQ_STAGE5_META_REPLAY_001')};}
  async #validateFiles({folderId,requestId,responseId}){for(const id of [requestId,responseId]){const m=await this.drive.metadata(id);if(m.id!==id||m.mimeType!=='text/plain'||!m.parents?.includes(folderId))throw new Error('STAGING_FILE_INVALID');}}
  readiness(){return {gate_instance_id:this.gateInstanceId,actor_binding_scope:'STAGING_CHANNEL_ONLY',oauth_scope:DRIVE_SCOPE,folder_id:this.files?.folderId??null,request_file_id:this.files?.requestId??null,response_file_id:this.files?.responseId??null,request_name:this.baseline?.name??null,baseline_revision:this.baseline,watch_active:Boolean(this.channel),watch_expiration:this.channel?.expiration??null,principal_fingerprint:this.principalPermissionId?hash(this.principalPermissionId).slice(0,16):null,rename_envelopes:this.envelopes};}
  async webhook(headers){
    if(!this.channel||!this.files)return {http:503,result:{result:'NOT_READY'}};const channel=validateChannel(headers,this.channel);if(!channel.ok)return {http:channel.ignored?204:403,result:{result:channel.code}};
    const meta=await this.drive.metadata(this.files.requestId);if(meta.id!==this.files.requestId||meta.mimeType!=='text/plain'||!meta.parents?.includes(this.files.folderId))return this.#respond(null,'REMOTE_READ_INVALID');
    if(String(meta.version)===String(this.baseline.version)||meta.headRevisionId&&meta.headRevisionId===this.baseline.headRevisionId)return {http:204,result:{result:'BASELINE_IGNORED'}};
    if(!meta.lastModifyingUser?.permissionId||meta.lastModifyingUser.permissionId!==this.principalPermissionId)return this.#respond(null,'ACTOR_BINDING_UNPROVEN');
    const parsed=parseMetadataEnvelope(meta.name,this.gateInstanceId);if(!parsed.ok)return this.#respond(null,parsed.code);const req=parsed.value;const transportKey=`${this.files.requestId}:${meta.headRevisionId??meta.version}:${req.request_id}:${req.nonce}`;
    if(this.seen.has(transportKey))return {http:204,result:{result:'TRANSPORT_DUPLICATE_IGNORED'}};
    if(this.nonces.has(req.nonce))return this.#respond(req,'NONCE_REPLAY');this.seen.add(transportKey);this.nonces.add(req.nonce);
    let response;if(req.operation==='READ')response=this.roles.client('dev-credential-dga').request('READ_SNAPSHOT');else if(req.operation==='STATUS')response=this.roles.client('dev-credential-dga').request('READ_COMMAND_STATUS',{command_id:COMMAND_ID});else response=this.roles.client('dev-credential-dga').submitCommand(this.#command());
    return this.#respond(req,response.ok?'PASS':response.reason_code,{response,replay:req.operation==='REPLAY',message_number:channel.messageNumber,revision:meta.headRevisionId??meta.version});
  }
  #command(){const stamp=iso();return {command_id:COMMAND_ID,command_type:'CREATE_TASK',actor_id:'ACTOR:DIEGO',actor_role:'DGA',issued_at:stamp,idempotency_key:IDEMPOTENCY_KEY,correlation_id:`CORR:${COMMAND_ID}`,authority_ref:'STAGE5_CHANNEL:DGA',payload:{object:{id:'TASK:STAGE5:SYNTHETIC:CLOUD',type:'TASK',status:'OPEN',created_at:stamp,updated_at:stamp,basis_ref:[COMMAND_ID],action:'DEV_ROLE_GATE',state:'OPEN',responsible_role:'DGA',related_ids:['ENTITY:STAGE5:SYNTHETIC'],non_productive:true}}};}
  async #respond(req,result,extra={}){const response={request_id:req?.request_id??null,gate_instance_id:this.gateInstanceId,actor_id:'ACTOR:DIEGO',actor_role:'DGA',actor_binding_scope:'STAGING_CHANNEL_ONLY',operation:req?.operation??null,result,state_version:extra.response?.state_version??this.roles.client('dev-credential-dga').request('HEALTH').state_version,command_id:['COMMAND','REPLAY','STATUS'].includes(req?.operation)?COMMAND_ID:null,status:extra.response?.data?.command_status??extra.response?.data?.status??null,task_ref:extra.response?.data?.task_ref??null,audit_ref:req?.request_id?`AUDIT:${hash(req.request_id).slice(0,16)}`:null,processed_at:iso(),error_code:result==='PASS'?null:result,replay:Boolean(extra.replay)};await this.drive.update(this.files.responseId,Buffer.from(JSON.stringify(response,null,2)+'\n'));this.audit.push({...response,channel_id_fingerprint:this.channel?hash(this.channel.channelId).slice(0,16):null,request_revision:extra.revision??null});return {http:200,result:response};}
}
