import fs from 'node:fs/promises';
import crypto from 'node:crypto';
// The installed command registry supplies the exact document path. No model arguments.
const file=process.argv[2];if(!file)throw new Error('EXPLICIT_DESTINATION_REQUIRED');
const bytes=await fs.readFile(file),text=bytes.toString('utf8');
const findings={utf8_roundtrip:Buffer.from(text,'utf8').equals(bytes),nonempty:bytes.length>400,headings:(text.match(/^#{1,6}\s.+/gm)??[]).length,actor_mentions:['Gaby Chat','Gaby CW','Codex','Diego'].map(actor=>({actor,present:text.toLowerCase().includes(actor.toLowerCase())})),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
const pass=findings.utf8_roundtrip&&findings.nonempty&&findings.headings>=3&&findings.actor_mentions.every(a=>a.present);
console.log(JSON.stringify({result:pass?'PASS':'FAIL',findings}));if(!pass)process.exitCode=1;
