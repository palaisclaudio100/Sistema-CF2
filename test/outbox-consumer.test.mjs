import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {OutboxConsumer} from '../src/outbox-consumer.mjs';

class Store{
  constructor(events=[]){this.events=new Map(events.map(event=>[event.event_id,{...event,status:'PENDING'}]));this.marks=0;}
  async pendingOutbox(limit){return[...this.events.values()].filter(event=>event.status==='PENDING').slice(0,limit);}
  async markOutboxConsumed(event_id){const event=this.events.get(event_id);if(!event||event.status!=='PENDING')return false;event.status='CONSUMED';this.marks++;return true;}
}
const event={event_id:'EVENT:CANARY:001',event_type:'ACCEPTED',payload:{producer:'CORE_PROD'}};

test('OUTBOX-01 normal runtime consumes a pending event without cutover',async()=>{const store=new Store([event]),consumer=new OutboxConsumer(store);assert.deepEqual(await consumer.runOnce(),{scanned:1,consumed:1});assert.equal(store.events.get(event.event_id).status,'CONSUMED');});
test('OUTBOX-02 successful processing leaves no pending event',async()=>{const store=new Store([event]),consumer=new OutboxConsumer(store);await consumer.runOnce();assert.equal((await store.pendingOutbox(10)).length,0);});
test('OUTBOX-03 processing failure preserves PENDING and logs the error',async()=>{const errors=[],store=new Store([event]),consumer=new OutboxConsumer(store,{handler:async()=>{throw new Error('DELIVERY_FAILED');},logger:{error:(...args)=>errors.push(args)}});assert.deepEqual(await consumer.runOnce(),{scanned:1,consumed:0});assert.equal(store.events.get(event.event_id).status,'PENDING');assert.equal(store.marks,0);assert.equal(errors.length,1);});
test('OUTBOX-04 prod-service starts the normal consumer',()=>{const source=fs.readFileSync(new URL('../src/prod-service.mjs',import.meta.url),'utf8');assert.match(source,/new OutboxConsumer\(store\)/);assert.match(source,/outboxConsumer\.start\(\)/);});
test('OUTBOX-05 shutdown stops polling and waits for in-flight processing',async()=>{let release;const gate=new Promise(resolve=>{release=resolve;}),store=new Store([event]),consumer=new OutboxConsumer(store,{pollIntervalMs:1000,handler:()=>gate});consumer.start();assert.equal(consumer.health().status,'RUNNING');const stopped=consumer.stop();release();await stopped;assert.equal(consumer.health().status,'STOPPED');assert.equal(store.events.get(event.event_id).status,'CONSUMED');});
test('OUTBOX-06 a consumed event is not processed twice',async()=>{let calls=0;const store=new Store([event]),consumer=new OutboxConsumer(store,{handler:async()=>{calls++;}});await consumer.runOnce();await consumer.runOnce();assert.equal(calls,1);assert.equal(store.marks,1);});
test('OUTBOX-07 production cutover reuses the shared consumer',()=>{const source=fs.readFileSync(new URL('../src/production-cutover.mjs',import.meta.url),'utf8');assert.match(source,/import \{OutboxConsumer\}/);assert.match(source,/new OutboxConsumer\(this\.store\)\.runOnce\(\)/);assert.doesNotMatch(source,/UPDATE outbox SET status='CONSUMED'/);});
test('OUTBOX-08 normal CANARY writers do not depend on executing cutover',()=>{const service=fs.readFileSync(new URL('../src/prod-service.mjs',import.meta.url),'utf8'),roles=fs.readFileSync(new URL('../src/production-role-interface.mjs',import.meta.url),'utf8');assert.ok(service.indexOf('outboxConsumer.start()')>service.indexOf('server.listen'));assert.doesNotMatch(roles,/ProductionCutoverCoordinator/);});
