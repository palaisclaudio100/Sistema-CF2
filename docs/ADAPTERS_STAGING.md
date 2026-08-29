# Adapters A/C — Etapa 4

`FileSystemAAdapter` acepta solo rutas relativas bajo un root de staging explícito. No escanea ni resuelve nombres.

`DriveIdAdapter` requiere un `C_file_id` presente en su allow-list y un transporte inyectado que exponga únicamente `metadataById`, `writeById` y `readById`. No contiene credenciales, OAuth, búsqueda por nombre ni selección por fecha.

La configuración futura no versionada deberá proporcionar únicamente el transporte de staging y la allow-list autorizada. Nunca tokens ni IDs productivos.

`ReplicationService` aplica seal A, write C por ID, readback del mismo ID, re-seal A y comparación de bytes/hash antes de emitir `SYNC_VERIFIED`.
