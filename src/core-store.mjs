import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const AUTHORITY = { ROLE_DELEGATED: 1, DGA_DELEGATED: 2, CLAUDIO_PERSISTED: 3, CLAUDIO_DIRECT: 4 };
const TYPES = new Set(['ENTITY','SURFACE','TASK','DECISION','VERIFICATION','RELATION']);
const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const normalize = value => value.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es-AR').replace(/\s+/g, ' ');

export class CF2Error extends Error { constructor(reason_code, message = reason_code) { super(message); this.reason_code = reason_code; } }

export class CoreStore {
  constructor(dbPath) { this.dbPath = dbPath; fs.mkdirSync(path.dirname(dbPath), {recursive:true}); this.db = new DatabaseSync(dbPath); this.#migrate(); }
  close() { this.db.close(); }
  #migrate() {
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (alias TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(alias, entity_id));
      CREATE TABLE IF NOT EXISTS decisions (object_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, decision_key TEXT NOT NULL, status TEXT NOT NULL, authority TEXT NOT NULL, authority_rank INTEGER NOT NULL, effective_at TEXT NOT NULL, supersedes TEXT);
      CREATE INDEX IF NOT EXISTS decisions_current ON decisions(subject_id, decision_key, status);
      CREATE TABLE IF NOT EXISTS verifications (object_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, attribute TEXT NOT NULL, class TEXT NOT NULL, status TEXT NOT NULL, valid_until TEXT, invalidation_rule TEXT);
      CREATE INDEX IF NOT EXISTS verification_current ON verifications(subject_id, attribute, status);
      CREATE TABLE IF NOT EXISTS tasks (object_id TEXT PRIMARY KEY, state TEXT NOT NULL, closure_ref TEXT);
      CREATE TABLE IF NOT EXISTS proofs (proof_ref TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (mutation_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor_id TEXT NOT NULL, actor_role TEXT NOT NULL, command_id TEXT, object_id TEXT, previous_version INTEGER NOT NULL, new_version INTEGER NOT NULL, reason TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, state_version INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (idempotency_key TEXT PRIMARY KEY, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS views (view_key TEXT PRIMARY KEY, body TEXT NOT NULL, generated_from_state_version INTEGER NOT NULL, updated_at TEXT NOT NULL);`);
    if (!this.db.prepare('SELECT value FROM meta WHERE key=?').get('state_version')) this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('state_version','0');
  }
  #version() { return Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('state_version').value); }
  #setVersion(version) { this.db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(version), 'state_version'); }
  #validate(object) {
    for (const field of ['id','type','status','created_at','updated_at','basis_ref']) if (!(field in object)) throw new CF2Error('INVALID_ID', `Missing ${field}`);
    if (!TYPES.has(object.type) || !Array.isArray(object.basis_ref) || object.basis_ref.length === 0) throw new CF2Error('INVALID_ID');
    if (object.type === 'TASK') { for (const k of ['action','state','responsible_role','related_ids']) if (!(k in object)) throw new CF2Error('INVALID_ID'); if (object.state === 'DONE' && !object.closure_ref) throw new CF2Error('MISSING_CLOSURE_PROOF'); }
    if (object.type === 'DECISION') { for (const k of ['subject_id','decision_key','value','authority','effective_at','source_ref']) if (!(k in object)) throw new CF2Error('INVALID_ID'); if (!(object.authority in AUTHORITY)) throw new CF2Error('AUTHORITY_DENIED'); }
    if (object.type === 'VERIFICATION') { for (const k of ['subject_id','attribute','value','class','verified_at','verified_by','evidence_ref']) if (!(k in object)) throw new CF2Error('MISSING_EVIDENCE'); if (!['FIJO','VOLÁTIL','CONDICIONAL'].includes(object.class)) throw new CF2Error('INVALID_ID'); if (object.class === 'VOLÁTIL' && !object.valid_until) throw new CF2Error('STALE_VERIFICATION'); if (object.class === 'CONDICIONAL' && !object.invalidation_rule) throw new CF2Error('INVALID_ID'); }
    if (object.type === 'ENTITY') for (const k of ['entity_kind','canonical_name','aliases']) if (!(k in object)) throw new CF2Error('INVALID_ID');
    if (object.type === 'SURFACE') for (const k of ['platform','surface_kind','external_id','owner_or_subject_id']) if (!(k in object)) throw new CF2Error('INVALID_ID');
    if (object.type === 'RELATION') for (const k of ['from_id','relation_type','to_id','effective_at']) if (!(k in object)) throw new CF2Error('INVALID_ID');
  }
  #object(id) { const row = this.db.prepare('SELECT body FROM objects WHERE id=?').get(id); return row ? parse(row.body) : null; }
  #writeObject(object) { this.db.prepare('INSERT OR REPLACE INTO objects(id,type,status,body,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(object.id,object.type,object.status,json(object),object.created_at,object.updated_at); }
  #event(type, subject_id, state_version, causation_id, command) { const event_id = `EVENT:${crypto.randomUUID()}`; const occurred_at=now(); const event={event_id,event_type:type,subject_id,occurred_at,producer:'CORE_DEV',causation_id,correlation_id:command.correlation_id ?? null,state_version,dedupe_key:command.idempotency_key}; this.db.prepare('INSERT INTO outbox(event_id,event_type,state_version,payload,created_at) VALUES(?,?,?,?,?)').run(event_id,type,state_version,json(event),occurred_at); return event_id; }
  #audit({command, object_id, before, after, reason, state_version}) { this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?)').run(`MUTATION:${crypto.randomUUID()}`,now(),command.actor_id,command.actor_role,command.command_id,object_id,before,state_version,reason,after); }
  #put(object, command, reason = 'ACCEPTED') {
    this.#validate(object); const previous = this.#object(object.id); this.#writeObject(object);
    if (object.type === 'ENTITY') { this.db.prepare('DELETE FROM aliases WHERE entity_id=?').run(object.id); for (const name of [object.canonical_name,...object.aliases]) this.db.prepare('INSERT OR IGNORE INTO aliases(alias,entity_id) VALUES(?,?)').run(normalize(name),object.id); }
    if (object.type === 'TASK') this.db.prepare('INSERT OR REPLACE INTO tasks(object_id,state,closure_ref) VALUES(?,?,?)').run(object.id,object.state,object.closure_ref ?? null);
    if (object.type === 'VERIFICATION') this.db.prepare('INSERT OR REPLACE INTO verifications(object_id,subject_id,attribute,class,status,valid_until,invalidation_rule) VALUES(?,?,?,?,?,?,?)').run(object.id,object.subject_id,object.attribute,object.class,object.status,object.valid_until ?? null,object.invalidation_rule ?? null);
    return previous;
  }
  submitCommand(command) {
    const required = ['command_id','command_type','actor_id','actor_role','issued_at','idempotency_key','payload'];
    for (const key of required) if (!(key in command)) throw new CF2Error('INVALID_ID', `Missing command ${key}`);
    const existing = this.db.prepare('SELECT response FROM idempotency WHERE idempotency_key=?').get(command.idempotency_key); if (existing) return parse(existing.response);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const beforeVersion = this.#version(); if (command.expected_state_version !== undefined && command.expected_state_version !== beforeVersion) throw new CF2Error('VERSION_CONFLICT');
      let object; let reason = 'ACCEPTED'; let conflict = false;
      if (['UPSERT_ENTITY','REGISTER_SURFACE','CREATE_TASK','SET_RELATION'].includes(command.command_type)) object = command.payload.object;
      else if (command.command_type === 'RECORD_DECISION') object = this.#recordDecision(command);
      else if (command.command_type === 'RECORD_VERIFICATION') object = command.payload.object;
      else if (command.command_type === 'TRANSITION_TASK') object = this.#transitionTask(command);
      else if (command.command_type === 'INVALIDATE_VERIFICATION') object = this.#invalidate(command);
      else throw new CF2Error('INVALID_ID', 'Unsupported command in Stage 1');
      if (object?.type === 'TASK' && object.state === 'DONE' && !this.db.prepare('SELECT 1 FROM proofs WHERE proof_ref=?').get(object.closure_ref)) throw new CF2Error('MISSING_CLOSURE_PROOF');
      const previous = this.#put(object, command, reason); const nextVersion = beforeVersion + 1; this.#setVersion(nextVersion);
      const event_id = this.#event('ACCEPTED', object.id, nextVersion, command.command_id, command); this.#audit({command,object_id:object.id,before:beforeVersion,after:'ACCEPTED',reason,state_version:nextVersion});
      const response = {accepted:true,reason_code:reason,resulting_state_version:nextVersion,emitted_event_ids:[event_id],conflict}; this.db.prepare('INSERT INTO idempotency VALUES(?,?)').run(command.idempotency_key,json(response)); this.db.exec('COMMIT'); return response;
    } catch (error) { this.db.exec('ROLLBACK'); return {accepted:false,reason_code:error.reason_code ?? 'FAIL_CLOSED',conflict:error.reason_code === 'CONFLICT'}; }
  }
  #recordDecision(command) {
    const object = structuredClone(command.payload.object); this.#validate(object); const current = this.db.prepare("SELECT object_id,authority,authority_rank FROM decisions WHERE subject_id=? AND decision_key=? AND status='CURRENT'").get(object.subject_id,object.decision_key);
    if (current) {
      if (AUTHORITY[object.authority] < current.authority_rank) throw new CF2Error('AUTHORITY_DENIED');
      if (!object.supersedes || object.supersedes !== current.object_id) throw new CF2Error('CONFLICT');
      const old = this.#object(current.object_id); old.status='SUPERSEDED'; old.superseded_by=object.id; old.updated_at=now(); this.#writeObject(old); this.db.prepare("UPDATE decisions SET status='SUPERSEDED' WHERE object_id=?").run(old.id);
    }
    object.status='CURRENT'; this.db.prepare('INSERT OR REPLACE INTO decisions VALUES(?,?,?,?,?,?,?,?)').run(object.id,object.subject_id,object.decision_key,object.status,object.authority,AUTHORITY[object.authority],object.effective_at,object.supersedes ?? null); return object;
  }
  #transitionTask(command) { const old=this.#object(command.payload.task_id); if (!old || old.type!=='TASK') throw new CF2Error('INVALID_ID'); const object={...old,state:command.payload.state,status:command.payload.state,closure_ref:command.payload.closure_ref ?? old.closure_ref,updated_at:now(),basis_ref:[...old.basis_ref, command.command_id]}; return object; }
  #invalidate(command) { const row=this.db.prepare("SELECT object_id FROM verifications WHERE subject_id=? AND attribute=? AND status='CURRENT'").get(command.payload.subject_id,command.payload.attribute); if (!row) throw new CF2Error('UNKNOWN'); const old=this.#object(row.object_id); if (old.class !== 'CONDICIONAL' || old.invalidation_rule !== command.payload.invalidation_rule) throw new CF2Error('FAIL_CLOSED'); return {...old,status:'EXPIRED',updated_at:now(),basis_ref:[...old.basis_ref,command.command_id]}; }
  registerDevProof(proof_ref, body={}) { this.db.prepare('INSERT OR REPLACE INTO proofs VALUES(?,?,?)').run(proof_ref,json(body),now()); }
  getCurrent(subject_id, property_key, at = now()) {
    const decision=this.db.prepare("SELECT object_id FROM decisions WHERE subject_id=? AND decision_key=? AND status='CURRENT'").get(subject_id,property_key); if (decision) return {status:'CURRENT',object:this.#object(decision.object_id)};
    const verification=this.db.prepare("SELECT object_id,class,valid_until,status FROM verifications WHERE subject_id=? AND attribute=? AND status='CURRENT'").get(subject_id,property_key);
    if (verification) { if (verification.class === 'VOLÁTIL' && verification.valid_until <= at) return {status:'EXPIRED',reason_code:'EXPIRED'}; return {status:'CURRENT',object:this.#object(verification.object_id)}; }
    return {status:'UNKNOWN',reason_code:'UNKNOWN'};
  }
  resolveEntity(nameOrId) { const direct=this.#object(nameOrId); if (direct?.type==='ENTITY') return {status:'EXACT',entity:direct}; const rows=this.db.prepare('SELECT entity_id FROM aliases WHERE alias=?').all(normalize(nameOrId)); if (!rows.length) return {status:'UNKNOWN',reason_code:'ENTITY_NEW'}; if (rows.length>1) return {status:'AMBIGUOUS',reason_code:'AMBIGUOUS_ALIAS',candidate_ids:rows.map(x=>x.entity_id)}; return {status:'UNIQUE',entity:this.#object(rows[0].entity_id)}; }
  regenerateEntityView(entityId) { const entity=this.#object(entityId); if (!entity) throw new CF2Error('UNKNOWN'); const version=this.#version(); const body={entity,generated_from_state_version:version}; this.db.prepare('INSERT OR REPLACE INTO views VALUES(?,?,?,?)').run(`ENTITY:${entityId}`,json(body),version,now()); return body; }
  deleteView(key) { this.db.prepare('DELETE FROM views WHERE view_key=?').run(key); }
  corruptView(key) { this.db.prepare('UPDATE views SET body=? WHERE view_key=?').run('{corrupt',key); }
  getAudit() { return this.db.prepare('SELECT * FROM audit ORDER BY timestamp').all(); }
  getOutbox() { return this.db.prepare('SELECT * FROM outbox ORDER BY created_at').all(); }
  getObject(id) { return this.#object(id); }
  stateVersion() { return this.#version(); }
  backupTo(backupPath) { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); const quoted=backupPath.replaceAll("'","''"); this.db.exec(`VACUUM INTO '${quoted}'`); return {backupPath,bytes:fs.statSync(backupPath).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex')}; }
  restoreFrom(backupPath) { this.close(); fs.copyFileSync(backupPath,this.dbPath); this.db=new DatabaseSync(this.dbPath); return {state_version:this.#version(),audit_count:this.getAudit().length}; }
}
