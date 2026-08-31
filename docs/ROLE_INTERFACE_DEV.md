# Interfaz de roles — Etapa 5 DEV

## Frontera

`RoleInterface` es la única frontera de lectura y comandos. Los consumidores reciben `RoleClient`; no reciben `CoreStore`, SQLite, rutas, tablas, outbox ni jobs físicos. Toda mutación usa `COMMAND_SUBMIT` y termina en `CoreStore.submitCommand`.

## Identidad y autenticación

`CredentialAuthenticator` resuelve una credencial opaca a `{actor_id, actor_role}` del lado servidor. Las credenciales incluidas son exclusivamente sintéticas DEV. El cliente no puede declarar identidad en el request; si lo intenta obtiene `ACTOR_MISMATCH`. El comando conserva `actor_id` y `actor_role` por trazabilidad, pero ambos deben coincidir con el principal autenticado.

No se registran credenciales, tokens ni headers. Claudio existe en la policy conceptual, pero esta etapa no provisiona una credencial productiva.

## Lectura tipada

La interfaz expone health/version, snapshot, resolución de ENTITY/SURFACE, CURRENT, bundle, task, estado de comando, HISTORY, evidence/basis y health del worker. HISTORY es explícito y no se mezcla con CURRENT. Estados como `UNKNOWN`, `EXPIRED`, `AMBIGUOUS` y `VERSION_CONFLICT` se conservan.

## Comandos y autoridad

El receipt distingue `ACCEPTED` de `DONE` y devuelve referencias de comando, evento, task y closure cuando existen. La idempotencia y `expected_state_version` siguen perteneciendo al Core.

La policy separa permiso para presentar un tipo de comando de autoridad para prevalecer. DGA requiere delegación `DGA_DELEGATED`; Gaby Chat solo puede presentar decisiones del dominio `MARKETING`; Productor Musical usa `ARTISTIC_PRODUCTION`; Gaby CW no puede presentar decisiones. Ninguno puede impersonar a Claudio.

Errores tipados relevantes: `AUTHENTICATION_REQUIRED`, `ACTOR_MISMATCH`, `ROLE_FORBIDDEN`, `AUTHORITY_REQUIRED`, `INVALID_SCHEMA`, `VERSION_CONFLICT`, `EVIDENCE_REQUIRED` y los reason codes preservados del Core.

## Cliente local y reconexión

`LocalCommandQueue` es transporte local durable para Gaby CW. Persiste comandos pendientes sin credencial y sin afirmar aceptación. Al reconectar entrega por la misma `RoleClient`; el `idempotency_key` impide duplicación. La cola no es autoridad y no accede al store.

## Continuidad

T17 acredita que, sin capacidad local, cloud puede leer y cursar trabajo independiente mientras el trabajo que exige A/local permanece `BLOCKED_LOCAL_CAPABILITY`. T18 acredita reinicio y reanudación local sin sesión conversacional ni duplicación.

Codex y Claude Code no tienen credenciales de actor ni participan en runtime. El camino cloud contractual es rol → interfaz → Core → status, sin relay de Claudio.

## Gate cloud pendiente

Esta implementación es DEV local y no abre HTTP ni despliega infraestructura. El cierre real requiere un canal cloud no productivo autorizado desde Diego/DGA o Gaby Chat que complete autenticación, lectura, comando sintético y consulta de status. `cf2-prod-core` no debe reutilizarse como staging.
