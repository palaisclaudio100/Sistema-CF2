import crypto from 'node:crypto';

export const OAUTH_SCOPES=Object.freeze(['openid','email','profile']);
export const ROLE_PRINCIPALS=Object.freeze({
  'ACTOR:DIEGO':Object.freeze(['DGA','PRODUCTOR_MUSICAL']),
  'ACTOR:GABY_CHAT':Object.freeze(['GABY_CHAT']),
  'ACTOR:GABY_CW':Object.freeze(['GABY_CW_AUDIOVISUAL','GABY_CW_DOCUMENTAL'])
});

const b64url=value=>Buffer.from(value,'base64url');
const fingerprint=sub=>crypto.createHash('sha256').update(`google:${sub}`).digest('hex');
const sessionHash=token=>crypto.createHash('sha256').update(token).digest('hex');
const json=(response,status,value,headers={})=>response.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers}).end(JSON.stringify(value));
const cookie=request=>Object.fromEntries((request.headers.cookie??'').split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const i=part.indexOf('=');return i<0?[part,'']:[part.slice(0,i),part.slice(i+1)];}));
const safeEqual=(left,right)=>{const a=Buffer.from(left??''),b=Buffer.from(right??'');return a.length===b.length&&crypto.timingSafeEqual(a,b);};

export function parseRoleBindings(raw){
  if(!raw)return new Map();
  let value;try{value=JSON.parse(raw);}catch{throw new Error('ROLE_BINDINGS_INVALID');}
  if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('ROLE_BINDINGS_INVALID');
  const result=new Map();
  for(const [key,actor_id] of Object.entries(value)){
    if(!/^[a-f0-9]{64}$/.test(key)||!ROLE_PRINCIPALS[actor_id])throw new Error('ROLE_BINDINGS_INVALID');
    result.set(key,Object.freeze({actor_id,allowed_roles:ROLE_PRINCIPALS[actor_id]}));
  }
  return result;
}

export class RoleAuthorizer{
  constructor(bindings){this.bindings=bindings;}
  principal(claims){if(!claims?.sub||claims.email_verified!==true)return null;return this.bindings.get(fingerprint(claims.sub))??null;}
  authorize(principal,acting_role){return Boolean(principal?.allowed_roles?.includes(acting_role));}
}

export class GoogleOpenIdClient{
  constructor({clientId,clientSecret,redirectUri,fetchImpl=globalThis.fetch,clock=()=>Date.now()}){this.clientId=clientId;this.clientSecret=clientSecret;this.redirectUri=redirectUri;this.fetch=fetchImpl;this.clock=clock;}
  configured(){return Boolean(this.clientId&&this.clientSecret&&this.redirectUri);}
  authorizationUrl({state,challenge,nonce}){const q=new URLSearchParams({client_id:this.clientId,redirect_uri:this.redirectUri,response_type:'code',scope:OAUTH_SCOPES.join(' '),state,nonce,code_challenge:challenge,code_challenge_method:'S256',access_type:'online',prompt:'select_account'});return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;}
  async exchange(code,verifier){const body=new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,redirect_uri:this.redirectUri,grant_type:'authorization_code',code,code_verifier:verifier});const response=await this.fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});if(!response.ok)throw new Error('OAUTH_EXCHANGE_FAILED');const tokens=await response.json();if(!tokens.id_token)throw new Error('ID_TOKEN_MISSING');return tokens.id_token;}
  async verify(idToken,nonce){
    const parts=idToken.split('.');if(parts.length!==3)throw new Error('ID_TOKEN_INVALID');
    let header,claims;try{header=JSON.parse(b64url(parts[0]));claims=JSON.parse(b64url(parts[1]));}catch{throw new Error('ID_TOKEN_INVALID');}
    if(header.alg!=='RS256'||!header.kid)throw new Error('ID_TOKEN_INVALID');
    const response=await this.fetch('https://www.googleapis.com/oauth2/v3/certs',{headers:{accept:'application/json'}});if(!response.ok)throw new Error('JWKS_UNAVAILABLE');const jwks=await response.json(),jwk=jwks.keys?.find(key=>key.kid===header.kid&&key.kty==='RSA');if(!jwk)throw new Error('ID_TOKEN_INVALID');
    const valid=crypto.verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),crypto.createPublicKey({key:jwk,format:'jwk'}),b64url(parts[2]));
    const now=Math.floor(this.clock()/1000),audience=Array.isArray(claims.aud)?claims.aud:[claims.aud];
    if(!valid||!['https://accounts.google.com','accounts.google.com'].includes(claims.iss)||!audience.includes(this.clientId)||!Number.isFinite(claims.exp)||!Number.isFinite(claims.iat)||claims.exp<=now||claims.iat>now+60||claims.nonce!==nonce||!claims.sub)throw new Error('ID_TOKEN_INVALID');
    return claims;
  }
}

