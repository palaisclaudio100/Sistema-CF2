import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleOpenIdClient,OAUTH_SCOPES,ROLE_PRINCIPALS,RoleAuthorizer,parseRoleBindings} from '../src/google-role-gateway.mjs';
import crypto from 'node:crypto';

const fp=sub=>crypto.createHash('sha256').update(`google:${sub}`).digest('hex');

test('OAuth request uses only openid email profile, PKCE and nonce',()=>{
  const client=new GoogleOpenIdClient({clientId:'CLIENT',clientSecret:'SECRET',redirectUri:'https://cf2-prod-core.onrender.com/oauth/google/callback'});
  const url=new URL(client.authorizationUrl({state:'STATE',challenge:'CHALLENGE',nonce:'NONCE'}));
  assert.deepEqual(url.searchParams.get('scope').split(' '),OAUTH_SCOPES);
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.get('nonce'),'NONCE');
  assert.equal(url.searchParams.get('redirect_uri'),'https://cf2-prod-core.onrender.com/oauth/google/callback');
  assert.equal(url.searchParams.has('client_secret'),false);
});

test('bindings are server-side and Diego alone receives two roles',()=>{
  const bindings=parseRoleBindings(JSON.stringify({[fp('diego-sub')]:'ACTOR:DIEGO',[fp('chat-sub')]:'ACTOR:GABY_CHAT',[fp('cw-sub')]:'ACTOR:GABY_CW'}));
  const auth=new RoleAuthorizer(bindings),diego=auth.principal({sub:'diego-sub',email_verified:true}),chat=auth.principal({sub:'chat-sub',email_verified:true}),cw=auth.principal({sub:'cw-sub',email_verified:true});
  assert.deepEqual(diego.allowed_roles,ROLE_PRINCIPALS['ACTOR:DIEGO']);
  const matrix=[
    [diego,'DGA',true],[diego,'PRODUCTOR_MUSICAL',true],[diego,'GABY_CHAT',false],[diego,'GABY_CW_AUDIOVISUAL',false],[diego,'GABY_CW_DOCUMENTAL',false],
    [chat,'DGA',false],[chat,'PRODUCTOR_MUSICAL',false],[chat,'GABY_CHAT',true],[chat,'GABY_CW_AUDIOVISUAL',false],[chat,'GABY_CW_DOCUMENTAL',false],
    [cw,'DGA',false],[cw,'PRODUCTOR_MUSICAL',false],[cw,'GABY_CHAT',false],[cw,'GABY_CW_AUDIOVISUAL',true],[cw,'GABY_CW_DOCUMENTAL',true]
  ];
  for(const [principal,role,expected] of matrix)assert.equal(auth.authorize(principal,role),expected,`${principal.actor_id} -> ${role}`);
});

test('unbound, missing host identity, invalid maps and unverified email fail closed',()=>{
  const auth=new RoleAuthorizer(new Map());
  assert.equal(auth.principal({sub:'unknown',email_verified:true}),null);
  assert.equal(auth.principal({sub:'unknown',email_verified:false}),null);
  assert.equal(Object.hasOwn(ROLE_PRINCIPALS,'ACTOR:CF2_CUTOVER_EXECUTOR'),false);
  assert.throws(()=>parseRoleBindings('{bad'),/ROLE_BINDINGS_INVALID/);
  assert.throws(()=>parseRoleBindings(JSON.stringify({bad:'ACTOR:DIEGO'})),/ROLE_BINDINGS_INVALID/);
});

test('source contains no token logging and forbids client actor declarations',async()=>{
  const fs=await import('node:fs/promises'),source=await fs.readFile(new URL('../src/google-role-gateway.mjs',import.meta.url),'utf8');
  assert.match(source,/body\.actor_id\|\|body\.actor_role/);
  assert.match(source,/ROLE_FORBIDDEN/);
  assert.match(source,/session\.revoked=true/);
  assert.doesNotMatch(source,/console\./);
  assert.doesNotMatch(source,/JSON\.stringify\(tokens\)/);
  assert.doesNotMatch(source,/json\(response,\s*\d+,\s*tokens\)/);
});
