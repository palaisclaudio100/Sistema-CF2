import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extract } from '../scripts/stage6-extract-catalog-candidates.mjs';

const fixture='# 5. Catálogo publicado — "Todavía"\n\n| # | Canción | Estado estratégico |\n|---:|---|---|\n| 1 | Uno | Activo |\n| 2 | Dos | Pausado |\n\n---\n';
test('catalog extractor seals the full source and emits candidates only',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-catalog-'));try{const file=path.join(dir,'catalog.md');fs.writeFileSync(file,fixture);const sha=crypto.createHash('sha256').update(fixture).digest('hex');const result=extract({source:file,sha256:sha,albumId:'ALBUM:TODAVIA'});assert.equal(result.no_side_effect,true);assert.equal(result.coverage,'CANDIDATE');assert.equal(result.catalog_memberships.length,2);assert.equal(result.catalog_memberships[0].classification,'CANDIDATE');assert.match(result.catalog_memberships[1].evidence_ref,/#L6$/);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('catalog extractor rejects a source whose full seal differs',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf2-catalog-'));try{const file=path.join(dir,'catalog.md');fs.writeFileSync(file,fixture);assert.throws(()=>extract({source:file,sha256:'0'.repeat(64),albumId:'ALBUM:TODAVIA'}),/SOURCE_SHA256_MISMATCH/);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
