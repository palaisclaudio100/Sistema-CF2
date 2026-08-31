# CF2 — Outbox y worker determinista (Etapa 3 DEV)

La semántica es **at-least-once con consumidores idempotentes**. No se promete exactly-once entre procesos. El Core, outbox, jobs, intentos y timers viven en SQLite durable; ninguna sesión conversacional es parte del runtime.

## Frontera transaccional y outbox

Cada comando aceptado persiste el objeto, `state_version`, auditoría y evento outbox dentro de una única transacción. Un crash posterior al commit conserva el evento `PENDING`. Startup reconciliation lo transforma idempotentemente en un único job por `dedupe_key` y marca el evento `DISPATCHED` con intento y timestamp de consumo.

El envelope conserva `event_id`, tipo, sujeto, tiempo, productor, causación, correlación, versión y dedupe. El payload durable contiene el envelope y puede evolucionar a `payload_ref` sin cambiar la semántica.

## Jobs, claim y lease

Estados: `READY`, `CLAIMED`, `RUNNING`, `RETRY_WAIT`, `DONE`, `FAILED_ACTIONABLE`, `CANCELLED`.

El claim es una actualización condicional de un solo job READY y asigna `worker_id`, `run_id` y `lease_until`. Un lease vencido vuelve a READY con evidencia `LEASE_EXPIRED_CHECK_BEFORE_ACT`; en esta etapa, sin efectos externos, la continuación es segura e idempotente. Las etapas con adapters deberán implementar check-before-act antes de repetir un efecto.

## Retries y timers

Solo errores clasificados `TRANSIENT_TECHNICAL` reciben retry. El backoff exponencial está acotado por demora, intentos y ventana máxima, con jitter determinista. Cada retry depende de un timer durable `JOB_RETRY`; el worker no reclama directamente un `RETRY_WAIT`.

Errores permanentes (`INVALID_SCHEMA`, autoridad, ambigüedad, conflicto, permisos accionables o job desconocido) pasan una sola vez a `FAILED_ACTIONABLE` y no generan timer.

Los timers durables implementados son:

- `JOB_RETRY`;
- `TTL_EXPIRE`;
- `CONDITIONAL_INVALIDATION`.

No hay polling periódico ni heartbeat creador de trabajo. Sin evento, job READY o timer vencido, una ejecución queda idle y no crea trabajo.

## Startup reconciliation

En cada arranque controlado:

1. recupera leases vencidos;
2. dispara una vez timers vencidos;
3. despacha outbox pendiente;
4. reclama y ejecuta jobs READY.

Los timers futuros permanecen PENDING. Los vencidos durante downtime se disparan al reiniciar mediante dedupe durable.

## Observabilidad

`workerHealth()` expone `state_version`, outbox pendiente y antigüedad, conteos por estado de job, leases vencidos, timers por estado y vencidos, métricas, último éxito y últimos errores. No expone secretos.

## Límites de Etapa 3

`DeterministicWorker` es un harness DEV sin red, adapters, efectos externos, scheduler permanente ni dependencia de Codex, Claude Code, Gaby CW u otra memoria conversacional. No está conectado al startup productivo.
