# Etapa 6 — migrador, baseline y shadow

El baseline usa solamente un manifiesto de fuentes explícitas. Cada archivo CF1 se abre
en lectura completa, se sella con bytes/SHA-256/mtime y no se sigue ningún symlink ni
se explora un directorio. Un límite de lectura o un archivo que cambia durante la lectura
falla cerrado: nunca se importa una lectura truncada.

Los datos se clasifican antes de importarse. Sólo `AUTHORITATIVE_CURRENT` que posea
evidencia y un comando CF2 válido entra al Core. `CANDIDATE`, `CONFLICT` y `UNKNOWN`
permanecen explícitos en el informe; no son falsos ni se convierten en CURRENT.
La cobertura de cada colección empieza como `UNKNOWN`; una lista vacía no acredita
que esa colección esté vacía hasta que una extracción tipada la marque explícitamente.

Los mappings deben contener `artifact_id`, `A_path`, `C_file_id` exacto,
`A_TO_C_EXACT_ID` y `byte_preserving=true`. No existe búsqueda por nombre.

El comparador contrasta colecciones tipadas por ID exacto; una ausencia se informa como
`UNKNOWN` y una diferencia material como `CONFLICT`. El shadow sólo registra
observaciones y `WOULD_*`, con `no_side_effect=true`; no recibe adapters externos.
El gate temporal exige una evidencia de al menos 24 horas antes de declarar la soak
cumplida.

## Ejecución read-only

`node scripts/stage6-build-baseline.mjs <manifiesto.json>` materializa el baseline
en stdout. El manifiesto define cada path de CF1 de forma explícita y relativa a sí
mismo; el script no recorre directorios ni escribe en CF1. El ejemplo de estructura
está en `fixtures/stage6/baseline-manifest.example.json`; no es una fuente CF1 ni una
autorización para importar datos de ejemplo.

`node scripts/stage6-shadow-observe.mjs --store=<core-dev.db> --session=<id>
--baseline=<baseline.json> --current=<cf2-logical-state.json>` añade una observación
únicamente al Core CF2 indicado. Reabrir el mismo `session` conserva el inicio original;
no reinicia la ventana de 24 horas ni ejecuta adaptadores.

## Ledger de revisión

`node scripts/stage6-resolve-unknowns.mjs --ledger=<review-ledger.json>
--store=<core-dev.db>` es el único importador de baseline. El ledger debe enlazarse al
`baseline_digest` sellado y clasificar cada hallazgo con `evidence_ref`. Sólo registros
`AUTHORITATIVE_CURRENT` con un comando CF2 completo pueden entrar al store; los demás
quedan como `CANDIDATE`, `CONFLICT` o `UNKNOWN`. El importador nunca escribe CF1 y no
puede declarar F7: siempre devuelve `NOT_EVALUATED` hasta que la soak y la revisión se
acrediten por separado.
