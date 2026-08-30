# CF2 — infraestructura productiva mínima

Este documento describe la infraestructura productiva mínima de CF2 en Render. Acredita el despliegue técnico inicial; no autoriza cutover.

## Recursos previstos

- `cf2-prod-postgres`: Render Managed PostgreSQL `0.1c-256mb`, 1 GB, Oregon, aislada de DEV y SHADOW. El tráfico público está bloqueado; sólo se usa la red privada de Render.
- `cf2-prod-core`: servicio Node persistente `0.5c-512mb`, Oregon, con Core PostgreSQL, migraciones, health y flags seguros.

El blueprint [`render.yaml`](../render.yaml) fija los tres flags de cutover/adapters/roles en `false`. El release debe inyectarse explícitamente en `CF2_RELEASE_ID`; `DATABASE_URL` se vincula con el selector Datastore URL de Render y el repositorio nunca contiene secretos.

## Operación preparada

1. Render provee `DATABASE_URL` por referencia al recurso de base.
2. El servicio ejecuta migraciones versionadas al inicio y expone `GET /health`.
3. No hay tareas programadas, polling agentic, adapters externos ni writer productivo habilitados.
4. `pnpm verify:prod-health` valida de forma no destructiva que el endpoint público responde, la base está `UP` y los tres flags continúan en `false`.
5. Render ofrece recuperación puntual de siete días y export lógico con retención mínima de siete días. Crear exportaciones o restauraciones requiere aprobación puntual: debe hacerse con datos sintéticos y en un destino aislado, nunca sobre CF1.

## Límite de esta entrega

Antes de crear recursos se necesita una sesión Render, un origen Git autorizado y confirmación inmediata previa al cargo. Después del despliegue se debe ejecutar el preflight, pero no transferir lectura ni writers sin una autorización posterior del DGA.

## Estado verificado el 30 de agosto de 2026

- `cf2-prod-core` desplegado con release `cf2-prod-2710416` y commit `9012b6c`.
- `GET /health`: base `UP`, PostgreSQL 18.6, `state_version: 0`, `outbox_pending: 0`.
- `production_cutover_enabled`, `external_adapters_enabled` y `role_cutover_enabled`: `false`.
- CF1 no fue consultado, importado, modificado ni usado como writer durante este despliegue.
