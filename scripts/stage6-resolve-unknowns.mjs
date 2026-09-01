import fs from 'node:fs';
import path from 'node:path';
import { CoreStore } from '../src/core-store.mjs';
import { CLASSIFICATIONS, SelectiveMigrator } from '../src/shadow.mjs';

const parsed = Object.fromEntries(process.argv.slice(2).map(value => { const [key, ...rest] = value.split('='); return [key.replace(/^--/, ''), rest.join('=')]; }));
const fail = code => { process.stderr.write(`${code}\n`); process.exitCode=2; };
const read = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const coverageKeys=['entities','decisions','tasks','relations','catalog_memberships','mappings','surfaces'];

function validateLedger(ledger) {
  if (ledger?.kind!=='STAGE6_REVIEW_LEDGER' || !/^[a-f0-9]{64}$/i.test(ledger?.baseline_digest??'') || !Array.isArray(ledger.records)) throw new Error('INVALID_STAGE6_REVIEW_LEDGER');
  const coverage={};
  for (const key of coverageKeys) { const value=ledger.coverage?.[key]??'UNKNOWN'; if(!CLASSIFICATIONS.has(value)) throw new Error('INVALID_BASELINE_COVERAGE'); coverage[key]=value; }
  for (const record of ledger.records) {
    if (!CLASSIFICATIONS.has(record?.classification) || !record.evidence_ref || typeof record.evidence_ref!=='string') throw new Error('INVALID_MIGRATION_CLASSIFICATION');
    if (record.classification==='AUTHORITATIVE_CURRENT' && !record.command) throw new Error('MISSING_COMMAND');
  }
  return {...ledger,coverage};
}

if (!parsed.ledger || !parsed.store) fail('USAGE: --ledger=<review-ledger.json> --store=<cf2-dev.db>');
if (!process.exitCode) try {
  const ledger=validateLedger(read(parsed.ledger));
  const store=new CoreStore(path.resolve(parsed.store));
  const report=new SelectiveMigrator(store).import(ledger.records);
  const output={
    kind:'MIGRATION_IMPORT_REPORT', mode:'CF2_ONLY', no_side_effect:true, cf1_write_count:0,
    baseline_digest:ledger.baseline_digest, source_manifest_ref:ledger.source_manifest_ref??null,
    coverage:ledger.coverage, report,
    f7:{result:'NOT_EVALUATED',reason_code:'F7_REQUIRES_SEPARATE_SOAK_AND_REVIEW_EVIDENCE'}
  };
  process.stdout.write(`${JSON.stringify(output,null,2)}\n`);
  store.close();
} catch (error) { fail(error.reason_code??error.message??'FAIL_CLOSED'); }
