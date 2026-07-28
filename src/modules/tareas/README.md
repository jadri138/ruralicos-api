# Tareas y pipeline

Orquestador de trabajos programados. Coordina las fases sin duplicar la lógica propia de scrapers, alertas, digest o MIA.

## Archivos

| Archivo | Función |
| --- | --- |
| `tareas.routes.js` | Endpoints de cron, salud y operaciones |
| `tareas.helpers.js` | Registro y utilidades de ejecución |
| `pipelineJobs.js` | Claim, heartbeat, checkpoint, reintento y estado |
| `pipelineRunner.js` | Máquina de fases del pipeline |

## Endpoints principales

| Endpoint | Uso |
| --- | --- |
| `/tareas/salud-fuentes` | Estado agregado de fuentes |
| `/tareas/scrapers-diario` | Ingesta principal |
| `/tareas/scraper` | Una fuente concreta |
| `/tareas/complementarios-diario` | Provinciales y complementarias |
| `/tareas/cotejar-listados-oficiales` | Coincidencias con listados |
| `/tareas/pipeline-tick` | Runner reanudable recomendado |
| `/tareas/pipeline-jobs` | Diagnóstico de jobs |
| `/tareas/pipeline-diario` | Flujo monolítico de compatibilidad |

## Runner con checkpoints

Un cron frecuente llama a `pipeline-tick`. Cada tick:

1. hace preflight;
2. reclama o reanuda el job del día;
3. ejecuta fases mientras quede presupuesto;
4. actualiza heartbeat y checkpoint;
5. sale antes del timeout del proxy;
6. el siguiente tick continúa.

Los límites `PIPELINE_TICK_*` impiden jobs huérfanos y permiten recuperar un claim realmente obsoleto.

## Sombra y producción

`PIPELINE_TICK_SHADOW=true` ejecuta el flujo sin efectos de envío previstos para el corte. Cambiarlo afecta producción: comprobar primero métricas, variables y runbook `docs/pipeline_tick_rollout.md`.

## Reglas operativas

- Todo endpoint de trabajo valida `CRON_TOKEN`.
- Una fase debe ser idempotente o detectar que ya terminó.
- Los errores parciales se registran; no se esconden detrás de un `ok`.
- No iniciar una petición externa si no cabe en el presupuesto restante.
- Reintentar con límite y dejar un estado terminal claro.
- Reparar jobs con el script específico y `dry-run` antes de escribir.

Pruebas: `pipelineRunner`, `pipelineShadowStale`, `pipelineDiarioJubilado`, `scraperRunQuality`, `fuentesHealth` y `runDigestWorkflow`.
