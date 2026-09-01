import crypto from 'node:crypto';
import fs from 'node:fs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const EMPTY = Object.freeze({status:'UNKNOWN', reason_code:'UNKNOWN'});
export const CLASSIFICATIONS = new Set(['AUTHORITATIVE_CURRENT','CANDIDATE','CONFLICT','UNKNOWN']);
export const SHADOW_MINIMUM_SOAK_MS = 24 * 60 * 60 * 1000;

function fail(code, message = code) { const error = new Error(message); error.reason_code = code; throw error; }
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])); return value; }
function fingerprint(value) { return sha256(Buffer.from(JSON.stringify(stable(value)))); }
function required(value, field) { if (value === undefined || value === null || value === '') fail('INVALID_BASELINE_MANIFEST', `Missing ${field}`); return value; }

function sealArtifact(item, {maxSourceBytes}) {
  const sourcePath = required(item?.path, 'artifact.path'); const ref = required(item?.ref, 'artifact.ref'); let stat;
  try { stat = fs.lstatSync(sourcePath); } catch { fail('SOURCE_UNREADABLE', ref); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('SOURCE_NOT_REGULAR_FILE', ref);
  if (stat.size > maxSourceBytes) fail('SOURCE_READ_LIMIT_EXCEEDED', ref);
  let bytes; try { bytes = fs.readFileSync(sourcePath); } catch { fail('SOURCE_UNREADABLE', ref); }
  if (bytes.length !== stat.size) fail('SOURCE_READ_INCOMPLETE', ref);
  const after = fs.statSync(sourcePath); if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('SOURCE_CHANGED_DURING_READ', ref);
  return Object.freeze({ref, A_path:sourcePath, bytes:bytes.length, sha256:sha256(bytes), modified_at:stat.mtime.toISOString(), ...(item.C_file_id ? {C_file_id:item.C_file_id} : {}), ...(item.proof_ref ? {proof_ref:item.proof_ref} : {})});
}

function exactMapping(mapping) {
  for (const field of ['artifact_id','A_path','C_file_id','replication_mode','byte_preserving']) required(mapping?.[field], `mapping.${field}`);
  if (mapping.byte_preserving !== true || mapping.replication_mode !== 'A_TO_C_EXACT_ID') fail('INVALID_EXACT_ID_MAPPING');
  return Object.freeze({...mapping, B_path:mapping.B_path ?? null});
}

/** Read-only CF1 baseline builder. Explicit sources only; no automatic discovery. */
export function createMigrationBaseline({artifacts=[],schedulers=[],mappings=[],tasks=[],decisions=[],surfaces=[],entities=[],relations=[],catalog_memberships=[],source_manifest_ref=null,at=now(),maxSourceBytes=8*1024*1024}={}) {
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) fail('INVALID_BASELINE_MANIFEST');
  const sealed=artifacts.map(item=>sealArtifact(item,{maxSourceBytes})), refs=sealed.map(item=>item.ref);
  if (new Set(refs).size!==refs.length) fail('DUPLICATE_SOURCE_REF');
  const baseline={kind:'MIGRATION_BASELINE',mode:'CF1_READ_ONLY',no_side_effect:true,baseline_at:at,source_manifest_ref,artifacts:sealed,schedulers:[...schedulers],mappings:mappings.map(exactMapping),entities:[...entities],decisions:[...decisions],tasks:[...tasks],relations:[...relations],catalog_memberships:[...catalog_memberships],surfaces:[...surfaces]};
  return Object.freeze({...baseline,baseline_digest:fingerprint(baseline)});
}

export function classifyFinding(finding) { if (!finding || !CLASSIFICATIONS.has(finding.classification)) fail('INVALID_MIGRATION_CLASSIFICATION'); if (!finding.evidence_ref) fail('MISSING_EVIDENCE'); return Object.freeze({...finding}); }

/** Temporary importer: only explicit AUTHORITATIVE_CURRENT records become CF2 state. */
export class SelectiveMigrator {
  constructor(store) { this.store=store; }
  import(records=[]) { const report={kind:'MIGRATION_IMPORT_REPORT',mode:'CF2_ONLY',imported:[],candidates:[],conflicts:[],unknown:[],rejected:[]}; for(const raw of records) { let record; try {record=classifyFinding(raw);} catch(error) {report.rejected.push({...raw,reason_code:error.reason_code??'FAIL_CLOSED'});continue;} if(record.classification==='AUTHORITATIVE_CURRENT') { if(!record.command) {report.rejected.push({...record,reason_code:'MISSING_COMMAND'});continue;} const result=this.store.submitCommand(record.command);(result.accepted?report.imported:report.rejected).push({...record,result}); } else if(record.classification==='CANDIDATE') report.candidates.push(record); else if(record.classification==='CONFLICT') report.conflicts.push(record); else report.unknown.push(record); } return Object.freeze(report); }
}

