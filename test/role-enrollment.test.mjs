import test from 'node:test';
import assert from 'node:assert/strict';
import {RoleEnrollmentService,ENROLLMENT_SPECS,CODEX_ENROLLMENT_SPEC,ENROLLMENT_TTL_SECONDS,enrollmentPage} from '../src/role-enrollment.mjs';
import {RoleAuthorizer} from '../src/google-role-gateway.mjs';

class MemoryPool{
  constructor(){this.enrollments=new Map();this.sessions=new Map();this.audits=[];}
  async connect(){return this;}release(){}
  async query(sql,p=[]){
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[],rowCount:0};
    if(sql.startsWith('SELECT enrollment_id FROM role_gateway_enrollments WHERE enrollment_id=ANY')){const rows=p[0].filter(id=>this.enrollments.has(id)).map(enrollment_id=>({enrollment_id}));return{rows,rowCount:rows.length};}
    if(sql.startsWith('INSERT INTO role_gateway_enrollments(')){const [enrollment_id,actor_id,token_hash,status,created_at,expires_at]=p;this.enrollments.set(enrollment_id,{enrollment_id,actor_id,token_hash,status,created_at,expires_at});return{rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO role_gateway_enrollment_audit(')){this.audits.push({enrollment_id:p[1],session_id:p[2],actor_id:p[3],operation:p[4],accepted:p[5],reason_code:p[6]});return{rows:[],rowCount:1};}
    if(sql.includes('FROM role_gateway_enrollments WHERE token_hash=')){const row=[...this.enrollments.values()].find(item=>item.token_hash===p[0]);return{rows:row?[{...row}]:[],rowCount:row?1:0};}
    if(sql.startsWith("UPDATE role_gateway_enrollments SET status='EXPIRED'")){this.enrollments.get(p[0]).status='EXPIRED';return{rows:[],rowCount:1};}
    if(sql.includes('FROM role_gateway_enrollments WHERE enrollment_id=')){const row=this.enrollments.get(p[0]);return{rows:row?[{...row}]:[],rowCount:row?1:0};}
    if(sql.startsWith("UPDATE role_gateway_enrollments SET status='CONSUMED'")){const row=this.enrollments.get(p[0]);Object.assign(row,{status:'CONSUMED',human_fingerprint:p[1],consumed_at:p[2]});return{rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO role_gateway_sessions(')){const [session_id,enrollment_id,actor_id,access_jti_hash,refresh_token_hash,created_at,access_expires_at,refresh_expires_at]=p;this.sessions.set(session_id,{session_id,enrollment_id,actor_id,access_jti_hash,refresh_token_hash,created_at,access_expires_at,refresh_expires_at,revoked_at:null});return{rows:[],rowCount:1};}
    if(sql.startsWith('SELECT actor_id FROM role_gateway_sessions')){const row=this.sessions.get(p[0]),valid=row&&row.actor_id===p[1]&&row.access_jti_hash===p[2]&&!row.revoked_at&&new Date(row.access_expires_at)>new Date();return{rows:valid?[{actor_id:row.actor_id}]:[],rowCount:valid?1:0};}
    if(sql.startsWith('SELECT session_id,enrollment_id,actor_id,refresh_expires_at')){const row=[...this.sessions.values()].find(item=>item.refresh_token_hash===p[0]&&!item.revoked_at);return{rows:row?[{...row}]:[],rowCount:row?1:0};}
    if(sql.startsWith('UPDATE role_gateway_sessions SET access_jti_hash=')){const row=this.sessions.get(p[0]);Object.assign(row,{access_jti_hash:p[1],refresh_token_hash:p[2],access_expires_at:p[3]});return{rows:[],rowCount:1};}
    if(sql.startsWith('UPDATE role_gateway_sessions SET revoked_at=')){const row=this.sessions.get(p[0]);if(!row||row.revoked_at)return{rows:[],rowCount:0};row.revoked_at=new Date();return{rows:[{enrollment_id:row.enrollment_id,actor_id:row.actor_id}],rowCount:1};}
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  }
}

const jwtPayload=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
const fragmentToken=url=>new URLSearchParams(new URL(url).hash.slice(1)).get('token');

test('same Google identity authorizes two independent CF2 principals',async()=>{
  const pool=new MemoryPool(),service=new RoleEnrollmentService({pool},{baseUrl:'https://cf2-prod-core.onrender.com',signingSecret:'synthetic-secret-with-sufficient-entropy'}),pair=await service.createPair();
  assert.deepEqual(pair.map(item=>item.enrollment_id),ENROLLMENT_SPECS.map(item=>item.enrollment_id));
  assert.equal(ENROLLMENT_TTL_SECONDS,600);
  const rawChat=fragmentToken(pair[0].url),rawCw=fragmentToken(pair[1].url);
  assert.notEqual(rawChat,rawCw);assert.equal([...pool.enrollments.values()].some(row=>[rawChat,rawCw].includes(row.token_hash)),false);
  const chatTarget=await service.start(rawChat),cwTarget=await service.start(rawCw),human='a'.repeat(64);
  const chat=await service.consume({...chatTarget,human_fingerprint:human}),cw=await service.consume({...cwTarget,human_fingerprint:human});
  assert.equal(jwtPayload(chat.access_token).sub,'ACTOR:GABY_CHAT');assert.equal(jwtPayload(cw.access_token).sub,'ACTOR:GABY_CW');
  assert.notEqual(jwtPayload(chat.access_token).sid,jwtPayload(cw.access_token).sid);assert.notEqual(chat.refresh_token,cw.refresh_token);
  assert.equal(pool.enrollments.get('ENROLLMENT:GABY_CHAT').human_fingerprint,human);assert.equal(pool.enrollments.get('ENROLLMENT:GABY_CW').human_fingerprint,human);
  const authorizer=new RoleAuthorizer(new Map()),chatPrincipal=await service.authenticate(`Bearer ${chat.access_token}`),cwPrincipal=await service.authenticate(`Bearer ${cw.access_token}`);
  assert.equal(authorizer.authorize(chatPrincipal,'GABY_CHAT'),true);assert.equal(authorizer.authorize(chatPrincipal,'GABY_CW_AUDIOVISUAL'),false);
  assert.equal(authorizer.authorize(cwPrincipal,'GABY_CW_AUDIOVISUAL'),true);assert.equal(authorizer.authorize(cwPrincipal,'GABY_CW_DOCUMENTAL'),true);assert.equal(authorizer.authorize(cwPrincipal,'GABY_CHAT'),false);
  await service.revoke(jwtPayload(chat.access_token).sid);
  assert.equal(await service.authenticate(`Bearer ${chat.access_token}`),null);assert.equal((await service.authenticate(`Bearer ${cw.access_token}`)).actor_id,'ACTOR:GABY_CW');
  await assert.rejects(service.consume({...chatTarget,human_fingerprint:human}),/ENROLLMENT_CONSUMED/);
  await assert.rejects(service.start(rawChat),/ENROLLMENT_CONSUMED/);
  assert.equal((await service.refresh(cw.refresh_token)).actor_id,'ACTOR:GABY_CW');
});

test('actor target is server-side and mismatch or client actor declaration fails closed',async()=>{
  const pool=new MemoryPool(),service=new RoleEnrollmentService({pool},{baseUrl:'https://cf2-prod-core.onrender.com',signingSecret:'synthetic-secret-with-sufficient-entropy'}),pair=await service.createPair(),chatTarget=await service.start(fragmentToken(pair[0].url));
  await assert.rejects(service.consume({...chatTarget,actor_id:'ACTOR:GABY_CW',human_fingerprint:'b'.repeat(64)}),/ENROLLMENT_ACTOR_MISMATCH/);
  const page=enrollmentPage();assert.match(page,/JSON\.stringify\(\{enrollment_token:token\}\)/);assert.doesNotMatch(page,/actor_id|GABY_CHAT|GABY_CW/);
});

test('expired enrollment is persisted as EXPIRED and cannot start OAuth',async()=>{
  const pool=new MemoryPool();let now=Date.now();const service=new RoleEnrollmentService({pool},{baseUrl:'https://cf2-prod-core.onrender.com',signingSecret:'synthetic-secret-with-sufficient-entropy',clock:()=>now}),pair=await service.createPair();
  now+=ENROLLMENT_TTL_SECONDS*1000+1;
  await assert.rejects(service.start(fragmentToken(pair[0].url)),/ENROLLMENT_EXPIRED/);
  assert.equal(pool.enrollments.get('ENROLLMENT:GABY_CHAT').status,'EXPIRED');
});

test('browser enrollment confirmation never returns bearer or refresh credentials',async()=>{
  const pool=new MemoryPool(),service=new RoleEnrollmentService({pool},{baseUrl:'https://cf2-prod-core.onrender.com',signingSecret:'synthetic-secret-with-sufficient-entropy'}),pair=await service.createPair(),target=await service.start(fragmentToken(pair[0].url));
  const result=await service.consume({...target,human_fingerprint:'c'.repeat(64),issueCredentials:false});
  assert.deepEqual(result,{result:'ENROLLMENT_PASS',actor_id:'ACTOR:GABY_CHAT',allowed_roles:['GABY_CHAT']});
  assert.equal(pool.sessions.size,0);assert.equal(Object.hasOwn(result,'access_token'),false);assert.equal(Object.hasOwn(result,'refresh_token'),false);
});

test('Codex enrollment is independent from the existing Gaby pair',async()=>{
  const pool=new MemoryPool(),service=new RoleEnrollmentService({pool},{baseUrl:'https://cf2-prod-core.onrender.com',signingSecret:'synthetic-secret-with-sufficient-entropy'});
  const pair=await service.createPair(),codex=await service.createCodexEnrollment();
  assert.deepEqual(pair.map(item=>item.enrollment_id),ENROLLMENT_SPECS.map(item=>item.enrollment_id));
  assert.equal(pair.length,2);assert.equal(codex.enrollment_id,CODEX_ENROLLMENT_SPEC.enrollment_id);assert.equal(codex.actor_id,'ACTOR:CODEX');
  assert.equal(pool.enrollments.get('ENROLLMENT:CODEX').actor_id,'ACTOR:CODEX');
});
