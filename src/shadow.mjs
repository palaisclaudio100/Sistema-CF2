import crypto from 'node:crypto';
import fs from 'node:fs';

const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const now=()=>new Date().toISOString();
export const CLASSIFICATIONS=new Set(['AUTHORITATIVE_CURRENT','CANDIDATE','CONFLICT','UNKNOWN']);

/** Read-only CF1 baseline builder. It only receives explicit source paths and never writes to them. */
export function createMigrationBaseline({artifacts=[],schedulers=[],mappings=[],tasks=[],decisions=[],surfaces=[],at=now()}={}) {
  return {kind:'MIGRATION_BASELINE',baseline_at:at,artifacts:artifacts.map(item=>{const bytes=fs.readFileSync(item.path);const stat=fs.statSync(item.path);return {ref:item.ref,A_path:item.path,bytes:bytes.length,sha256:sha256(bytes),modified_at:stat.mtime.toISOString(),...(item.C_file_id?{C_file_id:item.C_file_id}:{}),...(item.proof_ref?{proof_ref:item.proof_ref}:{})};}),schedulers,mappings,tasks,decisions,surfaces};
}

export function classifyFinding(finding) { if(!CLASSIFICATIONS.has(finding.classification)) throw new Error('Invalid migration classification'); return {...finding}; }

/** Temporary importer: only explicit AUTHORITATIVE_CURRENT records become CF2 state. */
export class SelectiveMigrator {
  constructor(store) { this.store=store; }
  import(records=[]) { const report={kind:'MIGRATION_IMPORT_REPORT',imported:[],candidates:[],conflicts:[],unknown:[],rejected:[]}; for(const raw of records) { const record=classifyFinding(raw); if(record.classification==='AUTHORITATIVE_CURRENT') { if(!record.command) {report.rejected.push({...record,reason_code:'MISSING_EVIDENCE'});continue;} const result=this.store.submitCommand(record.command); (result.accepted?report.imported:report.rejected).push({...record,result}); } else if(record.classification==='CANDIDATE') report.candidates.push(record); else if(record.classification==='CONFLICT') report.conflicts.push(record); else report.unknown.push(record); } return report; }
}

export function compareLogical(cf1={},cf2={}) { const keys=new Set([...Object.keys(cf1),...Object.keys(cf2)]); const discrepancies=[]; for(const key of [...keys].sort()) { const left=cf1[key]; const right=cf2[key]; const leftPresent=Object.hasOwn(cf1,key); const rightPresent=Object.hasOwn(cf2,key); if(leftPresent!==rightPresent || JSON.stringify(left)!==JSON.stringify(right)) discrepancies.push({object:key,property:'logical_state',CF1:(leftPresent&&left!==undefined)?left:{status:'UNKNOWN'},CF2:(rightPresent&&right!==undefined)?right:{status:'UNKNOWN'},classification:(!leftPresent||!rightPresent||left===undefined||right===undefined)?'MATERIAL':'CRITICAL',action_proposed:'review_source_evidence'}); } return {kind:'CF1_CF2_COMPARISON',discrepancies,critical:discrepancies.filter(item=>item.classification==='CRITICAL').length,material:discrepancies.filter(item=>item.classification==='MATERIAL').length,non_critical:0}; }

/** Shadow never executes an external operation; it only persists an intention in its own DEV log. */
export class ShadowRuntime {
  constructor({at=now}={}) { this.at=at; this.started_at=null; this.observations=[]; this.would_do=[]; }
  start() { this.started_at=this.at(); return {mode:'SHADOW_READ',started_at:this.started_at,no_side_effect:true}; }
  observe({baseline,current,label='read-only'}={}) { const changed=JSON.stringify(baseline?.artifacts ?? [])!==JSON.stringify(current?.artifacts ?? []); const observation={observed_at:this.at(),label,changed,mode:'SHADOW_READ',no_side_effect:true}; this.observations.push(observation); return observation; }
  wouldDo(action,payload={}) { const item={id:`WOULD_DO:${crypto.randomUUID()}`,at:this.at(),action:`WOULD_${action}`,payload,no_side_effect:true}; this.would_do.push(item); return item; }
  report() { return {kind:'SHADOW_SOAK_REPORT',started_at:this.started_at,observations:this.observations,would_do:this.would_do,duration_ms:this.started_at?Math.max(0,new Date(this.at()).getTime()-new Date(this.started_at).getTime()):0}; }
}
