import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteMcpServer,MCP_ACTOR_ROLES} from '../src/remote-mcp.mjs';
import {ActorTransport} from '../src/actor-transport.mjs';
import {OrchestrationApi,orchestrationTools} from '../src/orchestration-api.mjs';

const D='ACTOR:DIEGO',G='ACTOR:GABY_CHAT',C='ACTOR:GABY_CW';
function fixture(){
  const rows=new Map();
  const repo={
    async create(t){if(rows.has(t.thread_id))throw new Error('THREAD_ALREADY_EXISTS');rows.set(t.thread_id,structuredClone(t));return t;},
    async read(id){return structuredClone(rows.get(id));},
    async change(id,fn){const t=await fn(await this.read(id));rows.set(id,structuredClone(t));return t;}
  };
  let actor=D,legacyCalls=0;
  const pool={query:async()=>({rows:[{actor_id:actor}]})};
  const transport=new ActorTransport(repo),orchestration=new OrchestrationApi(transport,{});
  const server=new RemoteMcpServer({pool},{baseUrl:'https://cf2.example',orchestration,roleInterface:{submitRoleCommand:async()=>{legacyCalls++;return{accepted:false,reason_code:'ROLE_FORBIDDEN'};}}});
  async function rpc(method,params={},as=D){
    actor=as;let body;
    const response={writeHead(){return this;},end(value){body=value;}};
    await server.handleMcp({method:'POST',headers:{authorization:'Bearer client-session'}},response,new URL(`https://cf2.example/mcp/${as===D?'diego':as===G?'gaby-chat':'gaby-cw'}`),async()=>({jsonrpc:'2.0',id:1,method,params}));
    return JSON.parse(body).result;
  }
  const call=async(name,args,as=D)=>(await rpc('tools/call',{name,arguments:args},as)).structuredContent;
  return{rpc,call,transport,legacyCalls:()=>legacyCalls};
}
const start={thread_id:'THREAD:TEST:REAL_CLIENT_CONTRACT',stages:[G,C],payload:{brief:'Unit fixture: not production acceptance'}};
const command=(type,payload)=>({acting_role:'DGA',command:{command_type:type,payload}});

test('configured Diego MCP tools/list publishes callable orchestration and the compatible public command schemas',async()=>{
  const f=fixture(),tools=(await f.rpc('tools/list')).tools;
  for(const tool of orchestrationTools)assert.deepEqual(tools.find(t=>t.name===tool.name),tool);
  const variants=tools.find(t=>t.name==='submit_task_command').inputSchema.properties.command.oneOf;
  assert.deepEqual(variants.map(v=>v.properties.command_type.const),['CREATE_TASK','TRANSITION_TASK','START_WORKFLOW','CONTROL_WORKFLOW']);
  const result=await f.call('start_workflow',start);
  assert.equal(result.initiator,D);assert.equal(result.messages[0].recipient,G);
});

test('existing client command starts the same workflow and get_task returns automatic responses and closure',async()=>{
  const f=fixture(),accepted=await f.call('submit_task_command',command('START_WORKFLOW',start));
  assert.equal(accepted.accepted,true);assert.equal(accepted.actor_id,D);assert.equal(f.legacyCalls(),0);
  for(const actor_id of [G,C]){
    const t=await f.transport.read({actor_id:D},start.thread_id),request=t.messages.find(m=>m.recipient===actor_id&&m.state==='PENDING');
    await f.transport.reply({actor_id},{thread_id:t.thread_id,message_id:request.message_id,type:'RESPONSE',payload:{unit_fixture:true}});
  }
  const result=await f.call('get_task',{task_id:start.thread_id});
  assert.equal(result.workflow.state,'READY_TO_CLOSE');
  assert.deepEqual(result.workflow.messages.filter(m=>m.type==='RESPONSE').map(m=>[m.sender,m.recipient]),[[G,D],[C,D]]);
  const closed=await f.call('submit_task_command',command('CONTROL_WORKFLOW',{thread_id:start.thread_id,operation:'CLOSE'}));
  assert.equal(closed.workflow.state,'CLOSED');
  assert.equal((await f.call('get_task',{task_id:start.thread_id})).workflow.state,'CLOSED');
});

test('workflow command rejects actor spoofing, wrong acting role and unauthorized actors before mutation',async()=>{
  const f=fixture();
  assert.equal((await f.call('submit_task_command',{...command('START_WORKFLOW',start),actor_id:D})).error_code,'INVALID_SCHEMA');
  assert.equal((await f.call('submit_task_command',command('START_WORKFLOW',{...start,actor_id:D}))).error_code,'INVALID_SCHEMA');
  assert.equal((await f.call('submit_task_command',{...command('START_WORKFLOW',start),acting_role:'PRODUCTOR_MUSICAL'})).error_code,'ROLE_FORBIDDEN');
  assert.equal((await f.call('submit_task_command',command('START_WORKFLOW',start),G)).error_code,'ROLE_FORBIDDEN');
  assert.equal((await f.call('get_task',{task_id:start.thread_id})).error_code,'THREAD_UNKNOWN');
  assert.equal(f.legacyCalls(),0);
});

test('workflow read preserves participation ACL and rejects an early close or duplicate dispatch',async()=>{
  const f=fixture();await f.call('submit_task_command',command('START_WORKFLOW',start));
  assert.equal((await f.call('get_task',{task_id:start.thread_id},C)).error_code,'ROLE_FORBIDDEN');
  assert.equal((await f.call('submit_task_command',command('CONTROL_WORKFLOW',{thread_id:start.thread_id,operation:'CLOSE'}))).error_code,'THREAD_NOT_COMPLETE');
  assert.equal((await f.call('submit_task_command',command('START_WORKFLOW',start))).error_code,'THREAD_ALREADY_EXISTS');
  assert.equal((await f.call('get_task',{task_id:start.thread_id})).workflow.messages.length,1);
  const names=(await f.rpc('tools/list',{},G)).tools.map(t=>t.name);
  assert.equal(names.includes('control_workflow'),false);
  assert.deepEqual(MCP_ACTOR_ROLES[D],['DGA','PRODUCTOR_MUSICAL']);
});

test('ordinary executor policy still rejects cross-role actions through either published entry point',async()=>{
  const f=fixture(),invalid={...start,payload:{operation:'ORDINARY_WORK',brief:'Invalid cross-role action',source_reference:'TEST',steps:{[G]:{action:'WRITE_VALIDATED'},[C]:{action:'WRITE_VALIDATED',object_id:'TEST',expected_sha256:null}}}};
  assert.equal((await f.call('start_workflow',invalid)).result,'FAIL_CLOSED');
  assert.equal((await f.call('submit_task_command',command('START_WORKFLOW',invalid))).result,'FAIL_CLOSED');
  assert.equal((await f.call('get_task',{task_id:start.thread_id})).error_code,'THREAD_UNKNOWN');
});
