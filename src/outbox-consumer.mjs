const defaultHandler=async()=>{};

export class OutboxConsumer{
  constructor(store,{handler=defaultHandler,pollIntervalMs=2000,batchSize=100,logger=console}={}){
    this.store=store;this.handler=handler;this.pollIntervalMs=pollIntervalMs;this.batchSize=batchSize;this.logger=logger;this.timer=null;this.inFlight=null;this.processed=0;this.lastRunAt=null;this.lastSuccessAt=null;this.lastError=null;
  }
  async runOnce(){
    if(this.inFlight)return this.inFlight;
    this.inFlight=(async()=>{this.lastRunAt=new Date().toISOString();let consumed=0;const events=await this.store.pendingOutbox(this.batchSize);for(const event of events){try{await this.handler(event);if(await this.store.markOutboxConsumed(event.event_id)){consumed++;this.processed++;this.lastSuccessAt=new Date().toISOString();this.lastError=null;}}catch(error){this.lastError=String(error?.message??error);this.logger.error('OUTBOX_CONSUMER_ERROR',{event_id:event.event_id,error:this.lastError});}}return{scanned:events.length,consumed};})().finally(()=>{this.inFlight=null;});
    return this.inFlight;
  }
  start(){if(this.timer)return false;void this.runOnce().catch(error=>{this.lastError=String(error?.message??error);this.logger.error('OUTBOX_CONSUMER_POLL_ERROR',{error:this.lastError});});this.timer=setInterval(()=>{void this.runOnce().catch(error=>{this.lastError=String(error?.message??error);this.logger.error('OUTBOX_CONSUMER_POLL_ERROR',{error:this.lastError});});},this.pollIntervalMs);this.timer.unref?.();return true;}
  async stop(){if(this.timer){clearInterval(this.timer);this.timer=null;}if(this.inFlight)await this.inFlight;}
  health(){return{status:this.timer?'RUNNING':'STOPPED',poll_interval_ms:this.pollIntervalMs,processed:this.processed,last_run_at:this.lastRunAt,last_success_at:this.lastSuccessAt,last_error:this.lastError};}
}
