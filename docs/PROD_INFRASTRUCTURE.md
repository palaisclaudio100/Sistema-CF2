# CF2 — infraestructura productiva mínima

Este documento describe infraestructura preparada para Render. No acredita despliegue ni autoriza cutover.

## Recursos previstos

- `cf2-prod-postgres`: Render Managed PostgreSQL `basic-256mb`, aislada de DEV y SHADOW.
- `cf2-prod-core`: servicio Node persistente `starter`, con Core PostgreSQL, migraciones, health y flags seguros.

El blueprint [`render.yaml`](../render.yaml) fija los tres flags de cutover/adapters/roles en `false`. El release debe inyectarse explícitamente en `CF2_RELEASE_ID`; el repositorio nunca contiene secretos.

## Operación preparada

1. Render provee `CF2_DATABASE_URL` por referencia al recurso de base.
2. El servicio ejecuta migraciones versionadas al inicio y expone `GET /health`.
3. No hay tareas programadas, polling agentic, adapters externos ni writer productivo habilitados.
4. El smoke de base requiere datos sintéticos y una restauración en destino aislado; todavía no debe usar CF1.

## Límite de esta entrega

Antes de crear recursos se necesita una sesión Render, un origen Git autorizado y confirmación inmediata previa al cargo. Después del despliegue se debe ejecutar el preflight, pero no transferir lectura ni writers sin una autorización posterior del DGA.
