# Tareas y pipeline

Orquestador de trabajos programados. Coordina las fases sin duplicar la lógica propia de scrapers, alertas, digest o MIA.

## Archivos

| Archivo | Función |
| --- | --- |
| `tareas.routes.js` | Endpoints de cron, salud y operaciones |
| `tareas.helpers.js` | Registro y utilidades de ejecución |
| `pipelineJobs.js` | Persistencia del runner legado; el cron principal no lo usa |
| `pipelineRunner.js` | Runner legado aún invocable, conservado para diagnóstico y pruebas |

## Endpoints principales

| Endpoint | Uso |
| --- | --- |
| `/tareas/salud-fuentes` | Estado agregado de fuentes |
| `/tareas/scrapers-diario` | Ingesta principal |
| `/tareas/scraper` | Una fuente concreta |
| `/tareas/complementarios-diario` | Provinciales y complementarias |
| `/tareas/cotejar-listados-oficiales` | Coincidencias con listados |
| `/tareas/pipeline-tick` | Endpoint legado aún activo; no programar ni invocar en producción |
| `/tareas/pipeline-jobs` | Diagnóstico de jobs históricos |
| `/tareas/pipeline-diario` | Endpoint monolítico legado |

## Ejecución de producción

Render ejecuta una vez al día:

```bash
node scripts/run_digest_workflow.js
```

El script llama a los endpoints de cada fase en orden y no avanza al digest si
clasificación, resumen o revisión quedan incompletos. No depende de
`pipeline_jobs`, claims ni heartbeats.

## Sombra y producción

El antiguo modo con checkpoints queda documentado como incidente histórico en
`docs/pipeline_tick_rollout.md`. La ruta sigue existiendo por compatibilidad,
pero no debe configurarse como cron ni usarse para relanzar el flujo diario.

## Reglas operativas

- Todo endpoint de trabajo valida `CRON_TOKEN`.
- Una fase debe ser idempotente o detectar que ya terminó.
- Los errores parciales se registran; no se esconden detrás de un `ok`.
- No iniciar una petición externa si no cabe en el presupuesto restante.
- Reintentar con límite y dejar un estado terminal claro.
- Reparar jobs con el script específico y `dry-run` antes de escribir.

Pruebas: `pipelineRunner`, `pipelineShadowStale`, `pipelineDiarioJubilado`, `scraperRunQuality`, `fuentesHealth` y `runDigestWorkflow`.
