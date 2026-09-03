import fs from 'node:fs';
import path from 'node:path';
import { runIntegratedStage7Gate } from '../src/cutover-tooling.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dev', 'shadow', 'STAGE7_CUTOVER_DRILL.json');
const report = runIntegratedStage7Gate();
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ environment:report.environment,scope:report.scope,single_writer:report.single_writer,equality_initial:report.equality_initial.result,equality_final:report.equality_final.result,decision_persisted:report.decision_persisted,journal_entries:report.journal.length,rollbacks:report.rollback,environment_transition:report.environment_transition,cf1_writes:report.cf1_writes,external_effects:report.external_effects,production_cutover_disabled:report.production_cutover_disabled }, null, 2));
