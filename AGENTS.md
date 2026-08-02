# Guía rápida para agentes: ruralicos-api

## Antes de leer código

1. Para arquitectura o flujo completo, lee `docs/AI_CONTEXT.md`.
2. Para una tarea concreta, usa su tabla «tarea → símbolos → pruebas» y abre solo esos fragmentos.
3. Los README de cada módulo explican invariantes; los roadmaps y auditorías son históricos.

## Verdad operativa

- Orquestador de producción: `node scripts/run_digest_workflow.js`, una vez al día.
- No existe un segundo orquestador HTTP: los endpoints de `tareas` ejecutan fases concretas.
- Investigar producción no autoriza escrituras, reparaciones ni reenvíos.

## Lectura eficiente

- No abras enteros `digest.service.js`, `digest.routes.js`, `alertQuality.js`, `alertas.service.js` ni `admin.mia.routes.js`: son archivos grandes.
- Busca primero el handler o función con `rg -n -C 8 "<símbolo>"`.
- `src/routes.js` responde qué módulo registra una ruta.
- `scripts/run_digest_workflow.js` responde el orden real del cron.
- `supabase/migrations/` responde el esquema; no lo deduzcas solo desde consultas JS.

## Riesgo y pruebas

| Cambio | Pruebas iniciales |
| --- | --- |
| Territorio, sector o tipo | `alertaMatcher`, `alertSelectionGate`, `alertSelectionEngine` |
| Clasificación/descarte | `alertDiscardAudit`, `auditedFalseDiscardCorpus` |
| Digest/texto/validación | grupo `digest`, `finalDigestValidator`, `finalValidationAuthority` |
| Cron | `runDigestWorkflow`, `runDigestWorkflowExecution` |
| Scraper | test de la fuente + `scraperRunQuality` |
| MIA/feedback | test dirigido del módulo + inbound/policy |
| Supabase | migración nueva + `$ruralicos-supabase` |

Después: `npm run check:core`; usa `npm run test:local` para cambios amplios.

## Invariantes

- Evidencia y bloqueos duros prevalecen sobre score, embeddings y aprendizaje.
- No cruzar territorio sin alcance respaldado.
- No inferir beneficiario por el plan de suscripción.
- Un envío debe ser trazable desde alerta → decisión → item → digest → log/clic/feedback.
- Nunca enviar WhatsApp ni ejecutar backfills reales desde una prueba local.
