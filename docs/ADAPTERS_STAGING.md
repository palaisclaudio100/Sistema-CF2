# CF2 — Adapters A/C y mappings (Etapa 4 DEV)

Esta implementación opera únicamente sobre fixtures DEV. No contiene credenciales, IDs Drive reales, rutas CF productivas ni activación de adapters productivos.

## Modelo

- **A**: archivo físico canónico dentro de un root DEV explícito.
- **B**: superficie local opcional y exclusivamente diagnóstica.
- **C**: objeto remoto exacto identificado por `C_file_id` autorizado.

La única dirección automática contemplada es `A → C`. C nunca sobrescribe A y B nunca cierra una replicación.

## Mapping

Cada mapping autorizado contiene `mapping_id`, `artifact_id`, `generation_id`, `A_path`, `C_file_id`, `B_path` opcional, `replication_mode=A_TO_C_EXACT_ID` y `byte_preserving=true`. Cambiar silenciosamente el ID C dentro de la misma generación falla con `MAPPING_ID_CHANGE_REQUIRES_NEW_GENERATION`.

No existen métodos de búsqueda por nombre, filename, carpeta o fecha. Una solicitud sin mapping exacto falla con `MAPPING_MISSING`.

## Sellado A

`FileSystemAAdapter.seal()` produce:

- `source_seal_ref`;
- `artifact_id` y `generation_id`;
- `A_path`;
- bytes y SHA-256;
- `sealed_at`;
- mtime únicamente diagnóstico.

Antes del proof, `verifySeal()` vuelve a leer A. Si cambió, el resultado es `SUPERSEDED_GENERATION` y nunca `SYNC_VERIFIED`.

## Adapter C

`DriveIdAdapter` expone únicamente `writeExactId`, `readExactId` y metadata por ID exacto. El readback válido exige:

- mismo ID;
- respuesta autenticada;
- bytes materializables y no vacíos;
- MIME byte-preserving permitido.

HTML/login, MIME inesperado, respuesta incompleta o lectura no autenticada producen `C_READBACK_FAILED / REMOTE_READ_INVALID`, nunca `DIVERGED`.

## Estados y proof

La traza durable usa:

- `A_SEALED`;
- `C_WRITE_PENDING`;
- `C_READBACK_VERIFIED` interno;
- `SYNC_VERIFIED`;
- `C_WRITE_FAILED`;
- `C_READBACK_FAILED`;
- `DIVERGED`;
- `SUPERSEDED_GENERATION`.

`DIVERGED` requiere readback válido por el mismo ID y desigualdad real de bytes/hash.

El `REPLICATION_PROOF` conserva generación, seal, ID C, referencias de escritura/readback, bytes y hashes A/C, estado y hora de finalización. HTTP success, nombre, mtime, tamaño aislado o B no son proof.

## Crash y recovery

Cada fase queda en `replication_attempts`. Tras un crash después de escribir C, el reinicio hace readback/check-before-act. Si C ya contiene la generación correcta, no vuelve a escribir. Tras un crash posterior al readback, el reinicio materializa el proof sin duplicar escritura.

La integración DEV utiliza un job durable `REQUEST_REPLICATION` del worker de Etapa 3. No está conectada al runtime productivo.

## Pendiente externo

El gate local usa `InMemoryDriveStaging`. El cierre real requiere un `C_file_id` expresamente creado y autorizado como staging no productivo, byte-preserving y descartable. Ningún objeto Drive existente se selecciona por inferencia.
