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
      CREATE TABLE IF NOT EXISTS views (view_key TEXT PRIMARY KEY, body TEXT NOT NULL, generated_from_state_version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, event_id TEXT UNIQUE, job_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, worker_id TEXT, claimed_at TEXT, lease_until TEXT, attempt INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, dedupe_key TEXT UNIQUE NOT NULL, last_error TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS job_attempts (attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL, worker_id TEXT, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_metrics (metric_key TEXT PRIMARY KEY, metric_value INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS timers (timer_id TEXT PRIMARY KEY, timer_type TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL, dedupe_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, fired_at TEXT);
      CREATE INDEX IF NOT EXISTS timers_due ON timers(status,due_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS mappings (mapping_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, generation TEXT NOT NULL, A_path TEXT NOT NULL, C_file_id TEXT NOT NULL, environment TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(artifact_id,generation));
      CREATE TABLE IF NOT EXISTS replication_attempts (attempt_id TEXT PRIMARY KEY, mapping_id TEXT NOT NULL, artifact_id TEXT NOT NULL, generation TEXT NOT NULL, C_file_id TEXT NOT NULL, result TEXT NOT NULL, reason_code TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replication_proofs (proof_id TEXT PRIMARY KEY, mapping_id TEXT NOT NULL, artifact_id TEXT NOT NULL, generation TEXT NOT NULL, C_file_id TEXT NOT NULL, result TEXT NOT NULL, reason_code TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access_audit (request_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor_id TEXT NOT NULL, role TEXT NOT NULL, operation TEXT NOT NULL, authorized INTEGER NOT NULL, reason_code TEXT NOT NULL, detail TEXT NOT NULL);`);
    this.#ensureColumn('outbox','status',"TEXT NOT NULL DEFAULT 'PENDING'");
    this.#ensureColumn('outbox','attempt',"INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn('outbox','consumed_at','TEXT');
    this.#ensureColumn('outbox','last_error','TEXT');
    this.#ensureColumn('jobs','run_id','TEXT');
    this.#ensureColumn('jobs','causation_id','TEXT');
    this.#ensureColumn('jobs','created_at','TEXT');
    if (!this.db.prepare('SELECT value FROM meta WHERE key=?').get('state_version')) this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('state_version','0');
  }
  #ensureColumn(table, column, definition) { const columns=this.db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name); if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
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
  #event(type, subject_id, state_version, causation_id, command) { const event_id = `EVENT:${crypto.randomUUID()}`; const occurred_at=now(); const event={event_id,event_type:type,subject_id,occurred_at,producer:'CORE_DEV',causation_id,correlation_id:command.correlation_id ?? null,state_version,dedupe_key:command.idempotency_key}; this.db.prepare('INSERT INTO outbox(event_id,event_type,state_version,payload,created_at,status) VALUES(?,?,?,?,?,?)').run(event_id,type,state_version,json(event),occurred_at,'PENDING'); return event_id; }
  #audit({command, object_id, before, after, reason, state_version}) { this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?)').run(`MUTATION:${crypto.randomUUID()}`,now(),command.actor_id,command.actor_role,command.command_id,object_id,before,state_version,reason,after); }
  #put(object, command, reason = 'ACCEPTED') {
    this.#validate(object); const previous = this.#object(object.id); this.#writeObject(object);
    if (object.type === 'ENTITY') { this.db.prepare('DELETE FROM aliases WHERE entity_id=?').run(object.id); for (const name of [object.canonical_name,...object.aliases]) this.db.prepare('INSERT OR IGNORE INTO aliases(alias,entity_id) VALUES(?,?)').run(normalize(name),object.id); }
    if (object.type === 'TASK') this.db.prepare('INSERT OR REPLACE INTO tasks(object_id,state,closure_ref) VALUES(?,?,?)').run(object.id,object.state,object.closure_ref ?? null);
    if (object.type === 'VERIFICATION') { this.db.prepare('INSERT OR REPLACE INTO verifications(object_id,subject_id,attribute,class,status,valid_until,invalidation_rule) VALUES(?,?,?,?,?,?,?)').run(object.id,object.subject_id,object.attribute,object.class,object.status,object.valid_until ?? null,object.invalidation_rule ?? null); if (object.class==='VOLÁTIL' && object.status==='CURRENT') this.scheduleTimer({timer_type:'TTL_EXPIRE',due_at:object.valid_until,dedupe_key:`TTL:${object.id}:${object.valid_until}`,payload:{verification_id:object.id}}); }
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
      else if (command.command_type === 'EXPIRE_VERIFICATION') object = this.#expireVerification(command);
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
  #expireVerification(command) { const old=this.#object(command.payload.verification_id); if (!old || old.type!=='VERIFICATION' || old.class!=='VOLÁTIL' || old.status!=='CURRENT') throw new CF2Error('FAIL_CLOSED'); if (old.valid_until > (command.payload.at ?? now())) throw new CF2Error('FAIL_CLOSED'); return {...old,status:'EXPIRED',updated_at:now(),basis_ref:[...old.basis_ref,command.command_id]}; }
  registerDevProof(proof_ref, body={}) { this.db.prepare('INSERT OR REPLACE INTO proofs VALUES(?,?,?)').run(proof_ref,json(body),now()); }
  getCurrent(subject_id, property_key, at = now()) {
    const decision=this.db.prepare("SELECT object_id FROM decisions WHERE subject_id=? AND decision_key=? AND status='CURRENT'").get(subject_id,property_key); if (decision) return {status:'CURRENT',object:this.#object(decision.object_id)};
    const verification=this.db.prepare("SELECT object_id,class,valid_until,status FROM verifications WHERE subject_id=? AND attribute=? AND status='CURRENT'").get(subject_id,property_key);
    if (verification) { if (verification.class === 'VOLÁTIL' && verification.valid_until <= at) return {status:'EXPIRED',reason_code:'EXPIRED'}; return {status:'CURRENT',object:this.#object(verification.object_id)}; }
    return {status:'UNKNOWN',reason_code:'UNKNOWN'};
  }
  resolveEntity(nameOrId) {
    const direct=this.#object(nameOrId); if (direct?.type==='ENTITY' && direct.status==='CURRENT') return {status:'EXACT',matched_by:'ID',entity:direct};
    const needle=normalize(nameOrId); const entities=this.#allObjects('ENTITY','CURRENT');
    const canonical=entities.filter(entity=>normalize(entity.canonical_name)===needle);
    if (canonical.length>1) return {status:'AMBIGUOUS',reason_code:'AMBIGUOUS_CANONICAL_NAME',candidate_ids:canonical.map(x=>x.id)};
    if (canonical.length===1) return {status:'UNIQUE',matched_by:'CANONICAL_NAME',entity:canonical[0]};
    const aliases=entities.filter(entity=>entity.aliases.some(alias=>normalize(alias)===needle));
    if (aliases.length>1) return {status:'AMBIGUOUS',reason_code:'AMBIGUOUS_ALIAS',candidate_ids:aliases.map(x=>x.id)};
    if (aliases.length===1) return {status:'UNIQUE',matched_by:'ALIAS',entity:aliases[0]};
    return {status:'UNKNOWN',reason_code:'ENTITY_CANDIDATE_NEW'};
  }
  resolveSurface({id,platform,external_id}) { if (id) { const object=this.#object(id); return object?.type==='SURFACE' && object.status==='CURRENT' ? {status:'EXACT',matched_by:'ID',surface:object} : {status:'UNKNOWN',reason_code:'UNKNOWN'}; } const matches=this.#allObjects('SURFACE','CURRENT').filter(x=>x.platform===platform && x.external_id===external_id); if (!matches.length) return {status:'UNKNOWN',reason_code:'ENTITY_CANDIDATE_NEW'}; if (matches.length>1) return {status:'AMBIGUOUS',reason_code:'AMBIGUOUS_EXTERNAL_ID',candidate_ids:matches.map(x=>x.id)}; return {status:'UNIQUE',matched_by:'PLATFORM_EXTERNAL_ID',surface:matches[0]}; }
  #allObjects(type, status) { const rows=this.db.prepare('SELECT body FROM objects WHERE type=?' + (status ? ' AND status=?' : '') + ' ORDER BY id').all(...(status?[type,status]:[type])); return rows.map(row=>parse(row.body)); }
  listCurrent(type,{at=now()}={}) { if (!TYPES.has(type)) throw new CF2Error('INVALID_ID'); if (type==='TASK') return this.listOperationalTasks(); if (type==='VERIFICATION') return this.#allObjects(type,'CURRENT').filter(item=>this.#verificationState(item,at)==='CURRENT'); return this.#allObjects(type,'CURRENT'); }
  listCurrentRelations(entityId) { return this.#allObjects('RELATION','CURRENT').filter(r=>!entityId || r.from_id===entityId || r.to_id===entityId); }
  listOperationalTasks() { return this.#allObjects('TASK').filter(task=>['OPEN','READY','IN_PROGRESS','BLOCKED'].includes(task.state)); }
  getHistory(subject_id, property_key) {
    const decisions=this.db.prepare("SELECT object_id FROM decisions WHERE subject_id=?" + (property_key?' AND decision_key=?':'') + " ORDER BY effective_at, CASE status WHEN 'SUPERSEDED' THEN 0 ELSE 1 END, object_id").all(...(property_key?[subject_id,property_key]:[subject_id])).map(r=>this.#object(r.object_id));
    const verifications=this.db.prepare('SELECT object_id FROM verifications WHERE subject_id=?' + (property_key?' AND attribute=?':'') + ' ORDER BY object_id').all(...(property_key?[subject_id,property_key]:[subject_id])).map(r=>this.#object(r.object_id));
    const relations=this.#allObjects('RELATION').filter(r=>r.from_id===subject_id || r.to_id===subject_id);
    const tasks=this.#allObjects('TASK').filter(task=>task.related_ids.includes(subject_id));
    const ids=new Set([...decisions,...verifications,...relations,...tasks].map(x=>x.id));
    return {decisions,verifications,relations,tasks,audit:this.getAudit().filter(a=>ids.has(a.object_id))};
  }
  #verificationState(object, at=now()) { if (object.status!=='CURRENT') return object.status; if (object.class==='VOLÁTIL' && object.valid_until<=at) return 'EXPIRED'; return 'CURRENT'; }
  getCurrentBundle(subjectId,{at=now()}={}) {
    const subject=this.#object(subjectId); if (!subject || !['ENTITY','SURFACE'].includes(subject.type) || subject.status!=='CURRENT') return {status:'UNKNOWN',reason_code:'UNKNOWN'};
    const surfaceIds=new Set(subject.type==='SURFACE' ? [subject.id] : this.#allObjects('SURFACE','CURRENT').filter(surface=>surface.owner_or_subject_id===subject.id).map(surface=>surface.id));
    const subjectIds=new Set([subject.id,...surfaceIds]);
    const decisions=this.#allObjects('DECISION','CURRENT').filter(item=>subjectIds.has(item.subject_id));
    const relations=this.listCurrentRelations().filter(item=>subjectIds.has(item.from_id)||subjectIds.has(item.to_id));
    const tasks=this.listOperationalTasks().filter(item=>item.related_ids.some(id=>subjectIds.has(id)));
    const verifications=this.listCurrent('VERIFICATION',{at}).filter(item=>subjectIds.has(item.subject_id));
    const surfaces=[...surfaceIds].map(id=>this.#object(id));
    return {status:'CURRENT',subject,surfaces,decisions,relations,tasks,verifications,history_ref:{subject_id:subject.id}};
  }
  resolveCurrent(query,{at=now()}={}) { const resolved=query.type==='SURFACE' ? this.resolveSurface(query) : this.resolveEntity(query.id ?? query.name ?? query.alias); if (!['EXACT','UNIQUE'].includes(resolved.status)) return resolved; const subject=resolved.entity ?? resolved.surface; return {...resolved,current:this.getCurrentBundle(subject.id,{at})}; }
  getEntityCard(entityId) {
    const entity=this.#object(entityId); if (!entity || entity.type!=='ENTITY') throw new CF2Error('UNKNOWN');
    const bundle=this.getCurrentBundle(entityId);
    return {kind:'ENTITY_CARD',entity,surfaces:bundle.surfaces,relations:bundle.relations,decisions:bundle.decisions,verifications:bundle.verifications.map(v=>({...v,validity:'CURRENT'})),tasks:bundle.tasks,history_ref:{subject_id:entityId},generated_from_state_version:this.#version()};
  }
  getSurfaceView(surfaceId) {
    const surface=this.#object(surfaceId); if (!surface || surface.type!=='SURFACE') throw new CF2Error('UNKNOWN');
    const verifications=this.listCurrent('VERIFICATION').filter(v=>v.subject_id===surfaceId).map(v=>({...v,validity:'CURRENT'}));
    return {kind:'SURFACE_VIEW',surface,verifications,history_ref:{subject_id:surfaceId},generated_from_state_version:this.#version()};
  }
  getTaskView() { const groups={OPEN:[],READY:[],IN_PROGRESS:[],BLOCKED:[]}; for(const task of this.listOperationalTasks()) groups[task.state].push(task); return {kind:'TASK_VIEW',groups,generated_from_state_version:this.#version()}; }
  getSnapshot() {
    const tasks=this.getTaskView().groups; const operational=[tasks.BLOCKED,tasks.OPEN,tasks.READY,tasks.IN_PROGRESS].flat(); const decisions=this.#allObjects('DECISION','CURRENT');
    const activeIds=new Set([...operational.flatMap(task=>task.related_ids),...decisions.map(item=>item.subject_id)]); const relations=this.listCurrentRelations().filter(item=>activeIds.has(item.from_id)||activeIds.has(item.to_id));
    for (const relation of relations) { activeIds.add(relation.from_id); activeIds.add(relation.to_id); }
    const surfaces=this.#allObjects('SURFACE','CURRENT').filter(surface=>activeIds.has(surface.id)||activeIds.has(surface.owner_or_subject_id)); for (const surface of surfaces) activeIds.add(surface.id);
    return {kind:'STARTUP_SNAPSHOT',generated_from_state_version:this.#version(),blocked_tasks:tasks.BLOCKED,open_tasks:[...tasks.OPEN,...tasks.READY,...tasks.IN_PROGRESS],current_decisions:decisions,conflicts:[...this.#allObjects('DECISION','CONFLICT'),...this.#allObjects('VERIFICATION','CONFLICT'),...this.#allObjects('RELATION','CONFLICT')],active_refs:[...activeIds].sort(),main_relations:relations,hydrate_refs:[...activeIds].sort().map(id=>({id}))};
  }
  getAlphabeticalEntityIndex() { return {kind:'ENTITY_ALPHABETICAL_INDEX',entries:this.#allObjects('ENTITY','CURRENT').map(({id,canonical_name,aliases,entity_kind})=>({id,canonical_name,aliases,entity_kind})).sort((a,b)=>normalize(a.canonical_name).localeCompare(normalize(b.canonical_name),'es-AR')||a.id.localeCompare(b.id)),generated_from_state_version:this.#version()}; }
  #saveView(key, body) { const version=this.#version(); const full={...body,generated_from_state_version:version}; this.db.prepare('INSERT OR REPLACE INTO views VALUES(?,?,?,?)').run(key,json(full),version,now()); return full; }
  regenerateEntityView(entityId) { return this.#saveView(`ENTITY:${entityId}`,this.getEntityCard(entityId)); }
  regenerateSurfaceView(surfaceId) { return this.#saveView(`SURFACE:${surfaceId}`,this.getSurfaceView(surfaceId)); }
  regenerateTaskView() { return this.#saveView('TASKS:OPERATIONAL',this.getTaskView()); }
  regenerateSnapshot() { return this.#saveView('SNAPSHOT:DEFAULT',this.getSnapshot()); }
  regenerateAlphabeticalIndex() { return this.#saveView('INDEX:ENTITIES:ALPHABETICAL',this.getAlphabeticalEntityIndex()); }
  readDerivedView(key) { const row=this.db.prepare('SELECT body,generated_from_state_version FROM views WHERE view_key=?').get(key); if (!row) return {status:'MISSING'}; try { const body=parse(row.body); return Number(row.generated_from_state_version)===this.#version() ? {status:'VALID',body} : {status:'STALE'}; } catch { return {status:'INVALID'}; } }
  deleteAllViews() { const result=this.db.prepare('DELETE FROM views').run(); return result.changes; }
  regenerateAllViews() { const entityViews=this.#allObjects('ENTITY','CURRENT').map(x=>this.regenerateEntityView(x.id)); const surfaceViews=this.#allObjects('SURFACE','CURRENT').map(x=>this.regenerateSurfaceView(x.id)); return {entities:entityViews.length,surfaces:surfaceViews.length,tasks:this.regenerateTaskView(),snapshot:this.regenerateSnapshot(),alphabetical_index:this.regenerateAlphabeticalIndex()}; }
  listDerivedViews() { return this.db.prepare('SELECT view_key,body,generated_from_state_version FROM views ORDER BY view_key').all().map(row=>({view_key:row.view_key,body:parse(row.body),generated_from_state_version:Number(row.generated_from_state_version)})); }
  derivedViewsDigest() { return crypto.createHash('sha256').update(json(this.listDerivedViews())).digest('hex'); }
  authoritativeDigest() { const rows=['objects','decisions','verifications','tasks','proofs','audit','outbox','idempotency'].map(table=>[table,this.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]); return crypto.createHash('sha256').update(json(rows)).digest('hex'); }
  deleteView(key) { this.db.prepare('DELETE FROM views WHERE view_key=?').run(key); }
  corruptView(key,body='{corrupt') { this.db.prepare('UPDATE views SET body=? WHERE view_key=?').run(typeof body==='string'?body:json(body),key); }
  getAudit() { return this.db.prepare('SELECT * FROM audit ORDER BY timestamp').all(); }
  getOutbox() { return this.db.prepare('SELECT * FROM outbox ORDER BY created_at').all(); }
  registerStagingMapping(mapping) { const fields=['mapping_id','artifact_id','generation','A_path','C_file_id','environment','status','created_at','updated_at','basis_ref']; for (const field of fields) if (!(field in mapping)) throw new CF2Error('INVALID_ID',`Missing mapping ${field}`); if (mapping.environment!=='STAGING' || mapping.status!=='AUTHORIZED' || !mapping.C_file_id) throw new CF2Error('FAIL_CLOSED'); this.db.prepare('INSERT INTO mappings VALUES(?,?,?,?,?,?,?,?,?,?)').run(mapping.mapping_id,mapping.artifact_id,mapping.generation,mapping.A_path,mapping.C_file_id,mapping.environment,mapping.status,json(mapping),mapping.created_at,mapping.updated_at); return mapping; }
  getAuthorizedMapping(artifact_id,generation) { const row=this.db.prepare("SELECT body FROM mappings WHERE artifact_id=? AND generation=? AND environment='STAGING' AND status='AUTHORIZED'").get(artifact_id,generation); return row ? parse(row.body) : null; }
  saveReplicationAttempt(attempt) { const fields=['attempt_id','mapping_id','artifact_id','generation','C_file_id','result','reason_code','created_at']; for (const field of fields) if (!(field in attempt)) throw new CF2Error('MISSING_EVIDENCE'); this.db.prepare('INSERT INTO replication_attempts VALUES(?,?,?,?,?,?,?,?,?)').run(attempt.attempt_id,attempt.mapping_id,attempt.artifact_id,attempt.generation,attempt.C_file_id,attempt.result,attempt.reason_code,json(attempt),attempt.created_at); return attempt; }
  saveReplicationProof(proof) { const fields=['proof_id','mapping_id','artifact_id','generation','C_file_id','result','reason_code','created_at']; for (const field of fields) if (!(field in proof)) throw new CF2Error('MISSING_EVIDENCE'); this.db.prepare('INSERT OR IGNORE INTO replication_proofs VALUES(?,?,?,?,?,?,?,?,?)').run(proof.proof_id,proof.mapping_id,proof.artifact_id,proof.generation,proof.C_file_id,proof.result,proof.reason_code,json(proof),proof.created_at); const row=this.db.prepare('SELECT body FROM replication_proofs WHERE proof_id=?').get(proof.proof_id); return parse(row.body); }
  listReplicationProofs() { return this.db.prepare('SELECT body FROM replication_proofs ORDER BY created_at,proof_id').all().map(row=>parse(row.body)); }
  listReplicationAttempts() { return this.db.prepare('SELECT body FROM replication_attempts ORDER BY created_at,attempt_id').all().map(row=>parse(row.body)); }
  recordAccessAttempt(entry) { this.db.prepare('INSERT OR REPLACE INTO access_audit VALUES(?,?,?,?,?,?,?,?)').run(entry.request_id,entry.timestamp,entry.actor_id,entry.role,entry.operation,entry.authorized?1:0,entry.reason_code,json(entry.detail ?? {})); }
  getAccessAudit() { return this.db.prepare('SELECT * FROM access_audit ORDER BY timestamp,request_id').all().map(row=>({...row,authorized:Boolean(row.authorized),detail:parse(row.detail)})); }
  listJobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY job_id').all().map(job=>({...job,payload:parse(job.payload),result:job.result ? parse(job.result) : null})); }
  getJobAttempts(job_id) { return this.db.prepare('SELECT * FROM job_attempts WHERE job_id=? ORDER BY occurred_at, attempt_id').all(job_id).map(item=>({...item,detail:parse(item.detail)})); }
  recordWorkerMetric(metric_key, at=now()) { this.#metric(metric_key,at); }
  getObject(id) { return this.#object(id); }
  stateVersion() { return this.#version(); }
  #jobAttempt(job_id, attempt, status, worker_id, detail, at=now()) { this.db.prepare('INSERT INTO job_attempts VALUES(?,?,?,?,?,?,?)').run(`JOB_ATTEMPT:${crypto.randomUUID()}`,job_id,attempt,status,at,worker_id ?? null,json(detail)); }
  #metric(key, at=now()) { this.db.prepare("INSERT INTO worker_metrics(metric_key,metric_value,updated_at) VALUES(?,?,?) ON CONFLICT(metric_key) DO UPDATE SET metric_value=metric_value+1,updated_at=excluded.updated_at").run(key,1,at); }
  enqueueDevJob({job_type,payload={},dedupe_key,event_id=null,causation_id=null,at=now()}) { const job_id=`JOB:${crypto.randomUUID()}`; this.db.prepare('INSERT OR IGNORE INTO jobs(job_id,event_id,job_type,payload,status,attempt,dedupe_key,next_attempt_at,causation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(job_id,event_id,job_type,json(payload),'READY',0,dedupe_key,at,causation_id,at); return this.db.prepare('SELECT * FROM jobs WHERE dedupe_key=?').get(dedupe_key); }
  scheduleTimer({timer_type,due_at,dedupe_key,payload={},at=now()}) { const timer_id=`TIMER:${crypto.randomUUID()}`; this.db.prepare('INSERT OR IGNORE INTO timers(timer_id,timer_type,due_at,status,dedupe_key,payload,created_at) VALUES(?,?,?,?,?,?,?)').run(timer_id,timer_type,due_at,'PENDING',dedupe_key,json(payload),at); return this.db.prepare('SELECT * FROM timers WHERE dedupe_key=?').get(dedupe_key); }
  fireDueTimers(at=now()) { const rows=this.db.prepare("SELECT * FROM timers WHERE status='PENDING' AND due_at<=? ORDER BY due_at,timer_id").all(at); this.db.exec('BEGIN IMMEDIATE'); try { for(const timer of rows){ const payload=parse(timer.payload); if(timer.timer_type==='JOB_RETRY') this.db.prepare("UPDATE jobs SET status='READY',worker_id=NULL,claimed_at=NULL WHERE job_id=? AND status='RETRY_WAIT'").run(payload.job_id); else if(timer.timer_type==='TTL_EXPIRE') this.enqueueDevJob({job_type:'TTL_EXPIRE',payload,dedupe_key:`TIMER_JOB:${timer.dedupe_key}`,causation_id:timer.timer_id,at}); else if(timer.timer_type==='CONDITIONAL_INVALIDATION') this.enqueueDevJob({job_type:'INVALIDATE_CONDITIONAL',payload,dedupe_key:`TIMER_JOB:${timer.dedupe_key}`,causation_id:timer.timer_id,at}); this.db.prepare("UPDATE timers SET status='FIRED',fired_at=? WHERE timer_id=? AND status='PENDING'").run(at,timer.timer_id); } this.db.exec('COMMIT'); return rows.length; } catch(error){this.db.exec('ROLLBACK');throw error;} }
  listTimers() { return this.db.prepare('SELECT * FROM timers ORDER BY due_at,timer_id').all().map(timer=>({...timer,payload:parse(timer.payload)})); }
  cancelJob(job_id,at=now()) { const job=this.db.prepare('SELECT attempt FROM jobs WHERE job_id=?').get(job_id); const changed=this.db.prepare("UPDATE jobs SET status='CANCELLED',lease_until=NULL WHERE job_id=? AND status NOT IN ('DONE','FAILED_ACTIONABLE','CANCELLED')").run(job_id).changes; if(changed) this.#jobAttempt(job_id,job?.attempt ?? 0,'CANCELLED',null,{},at); return Boolean(changed); }
  dispatchPendingOutbox(at=now()) { const rows=this.db.prepare("SELECT * FROM outbox WHERE status='PENDING' ORDER BY created_at").all(); this.db.exec('BEGIN IMMEDIATE'); try { for (const row of rows) { this.enqueueDevJob({job_type:'OUTBOX_EVENT',payload:parse(row.payload),dedupe_key:`EVENT:${row.event_id}`,event_id:row.event_id,causation_id:row.event_id,at}); this.db.prepare("UPDATE outbox SET status='DISPATCHED',attempt=attempt+1,consumed_at=? WHERE event_id=?").run(at,row.event_id); } this.db.exec('COMMIT'); return rows.length; } catch(error) { this.db.exec('ROLLBACK'); throw error; } }
  recoverExpiredLeases(at=now()) { const rows=this.db.prepare("SELECT * FROM jobs WHERE status IN ('CLAIMED','RUNNING') AND lease_until<=?").all(at); for (const row of rows) { this.db.prepare("UPDATE jobs SET status='READY',worker_id=NULL,claimed_at=NULL,lease_until=NULL,next_attempt_at=?,last_error=? WHERE job_id=?").run(at,'LEASE_EXPIRED_CHECK_BEFORE_ACT',row.job_id); this.#jobAttempt(row.job_id,row.attempt,'LEASE_EXPIRED',row.worker_id,{reason:'LEASE_EXPIRED',recovery:'CHECK_BEFORE_ACT'},at); this.#metric('leases_expired',at); } return rows.length; }
  claimNextJob(worker_id,{at=now(),lease_ms=30000,run_id=`RUN:${crypto.randomUUID()}`}={}) { const row=this.db.prepare("SELECT * FROM jobs WHERE status='READY' ORDER BY job_id LIMIT 1").get(); if (!row) return null; const lease_until=new Date(new Date(at).getTime()+lease_ms).toISOString(); const changed=this.db.prepare("UPDATE jobs SET status='CLAIMED',worker_id=?,claimed_at=?,lease_until=?,attempt=attempt+1,run_id=? WHERE job_id=? AND status='READY'").run(worker_id,at,lease_until,run_id,row.job_id).changes; if (!changed) return null; const claimed=this.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(row.job_id); this.#jobAttempt(claimed.job_id,claimed.attempt,'CLAIMED',worker_id,{lease_until,run_id},at); return claimed; }
  startJob(job_id,worker_id,at=now()) { const changes=this.db.prepare("UPDATE jobs SET status='RUNNING' WHERE job_id=? AND worker_id=? AND status='CLAIMED'").run(job_id,worker_id).changes; if (!changes) throw new CF2Error('FAIL_CLOSED'); const job=this.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(job_id); this.#jobAttempt(job_id,job.attempt,'RUNNING',worker_id,{},at); return job; }
  completeJob(job_id,worker_id,result,at=now()) { if (result===undefined || result===null) throw new CF2Error('MISSING_EVIDENCE'); const changes=this.db.prepare("UPDATE jobs SET status='DONE',lease_until=NULL,result=?,last_error=NULL WHERE job_id=? AND worker_id=? AND status='RUNNING'").run(json(result),job_id,worker_id).changes; if (!changes) throw new CF2Error('FAIL_CLOSED'); const job=this.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(job_id); this.#jobAttempt(job_id,job.attempt,'DONE',worker_id,result,at); this.#metric(result.noop?'jobs_noop':'jobs_executed',at); return job; }
  retryJob(job_id,worker_id,error,{at=now(),max_attempts=3,base_delay_ms=1000,max_delay_ms=60000,max_window_ms=300000,jitter_ms=0,transient=false}={}) { const job=this.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(job_id); if (!job || job.worker_id!==worker_id || job.status!=='RUNNING') throw new CF2Error('FAIL_CLOSED'); const exhausted=job.attempt>=max_attempts || new Date(at).getTime()-new Date(job.created_at ?? job.claimed_at ?? at).getTime()>=max_window_ms; const retry=transient && !exhausted; const delay=Math.min(base_delay_ms*(2**Math.max(0,job.attempt-1))+jitter_ms,max_delay_ms); const next=retry?new Date(new Date(at).getTime()+delay).toISOString():null; const status=retry?'RETRY_WAIT':'FAILED_ACTIONABLE'; this.db.prepare('UPDATE jobs SET status=?,lease_until=NULL,next_attempt_at=?,last_error=? WHERE job_id=?').run(status,next,String(error),job_id); if(retry) this.scheduleTimer({timer_type:'JOB_RETRY',due_at:next,dedupe_key:`RETRY:${job_id}:${job.attempt}`,payload:{job_id,attempt:job.attempt}}); this.#jobAttempt(job_id,job.attempt,status,worker_id,{error:String(error),next_attempt_at:next,classification:transient?'TRANSIENT_TECHNICAL':'PERMANENT'},at); this.#metric(retry?'jobs_retries':'jobs_actionable_failures',at); return this.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(job_id); }
  listDueVolatile(at=now()) { return this.#allObjects('VERIFICATION','CURRENT').filter(v=>v.class==='VOLÁTIL' && v.valid_until<=at); }
  workerHealth(at=now()) { const byStatus={}; for (const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status').all()) byStatus[row.status]=row.count; const timers={}; for(const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM timers GROUP BY status').all()) timers[row.status]=row.count; const metrics=Object.fromEntries(this.db.prepare('SELECT metric_key,metric_value FROM worker_metrics').all().map(x=>[x.metric_key,x.metric_value])); const last=this.db.prepare("SELECT occurred_at FROM job_attempts WHERE status='DONE' ORDER BY occurred_at DESC LIMIT 1").get(); const last_errors=this.db.prepare("SELECT job_id,last_error FROM jobs WHERE last_error IS NOT NULL ORDER BY job_id DESC LIMIT 10").all(); const oldest=this.db.prepare("SELECT created_at FROM outbox WHERE status='PENDING' ORDER BY created_at LIMIT 1").get(); const recent_events=this.db.prepare("SELECT event_id,event_type,status,created_at FROM outbox ORDER BY created_at DESC LIMIT 10").all(); const since=last ? Math.max(0,new Date(at).getTime()-new Date(last.occurred_at).getTime()) : null; return {worker_health:'DEV_MANUAL',state_version:this.#version(),jobs:byStatus,outbox_pending:this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='PENDING'").get().count,outbox_oldest_age_ms:oldest?Math.max(0,new Date(at).getTime()-new Date(oldest.created_at).getTime()):null,expired_leases:this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('CLAIMED','RUNNING') AND lease_until<=?").get(at).count,timers,timers_due:this.db.prepare("SELECT COUNT(*) AS count FROM timers WHERE status='PENDING' AND due_at<=?").get(at).count,metrics,last_success_at:last?.occurred_at ?? null,last_work_at:last?.occurred_at ?? null,time_since_last_work_ms:since,last_errors,recent_events}; }
  backupTo(backupPath) { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); const quoted=backupPath.replaceAll("'","''"); this.db.exec(`VACUUM INTO '${quoted}'`); return {backupPath,bytes:fs.statSync(backupPath).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex')}; }
  restoreFrom(backupPath) { this.close(); fs.copyFileSync(backupPath,this.dbPath); this.db=new DatabaseSync(this.dbPath); return {state_version:this.#version(),audit_count:this.getAudit().length}; }
}
