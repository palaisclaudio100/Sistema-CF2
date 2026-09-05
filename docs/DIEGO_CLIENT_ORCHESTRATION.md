# CF2 Diego: asignación y retorno desde el cliente autenticado

La asignación a otro actor es una operación de orquestación. CREATE_TASK conserva la ACL de propiedad del rol y no concede atribuciones de otro actor a Diego.

Con orquestación configurada, `/mcp/diego` publica `start_workflow`, `read_thread`, `get_thread_status`, `control_workflow`, `read_inbox`, las operaciones de mensajes y Canon Gateway. Identidad y roles proceden de la sesión OAuth del cliente.

Para clientes que ya tienen el catálogo anterior, `submit_task_command` admite dos variantes públicas explícitas bajo `acting_role: DGA`:

```json
{"acting_role":"DGA","command":{"command_type":"START_WORKFLOW","payload":{"thread_id":"THREAD:ORDINARY:ID_UNICO","stages":["ACTOR:GABY_CHAT","ACTOR:GABY_CW"],"payload":{"operation":"ORDINARY_WORK","brief":"Trabajo definido por Diego","source_reference":"REFERENCIA:ORDEN","steps":{"ACTOR:GABY_CHAT":{"action":"ANALYZE_DRAFT_VALIDATE","object_id":"OBJETO:REGISTRADO"},"ACTOR:GABY_CW":{"action":"WRITE_VALIDATED","object_id":"OBJETO:REGISTRADO","expected_sha256":"HASH_SHA256_REAL_DE_LA_VERSION_AUTORIZADA"}}}}}}
```

Los marcadores del ejemplo requieren IDs y versión reales autorizados. No registran objetos ni conceden permisos. Se mantienen las validaciones del executor, el contenido validado por Gaby Chat y la escritura con respaldo y read-back de Gaby CW. No se envía actor_id ni se utiliza un token interno.

Consultar `get_task` con `task_id` igual al `thread_id` devuelto permite leer el workflow, respuestas automáticas, evidencia y auditoría desde el mismo cliente. Para cerrar cuando esté READY_TO_CLOSE:

```json
{"acting_role":"DGA","command":{"command_type":"CONTROL_WORKFLOW","payload":{"thread_id":"THREAD:ORDINARY:ID_UNICO","operation":"CLOSE"}}}
```

Estas variantes llaman exactamente a las mismas operaciones públicas que los tools dedicados. No crean un TASK de otro rol. No aceptan campos adicionales ni identidad del cliente. Un segundo inicio con el mismo thread_id se rechaza sin duplicar trabajo; consultar ese ID antes de reintentar una respuesta incierta. El cierre se rechaza mientras exista trabajo pendiente.

Las pruebas unitarias de este contrato no acreditan aceptación productiva. La regresión sólo puede cerrarse con una invocación desde CF2 Diego autenticado, trabajo ordinario real de Gaby Chat, escritura y relectura de Gaby CW, retorno y cierre desde ese cliente.
