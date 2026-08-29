# Decisión técnica de Store — Etapa 1 DEV

## Elección

SQLite embebido mediante `node:sqlite` (Node 24), envuelto por `CoreStore` y expuesto por la frontera `createDevRepository`.

## Motivos

- Transacciones reales para estado, audit, outbox e idempotencia en una única unidad ACID local.
- Sin servicio, red, credenciales, agente ni proceso residente.
- Archivo exclusivo de DEV bajo `Sistema-CF2/dev/` o directorio temporal de tests; nunca se sincroniza ni se usa como store productivo.
- `VACUUM INTO` permite backup consistente; la restauración se comprueba mediante state version y audit.
- La frontera de repositorio evita acoplar el dominio a SQL y permite reemplazar el motor sin cambiar contratos A–H.

## Alternativas descartadas en Etapa 1

- JSON/CSV: no entregan transacciones ni concurrencia suficiente.
- SQLite sincronizado por OneDrive/Drive: prohibido por la Mesa.
- Postgres o servicio cloud: válidos para evaluar más adelante, pero introducen cuenta, credenciales y decisión de costo/operación no necesaria para DEV.
- ORM: agrega dependencia sin necesidad para el conjunto reducido de consultas de esta etapa.

## Límites explícitos

No es el store productivo ni una decisión de infraestructura final. No hay HTTP, jobs ejecutándose, polling, watcher, adapter A/B/C ni conexión a CF 1.0.
