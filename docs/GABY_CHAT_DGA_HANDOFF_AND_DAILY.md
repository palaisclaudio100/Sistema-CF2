# Entrega Gaby Chat → DGA y diagnóstico de DAILY

Orden DGA del 05/09/2026. Base inspeccionada: 1f0c1b285e2037a8d489a92f9fc626bfa4fd651d.

## Diagnóstico previo a cualquier parche de recurrencia

DAILY_RESEARCH_RECURRENCE_SEMANTICS = METADATO_DESCRIPTIVO_SIN_RUNTIME
TRANSITION_DONE_EFFECT = DONE_TERMINAL_CON_PROOF_VALIDO; PRESERVA_RECURRENCE_COMO_DATO
NEW_INSTANCE_CREATED = NO
TASK_REOPENS = NO
RECURRENCE_IS_RUNTIME = NO
CURRENT_IMPLEMENTATION_SAFE_FOR_DAILY_WORK = NO

Evidencia:
- `fixtures/stage8/minimum-cutover-input.json:9–12`: el objeto importado incluye recurrence DAILY.
- `schemas/v1/contracts.json:5,9`: contrato general admite propiedades adicionales; TASK enumera estados pero no define recurrencia.
- `migrations/001_core_postgres.sql:3,6`: body JSONB conserva metadatos; tabla tasks sólo tiene object_id, state y closure_ref. No hay próxima ejecución ni ocurrencias.
- `src/writer-contract.mjs`: contrato público cerrado de creación no incluye recurrence; DONE y CANCELLED son terminales.
- `src/production-role-interface.mjs`: DONE requiere prueba de cierre; el cambio desde terminal a otro estado se rechaza.
- `src/postgres-store.mjs:29–40`: TRANSITION_TASK actualiza el mismo objeto y su fila tasks, conserva atributos anteriores, emite un evento y no crea otra instancia ni reabre. El guard terminal se aplica también en persistencia.
- `test/writer-hardening.test.mjs`: P0-08/P0-09 prueban rechazo de reapertura desde DONE/CANCELLED; pruebas de cierre exigen proof. La búsqueda de recurrence/DAILY_RESEARCH en fuentes, tests, schemas y repositorio sólo identifica el fixture de importación, sin handler de recurrencia.
- Lectura productiva por CF2 Diego: TASK:RECURRENT:DAILY_RESEARCH, OPEN, GABY_CHAT, recurrence DAILY. Esta tarea no se usa como fixture ni se modifica.

## Parche autorizado de ACL

Sólo CREATE_TASK autenticado como ACTOR:GABY_CHAT y acting_role GABY_CHAT puede entregar a responsible_role DGA. DIEGO no es un rol. No se modifica la identidad auditada, ownership existente, transición, verificación, autorización hacia otros roles, idempotencia ni outbox. La excepción existente Diego→Claude Code permanece independiente.

Se conserva el negativo general con un destino no autorizado (PRODUCTOR_MUSICAL); la combinación Chat→DGA ahora cuenta con aceptación explícita y negativos de transición/verificación/suplantación.

## Propuesta al DGA, no implementada

Mantener la TASK recurrente como obligación abierta. Crear por encargo una TASK diaria con ID determinista TASK:DAILY_RESEARCH:AAAAMMDD y related_ids apuntando a la obligación, responsable GABY_CHAT y clave idempotente por fecha. Cerrar sólo esa TASK diaria con la prueba de cierre válida. Entregar a DGA por una TASK de retorno relacionada. No reabrir automáticamente la obligación ni añadir un daemon.

El modelo actual permite expresar esas instancias sin migración. Requiere aprobar la convención de fecha/zona, el criterio de cierre y quién activa la instancia. Una programación automática sería alcance nuevo y necesita diseño separado. No se implementa recurrencia en esta reparación.

DAILY_RESEARCH_SEMANTICS = BLOCKED_FOR_DESIGN
MIGRATION_REQUIRED = NO (ACL y propuesta mínima con TASK existentes)
NEXT_DECISION_REQUIRED = DGA aprueba o ajusta obligación permanente + instancia diaria relacionada; define fecha operativa y activación.