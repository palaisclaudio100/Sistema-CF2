import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ROLE_ROUTING} from '../src/cutover-tooling.mjs';
import {ROLE_PRINCIPALS} from '../src/google-role-gateway.mjs';
import {MCP_ACTOR_ROLES,mcpToolsFor,resourceActor} from '../src/remote-mcp.mjs';
import {ProductionRoleInterface} from '../src/production-role-interface.mjs';

const base='https://cf2-prod-core.onrender.com';
const stamp='2026-09-04T00:00:00.000Z';
const task={id:'TASK:CANARY:CODEX:ACTOR',type:'TASK',status:'OPEN',created_at:stamp,updated_at:stamp,basis_ref:['CANARY:CODEX'],action:'VERIFY_CODEX_ACTOR_BINDING',state:'OPEN',responsible_role:'CODEX',related_ids:[],non_productive:true};
const command={command_id:'COMMAND:CANARY:CODEX:CREATE',command_type:'CREATE_TASK',idempotency_key:'canary-codex-create',payload:{object:task}};
const principal={actor_id:'ACTOR:CODEX',allowed_roles:['CODEX']};

test('Codex is a distinct non-resident engineering role and principal',()=>{
  assert.deepEqual(ROLE_ROUTING.CODEX,{actor_role:'CODEX',domains:['ENGINEERING','INFRASTRUCTURE'],operational_runtime:false});
  assert.notDeepEqual(ROLE_ROUTING.CODEX,ROLE_ROUTING.CLAUDE_CODE);
  assert.deepEqual(ROLE_PRINCIPALS['ACTOR:CODEX'],['CODEX']);
  assert.deepEqual(MCP_ACTOR_ROLES['ACTOR:CODEX'],['CODEX']);
});

test('Codex exact MCP resource fixes ACTOR:CODEX server-side',()=>{
  assert.equal(resourceActor(base,`${base}/mcp/codex`),'ACTOR:CODEX');
  assert.equal(resourceActor(base,`${base}/mcp/codex?actor_id=ACTOR:DIEGO`),null);
  assert.equal(resourceActor(base,`${base}/mcp/diego`),'ACTOR:DIEGO');
});

test('Codex MCP exposes reads, TASK commands and status but no verification',()=>{
  assert.deepEqual(mcpToolsFor(principal).map(tool=>tool.name),['get_my_tasks','get_task','submit_task_command','get_status']);
});

test('Codex command identity is injected and cross-role or verification is denied',async()=>{
  const submitted=[],store={writer:async()=> 'CF2_WRITER',getObject:async()=>null,hasProof:async()=>false,replayCommand:async()=>null,submitCommand:async value=>(submitted.push(value),{accepted:true,resulting_state_version:1})},roles=new ProductionRoleInterface(store);
  const accepted=await roles.submitRoleCommand({principal,acting_role:'CODEX',command});
  assert.equal(accepted.accepted,true);assert.equal(submitted[0].actor_id,'ACTOR:CODEX');assert.equal(submitted[0].actor_role,'CODEX');
  assert.equal((await roles.submitRoleCommand({principal,acting_role:'DGA',command:{...command,command_id:'COMMAND:CANARY:CODEX:CROSS'}})).reason_code,'ROLE_FORBIDDEN');
  assert.equal((await roles.submitRoleCommand({principal,acting_role:'CODEX',command:{command_id:'COMMAND:CANARY:CODEX:VERIFY',command_type:'RECORD_VERIFICATION',idempotency_key:'canary-codex-verify',payload:{object:{}}}})).reason_code,'ROLE_FORBIDDEN');
  assert.equal((await roles.submitRoleCommand({principal,acting_role:'CODEX',command:{...command,actor_id:'ACTOR:DIEGO'}})).reason_code,'ACTOR_MISMATCH');
  assert.equal(submitted.length,1);
});

test('Codex migration is narrow and leaves Claude Code absent',()=>{
  const sql=fs.readFileSync(new URL('../migrations/006_codex_actor.sql',import.meta.url),'utf8');
  assert.match(sql,/ACTOR:CODEX/);assert.doesNotMatch(sql,/ACTOR:CLAUDE_CODE|CLAUDE_CODE/);
});

test('Codex deploy targets only the exact production core and performs one exact deploy',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/cf2-codex-actor-deploy.yml',import.meta.url),'utf8');
  assert.match(workflow,/SERVICE_ID: srv-daa8dngae00c73a3m15g/);assert.match(workflow,/TARGET_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.equal((workflow.match(/call\('POST',f'\/services\/\{service_id\}\/deploys'/g)??[]).length,1);
  assert.doesNotMatch(workflow,/call\('PATCH'|env-vars\/|\/postgres\/|cf2-prod-postgres/);
  assert.match(workflow,/\.well-known\/oauth-protected-resource\/mcp\/codex/);
});
