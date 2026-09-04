import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ProductionRoleInterface} from '../src/production-role-interface.mjs';
import {MCP_ACTOR_ROLES,mcpToolsFor} from '../src/remote-mcp.mjs';

const stamp='2026-09-04T00:00:00.000Z';
const principals=Object.freeze({
  DIEGO:{actor_id:'ACTOR:DIEGO',allowed_roles:['DGA','PRODUCTOR_MUSICAL']},
  GABY_CHAT:{actor_id:'ACTOR:GABY_CHAT',allowed_roles:['GABY_CHAT']},
  GABY_CW:{actor_id:'ACTOR:GABY_CW',allowed_roles:['GABY_CW_AUDIOVISUAL','GABY_CW_DOCUMENTAL']},
  CODEX:{actor_id:'ACTOR:CODEX',allowed_roles:['CODEX']},
  CLAUDE_CODE:{actor_id:'ACTOR:CLAUDE_CODE',allowed_roles:['CLAUDE_CODE']}
});

const task=(id,responsible_role)=>({id,type:'TASK',status:'CANCELLED',created_at:stamp,updated_at:stamp,basis_ref:['ACL:CLAUDE_CODE:ASSIGNMENT'],action:'VERIFY_CLAUDE_CODE_ASSIGNMENT_ACL',state:'CANCELLED',responsible_role,related_ids:[],non_productive:true});
const command=(id,responsible_role)=>({command_id:`COMMAND:${id}`,command_type:'CREATE_TASK',idempotency_key:`IDEMPOTENCY:${id}`,payload:{object:task(`TASK:${id}`,responsible_role)}});
const store=()=>{const submitted=[];return{submitted,writer:async()=> 'CF2_WRITER',getObject:async()=>null,hasProof:async()=>false,replayCommand:async()=>null,submitCommand:async value=>(submitted.push(value),{accepted:true,resulting_state_version:1})};};

test('only ACTOR:DIEGO acting as DGA can assign a TASK to CLAUDE_CODE',async()=>{
  const target=store(),roles=new ProductionRoleInterface(target),result=await roles.submitRoleCommand({principal:principals.DIEGO,acting_role:'DGA',command:command('CANARY:ACL:DIEGO','CLAUDE_CODE')});
  assert.equal(result.accepted,true);
  assert.equal(target.submitted.length,1);
  assert.equal(target.submitted[0].actor_id,'ACTOR:DIEGO');
  assert.equal(target.submitted[0].actor_role,'DGA');
  assert.equal(target.submitted[0].payload.object.responsible_role,'CLAUDE_CODE');
});

test('Diego cannot use PRODUCTOR_MUSICAL to assign CLAUDE_CODE',async()=>{
  const target=store(),roles=new ProductionRoleInterface(target),result=await roles.submitRoleCommand({principal:principals.DIEGO,acting_role:'PRODUCTOR_MUSICAL',command:command('CANARY:ACL:DIEGO:MUSIC','CLAUDE_CODE')});
  assert.equal(result.reason_code,'ROLE_FORBIDDEN');assert.equal(target.submitted.length,0);
});

for(const [name,acting_role] of [['GABY_CHAT','GABY_CHAT'],['GABY_CW','GABY_CW_AUDIOVISUAL'],['CODEX','CODEX']]){
  test(`${name} cannot assign a TASK directly to CLAUDE_CODE`,async()=>{
    const target=store(),roles=new ProductionRoleInterface(target),result=await roles.submitRoleCommand({principal:principals[name],acting_role,command:command(`CANARY:ACL:${name}`,'CLAUDE_CODE')});
    assert.equal(result.reason_code,'ROLE_FORBIDDEN');assert.equal(target.submitted.length,0);
  });
}

test('Claude Code actor and least-privilege tool surface remain unchanged',()=>{
  assert.deepEqual(MCP_ACTOR_ROLES['ACTOR:CLAUDE_CODE'],['CLAUDE_CODE']);
  assert.deepEqual(mcpToolsFor(principals.CLAUDE_CODE).map(tool=>tool.name),['get_my_tasks','get_task','submit_task_command','get_status']);
});

test('assignment ACL deploy targets only the exact production core and exact pushed commit',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/cf2-claude-code-assignment-acl-deploy.yml',import.meta.url),'utf8');
  assert.match(workflow,/SERVICE_ID: srv-daa8dngae00c73a3m15g/);
  assert.match(workflow,/TARGET_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.equal((workflow.match(/call\('POST',f'\/services\/\{service_id\}\/deploys'/g)??[]).length,1);
  assert.doesNotMatch(workflow,/call\('PATCH'|env-vars\/|\/postgres\/|cf2-prod-postgres/);
  assert.match(workflow,/\.well-known\/oauth-protected-resource\/mcp\/claude-code/);
});
