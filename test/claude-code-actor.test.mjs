import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ROLE_ROUTING} from '../src/cutover-tooling.mjs';
import {ROLE_PRINCIPALS} from '../src/google-role-gateway.mjs';
import {MCP_ACTOR_ROLES,mcpToolsFor,resourceActor} from '../src/remote-mcp.mjs';
import {ProductionRoleInterface} from '../src/production-role-interface.mjs';

const base='https://cf2-prod-core.onrender.com';
const stamp='2026-09-04T00:00:00.000Z';
const task={id:'TASK:CANARY:CLAUDE_CODE:ACTOR',type:'TASK',status:'CANCELLED',created_at:stamp,updated_at:stamp,basis_ref:['CANARY:CLAUDE_CODE'],action:'VERIFY_CLAUDE_CODE_ACTOR_BINDING',state:'CANCELLED',responsible_role:'CLAUDE_CODE',related_ids:[],non_productive:true};
const command={command_id:'COMMAND:CANARY:CLAUDE_CODE:CREATE',command_type:'CREATE_TASK',idempotency_key:'canary-claude-code-create',payload:{object:task}};
const principal={actor_id:'ACTOR:CLAUDE_CODE',allowed_roles:['CLAUDE_CODE']};

test('Claude Code is a distinct available non-resident auxiliary role',()=>{
  assert.deepEqual(ROLE_ROUTING.CLAUDE_CODE,{actor_role:'CLAUDE_CODE',domains:['AUXILIARY_ENGINEERING'],operational_runtime:false});
  assert.notDeepEqual(ROLE_ROUTING.CLAUDE_CODE,ROLE_ROUTING.CODEX);
  assert.deepEqual(ROLE_PRINCIPALS['ACTOR:CLAUDE_CODE'],['CLAUDE_CODE']);
  assert.deepEqual(MCP_ACTOR_ROLES['ACTOR:CLAUDE_CODE'],['CLAUDE_CODE']);
});

test('Claude Code exact MCP resource fixes ACTOR:CLAUDE_CODE server-side',()=>{
  assert.equal(resourceActor(base,`${base}/mcp/claude-code`),'ACTOR:CLAUDE_CODE');
  assert.equal(resourceActor(base,`${base}/mcp/claude-code?actor_id=ACTOR:CODEX`),null);
  assert.equal(resourceActor(base,`${base}/mcp/codex`),'ACTOR:CODEX');
});

test('Claude Code MCP exposes only reads, TASK commands and status',()=>{
  assert.deepEqual(mcpToolsFor(principal).map(tool=>tool.name),['get_my_tasks','get_task','submit_task_command','get_status']);
});

test('Claude Code identity is injected and cross-role, impersonation and verification are denied',async()=>{
  const submitted=[],store={writer:async()=> 'CF2_WRITER',getObject:async()=>null,hasProof:async()=>false,replayCommand:async()=>null,submitCommand:async value=>(submitted.push(value),{accepted:true,resulting_state_version:1})},roles=new ProductionRoleInterface(store);
  const accepted=await roles.submitRoleCommand({principal,acting_role:'CLAUDE_CODE',command});
  assert.equal(accepted.accepted,true);assert.equal(submitted[0].actor_id,'ACTOR:CLAUDE_CODE');assert.equal(submitted[0].actor_role,'CLAUDE_CODE');
  assert.equal((await roles.submitRoleCommand({principal,acting_role:'CODEX',command:{...command,command_id:'COMMAND:CANARY:CLAUDE_CODE:CROSS'}})).reason_code,'ROLE_FORBIDDEN');
  assert.equal((await roles.submitRoleCommand({principal,acting_role:'CLAUDE_CODE',command:{command_id:'COMMAND:CANARY:CLAUDE_CODE:VERIFY',command_type:'RECORD_VERIFICATION',idempotency_key:'canary-claude-code-verify',payload:{object:{}}}})).reason_code,'ROLE_FORBIDDEN');
  assert.equal((await roles.submitRoleCommand({principal,acting_role:'CLAUDE_CODE',command:{...command,actor_id:'ACTOR:CODEX'}})).reason_code,'ACTOR_MISMATCH');
  assert.equal(submitted.length,1);
});

test('Claude Code migration is narrow and preserves all existing actors',()=>{
  const sql=fs.readFileSync(new URL('../migrations/007_claude_code_actor.sql',import.meta.url),'utf8');
  for(const actor of ['ACTOR:DIEGO','ACTOR:GABY_CHAT','ACTOR:GABY_CW','ACTOR:CODEX','ACTOR:CLAUDE_CODE'])assert.match(sql,new RegExp(actor));
  assert.doesNotMatch(sql,/ALTER TABLE objects|ALTER TABLE outbox|INSERT INTO objects/);
});

test('Claude Code deploy targets only exact production core and one exact commit deploy',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/cf2-claude-code-actor-deploy.yml',import.meta.url),'utf8');
  assert.match(workflow,/SERVICE_ID: srv-daa8dngae00c73a3m15g/);assert.match(workflow,/TARGET_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.equal((workflow.match(/call\('POST',f'\/services\/\{service_id\}\/deploys'/g)??[]).length,1);
  assert.doesNotMatch(workflow,/call\('PATCH'|env-vars\/|\/postgres\/|cf2-prod-postgres/);
  assert.match(workflow,/\.well-known\/oauth-protected-resource\/mcp\/claude-code/);
});
