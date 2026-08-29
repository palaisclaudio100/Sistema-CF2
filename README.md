# Sistema CF 2.0 — Etapa 0

Repositorio aislado de contratos, fixtures y pruebas deterministas. No contiene runtime productivo, watchers, polling, credenciales, adapters activos ni acceso a CF 1.0.

Ejecutar con Node 20 o superior:

```powershell
npm run check
```

Los esquemas son JSON Schema 2020-12 versionados. `scripts/validate-contracts.mjs` es un validador determinista de Etapa 0 para el subconjunto usado por estos contratos y fixtures. El motor completo de validación y el store quedan explícitamente para Etapa 1.

Autoridad de arquitectura: Mesa DGA CF 2.0, ID `1pNLVnfqOTCge4JozDGPEsjFD5dbEnrpWFwg6lTgGjX8`.
