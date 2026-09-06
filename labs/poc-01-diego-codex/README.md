# POC-01 — Diego programático ↔ Codex (laboratorio desechable)

Estado: **POC_RESULT = FAIL** — `FAIL_REASON = REQUIRED_CREDENTIAL_NOT_AVAILABLE`.

## Qué se intentó

Ejecutar la orden POC-01 (Temporal local → Diego/gpt-5.6-sol → Codex App Server → Diego)
en un laboratorio separado de CF2. Antes de instalar componentes o generar consumo se
verificó el entorno de ejecución (sección 10 y 11 de la orden).

## Qué se observó

| Verificación | Resultado |
|---|---|
| `OPENAI_API_KEY` en el entorno | ausente |
| `~/.codex/auth.json` (login Codex) | ausente |
| Codex CLI instalado | no (instalable desde npm, pero sin credencial no autentica) |
| `api.openai.com` alcanzable | sí (HTTP 401 sin credencial) |
| Temporal CLI descargable (GitHub Releases) | no (HTTP 403 vía proxy) |
| Daemon Docker | no disponible |
| Ruta del laboratorio | `/home/user/poc01-lab`, no es repo CF, sin symlinks a producción |

Sin credencial OpenAI no es posible invocar a Diego (`gpt-5.6-sol`) ni autenticar Codex
App Server. La orden indica en ese caso detener y devolver
`POC_RESULT = FAIL / FAIL_REASON = REQUIRED_CREDENTIAL_NOT_AVAILABLE`, sin crear cuentas
ni generar gastos.

## Qué NO se hizo

- No se construyó ni ejecutó el workflow Temporal.
- No se realizó ninguna llamada a la API de OpenAI ni a Codex.
- No se creó ninguna cuenta, suscripción ni infraestructura.
- No se tocó ningún componente de CF2.

Consumo: USD 0. Llamadas gpt-5.6-sol: 0. Turnos Codex: 0.

## Cómo repetir la prueba

1. Proveer en el entorno de la sesión una credencial ya autorizada para el laboratorio
   (`OPENAI_API_KEY` o login de Codex en `~/.codex/auth.json`). No escribirla en repo,
   logs ni prompts.
2. Asegurar una vía para Temporal local (binario `temporal` o acceso a GitHub Releases).
3. Reemitir la orden POC-01. El laboratorio se reconstruye desde cero en un directorio
   separado; no hay estado que conservar de esta corrida.

## Contenido

- `poc_report.json` — informe obligatorio (sección 12).
- `README.md` — este archivo.