function asMap(state) { const result=new Map(); for(const [collection,records] of Object.entries(state??{})) {if(!Array.isArray(records))continue;for(const record of records) {const id=record?.id??record?.artifact_id??record?.mapping_id??record?.membership_id;if(!id)fail('COMPARISON_ID_REQUIRED',collection);result.set(`${collection}:${id}`,stable(record));}} return result; }

/** Compares typed logical records by exact stable identity; absence remains UNKNOWN. */
export function compareLogical(cf1={},cf2={}) { const left=asMap(cf1),right=asMap(cf2),keys=new Set([...left.keys(),...right.keys()]),discrepancies=[]; for(const key of [...keys].sort()) {const a=left.get(key),b=right.get(key);if(a===undefined||b===undefined)discrepancies.push({object:key,property:'logical_state',CF1:a??EMPTY,CF2:b??EMPTY,classification:'UNKNOWN',action_proposed:'obtain_source_evidence'});else if(fingerprint(a)!==fingerprint(b))discrepancies.push({object:key,property:'logical_state',CF1:a,CF2:b,classification:'CONFLICT',action_proposed:'review_source_evidence'});} const count=classification=>discrepancies.filter(item=>item.classification===classification).length; return Object.freeze({kind:'CF1_CF2_LOGICAL_COMPARISON',no_side_effect:true,discrepancies,conflict:count('CONFLICT'),unknown:count('UNKNOWN'),candidate:0,result:discrepancies.length?'DIFFERENCES_DETECTED':'EQUAL'}); }

/** Shadow is observation-only: it cannot receive adapters or execute external effects. */
export class ShadowRuntime {
  constructor({at=now,minimumSoakMs=SHADOW_MINIMUM_SOAK_MS}={}) { if(!Number.isSafeInteger(minimumSoakMs)||minimumSoakMs<1)fail('INVALID_SOAK_DURATION');this.at=at;this.minimumSoakMs=minimumSoakMs;this.started_at=null;this.observations=[];this.would_do=[];this.keys=new Set(); }
  start() { if(this.started_at)return {mode:'SHADOW_READ',started_at:this.started_at,no_side_effect:true};this.started_at=this.at();return {mode:'SHADOW_READ',started_at:this.started_at,no_side_effect:true}; }
  observe({baseline,current,label='read-only'}={}) { if(!this.started_at)fail('SHADOW_NOT_STARTED');const comparison=compareLogical(baseline,current),observation=Object.freeze({observed_at:this.at(),label,comparison,mode:'SHADOW_READ',no_side_effect:true});this.observations.push(observation);return observation; }
  wouldDo(action,payload={}) { if(!this.started_at)fail('SHADOW_NOT_STARTED');const item=Object.freeze({id:`WOULD_DO:${crypto.randomUUID()}`,at:this.at(),action:`WOULD_${action}`,payload:stable(payload),no_side_effect:true});this.would_do.push(item);return item; }
  transportObservation({file_id,observed_name,modified_time,request_id,nonce,baseline,current,label='read-only'}={}) { const key=[file_id,observed_name,modified_time,request_id,nonce].join('|');if(this.keys.has(key))return Object.freeze({result:'TRANSPORT_DUPLICATE_IGNORED',no_side_effect:true});this.keys.add(key);return this.observe({baseline,current,label}); }
  soakStatus() { if(!this.started_at)return {result:'NOT_STARTED',no_side_effect:true};const elapsed=Math.max(0,new Date(this.at()).getTime()-new Date(this.started_at).getTime());return Object.freeze({result:elapsed>=this.minimumSoakMs?'SOAK_DURATION_MET':'SOAK_DURATION_PENDING',elapsed_ms:elapsed,minimum_soak_ms:this.minimumSoakMs,no_side_effect:true}); }
  report() { const soak=this.soakStatus();return Object.freeze({kind:'SHADOW_SOAK_REPORT',started_at:this.started_at,observations:this.observations,would_do:this.would_do,duration_ms:soak.elapsed_ms??0,minimum_soak_ms:this.minimumSoakMs,soak_result:soak.result,no_side_effect:true}); }
}
