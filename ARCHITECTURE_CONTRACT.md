# CF 2.0 — Contrato arquitectónico no negociable

Fuente: Mesa DGA CF 2.0, ID `1pNLVnfqOTCge4JozDGPEsjFD5dbEnrpWFwg6lTgGjX8`, leída el 29/08/2026.

## Invariantes

- DECISION acredita intención; VERIFICATION acredita hecho vigente; TASK acredita flujo, nunca resultado por sí sola.
- Precedencia: Claudio directo > Claudio persistido > DGA delegado > rol delegado.
- Un único CURRENT por propiedad de valor único, o `UNKNOWN`, `CONFLICT` o `EXPIRED` explícito. Ausencia no significa `false`.
- MEMORIA, ESTADO y EVIDENCIA son planos separados; vistas e índices son derivados y regenerables.
- A es canon físico OneDrive `D:`; B es diagnóstico/transporte local `G:`; C es objeto remoto por ID. A↔B no certifica A↔C.
- IDs autoritativos: un nombre o alias nunca sustituye un ID existente.
- FIJO, VOLÁTIL y CONDICIONAL tienen vigencia explícita y fallan cerrados localmente en el atributo afectado.
- No hay borrado destructivo de decisiones ni verificaciones autoritativas.
- Comando, acuse, ejecución, resultado, prueba y cierre son hechos distintos. `TASK DONE` exige `closure_ref`.
- Mutaciones futuras entrarán exclusivamente por `submit_command(command)` y el modelo será single-writer.

## Alcance de Etapa 0

Solo contratos, reason codes, fixtures, lint y pruebas. Se prohíben runtime, polling, watcher, conexión a producción, migración y cualquier escritura sobre CF 1.0, `D:`, `G:` o Drive por ID real.