export class ProductionRoleGateway{
  constructor(store,{clientId,clientSecret,baseUrl,bindings,fetchImpl,clock=()=>Date.now()}={}){
    this.store=store;this.clock=clock;this.states=new Map();this.sessions=new Map();this.authorizer=new RoleAuthorizer(parseRoleBindings(bindings));
    this.oauth=new GoogleOpenIdClient({clientId,clientSecret,redirectUri:`${baseUrl}/oauth/google/callback`,fetchImpl,clock});
  }
  health(){return{oauth:this.oauth.configured()?'READY':'NOT_READY',binding_count:this.authorizer.bindings.size,scopes:OAUTH_SCOPES,redirect_uri:this.oauth.redirectUri};}
  #prune(){const now=this.clock();for(const [key,value] of this.states)if(value.expires<=now)this.states.delete(key);for(const [key,value] of this.sessions)if(value.expires<=now||value.revoked)this.sessions.delete(key);}
  #session(request){this.#prune();const token=cookie(request)['__Host-cf2_role_session'];if(!token)return null;return this.sessions.get(sessionHash(token))??null;}
  async #audit({principal,acting_role,operation,authorized,reason_code,object_id=null}){await this.store.pool.query('INSERT INTO role_gateway_audit(event_id,actor_id,acting_role,operation,authorized,reason_code,object_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())',[`ROLE_GATE:${crypto.randomUUID()}`,principal?.actor_id??'UNAUTHENTICATED',acting_role??null,operation,authorized,reason_code,object_id]);}
  async #deny(response,status,reason,context={}){await this.#audit({...context,authorized:false,reason_code:reason});return json(response,status,{result:'FAIL_CLOSED',error_code:reason});}
  async handle(request,response,url,readBody){
    if(!url.pathname.startsWith('/oauth/google/')&&!url.pathname.startsWith('/role/'))return false;
    if(request.method==='GET'&&url.pathname==='/oauth/google/start'){
      if(!this.oauth.configured())return json(response,503,{result:'OAUTH_NOT_CONFIGURED'}),true;
      this.#prune();const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(48).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url'),nonce=crypto.randomBytes(32).toString('base64url');this.states.set(state,{verifier,nonce,expires:this.clock()+600_000});response.writeHead(302,{location:this.oauth.authorizationUrl({state,challenge,nonce}),'cache-control':'no-store'}).end();return true;
    }
    if(request.method==='GET'&&url.pathname==='/oauth/google/callback'){
      const state=url.searchParams.get('state'),entry=this.states.get(state);this.states.delete(state);if(!entry||entry.expires<=this.clock()||!url.searchParams.get('code'))return json(response,400,{result:'FAIL_CLOSED',error_code:'OAUTH_STATE_INVALID'}),true;
      try{const token=await this.oauth.exchange(url.searchParams.get('code'),entry.verifier),claims=await this.oauth.verify(token,entry.nonce),principal=this.authorizer.principal(claims),principal_fingerprint=fingerprint(claims.sub);if(!principal)return json(response,403,{result:'UNBOUND_PRINCIPAL',principal_fingerprint}),true;const raw=crypto.randomBytes(48).toString('base64url'),csrf=crypto.randomBytes(32).toString('base64url');this.sessions.set(sessionHash(raw),{...principal,csrf,expires:this.clock()+3_600_000,revoked:false});return json(response,200,{result:'OAUTH_PASS',actor_id:principal.actor_id,allowed_roles:principal.allowed_roles,csrf_token:csrf},{'set-cookie':`__Host-cf2_role_session=${raw}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`}),true;}catch(error){const code=['OAUTH_EXCHANGE_FAILED','ID_TOKEN_MISSING','ID_TOKEN_INVALID','JWKS_UNAVAILABLE'].includes(error?.message)?error.message:'OAUTH_FAILED';return json(response,401,{result:'FAIL_CLOSED',error_code:code}),true;}
    }
    const session=this.#session(request);if(!session)return await this.#deny(response,401,'AUTHENTICATION_REQUIRED',{operation:url.pathname}),true;
    if(request.method==='GET'&&url.pathname==='/role/whoami')return json(response,200,{result:'PASS',actor_id:session.actor_id,allowed_roles:session.allowed_roles,csrf_token:session.csrf}),true;
    if(request.method==='POST'&&url.pathname==='/role/logout'){if(!safeEqual(request.headers['x-cf2-csrf'],session.csrf))return await this.#deny(response,403,'CSRF_REJECTED',{principal:session,operation:'LOGOUT'}),true;session.revoked=true;return json(response,200,{result:'REVOKED'},{'set-cookie':'__Host-cf2_role_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'}),true;}
    if(request.method==='POST'&&url.pathname==='/role/objects'){
      if(!safeEqual(request.headers['x-cf2-csrf'],session.csrf))return await this.#deny(response,403,'CSRF_REJECTED',{principal:session,operation:'WRITE'}),true;
      let body;try{body=await readBody(request);if(!body||Array.isArray(body)||typeof body!=='object')throw new Error('INVALID_SCHEMA');}catch{return await this.#deny(response,400,'INVALID_SCHEMA',{principal:session,operation:'WRITE'}),true;}
      if(body.actor_id||body.actor_role||body.object?.actor_id||body.object?.actor_role)return await this.#deny(response,403,'ACTOR_MISMATCH',{principal:session,acting_role:body.acting_role,operation:'WRITE'}),true;
      if(!this.authorizer.authorize(session,body.acting_role))return await this.#deny(response,403,'ROLE_FORBIDDEN',{principal:session,acting_role:body.acting_role,operation:'WRITE'}),true;
      const object=body.object??{},isChat=session.actor_id==='ACTOR:GABY_CHAT'&&body.acting_role==='GABY_CHAT'&&object.type==='TASK'&&object.id?.startsWith('TASK:GATE:ROLE_IDENTITY:')&&object.responsible_role==='GABY_CHAT';
      const isCw=session.actor_id==='ACTOR:GABY_CW'&&body.acting_role.startsWith('GABY_CW_')&&object.type==='VERIFICATION'&&object.id?.startsWith('VERIFICATION:GATE:ROLE_IDENTITY:');
      if(!object.synthetic_gate||(!isChat&&!isCw))return await this.#deny(response,403,'ROLE_FORBIDDEN',{principal:session,acting_role:body.acting_role,operation:'WRITE'}),true;
      const stored={...object,actor_id:session.actor_id,acting_role:body.acting_role,external_effects:0};if(isCw)stored.verified_by=session.actor_id;
      try{await this.store.pool.query('INSERT INTO role_gateway_objects(object_id,object_type,body,actor_id,acting_role,created_at) VALUES($1,$2,$3::jsonb,$4,$5,now())',[stored.id,stored.type,JSON.stringify(stored),session.actor_id,body.acting_role]);}catch{return await this.#deny(response,409,'OBJECT_CONFLICT',{principal:session,acting_role:body.acting_role,operation:'WRITE',object_id:stored.id}),true;}
      await this.#audit({principal:session,acting_role:body.acting_role,operation:'WRITE',authorized:true,reason_code:'ACCEPTED',object_id:stored.id});return json(response,201,{result:'ACCEPTED',object_id:stored.id,actor_id:session.actor_id,acting_role:body.acting_role,external_effects:0}),true;
    }
    if(request.method==='GET'&&url.pathname.startsWith('/role/objects/')){
      const acting_role=request.headers['x-cf2-acting-role'];if(!this.authorizer.authorize(session,acting_role)||session.actor_id!=='ACTOR:DIEGO'||acting_role!=='DGA')return await this.#deny(response,403,'ROLE_FORBIDDEN',{principal:session,acting_role,operation:'READ'}),true;
      const object_id=decodeURIComponent(url.pathname.slice('/role/objects/'.length)),row=(await this.store.pool.query('SELECT body FROM role_gateway_objects WHERE object_id=$1',[object_id])).rows[0];await this.#audit({principal:session,acting_role,operation:'READ',authorized:true,reason_code:'ACCEPTED',object_id});return json(response,row?200:404,row?{result:'PASS',object:row.body}:{result:'UNKNOWN'}),true;
    }
    return await this.#deny(response,404,'NOT_FOUND',{principal:session,operation:url.pathname}),true;
  }
}
