import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {CoreStore} from './core-store.mjs';
import {RoleInterface} from './role-interface.mjs';
import {GoogleDriveClient,Stage5DriveBridge,DRIVE_SCOPE} from './stage5-drive-bridge.mjs';

const PORT=Number(process.env.PORT??10000);const BASE_URL=process.env.STAGE5_PUBLIC_URL??`http://127.0.0.1:${PORT}`;
const dbRoot=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-stage5-cloud-'));const store=new CoreStore(path.join(dbRoot,'synthetic.db'));
const roles=new RoleInterface(store,{localAvailable:false,version:'stage5-cloud-gate'});
const oauthConfigured=Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID&&process.env.GOOGLE_OAUTH_CLIENT_SECRET);
const drive=oauthConfigured?new GoogleDriveClient({clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,clientSecret:process.env.GOOGLE_OAUTH_CLIENT_SECRET,redirectUri:`${BASE_URL}/oauth/google/callback`}):null;
const bridge=drive?new Stage5DriveBridge({drive,roleInterface:roles}):null;const oauthStates=new Map();let ready=null;
const synthetic={id:'ENTITY:STAGE5:SYNTHETIC',type:'ENTITY',status:'CURRENT',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),basis_ref:['STAGE5:CLOUD:GATE'],entity_kind:'STAGING',canonical_name:'Stage 5 Synthetic Cloud Gate',aliases:['stage5 synthetic']};
store.submitCommand({command_id:'COMMAND:STAGE5:BOOTSTRAP',command_type:'UPSERT_ENTITY',actor_id:'ACTOR:CLAUDIO',actor_role:'CLAUDIO',issued_at:new Date().toISOString(),idempotency_key:'stage5-bootstrap-entity',payload:{object:synthetic}});

const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,BASE_URL);
  if(req.method==='GET'&&url.pathname==='/healthz')return json(res,200,{service:'cf2-stage5-role-gate',status:'UP',oauth_configured:oauthConfigured,gate_ready:Boolean(ready),state_version:store.stateVersion(),production_connections:0});
  if(req.method==='GET'&&url.pathname==='/oauth/google/start'){
    if(!drive)return json(res,503,{result:'GOOGLE_OAUTH_CLIENT_BOOTSTRAP_REQUIRED',redirect_uri:`${BASE_URL}/oauth/google/callback`,scope:DRIVE_SCOPE});
    const state=crypto.randomUUID(),verifier=crypto.randomBytes(48).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');oauthStates.set(state,{verifier,expires:Date.now()+600_000});res.writeHead(302,{location:drive.authorizationUrl({state,codeChallenge:challenge}),'cache-control':'no-store'});return res.end();
  }
  if(req.method==='GET'&&url.pathname==='/oauth/google/callback'){
    const entry=oauthStates.get(url.searchParams.get('state'));oauthStates.delete(url.searchParams.get('state'));if(!entry||entry.expires<Date.now()||!url.searchParams.get('code'))return json(res,400,{result:'OAUTH_STATE_INVALID'});
    await drive.exchange(url.searchParams.get('code'),entry.verifier);
    ready=await bridge.bootstrap({folderId:process.env.STAGE5_PROVISIONAL_FOLDER_ID,requestId:process.env.STAGE5_PROVISIONAL_REQUEST_ID,responseId:process.env.STAGE5_PROVISIONAL_RESPONSE_ID,webhookUrl:`${BASE_URL}/webhooks/drive`});return json(res,200,{result:'OAUTH_BOOTSTRAP_PASS',...ready});
  }
  if(req.method==='POST'&&url.pathname==='/webhooks/drive'){if(!bridge)return json(res,503,{result:'NOT_READY'});const outcome=await bridge.webhook(req.headers);if(outcome.http===204){res.writeHead(204);return res.end();}return json(res,outcome.http,outcome.result);}
  if(req.method==='GET'&&url.pathname==='/readyz')return json(res,ready?200:503,{ready:Boolean(ready),...(ready??{}),state_version:store.stateVersion()});
  return json(res,404,{result:'NOT_FOUND'});
}catch(error){return json(res,500,{result:'FAIL_CLOSED',error_code:String(error.message).replace(/[^A-Z0-9_]/gi,'_').slice(0,80)});}});
server.listen(PORT,'0.0.0.0');
const shutdown=()=>{server.close(()=>{store.close();fs.rmSync(dbRoot,{recursive:true,force:true});process.exit(0);});};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
