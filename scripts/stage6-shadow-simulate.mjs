import fs from 'node:fs';
import path from 'node:path';
import { CoreStore } from '../src/core-store.mjs';
import { ShadowRuntime } from '../src/shadow.mjs';

const args=Object.fromEntries(process.argv.slice(2).map(value=>{const [key,...rest]=value.split('=');return [key.replace(/^--/,''),rest.join('=')];}));
const fail=code=>{process.stderr.write(`${code}\n`);process.exitCode=2;};
const read=file=>JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));

if(!args.store||!args.session||!args.baseline||!args.current||!args['task-id'])fail('USAGE: --store=<cf2-dev.db> --session=<id> --baseline=<baseline.json> --current=<current.json> --task-id=<stable-id>');
if(!process.exitCode)try{
  const baseline=read(args.baseline),current=read(args.current);if(!baseline.baseline_digest)throw new Error('BASELINE_DIGEST_REQUIRED');
  const store=new CoreStore(path.resolve(args.store));const shadow=new ShadowRuntime({store,sessionId:args.session,baselineDigest:baseline.baseline_digest});shadow.start();
  const observation=shadow.observe({baseline,current,label:'F7_SIMULATED_TASK_CLOSURE'});
  const wouldDo=shadow.wouldDo('TRANSITION_TASK',{task_id:args['task-id'],state:'DONE',closure_ref:'SIMULATED_ONLY_NO_CLOSURE'});
  process.stdout.write(`${JSON.stringify({kind:'F7_SHADOW_SIMULATION',mode:'SHADOW_READ',no_side_effect:true,observation,would_do:wouldDo,cf1_write_count:0,external_effect_count:0},null,2)}\n`);store.close();
}catch(error){fail(error.reason_code??error.message??'FAIL_CLOSED');}
