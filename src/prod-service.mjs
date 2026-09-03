import http from 'node:http';
import { PostgresStore } from './postgres-store.mjs';
import {GitHubOidcAuthenticator,CUTOVER_AUDIENCE} from './github-oidc.mjs';
import {ProductionCutoverCoordinator} from './production-cutover.mjs';
import {CUTOVER_AUTHORITY_REF,MINIMUM_SCOPE} from './production-role-interface.mjs';
import {ProductionRoleGateway} from './google-role-gateway.mjs';
import {RoleEnrollmentService} from './role-enrollment.mjs';
import {ProductionRoleInterface} from './production-role-interface.mjs';
import {RemoteMcpServer} from './remote-mcp.mjs';

const enabled=value=>value==='true';
const config = Object.freeze({ release_id: process.env.CF2_RELEASE_ID, database_url: process.env.CF2_DATABASE_URL ?? process.env.DATABASE_URL, port: Number(process.env.PORT ?? 10000), production_cutover_enabled: enabled(process.env.CF2_PRODUCTION_WRITER_ENABLED), external_adapters_enabled: false, role_cutover_enabled: enabled(process.env.CF2_ROLE_CUTOVER_ENABLED), oidc:{repository:process.env.CF2_OIDC_REPOSITORY,repositoryId:process.env.CF2_OIDC_REPOSITORY_ID,workflowRef:process.env.CF2_OIDC_WORKFLOW_REF,ref:process.env.CF2_OIDC_REF,audience:CUTOVER_AUDIENCE} });
if (!config.release_id || !config.database_url) throw new Error('CF2_RELEASE_ID_AND_DATABASE_URL_REQUIRED');
const databaseHost = new URL(config.database_url).hostname;
// Render's private PostgreSQL endpoint uses a service-local self-signed CA. TLS
// remains enabled; only that internal endpoint is allowed to skip CA validation.
const renderInternalDatabase = /^dpg-[a-z0-9]+-a$/.test(databaseHost);
const store = new PostgresStore({ connectionString: config.database_url, ssl: { rejectUnauthorized: !renderInternalDatabase } });
await store.migrate();
const roleBaseUrl=process.env.RENDER_EXTERNAL_URL??'https://cf2-prod-core.onrender.com';
const roleEnrollments=new RoleEnrollmentService(store,{baseUrl:roleBaseUrl,signingSecret:process.env.CF2_GOOGLE_OAUTH_CLIENT_SECRET});
const operationalRoleInterface=new ProductionRoleInterface(store);
const remoteMcp=new RemoteMcpServer(store,{baseUrl:roleBaseUrl,roleInterface:operationalRoleInterface});
const roleGateway=new ProductionRoleGateway(store,{clientId:process.env.CF2_GOOGLE_OAUTH_CLIENT_ID,clientSecret:process.env.CF2_GOOGLE_OAUTH_CLIENT_SECRET,baseUrl:roleBaseUrl,bindings:process.env.CF2_GOOGLE_ROLE_BINDINGS,enrollments:roleEnrollments,remoteMcp});
let authenticator=null;try{authenticator=new GitHubOidcAuthenticator(config.oidc);}catch{}
const coordinator=new ProductionCutoverCoordinator(store,{productionEnabled:config.production_cutover_enabled,roleEnabled:config.role_cutover_enabled});
const send=(response,status,value)=>response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value));
const readRawBody=async request=>{const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>65536)throw new Error('PAYLOAD_TOO_LARGE');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');};
const readBody=async request=>JSON.parse((await readRawBody(request))||'{}');
const readForm=async request=>new URLSearchParams(await readRawBody(request));
const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'https://cf2-prod-core.onrender.com');
  if(request.method==='GET'&&request.url==='/health'){try{const health=await store.health(),writers=Object.fromEntries(await Promise.all(MINIMUM_SCOPE.map(async domain=>[domain,await store.writer(domain)])));return send(response,200,{service:'cf2-core',release_id:config.release_id,...health,flags:{production_cutover_enabled:config.production_cutover_enabled,external_adapters_enabled:false,role_cutover_enabled:config.role_cutover_enabled},writers,oidc:authenticator?'READY':'NOT_READY',role_gateway:roleGateway.health(),remote_mcp:remoteMcp.health()});}catch{return send(response,503,{service:'cf2-core',database:'DOWN'});}}
  if(await remoteMcp.handlePublic(request,response,url,readBody,readForm))return;
  if(await remoteMcp.handleMcp(request,response,url,readBody))return;
  if(await roleGateway.handle(request,response,url,readBody))return;
  if(request.method!=='POST'||!['/internal/cutover/preflight','/internal/cutover/execute'].includes(request.url))return send(response,404,{error_code:'NOT_FOUND'});
  try{if(!authenticator)throw new Error('AUTH_REJECTED');const authorization=request.headers.authorization??'',token=authorization.startsWith('Bearer ')?authorization.slice(7):null,principal=await authenticator.authenticate(token),payload=await readBody(request);if(payload.actor_id||payload.actor_role)throw new Error('ACTOR_MISMATCH');const args={authority_ref:payload.authority_ref,scope:payload.scope},result=request.url.endsWith('/preflight')?await coordinator.prepare(principal,args):await coordinator.execute(principal,args);return send(response,200,{...result,authenticated_actor:principal.actor_id,actor_kind:principal.actor_kind,authority_ref:CUTOVER_AUTHORITY_REF});}catch(error){const code=error.reason_code??error.message??'FAIL_CLOSED';return send(response,['AUTH_REJECTED','ACTOR_MISMATCH'].includes(code)?401:409,{result:'FAIL_CLOSED',error_code:code});}
});
server.listen(config.port,'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{await store.close();process.exit(0);}));
