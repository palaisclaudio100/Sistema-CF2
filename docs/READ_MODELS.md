# CF2 — Lectura y vistas

El Core es la única autoridad. Las fichas, índices, superficies, tareas y el snapshot son proyecciones descartables y regenerables.

## Resolución determinista

`resolveEntity()` aplica estrictamente: ID interno exacto, nombre canónico exacto normalizado y alias exacto normalizado. Un alias único resuelve; dos candidatos devuelven `AMBIGUOUS`; una ausencia devuelve `UNKNOWN / ENTITY_CANDIDATE_NEW`. La resolución nunca fusiona entidades ni convierte un nombre en ID.

`resolveSurface()` aplica ID interno o la pareja exacta `platform + external_id`. `resolveCurrent()` encadena resolución y recuperación bajo demanda.

## CURRENT e HISTORY

`listCurrent()` cubre ENTITY, SURFACE, TASK, DECISION, VERIFICATION y RELATION. Excluye supersedidos, tareas no operativas y verificaciones volátiles vencidas. La ausencia permanece `UNKNOWN`, nunca `FALSE`.

`getCurrentBundle()` devuelve el sujeto, sus superficies directas, decisiones, relaciones, tareas operativas y verificaciones pertinentes. Solo recorre vínculos directos necesarios. `getHistory()` es una llamada separada y explícita para antecedentes, `basis_ref`, contradicciones y supersesiones.

## Snapshot y vistas

`getSnapshot()` contiene tareas OPEN/READY/IN_PROGRESS/BLOCKED, decisiones CURRENT, conflictos y referencias necesarias para hidratar el camino activo. No incorpora todas las entidades ni el corpus Maestro/Estado/Histórico.

Las proyecciones regenerables son:

- fichas compactas por ENTITY, con superficies y contexto CURRENT;
- índice alfabético de entidades;
- superficies CURRENT;
- tareas operativas;
- snapshot de arranque.

`deleteAllViews()` puede eliminarlas físicamente. `regenerateAllViews()` las reconstruye íntegramente desde el Core. `authoritativeDigest()` excluye las vistas y demuestra que destruirlas, corromperlas o regenerarlas no altera estado autoritativo. `derivedViewsDigest()` permite comparar la equivalencia lógica de dos regeneraciones.

Una lectura CURRENT nunca consulta la tabla `views`; una proyección vieja o corrupta se repara regenerándola desde el Core.
