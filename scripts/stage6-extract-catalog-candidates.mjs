import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args=Object.fromEntries(process.argv.slice(2).map(value=>{const [key,...rest]=value.split('=');return [key.replace(/^--/,''),rest.join('=')];}));
const fail=code=>{process.stderr.write(`${code}\n`);process.exitCode=2;};
const clean=value=>value.trim().replace(/\*\*/g,'').replace(/`/g,'');

function extract({source,sha256,albumId}) {
  if(!source||!/^[a-f0-9]{64}$/i.test(sha256??'')||!albumId)throw new Error('USAGE: --source=<cf1.md> --sha256=<full-source-sha256> --album-id=<stable-id>');
  const bytes=fs.readFileSync(path.resolve(source));
  const actual=crypto.createHash('sha256').update(bytes).digest('hex');
  if(actual.toLowerCase()!==sha256.toLowerCase())throw new Error('SOURCE_SHA256_MISMATCH');
  const lines=bytes.toString('utf8').replace(/\r\n/g,'\n').split('\n');
  const heading=lines.findIndex(line=>line.trim()==='# 5. Catálogo publicado — "Todavía"');
  if(heading<0)throw new Error('CATALOG_HEADING_NOT_FOUND');
  const header=lines.findIndex((line,index)=>index>heading&&line.trim()==='| # | Canción | Estado estratégico |');
  if(header<0||!/^\|[-:]+\|[-:]+\|[-:]+\|$/.test(lines[header+1].replace(/\s/g,'')))throw new Error('CATALOG_TABLE_INVALID');
  const rows=[];
  for(let index=header+2;index<lines.length&&lines[index].startsWith('|');index++){
    const cells=lines[index].split('|').slice(1,-1).map(clean); if(cells.length!==3||!/^\d+$/.test(cells[0])||!cells[1])throw new Error('CATALOG_ROW_INVALID');
    rows.push({position:Number(cells[0]),title:cells[1],strategic_state:cells[2],line:index+1});
  }
  if(!rows.length||new Set(rows.map(row=>row.position)).size!==rows.length)throw new Error('CATALOG_ROWS_INVALID');
  return Object.freeze({kind:'CF1_CATALOG_CANDIDATE_EXTRACTION',mode:'CF1_READ_ONLY',no_side_effect:true,source_sha256:actual,album_id:albumId,coverage:'CANDIDATE',catalog_memberships:rows.map(row=>({classification:'CANDIDATE',evidence_ref:`CF1:CATALOG@sha256:${actual}#L${row.line}`,subject_id:`CATALOG_CANDIDATE:${albumId}:${String(row.position).padStart(2,'0')}`,position:row.position,title:row.title,strategic_state:row.strategic_state,reason:'Título y posición extraídos de tabla completa; requiere ID estable y revisión antes de crear relación CURRENT.'}))});
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!args.source||!args.sha256||!args['album-id'])fail('USAGE: --source=<cf1.md> --sha256=<full-source-sha256> --album-id=<stable-id>');
  if(!process.exitCode)try{process.stdout.write(`${JSON.stringify(extract({source:args.source,sha256:args.sha256,albumId:args['album-id']}),null,2)}\n`);}catch(error){fail(error.reason_code??error.message??'FAIL_CLOSED');}
}

export { extract };
