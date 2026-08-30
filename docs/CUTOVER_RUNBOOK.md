# Runbook manual de cutover — Etapa 7

Este runbook sirve solo para ensayos STAGING/SHADOW. `PRODUCTION_CUTOVER_DISABLED = true`; no existe un paso autorizado para activarlo.

## Antes

1. Confirmar el scope explícito (por ejemplo, `TASK` sin incluir `DECISION`).
2. Generar baseline, backup verificable y digest del Core de ensayo.
3. Calcular delta final y ejecutar igualdad lógica del scope.
4. Exigir `EQUAL` o diffs documentados como no bloqueantes. `BLOCKING_DIFF` y `UNKNOWN` detienen el ensayo.
5. Confirmar que el writer de cada dominio es `CF1_WRITER` y que la decisión simulada dice `APPROVED_NOT_EXECUTED_SIMULATION`.

## Durante

1. Bloquear un dominio: `CF1_WRITER → TRANSITION_LOCKED`.
2. Confirmar en el journal la entrada `WRITER_LOCKED`.
3. Hacer handoff solo para ese dominio: `TRANSITION_LOCKED → CF2_WRITER`.
4. Para detener: no enviar comandos adicionales; elegir R0, R1 o R2 según el punto de fallo.

## Si falla

- **R0:** antes del handoff. Cancelar desde `TRANSITION_LOCKED`; CF1 sigue writer y no hay reconciliación.
- **R1:** CF2 habilitado pero sin efecto externo irreversible. Cerrar CF2, preservar journal y reconciliar la lista de mutaciones simuladas; devolver el dominio a CF1.
- **R2:** ya hay mutaciones persistidas. Restaurar el backup de ensayo y verificar digest, audit y outbox; luego devolver el writer a CF1.

No editar CF1, no tocar Drive, no activar schedulers y no usar un backup productivo como sandbox.

## Después

1. Confirmar en barrier que todos los dominios del ensayo volvieron a `CF1_WRITER`.
2. Revisar journal completo y que no falten transiciones.
3. Comparar digest restaurado con la referencia del backup cuando aplique.
4. Confirmar `zero_production_side_effect = true`.

El paso siguiente solo puede ser una autorización explícita nueva de Claudio; este documento no concede activación productiva.
