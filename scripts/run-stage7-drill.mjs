import fs from 'node:fs';
import path from 'node:path';
import { runStagingDrill } from '../src/cutover-tooling.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dev', 'shadow', 'STAGE7_CUTOVER_DRILL.json');
const report = runStagingDrill();
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ environment: report.environment, equality: report.equality.result, journal_entries: report.journal.length, production_cutover_disabled: report.production_cutover_disabled, zero_production_side_effect: report.zero_production_side_effect }, null, 2));
