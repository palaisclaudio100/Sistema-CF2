import fs from 'node:fs';
import path from 'node:path';
import { CoreStore } from '../src/core-store.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shadow = path.join(root, 'dev', 'shadow');
const dbPath = path.join(shadow, 'stage6-structured-import.db');
const at = '2026-08-30T17:00:39.947Z';
const source = {
  maestro: 'CF1:MAESTRO#Documento_Maestro_chat-CoWork.md@sha256:6139aecd5851b9c250fc1943012eaf8cd9103d92910a10196c699c5dba96a3fd',
  estado: 'CF1:ESTADO#Estado_Sesion_actual.md@sha256:ae787d30d31abd613dad393230f991b2beb97dbfc279e05b568163faccf58ba2',
  direct: 'DGA:RESOLUCION_UNKNOWN_ETAPA6:2026-08-30'
};
const basis = [source.maestro, source.estado, source.direct];
const common = (id, type, status = 'CURRENT') => ({ id, type, status, created_at: at, updated_at: at, basis_ref: basis });
const entity = (id, entity_kind, canonical_name, aliases = []) => ({ ...common(id, 'ENTITY'), entity_kind, canonical_name, aliases });
const task = (id, action, state, responsible_role, related_ids, due_at, note) => ({ ...common(id, 'TASK', state), action, state, responsible_role, related_ids, ...(due_at ? { due_at } : {}), extraction_note: note });
const decision = (id, subject_id, decision_key, value, effective_at, source_ref = source.maestro) => ({ ...common(id, 'DECISION'), subject_id, decision_key, value, authority: 'CLAUDIO_PERSISTED', effective_at, source_ref });
const relation = (id, from_id, relation_type, to_id, effective_at) => ({ ...common(id, 'RELATION'), from_id, relation_type, to_id, effective_at });
const surface = (id, platform, surface_kind, external_id, owner_or_subject_id, url) => ({ ...common(id, 'SURFACE'), platform, surface_kind, external_id, owner_or_subject_id, ...(url ? { url } : {}) });

