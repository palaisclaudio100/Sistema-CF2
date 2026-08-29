# Interfaz de roles — Etapa 5 DEV

La frontera es `RoleInterface` y los consumidores usan `RoleClient`. Ningún cliente recibe SQLite, CoreStore ni ruta física.

Roles: `CLAUDIO`, `DGA`, `GABY_CHAT`, `GABY_CW`, `PRODUCTOR_MUSICAL`, `LOCAL_WORKER` y `CODEX_ENGINEER`.

Las respuestas incluyen `ok`, `request_id`, `actor_id`, `role`, `operation`, `reason_code`, `state_version` y `data`.

Las mutaciones y denegaciones se registran en `access_audit`. Lecturas de snapshot e histórico también se registran; lecturas triviales no, para evitar ruido.

Esto es una frontera DEV sin HTTP, puertos, secretos ni despliegue. Una etapa futura podrá alojar esta interfaz sin cambiar su contrato.
