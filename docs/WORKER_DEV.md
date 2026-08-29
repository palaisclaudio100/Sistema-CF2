# Worker determinista — Etapa 3 DEV

`DeterministicWorker` se ejecuta solo desde pruebas o un harness manual. No tiene scheduler, autostart, watcher, red, adapter ni agente.

## Ciclo manual

1. Despacha eventos pendientes de outbox a jobs por `event_id` y `dedupe_key`.
2. Recupera leases vencidos a `RETRY_WAIT`.
3. Agenda un timer únicamente si hay VERIFICATION VOLÁTIL ya vencida.
4. Reclama jobs con lease, ejecuta una operación mecánica y conserva el resultado.
5. Aplica backoff determinista `1 s, 2 s, 4 s` hasta el límite DEV configurable; después marca `FAILED`.

Estados: `READY`, `CLAIMED`, `RUNNING`, `RETRY_WAIT`, `DONE`, `FAILED`.

El trabajo vacío no crea job ni invoca agente. Outbox, TTL, invalidación dirigida y regeneración de vistas son operaciones deterministas.
