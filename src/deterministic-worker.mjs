import crypto from 'node:crypto';

export class WorkerExecutionError extends Error { constructor(code,{transient=false}={}) { super(code); this.code=code; this.transient=transient; } }

/** DEV-only event/timer-driven harness. It has no adapter, network or agent dependency. */
export class DeterministicWorker {
  constructor(store,{worker_id='WORKER:DEV',lease_ms=30000,max_attempts=3,base_delay_ms=1000,max_delay_ms=60000,max_window_ms=300000,jitter_bound_ms=250}={}) { this.store=store; this.worker_id=worker_id; this.lease_ms=lease_ms; this.max_attempts=max_attempts; this.base_delay_ms=base_delay_ms; this.max_delay_ms=max_delay_ms; this.max_window_ms=max_window_ms; this.jitter_bound_ms=jitter_bound_ms; }
  #systemCommand(command_type,payload,at,job_id) { return {command_id:`CMD:WORKER:${crypto.randomUUID()}`,command_type,actor_id:this.worker_id,actor_role:'WORKER_DETERMINISTIC',issued_at:at,idempotency_key:`${job_id}:${command_type}`,payload}; }
  #jitter(job) { if(!this.jitter_bound_ms) return 0; return crypto.createHash('sha256').update(`${job.job_id}:${job.attempt}`).digest().readUInt16BE(0)%this.jitter_bound_ms; }
  reconcile(at) { const leases=this.store.recoverExpiredLeases(at); const timers=this.store.fireDueTimers(at); const dispatched=this.store.dispatchPendingOutbox(at); return {dispatched,leases,timers}; }
  claimWithoutExecuting(at) { return this.store.claimNextJob(this.worker_id,{at,lease_ms:this.lease_ms}); }
  async runOnce({at=new Date().toISOString(),max_jobs=100}={}) {
    const reconciliation=this.reconcile(at); const summary={...reconciliation,executed:0,retried:0,failed:0,noop:0,agent_invocations:0};
    for (let index=0; index<max_jobs; index++) { const claimed=this.store.claimNextJob(this.worker_id,{at,lease_ms:this.lease_ms}); if (!claimed) break; const job=this.store.startJob(claimed.job_id,this.worker_id,at); try { const result=this.#execute(job,at); this.store.completeJob(job.job_id,this.worker_id,result,at); summary.executed++; if(result.noop) summary.noop++; } catch(error) { const updated=this.store.retryJob(job.job_id,this.worker_id,error.code ?? error.message,{at,max_attempts:this.max_attempts,base_delay_ms:this.base_delay_ms,max_delay_ms:this.max_delay_ms,max_window_ms:this.max_window_ms,jitter_ms:this.#jitter(job),transient:error.transient===true}); if(updated.status==='RETRY_WAIT') summary.retried++; else summary.failed++; } }
    if (summary.executed===0 && summary.retried===0 && summary.failed===0) this.store.recordWorkerMetric('idle_runs',at);
    return summary;
  }
  #execute(job,at) {
    const payload=JSON.parse(job.payload);
    if (job.job_type==='OUTBOX_EVENT') return {kind:'VIEW_REFRESH',event_id:payload.event_id,views:this.store.regenerateAllViews()};
    if (job.job_type==='TTL_EXPIRE') { const result=this.store.submitCommand(this.#systemCommand('EXPIRE_VERIFICATION',{verification_id:payload.verification_id,at},at,job.job_id)); if(!result.accepted && result.reason_code!=='FAIL_CLOSED') throw new WorkerExecutionError(result.reason_code); return {kind:'TTL_EXPIRE',expired:result.accepted?1:0,noop:!result.accepted}; }
    if (job.job_type==='INVALIDATE_CONDITIONAL') { const result=this.store.submitCommand(this.#systemCommand('INVALIDATE_VERIFICATION',payload,at,job.job_id)); if(!result.accepted) throw new WorkerExecutionError(result.reason_code); return {kind:'INVALIDATE_CONDITIONAL',result}; }
    if (job.job_type==='DEV_FAIL_ONCE') { if (job.attempt<=Number(payload.fail_attempts ?? 1)) throw new WorkerExecutionError('DEV_TRANSIENT_FAILURE',{transient:true}); return {kind:'DEV_FAIL_ONCE',recovered:true}; }
    if (job.job_type==='DEV_PERMANENT_FAILURE') throw new WorkerExecutionError('INVALID_SCHEMA');
    if (job.job_type==='NOOP') return {kind:'NOOP',noop:true};
    throw new WorkerExecutionError(`UNSUPPORTED_JOB:${job.job_type}`);
  }
}
