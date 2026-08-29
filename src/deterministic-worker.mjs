import crypto from 'node:crypto';

/** DEV-only manual harness. It has no scheduler, adapter, network or agent dependency. */
export class DeterministicWorker {
  constructor(store,{worker_id='WORKER:DEV',lease_ms=30000,max_attempts=3,base_delay_ms=1000}={}) { this.store=store; this.worker_id=worker_id; this.lease_ms=lease_ms; this.max_attempts=max_attempts; this.base_delay_ms=base_delay_ms; }
  #systemCommand(command_type,payload,at,job_id) { return {command_id:`CMD:WORKER:${crypto.randomUUID()}`,command_type,actor_id:this.worker_id,actor_role:'WORKER_DETERMINISTIC',issued_at:at,idempotency_key:`${job_id}:${command_type}`,payload}; }
  #scheduleTimers(at) { const due=this.store.listDueVolatile(at); if (due.length) this.store.enqueueDevJob({job_type:'TTL_SWEEP',payload:{at},dedupe_key:`TTL:${at}`,at}); return due.length; }
  reconcile(at) { const dispatched=this.store.dispatchPendingOutbox(at); const leases=this.store.recoverExpiredLeases(at); const timers=this.#scheduleTimers(at); return {dispatched,leases,timers}; }
  claimWithoutExecuting(at) { return this.store.claimNextJob(this.worker_id,{at,lease_ms:this.lease_ms}); }
  async runOnce({at=new Date().toISOString(),max_jobs=100}={}) {
    const reconciliation=this.reconcile(at); const summary={...reconciliation,executed:0,retried:0,failed:0,noop:0,agent_invocations:0};
    for (let index=0; index<max_jobs; index++) { const claimed=this.store.claimNextJob(this.worker_id,{at,lease_ms:this.lease_ms}); if (!claimed) break; const job=this.store.startJob(claimed.job_id,this.worker_id,at); try { const result=this.#execute(job,at); this.store.completeJob(job.job_id,this.worker_id,result,at); summary.executed++; if(result.noop) summary.noop++; } catch(error) { const updated=this.store.retryJob(job.job_id,this.worker_id,error,{at,max_attempts:this.max_attempts,base_delay_ms:this.base_delay_ms}); if(updated.status==='RETRY_WAIT') summary.retried++; else summary.failed++; } }
    if (summary.executed===0 && summary.retried===0 && summary.failed===0) this.store.recordWorkerMetric('idle_runs',at);
    return summary;
  }
  #execute(job,at) {
    const payload=JSON.parse(job.payload);
    if (job.job_type==='OUTBOX_EVENT') return {kind:'VIEW_REFRESH',event_id:payload.event_id,views:this.store.regenerateAllViews()};
    if (job.job_type==='TTL_SWEEP') { const due=this.store.listDueVolatile(at); const results=due.map(v=>this.store.submitCommand(this.#systemCommand('EXPIRE_VERIFICATION',{verification_id:v.id,at},at,job.job_id))); return {kind:'TTL_SWEEP',expired:results.filter(x=>x.accepted).length,noop:results.length===0}; }
    if (job.job_type==='INVALIDATE_CONDITIONAL') { const result=this.store.submitCommand(this.#systemCommand('INVALIDATE_VERIFICATION',payload,at,job.job_id)); if(!result.accepted) throw new Error(result.reason_code); return {kind:'INVALIDATE_CONDITIONAL',result}; }
    if (job.job_type==='DEV_FAIL_ONCE') { if (job.attempt<=Number(payload.fail_attempts ?? 1)) throw new Error('DEV_DETERMINISTIC_FAILURE'); return {kind:'DEV_FAIL_ONCE',recovered:true}; }
    if (job.job_type==='NOOP') return {kind:'NOOP',noop:true};
    throw new Error(`UNSUPPORTED_JOB:${job.job_type}`);
  }
}
