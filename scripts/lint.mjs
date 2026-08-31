import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(dir) { for (const entry of fs.readdirSync(dir, {withFileTypes:true})) { const full = path.join(dir, entry.name); if (entry.isDirectory() && !['.git','node_modules'].includes(entry.name)) walk(full); else if (entry.isFile()) files.push(full); } }
walk(root);
const errors = [];
for (const file of files.filter(file => file.endsWith('.json'))) { try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { errors.push(`${file}: ${error.message}`); } }
for (const file of files.filter(file => file.endsWith('.mjs'))) { try { execFileSync(process.execPath, ['--check', file], {stdio:'pipe'}); } catch (error) { errors.push(`${file}: syntax error`); } }
for (const file of files.filter(file => file.endsWith('.mjs') && path.basename(file) !== 'lint.mjs')) { const text = fs.readFileSync(file, 'utf8'); const stagingDriveGate=['stage5-drive-bridge.mjs','stage5-cloud-gate.test.mjs'].includes(path.basename(file)); if (!stagingDriveGate&&(text.includes('drive.google.com') || text.includes('googleapis') || text.includes('fs.watch'))) errors.push(`${file}: production integration or watcher is forbidden outside the allowlisted Stage 5 staging gate`); }
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`lint passed for ${files.length} files`);
