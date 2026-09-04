import test from 'node:test';
import assert from 'node:assert/strict';
import {MCP_ACTOR_ROLES,MCP_PROTOCOL_VERSION,MCP_SCOPE,RemoteMcpServer,mcpToolsFor,resourceActor,validRedirectUri} from '../src/remote-mcp.mjs';
import {ProductionRoleInterface} from '../src/production-role-interface.mjs';
import {validateWriterToolArgs} from '../src/writer-contract.mjs';

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

test('MCP exposes exactly the five authorized operations',()=>assert.deepEqual(mcpToolsFor({allowed_roles:['DGA','PRODUCTOR_MUSICAL']}).map(tool=>tool.name),['get_my_tasks','get_task','submit_task_command','submit_verification','get_status']));

const endpointByActor={
  'ACTOR:DIEGO':'/mcp/diego',
  'ACTOR:GABY_CHAT':'/mcp/gaby-chat',
  'ACTOR:GABY_CW':'/mcp/gaby-cw',
  'ACTOR:CODEX':'/mcp/codex'
};
const toolsListFor=async actor_id=>{
  const pool={query:async sql=>{if(sql.includes('FROM mcp_oauth_sessions'))return{rows:[{actor_id}]};throw new Error(`UNEXPECTED_QUERY:${sql}`);}};
  const server=new RemoteMcpServer({pool},{baseUrl:'https://cf2-prod-core.onrender.com',roleInterface:{}});
  let body='';const response={writeHead(){return this;},end(value=''){body=value;return this;}};
  const request={method:'POST',headers:{authorization:'Bearer schema-test','mcp-protocol-version':MCP_PROTOCOL_VERSION},socket:{remoteAddress:'127.0.0.1'}};
  await server.handleMcp(request,response,new URL(`https://cf2-prod-core.onrender.com${endpointByActor[actor_id]}`),async()=>({jsonrpc:'2.0',id:1,method:'tools/list'}));
  return JSON.parse(body).result.tools;
};
const writerEnums=tools=>tools.filter(tool=>tool.name.startsWith('submit_')).map(tool=>tool.inputSchema.properties.acting_role.enum);
const stamp='2026-09-04T00:00:00.000Z';
const chatTaskCommand={command_id:'COMMAND:SCHEMA:GABY:CREATE',command_type:'CREATE_TASK',idempotency_key:'schema-gaby-create',payload:{object:{id:'TASK:SCHEMA:GABY',type:'TASK',status:'OPEN',created_at:stamp,updated_at:stamp,basis_ref:['PROOF:SCHEMA'],action:'SCHEMA_TEST',state:'OPEN',responsible_role:'GABY_CHAT',related_ids:[]}}};
const chatVerificationCommand={command_id:'COMMAND:SCHEMA:GABY:VERIFY',command_type:'RECORD_VERIFICATION',idempotency_key:'schema-gaby-verify',payload:{object:{id:'VERIFICATION:SCHEMA:GABY',type:'VERIFICATION',status:'CURRENT',created_at:stamp,updated_at:stamp,basis_ref:['PROOF:SCHEMA'],subject_id:'TASK:SCHEMA:GABY',attribute:'SCHEMA_TEST',value:true,class:'FIJO',verified_at:stamp,evidence_ref:'PROOF:SCHEMA'}}};

test('MULTI-01 Diego tools/list publishes exactly DGA and PRODUCTOR_MUSICAL',async()=>{for(const roles of writerEnums(await toolsListFor('ACTOR:DIEGO')))assert.deepEqual(roles,['DGA','PRODUCTOR_MUSICAL']);});
test('MULTI-02 Gaby Chat tools/list publishes only GABY_CHAT',async()=>{for(const roles of writerEnums(await toolsListFor('ACTOR:GABY_CHAT')))assert.deepEqual(roles,['GABY_CHAT']);});
test('MULTI-02B Codex publishes TASK tools without verification',async()=>{const tools=await toolsListFor('ACTOR:CODEX');assert.deepEqual(tools.map(tool=>tool.name),['get_my_tasks','get_task','submit_task_command','get_status']);for(const roles of writerEnums(tools))assert.deepEqual(roles,['CODEX']);});
test('MULTI-03 Gaby Chat can construct a valid submit_task_command',async()=>{const tools=await toolsListFor('ACTOR:GABY_CHAT'),schema=tools.find(tool=>tool.name==='submit_task_command').inputSchema;assert.deepEqual(schema.properties.acting_role.enum,['GABY_CHAT']);assert.equal(validateWriterToolArgs('submit_task_command',{acting_role:'GABY_CHAT',command:chatTaskCommand},['GABY_CHAT']),true);});
test('MULTI-04 Gaby Chat can construct a valid submit_verification',async()=>{const tools=await toolsListFor('ACTOR:GABY_CHAT'),schema=tools.find(tool=>tool.name==='submit_verification').inputSchema;assert.deepEqual(schema.properties.acting_role.enum,['GABY_CHAT']);assert.equal(validateWriterToolArgs('submit_verification',{acting_role:'GABY_CHAT',command:chatVerificationCommand},['GABY_CHAT']),true);});
test('MULTI-05 Gaby Chat cannot act as DGA',()=>assert.equal(validateWriterToolArgs('submit_task_command',{acting_role:'DGA',command:chatTaskCommand},['GABY_CHAT']),false));
test('MULTI-06 Diego cannot act as GABY_CHAT',()=>assert.equal(validateWriterToolArgs('submit_task_command',{acting_role:'GABY_CHAT',command:chatTaskCommand},MCP_ACTOR_ROLES['ACTOR:DIEGO']),false));
test('MULTI-07 cross-role ownership remains rejected without a store write',async()=>{let writes=0;const store={replayCommand:async()=>null,getObject:async()=>chatTaskCommand.payload.object,hasProof:async()=>true,writer:async()=> 'CF2_WRITER',submitCommand:async()=>{writes++;return{accepted:true};}},roles=new ProductionRoleInterface(store),principal={actor_id:'ACTOR:DIEGO',allowed_roles:MCP_ACTOR_ROLES['ACTOR:DIEGO']},command={command_id:'COMMAND:SCHEMA:DGA:TRANSITION',command_type:'TRANSITION_TASK',idempotency_key:'schema-dga-transition',payload:{task_id:'TASK:SCHEMA:GABY',state:'CANCELLED'}};assert.equal((await roles.submitRoleCommand({principal,acting_role:'DGA',command})).reason_code,'ROLE_FORBIDDEN');assert.equal(writes,0);});
test('MULTI-08 every existing endpoint schema matches its principal roles',async()=>{for(const [actor_id,allowed_roles] of Object.entries(MCP_ACTOR_ROLES))for(const roles of writerEnums(await toolsListFor(actor_id)))assert.deepEqual(roles,allowed_roles);});
test('MULTI-09 sequential principals do not reuse another schema',async()=>{const diego=await toolsListFor('ACTOR:DIEGO'),chat=await toolsListFor('ACTOR:GABY_CHAT'),cw=await toolsListFor('ACTOR:GABY_CW');for(const roles of writerEnums(diego))assert.deepEqual(roles,['DGA','PRODUCTOR_MUSICAL']);for(const roles of writerEnums(chat))assert.deepEqual(roles,['GABY_CHAT']);for(const roles of writerEnums(cw))assert.deepEqual(roles,['GABY_CW_AUDIOVISUAL','GABY_CW_DOCUMENTAL']);assert.notEqual(diego[2].inputSchema,chat[2].inputSchema);});

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
