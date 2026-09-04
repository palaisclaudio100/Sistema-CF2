import test from 'node:test';
import assert from 'node:assert/strict';
import {MCP_ACTOR_ROLES,MCP_PROTOCOL_VERSION,MCP_SCOPE,MCP_TOOLS,RemoteMcpServer,resourceActor,validRedirectUri} from '../src/remote-mcp.mjs';
import {ProductionRoleInterface} from '../src/production-role-interface.mjs';

test('resource URLs fix each actor server-side and reject client-selected variants',()=>{
  const base='https://cf2-prod-core.onrender.com';
  assert.equal(resourceActor(base,`${base}/mcp/gaby-chat`),'ACTOR:GABY_CHAT');
  assert.equal(resourceActor(base,`${base}/mcp/gaby-cw`),'ACTOR:GABY_CW');
  assert.equal(resourceActor(base,`${base}/mcp/diego`),'ACTOR:DIEGO');
  assert.equal(resourceActor(base,`${base}/mcp?actor_id=ACTOR:GABY_CHAT`),null);
  assert.equal(resourceActor(base,'https://attacker.example/mcp/gaby-chat'),null);
});

test('OAuth metadata is PKCE-only public-client compatible and redirect validation is closed',()=>{
  const store={pool:{}},server=new RemoteMcpServer(store,{baseUrl:'https://cf2-prod-core.onrender.com',roleInterface:{}}),metadata=server.authorizationMetadata();
  assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['none']);assert.equal(metadata.scopes_supported[0],MCP_SCOPE);
  assert.equal(validRedirectUri('https://claude.ai/api/mcp/auth_callback'),true);assert.equal(validRedirectUri('http://127.0.0.1:3456/callback'),true);assert.equal(validRedirectUri('http://attacker.example/callback'),false);
  assert.equal(validRedirectUri('https://user:password@client.example/callback'),false);assert.equal(validRedirectUri('https://client.example/callback#fragment'),false);
});

test('MCP exposes exactly the five authorized operations',()=>assert.deepEqual(MCP_TOOLS.map(tool=>tool.name),['get_my_tasks','get_task','submit_task_command','submit_verification','get_status']));

const dgaReadFixture=()=>{
  const tasks=[
    {id:'TASK:READ:DGA',type:'TASK',status:'OPEN',state:'OPEN',responsible_role:'DGA'},
    {id:'TASK:READ:GABY_CHAT',type:'TASK',status:'OPEN',state:'OPEN',responsible_role:'GABY_CHAT'}
  ];
  const pool={query:async sql=>{
    if(sql.includes('FROM mcp_oauth_sessions'))return{rows:[{actor_id:'ACTOR:DIEGO'}]};
    if(sql.includes("FROM objects WHERE type='TASK' ORDER BY"))return{rows:tasks.map(body=>({body}))};
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  }};
  const store={pool,getObject:async id=>tasks.find(task=>task.id===id)??null};
  const server=new RemoteMcpServer(store,{baseUrl:'https://cf2-prod-core.onrender.com',roleInterface:{}});
  const call=async(name,args)=>{
    let body='';const response={writeHead(){return this;},end(value=''){body=value;return this;}};
    const request={method:'POST',headers:{authorization:'Bearer read-only-test','mcp-protocol-version':MCP_PROTOCOL_VERSION},socket:{remoteAddress:'127.0.0.1'}};
    await server.handleMcp(request,response,new URL('https://cf2-prod-core.onrender.com/mcp/diego'),async()=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}));
    return JSON.parse(body).result.structuredContent;
  };
  return{call};
};

test('OWN-01 Diego retains global task visibility through get_my_tasks',async()=>{const {call}=dgaReadFixture(),result=await call('get_my_tasks',{limit:10});assert.equal(result.result,'PASS');assert.deepEqual(new Set(result.tasks.map(task=>task.responsible_role)),new Set(['DGA','GABY_CHAT']));});
test('OWN-02 Diego retains direct read access to a GABY_CHAT task',async()=>{const {call}=dgaReadFixture(),result=await call('get_task',{task_id:'TASK:READ:GABY_CHAT'});assert.equal(result.result,'PASS');assert.equal(result.task.responsible_role,'GABY_CHAT');});

test('operational RoleInterface injects identity and rejects cross-role or impersonation',async()=>{
  const submitted=[],store={writer:async()=> 'CF2_WRITER',getObject:async()=>null,hasProof:async()=>false,submitCommand:async command=>(submitted.push(command),{accepted:true,resulting_state_version:9})},roles=new ProductionRoleInterface(store),chat={actor_id:'ACTOR:GABY_CHAT',allowed_roles:MCP_ACTOR_ROLES['ACTOR:GABY_CHAT']};
  const base={command_id:'COMMAND:X',command_type:'CREATE_TASK',idempotency_key:'IDEMPOTENCY:X',payload:{object:{id:'TASK:X',type:'TASK',state:'OPEN',status:'OPEN',responsible_role:'GABY_CHAT',created_at:'2026-09-03T00:00:00Z',updated_at:'2026-09-03T00:00:00Z',basis_ref:['TEST'],action:'TEST',related_ids:[]}}};
  assert.equal((await roles.submitRoleCommand({principal:chat,acting_role:'GABY_CHAT',command:base})).accepted,true);assert.equal(submitted[0].actor_id,'ACTOR:GABY_CHAT');assert.equal(submitted[0].actor_role,'GABY_CHAT');
  assert.equal((await roles.submitRoleCommand({principal:chat,acting_role:'GABY_CW_AUDIOVISUAL',command:base})).reason_code,'ROLE_FORBIDDEN');
  assert.equal((await roles.submitRoleCommand({principal:chat,acting_role:'GABY_CHAT',command:{...base,actor_id:'ACTOR:DIEGO'}})).reason_code,'ACTOR_MISMATCH');
  const cw={actor_id:'ACTOR:GABY_CW',allowed_roles:MCP_ACTOR_ROLES['ACTOR:GABY_CW']};assert.equal((await roles.submitRoleCommand({principal:cw,acting_role:'GABY_CHAT',command:base})).reason_code,'ROLE_FORBIDDEN');
});

test('protocol, roles and browser-token boundary are explicit in source',async()=>{
  const fs=await import('node:fs/promises'),gateway=await fs.readFile(new URL('../src/google-role-gateway.mjs',import.meta.url),'utf8');
  assert.equal(MCP_PROTOCOL_VERSION,'2025-06-18');assert.deepEqual(MCP_ACTOR_ROLES['ACTOR:GABY_CW'],['GABY_CW_AUDIOVISUAL','GABY_CW_DOCUMENTAL']);
  assert.match(gateway,/issueCredentials:false/);assert.doesNotMatch(gateway,/enrollmentConfirmation\([\s\S]{0,120}access_token/);
});
