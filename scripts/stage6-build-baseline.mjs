import fs from 'node:fs';
import path from 'node:path';
import { createMigrationBaseline } from '../src/shadow.mjs';

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  process.stderr.write('USAGE: node scripts/stage6-build-baseline.mjs <explicit-manifest.json>\n');
  process.exitCode = 2;
} else {
  const absoluteManifest = path.resolve(manifestPath);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(absoluteManifest, 'utf8')); }
  catch { process.stderr.write('INVALID_BASELINE_MANIFEST\n'); process.exitCode = 2; }
  if (manifest) {
    const artifacts = (manifest.artifacts ?? []).map(item => ({...item, path:path.resolve(path.dirname(absoluteManifest), item.path)}));
    const baseline = createMigrationBaseline({...manifest, artifacts, source_manifest_ref:manifest.source_manifest_ref ?? `MANIFEST:${absoluteManifest}`});
    process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
  }
}
