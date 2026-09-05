import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRoleReport} from '../scripts/actor-runtime.mjs';
test('native role reports accept plain JSON or exactly one explicit JSON code block',()=>{
 const report={result:'PASS',summary:'Reviewed',canon_versions:['abc'],external_effects:0};
 const plain=JSON.stringify(report);
 assert.deepEqual(parseRoleReport(plain),report);
 assert.deepEqual(parseRoleReport('Explanation\n```json\n'+plain+'\n```\nCaveat'),report);
 assert.throws(()=>parseRoleReport('```json\n'+plain+'\n```\n```json\n'+plain+'\n```'),/EXECUTOR_INVALID_EVIDENCE/);
 assert.throws(()=>parseRoleReport('prose only'),/EXECUTOR_INVALID_EVIDENCE/);
});
