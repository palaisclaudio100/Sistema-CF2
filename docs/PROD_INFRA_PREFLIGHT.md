# CF2 — preflight de infraestructura productiva

Fecha de verificación: 31 de agosto de 2026.

Este documento usa una política fail-closed: ningún resultado pendiente se interpreta como aptitud para cutover.

## Controles aprobados

| Control | Evidencia | Estado |
| --- | --- | --- |
| Core desplegado | `cf2-prod-core` responde `GET /health` | PASS |
| Persistencia | PostgreSQL 18.6 informa `database: UP` | PASS |
| Migración inicial | `state_version: 0` y `outbox_pending: 0` | PASS |
| Barreras de corte | writer, adaptadores externos y rol cutover en `false` | PASS |
| Aislamiento de red | PostgreSQL sin acceso público; enlace interno de Render | PASS |
| Observabilidad mínima | endpoint health y eventos de deploy disponibles | PASS |

## Gates pendientes — bloquean el cutover

| Gate | Acción pendiente | Riesgo / autorización |
| --- | --- | --- |
| Backup lógico | Crear un export de Render y registrar su identificador | Crea un artefacto en Render; requiere aprobación puntual |
| Restore drill | Restaurar el export a un destino aislado con datos sintéticos y comparar integridad | Crea un recurso; puede generar costo; requiere aprobación puntual |
| Prueba de recuperación | Documentar tiempo de restauración y resultado de health | Sólo después del restore drill |
| Datos de CF1 | No importar ni conectar CF1 hasta una decisión específica de migración | Bloqueado por diseño |
| Writer / roles | Mantener todas las flags en `false` hasta preflight completo y autorización del DGA | Bloqueado por diseño |

## Conclusión

La infraestructura base de CF2 está operativa, aislada y observable. El preflight global permanece **NO APROBADO** hasta completar el backup/restore drill aislado. No existe autorización para cutover, para cambiar el writer, ni para usar datos de CF1.
