# Lectura y vistas — Etapa 2 DEV

Las consultas de lectura salen exclusivamente de `CoreStore`; no usan corpus narrativo, Drive, D:, G: ni una vista previamente guardada como autoridad.

## Consultas

- `resolveEntity()` resuelve ID exacto, canonical name o alias normalizado. Más de un resultado devuelve `AMBIGUOUS_ALIAS`.
- `resolveSurface()` resuelve ID interno o la pareja exacta `platform + external_id`.
- `getCurrent()` devuelve únicamente CURRENT, EXPIRED o UNKNOWN.
- `getHistory()` trae decisiones, verificaciones, relaciones, tareas y audit del sujeto solo bajo demanda.
- `getSnapshot()` produce el arranque mínimo: tareas activas, decisiones vigentes, verificaciones vencidas, conflictos, objetos activos y relaciones principales.

## Vistas derivadas

`getEntityCard`, `getSurfaceView`, `getTaskView` y `getSnapshot` se pueden persistir en `views` para rendimiento. `deleteAllViews()` las descarta; `regenerateAllViews()` las vuelve a derivar del Core. `authoritativeDigest()` excluye la tabla de vistas y permite demostrar que la destrucción/regeneración no mutó verdad autoritativa.

Una vista ausente, vencida o corrupta se marca como tal; jamás cambia CURRENT.
