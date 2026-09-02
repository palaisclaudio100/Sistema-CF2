import fs from 'node:fs';
import path from 'node:path';
import { runMinimumOperationalRehearsal, runStagingDrill } from '../src/cutover-tooling.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dev', 'shadow', 'STAGE7_CUTOVER_DRILL.json');
const report = { generic:runStagingDrill(), minimum_operational:runMinimumOperationalRehearsal() };
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ environment: report.generic.environment, equality: report.generic.equality.result, minimum_scope:report.minimum_operational.scope, journal_entries:report.generic.journal.length+report.minimum_operational.journal.length, production_cutover_disabled:report.generic.production_cutover_disabled, zero_production_side_effect:report.generic.zero_production_side_effect&&report.minimum_operational.no_side_effect }, null, 2));
