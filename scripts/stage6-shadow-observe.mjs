import fs from 'node:fs';
import path from 'node:path';
import { CoreStore } from '../src/core-store.mjs';
import { ShadowRuntime } from '../src/shadow.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(item => { const [key, value] = item.split('='); return [key.replace(/^--/, ''), value]; }));
for (const key of ['store','session','baseline','current']) {
  if (!args[key]) { process.stderr.write(`MISSING_${key.toUpperCase()}\n`); process.exitCode=2; }
}
if (!process.exitCode) {
  const readJson = input => JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  try {
    const baseline=readJson(args.baseline), current=readJson(args.current);
    if (!baseline.baseline_digest) throw new Error('BASELINE_DIGEST_REQUIRED');
    const store=new CoreStore(path.resolve(args.store));
    const shadow=new ShadowRuntime({store,sessionId:args.session,baselineDigest:baseline.baseline_digest});
    shadow.start();
    const observation=shadow.observe({baseline,current,label:'CF1_READ_ONLY'});
    process.stdout.write(`${JSON.stringify({observation,soak:shadow.soakStatus()},null,2)}\n`);
    store.close();
  } catch (error) { process.stderr.write(`${error.reason_code ?? error.message ?? 'FAIL_CLOSED'}\n`); process.exitCode=2; }
}