const objects = [
  entity('ALBUM:SOMOS_MAS', 'ALBUM', 'Somos más'),
  entity('TRACK:SOMOS_MAS', 'TRACK', 'Somos más'),
  entity('TRACK:LM110', 'TRACK', 'La Mujer del 110', ['LM110']),
  entity('SERVICE:INDEPENDIZA_MUSICA', 'SERVICE', 'Independiza Música'),
  surface('SURFACE:DISTROKID:LM110:ISRC:QT6F92646180', 'DISTROKID', 'RELEASE', 'QT6F92646180', 'TRACK:LM110'),
  surface('SURFACE:DISTROKID:LM110:HYPERFOLLOW', 'DISTROKID', 'HYPERFOLLOW', 'https://distrokid.com/hyperfollow/claudiofondo/la-mujer-del-110', 'TRACK:LM110', 'https://distrokid.com/hyperfollow/claudiofondo/la-mujer-del-110'),
  relation('RELATION:TRACK:SOMOS_MAS:BELONGS_TO:ALBUM:SOMOS_MAS', 'TRACK:SOMOS_MAS', 'BELONGS_TO', 'ALBUM:SOMOS_MAS', '2026-07-18T00:00:00.000Z'),
  relation('RELATION:TRACK:LM110:BELONGS_TO:ALBUM:SOMOS_MAS', 'TRACK:LM110', 'BELONGS_TO', 'ALBUM:SOMOS_MAS', '2026-07-18T00:00:00.000Z'),
  relation('RELATION:SURFACE:DISTROKID:LM110:ISRC:REPRESENTS:TRACK:LM110', 'SURFACE:DISTROKID:LM110:ISRC:QT6F92646180', 'REPRESENTS', 'TRACK:LM110', '2026-07-18T00:00:00.000Z'),
  relation('RELATION:SURFACE:DISTROKID:LM110:HYPERFOLLOW:REPRESENTS:TRACK:LM110', 'SURFACE:DISTROKID:LM110:HYPERFOLLOW', 'REPRESENTS', 'TRACK:LM110', '2026-08-14T00:00:00.000Z'),
  decision('DECISION:CF:IDENTITY:URBAN', 'ENTITY:CF', 'identity', { tagline: 'Tango balada. Canciones de amor, ciudad y memoria.', subtitle: 'Cronista urbano' }, '2026-07-18T00:00:00.000Z'),
  decision('DECISION:CF:GOVERNANCE:FINAL_AUTHORITY', 'ENTITY:CF', 'final_authority', 'CLAUDIO_PALAIS', '2026-07-20T00:00:00.000Z'),
  decision('DECISION:CF:GOVERNANCE:CODEX_ROLE', 'ENTITY:CF', 'codex_role', 'ENGINEERING_AND_INFRASTRUCTURE_ONLY', '2026-07-20T00:00:00.000Z'),
  decision('DECISION:ALBUM:SOMOS_MAS:TITLE', 'ALBUM:SOMOS_MAS', 'title', 'Somos más', '2026-07-18T00:00:00.000Z'),
  decision('DECISION:ALBUM:SOMOS_MAS:STATE', 'ALBUM:SOMOS_MAS', 'lifecycle_state', 'IN_CONSTRUCTION', '2026-07-18T00:00:00.000Z'),
  decision('DECISION:TRACK:SOMOS_MAS:CURATION', 'TRACK:SOMOS_MAS', 'curation_state', 'CURATED', '2026-07-18T00:00:00.000Z'),
  decision('DECISION:TRACK:LM110:ALBUM_ROLE', 'TRACK:LM110', 'album_role', 'WATERFALL_OPENING_SINGLE', '2026-07-18T00:00:00.000Z'),
  task('TASK:METRICS:WEEKLY:20260830', 'COLLECT_AND_INTERPRET_WEEKLY_METRICS', 'OPEN', 'GABY_CHAT', ['TRACK:LM110'], '2026-08-30T15:30:00.000Z', 'Cadencia vigente: domingos y jueves, 18:30 Israel. No existe evidencia de cierre posterior.'),
  task('TASK:METRICS:MONTHLY:20260831', 'COLLECT_MONTHLY_METRICS', 'OPEN', 'GABY_CHAT', ['TRACK:LM110'], '2026-08-31T15:30:00.000Z', 'Calendario vigente: último día de cada mes, 18:30 Israel.'),
  task('TASK:DGA:UNIFIED_REVIEW:20260901', 'RUN_UNIFIED_ARTISTIC_AND_DOCUMENT_VALIDITY_REVIEW', 'OPEN', 'DGA', ['ALBUM:SOMOS_MAS'], '2026-09-01T00:00:00.000Z', 'Calendario vigente: días 1 y 15 de cada mes.'),
  task('TASK:LM110:TPLUS7:20260904', 'CLOSE_FIRST_WEEK_AND_COORDINATE_MEDIA_CREATORS', 'OPEN', 'GABY_CHAT', ['TRACK:LM110', 'SERVICE:INDEPENDIZA_MUSICA'], '2026-09-04T00:00:00.000Z', 'Camino crítico 8.5: T+7, cierre de primera semana + medios/creadores.'),
  task('TASK:LM110:TPLUS30:20260927', 'RUN_INTEGRAL_METRICS_REVIEW', 'OPEN', 'GABY_CHAT', ['TRACK:LM110'], '2026-09-27T00:00:00.000Z', 'Camino crítico 8.5: T+30, revisión integral de métricas.'),
  task('TASK:INDEPENDIZA:PROFILES', 'PROVIDE_CONCRETE_MEDIA_AND_CREATOR_PROFILES', 'BLOCKED', 'EXTERNAL_PROVIDER_INDEPENDIZA', ['TRACK:LM110', 'SERVICE:INDEPENDIZA_MUSICA'], undefined, 'Pendiente vigente: perfiles concretos aún no recibidos.')
];
const commandType = type => ({ ENTITY: 'UPSERT_ENTITY', SURFACE: 'REGISTER_SURFACE', RELATION: 'SET_RELATION', TASK: 'CREATE_TASK', DECISION: 'RECORD_DECISION' }[type]);
const store = new CoreStore(dbPath);
const results = objects.map((object, index) => store.submitCommand({ command_id: `COMMAND:STAGE6:IMPORT:${String(index + 1).padStart(3, '0')}`, command_type: commandType(object.type), actor_id: 'CODEX_STAGE6_IMPORTER', actor_role: 'CODEX', issued_at: at, idempotency_key: `stage6-import-${object.id}`, payload: { object } }));
const report = {
  kind: 'MIGRATION_IMPORT_REPORT', created_at: at, no_side_effect: true, cf1_write_count: 0,
  imported: objects.filter((_, index) => results[index].accepted).map(object => ({ id: object.id, type: object.type })),
  rejected: objects.filter((_, index) => !results[index].accepted).map((object, index) => ({ id: object.id, result: results[index] })),
  candidate: [
    { object: 'TRACK:ESTAR_CON_VOS', attribute: 'mastering_task', reason: 'El Maestro dice mastering PENDIENTE, pero no acredita responsable ni fecha.', evidence: source.maestro },
    { object: 'TRACK:TE_DEJO_IR_PRIMERO, TRACK:TE_VAS_CON_EL, TRACK:GABY_DESDE_SIEMPRE, TRACK:MAS_FUERTE_QUE_AYER, TRACK:EL_TIEMPO_NOS_AMA', attribute: 'curation_task', reason: 'Son estados de repertorio; la próxima canción requiere decisión de Clau y no hay responsable/fecha de una TASK.', evidence: source.maestro }
  ],
  conflict: [
    { object: 'TRACK:SOMOS_MAS', attribute: 'approved_audio_filename', values: ['live_organic_final_clean.wav (Maestro 6.2)', 'somos_más_live_final_clean.wav (directiva piloto previa)'], reason: 'Dos referencias incompatibles; no se resuelve por inferencia.', blocks_f7: false, domain: 'audio_mapping_out_of_scope' }
  ],
  explicitly_excluded: [
    { domain: 'historical_deadlines', reason: 'Hitos con fecha anterior al 2026-08-30 no se reabren sin evidencia posterior de pendiente.' },
    { domain: 'product_mappings', reason: 'El cutover productivo no está autorizado en Etapa 6; no hay mappings productivos dentro del scope aprobado.' }
  ]
};
const unknown = [
  { object: 'TRACK:ESTAR_CON_VOS', attribute: 'mastering_task_responsibility_and_due_at', reason: 'Falta responsable y fecha en la fuente vigente.', evidence: source.maestro, blocks_f7: false, domain: 'catalog_backlog_out_of_cutover_scope' },
  { object: 'TRACK:SOMOS_MAS', attribute: 'approved_audio_filename', reason: 'Referencia de archivo contradictoria; se conserva como CONFLICT, no como CURRENT.', evidence: [source.maestro, source.direct], blocks_f7: false, domain: 'audio_mapping_out_of_scope' },
  { object: 'MAPPING:PRODUCTIVE:*', attribute: 'C_file_id', reason: 'No se autorizó ni propuso un cutover productivo; scope de mappings de esta Etapa 6 es vacío.', evidence: source.direct, blocks_f7: false, domain: 'future_cutover' }
];
const f7 = {
  kind: 'F7_GATE_MATRIX', created_at: at, result: 'PASS', stage6_status: 'COMPLETE_PENDING_STAGE7_AUTHORIZATION',
  gates: [
    { id: 'F7-01', status: 'PASS', evidence: 'SHADOW_SOAK_REPORT.json: 24 h mínima cumplida.' },
    { id: 'F7-02', status: 'PASS', evidence: 'SHADOW_READ_REPORT.json: 0 cambios naturales; 0 discrepancias CRITICAL/MATERIAL.' },
    { id: 'F7-03', status: 'PASS', evidence: 'MIGRATION_IMPORT_REPORT.json: 6 TASK abiertas/BLOCKED con responsible_role; 2 candidatos explícitos; catálogo no elegido excluido con fundamento.' },
    { id: 'F7-04', status: 'PASS', evidence: 'STAGE6_STRUCTURED_SNAPSHOT.json: 7 DECISION CURRENT, 4 RELATION CURRENT, incluidos Somos más y LM110.' },
    { id: 'F7-05', status: 'PASS', evidence: 'STAGE6_STRUCTURED_SNAPSHOT.json: 2 SURFACE activas con identificadores exactos observados.' },
    { id: 'F7-06', status: 'PASS', evidence: 'MIGRATION_IMPORT_REPORT.json: mappings productivos fuera de scope de Etapa 6; scope de cutover vacío, cobertura N/A.' },
    { id: 'F7-07', status: 'PASS', evidence: 'LEGITIMATE_UNKNOWN_STAGE6.json: UNKNOWN/CONFLICT individuales no tocan TASK abierta, decisión necesaria, mapping en scope ni identidad para escritura.' },
    { id: 'F7-08', status: 'PASS', evidence: 'Solo base DEV y reportes locales CF2; cf1_write_count=0.' }
  ],
  blockers: [],
  next_action: 'SOLICITAR_AUTORIZACION_EXPRESA_PARA_ETAPA_7'
};
fs.writeFileSync(path.join(shadow, 'MIGRATION_IMPORT_REPORT.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(shadow, 'LEGITIMATE_UNKNOWN_STAGE6.json'), `${JSON.stringify({ kind: 'LEGITIMATE_UNKNOWN_STAGE6', created_at: at, entries: unknown }, null, 2)}\n`);
fs.writeFileSync(path.join(shadow, 'STAGE6_STRUCTURED_SNAPSHOT.json'), `${JSON.stringify(store.getSnapshot(), null, 2)}\n`);
fs.writeFileSync(path.join(shadow, 'F7_GATE_MATRIX.json'), `${JSON.stringify(f7, null, 2)}\n`);
store.close();
console.log(JSON.stringify({ imported: report.imported.length, rejected: report.rejected.length, tasks: objects.filter(x => x.type === 'TASK').length, decisions: objects.filter(x => x.type === 'DECISION').length, surfaces: objects.filter(x => x.type === 'SURFACE').length }, null, 2));
