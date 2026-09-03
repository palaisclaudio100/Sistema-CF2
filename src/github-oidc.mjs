import crypto from 'node:crypto';

export const GITHUB_OIDC_ISSUER='https://token.actions.githubusercontent.com';
export const CUTOVER_AUDIENCE='cf2-prod-role-interface';
export const CUTOVER_PRINCIPAL=Object.freeze({actor_id:'ACTOR:CF2_CUTOVER_EXECUTOR',actor_role:'AUTOMATION_EXECUTOR',actor_kind:'AUTOMATION_EXECUTOR'});
const decode=value=>JSON.parse(Buffer.from(value,'base64url').toString('utf8'));

export class OidcError extends Error{constructor(code='AUTH_REJECTED'){super(code);this.reason_code=code;}}

export class GitHubOidcAuthenticator{
  constructor({repository,repositoryId,workflowRef,ref,audience=CUTOVER_AUDIENCE,fetchImpl=fetch,now=()=>Math.floor(Date.now()/1000)}={}){
    if(!repository||!repositoryId||!workflowRef||!ref)throw new OidcError();
    Object.assign(this,{repository,repositoryId:String(repositoryId),workflowRef,ref,audience,fetchImpl,now});this.jwks=null;
  }
  async #keys(){
    if(this.jwks)return this.jwks;
    const config=await (await this.fetchImpl(`${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`)).json();
    if(config.issuer!==GITHUB_OIDC_ISSUER||typeof config.jwks_uri!=='string'||!config.jwks_uri.startsWith(`${GITHUB_OIDC_ISSUER}/`))throw new OidcError();
    const keys=await (await this.fetchImpl(config.jwks_uri)).json();if(!Array.isArray(keys.keys))throw new OidcError();return(this.jwks=keys.keys);
  }
  async authenticate(token){
    try{
      if(typeof token!=='string'||token.split('.').length!==3)throw new OidcError();
      const [encodedHeader,encodedPayload,signature]=token.split('.'),header=decode(encodedHeader),claims=decode(encodedPayload);
      if(header.alg!=='RS256'||!header.kid)throw new OidcError();
      const jwk=(await this.#keys()).find(key=>key.kid===header.kid&&key.kty==='RSA');if(!jwk)throw new OidcError();
      const valid=crypto.verify('RSA-SHA256',Buffer.from(`${encodedHeader}.${encodedPayload}`),crypto.createPublicKey({key:jwk,format:'jwk'}),Buffer.from(signature,'base64url'));if(!valid)throw new OidcError();
      const now=this.now(),audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
      if(claims.iss!==GITHUB_OIDC_ISSUER||!audiences.includes(this.audience)||typeof claims.exp!=='number'||claims.exp<=now||typeof claims.iat!=='number'||claims.iat>now+60||(claims.nbf!==undefined&&claims.nbf>now)||claims.repository!==this.repository||String(claims.repository_id)!==this.repositoryId||claims.workflow_ref!==this.workflowRef||claims.ref!==this.ref)throw new OidcError();
      return {...CUTOVER_PRINCIPAL,claims_fingerprint:crypto.createHash('sha256').update(`${claims.repository_id}|${claims.workflow_ref}|${claims.ref}|${claims.run_id??''}`).digest('hex')};
    }catch(error){if(error instanceof OidcError)throw error;throw new OidcError();}
  }
}
