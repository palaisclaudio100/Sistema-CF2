import crypto from 'node:crypto';

export const ENROLLMENT_TTL_SECONDS=600;
export const ACCESS_TTL_SECONDS=3600;
export const REFRESH_TTL_SECONDS=2_592_000;
export const ENROLLMENT_SPECS=Object.freeze([
  Object.freeze({enrollment_id:'ENROLLMENT:GABY_CHAT',actor_id:'ACTOR:GABY_CHAT'}),
  Object.freeze({enrollment_id:'ENROLLMENT:GABY_CW',actor_id:'ACTOR:GABY_CW'})
]);

const ACTOR_ROLES=Object.freeze({
  'ACTOR:GABY_CHAT':Object.freeze(['GABY_CHAT']),
  'ACTOR:GABY_CW':Object.freeze(['GABY_CW_AUDIOVISUAL','GABY_CW_DOCUMENTAL'])
});
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const randomToken=()=>crypto.randomBytes(32).toString('base64url');
const safeEqual=(left,right)=>{const a=Buffer.from(left??''),b=Buffer.from(right??'');return a.length===b.length&&crypto.timingSafeEqual(a,b);};

export class RoleEnrollmentService{
  constructor(store,{baseUrl,signingSecret,clock=()=>Date.now()}={}){
    if(!store?.pool||!baseUrl||!signingSecret)throw new Error('ENROLLMENT_CONFIGURATION_REQUIRED');
    this.pool=store.pool;this.baseUrl=baseUrl;this.clock=clock;
    this.signingKey=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(signingSecret),Buffer.from('cf2-role-gateway'),Buffer.from('access-token-v1'),32));
  }

  async createPair(){
    const client=await this.pool.connect(),createdAt=new Date(this.clock()),expiresAt=new Date(this.clock()+ENROLLMENT_TTL_SECONDS*1000),result=[];
    try{
      await client.query('BEGIN');
      const existing=await client.query('SELECT enrollment_id FROM role_gateway_enrollments WHERE enrollment_id=ANY($1::text[]) FOR UPDATE',[ENROLLMENT_SPECS.map(item=>item.enrollment_id)]);
      if(existing.rowCount)throw new Error('ENROLLMENT_ALREADY_EXISTS');
      for(const spec of ENROLLMENT_SPECS){
        const token=randomToken();
        await client.query('INSERT INTO role_gateway_enrollments(enrollment_id,actor_id,token_hash,status,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[spec.enrollment_id,spec.actor_id,digest(token),'PENDING',createdAt,expiresAt]);
        await this.#audit(client,{enrollment_id:spec.enrollment_id,actor_id:spec.actor_id,operation:'CREATED',accepted:true,reason_code:'PENDING'});
        result.push({...spec,url:`${this.baseUrl}/role/enroll#token=${token}`});
      }
      await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async start(token){
    if(typeof token!=='string'||token.length<40||token.length>128)throw new Error('ENROLLMENT_INVALID');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const row=(await client.query('SELECT enrollment_id,actor_id,status,expires_at FROM role_gateway_enrollments WHERE token_hash=$1 FOR UPDATE',[digest(token)])).rows[0];
      if(!row){await this.#audit(client,{operation:'START_REJECTED',accepted:false,reason_code:'ENROLLMENT_INVALID'});await client.query('COMMIT');throw new Error('ENROLLMENT_INVALID');}
      if(row.status==='PENDING'&&new Date(row.expires_at).getTime()<=this.clock()){await client.query("UPDATE role_gateway_enrollments SET status='EXPIRED' WHERE enrollment_id=$1",[row.enrollment_id]);await this.#audit(client,{...row,operation:'START_REJECTED',accepted:false,reason_code:'ENROLLMENT_EXPIRED'});await client.query('COMMIT');throw new Error('ENROLLMENT_EXPIRED');}
      if(row.status!=='PENDING'){await this.#audit(client,{...row,operation:'START_REJECTED',accepted:false,reason_code:`ENROLLMENT_${row.status}`});await client.query('COMMIT');throw new Error(`ENROLLMENT_${row.status}`);}
      await this.#audit(client,{...row,operation:'OAUTH_STARTED',accepted:true,reason_code:'PENDING'});await client.query('COMMIT');
      return Object.freeze({enrollment_id:row.enrollment_id,actor_id:row.actor_id});
    }catch(error){if(!['ENROLLMENT_INVALID','ENROLLMENT_EXPIRED','ENROLLMENT_CONSUMED'].includes(error.message))await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async consume({enrollment_id,actor_id,human_fingerprint,issueCredentials=true}){
    if(!ACTOR_ROLES[actor_id]||!/^[a-f0-9]{64}$/.test(human_fingerprint??''))throw new Error('ENROLLMENT_INVALID');
    const client=await this.pool.connect(),nowMs=this.clock(),session_id=`ROLE_SESSION:${crypto.randomUUID()}`,access_jti=crypto.randomUUID(),refresh_token=randomToken();
    try{
      await client.query('BEGIN');
      const row=(await client.query('SELECT enrollment_id,actor_id,status,expires_at FROM role_gateway_enrollments WHERE enrollment_id=$1 FOR UPDATE',[enrollment_id])).rows[0];
      if(!row||row.actor_id!==actor_id)throw new Error('ENROLLMENT_ACTOR_MISMATCH');
      if(row.status==='PENDING'&&new Date(row.expires_at).getTime()<=nowMs){await client.query("UPDATE role_gateway_enrollments SET status='EXPIRED' WHERE enrollment_id=$1",[enrollment_id]);await this.#audit(client,{...row,operation:'CONSUME_REJECTED',accepted:false,reason_code:'ENROLLMENT_EXPIRED'});await client.query('COMMIT');throw new Error('ENROLLMENT_EXPIRED');}
      if(row.status!=='PENDING')throw new Error(`ENROLLMENT_${row.status}`);
      const access_expires_at=new Date(nowMs+ACCESS_TTL_SECONDS*1000),refresh_expires_at=new Date(nowMs+REFRESH_TTL_SECONDS*1000);
      await client.query("UPDATE role_gateway_enrollments SET status='CONSUMED',human_fingerprint=$2,consumed_at=$3 WHERE enrollment_id=$1",[enrollment_id,human_fingerprint,new Date(nowMs)]);
      if(issueCredentials)await client.query('INSERT INTO role_gateway_sessions(session_id,enrollment_id,actor_id,access_jti_hash,refresh_token_hash,created_at,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[session_id,enrollment_id,actor_id,digest(access_jti),digest(refresh_token),new Date(nowMs),access_expires_at,refresh_expires_at]);
      await this.#audit(client,{enrollment_id,session_id:issueCredentials?session_id:null,actor_id,operation:'CONSUMED',accepted:true,reason_code:issueCredentials?'SESSION_ISSUED':'MCP_AUTHORIZATION_REQUIRED'});await client.query('COMMIT');
      return issueCredentials?this.#tokenResult({session_id,actor_id,access_jti,refresh_token,nowMs,refresh_expires_at}):{result:'ENROLLMENT_PASS',actor_id,allowed_roles:ACTOR_ROLES[actor_id]};
    }catch(error){if(!['ENROLLMENT_EXPIRED'].includes(error.message))await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async authenticate(authorization){
    if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))return null;
    const token=authorization.slice(7),claims=this.#verify(token);if(!claims)return null;
    const row=(await this.pool.query('SELECT actor_id FROM role_gateway_sessions WHERE session_id=$1 AND actor_id=$2 AND access_jti_hash=$3 AND revoked_at IS NULL AND access_expires_at>now()',[claims.sid,claims.sub,digest(claims.jti)])).rows[0];
    if(!row)return null;return{actor_id:row.actor_id,allowed_roles:ACTOR_ROLES[row.actor_id],session_id:claims.sid,auth_kind:'bearer'};
  }

  async refresh(refresh_token){
    if(typeof refresh_token!=='string'||refresh_token.length<40||refresh_token.length>128)throw new Error('REFRESH_REJECTED');
    const client=await this.pool.connect(),nowMs=this.clock(),nextRefresh=randomToken(),access_jti=crypto.randomUUID();
    try{
      await client.query('BEGIN');
      const row=(await client.query('SELECT session_id,enrollment_id,actor_id,refresh_expires_at FROM role_gateway_sessions WHERE refresh_token_hash=$1 AND revoked_at IS NULL FOR UPDATE',[digest(refresh_token)])).rows[0];
      if(!row||new Date(row.refresh_expires_at).getTime()<=nowMs)throw new Error('REFRESH_REJECTED');
      const access_expires_at=new Date(nowMs+ACCESS_TTL_SECONDS*1000);
      await client.query('UPDATE role_gateway_sessions SET access_jti_hash=$2,refresh_token_hash=$3,access_expires_at=$4 WHERE session_id=$1',[row.session_id,digest(access_jti),digest(nextRefresh),access_expires_at]);
      await this.#audit(client,{...row,operation:'REFRESHED',accepted:true,reason_code:'ROTATED'});await client.query('COMMIT');
      return this.#tokenResult({session_id:row.session_id,actor_id:row.actor_id,access_jti,refresh_token:nextRefresh,nowMs,refresh_expires_at:row.refresh_expires_at});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async revoke(session_id){
    const row=(await this.pool.query('UPDATE role_gateway_sessions SET revoked_at=now() WHERE session_id=$1 AND revoked_at IS NULL RETURNING enrollment_id,actor_id',[session_id])).rows[0];
    if(!row)throw new Error('REVOCATION_REJECTED');await this.#audit(this.pool,{...row,session_id,operation:'REVOKED',accepted:true,reason_code:'SESSION_ONLY'});
  }

  #tokenResult({session_id,actor_id,access_jti,refresh_token,nowMs,refresh_expires_at}){
    const issued=Math.floor(nowMs/1000),claims={iss:this.baseUrl,aud:'cf2-role-interface',sub:actor_id,roles:ACTOR_ROLES[actor_id],sid:session_id,jti:access_jti,iat:issued,exp:issued+ACCESS_TTL_SECONDS};
    return{actor_id,allowed_roles:ACTOR_ROLES[actor_id],access_token:this.#sign(claims),access_token_expires_in:ACCESS_TTL_SECONDS,refresh_token,refresh_token_expires_at:new Date(refresh_expires_at).toISOString(),token_type:'Bearer'};
  }
  #sign(claims){const unsigned=`${b64({alg:'HS256',typ:'JWT'})}.${b64(claims)}`,signature=crypto.createHmac('sha256',this.signingKey).update(unsigned).digest('base64url');return`${unsigned}.${signature}`;}
  #verify(token){
    const parts=token.split('.');if(parts.length!==3)return null;const expected=crypto.createHmac('sha256',this.signingKey).update(`${parts[0]}.${parts[1]}`).digest('base64url');if(!safeEqual(parts[2],expected))return null;
    let claims;try{claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{return null;}const now=Math.floor(this.clock()/1000);
    if(claims.iss!==this.baseUrl||claims.aud!=='cf2-role-interface'||!ACTOR_ROLES[claims.sub]||!claims.sid||!claims.jti||!Number.isFinite(claims.exp)||claims.exp<=now)return null;return claims;
  }
  async #audit(client,{enrollment_id=null,session_id=null,actor_id=null,operation,accepted,reason_code}){await client.query('INSERT INTO role_gateway_enrollment_audit(event_id,enrollment_id,session_id,actor_id,operation,accepted,reason_code,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())',[`ENROLLMENT_AUDIT:${crypto.randomUUID()}`,enrollment_id,session_id,actor_id,operation,accepted,reason_code]);}
}

export function enrollmentPage(){return`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>CF2 Client Enrollment</title><p id="status">Preparing secure enrollment…</p><script>'use strict';(async()=>{const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);if(!token)throw new Error('ENROLLMENT_TOKEN_MISSING');const response=await fetch('/role/enroll/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enrollment_token:token})});const data=await response.json();if(!response.ok)throw new Error(data.error_code||'ENROLLMENT_REJECTED');location.assign(data.authorization_url)})().catch(()=>{document.getElementById('status').textContent='Enrollment rejected.'});</script>`;}
