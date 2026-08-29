# Etapa 6 — baseline y shadow DEV

`createMigrationBaseline` solo lee paths explícitos y genera hash/bytes/fecha. Nunca explora ni modifica CF1.

`SelectiveMigrator` importa únicamente registros clasificados como `AUTHORITATIVE_CURRENT`; `CANDIDATE`, `CONFLICT` y `UNKNOWN` quedan en el informe sin convertirse en estado.

`ShadowRuntime` solo observa y registra `WOULD_DO`. No recibe adapters externos ni ejecuta efectos. La soak de 24 horas se cierra únicamente con evidencia temporal independiente.
