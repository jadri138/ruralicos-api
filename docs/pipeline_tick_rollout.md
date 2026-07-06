# Rollout del runner de pipeline con checkpoints (C1)

`/tareas/pipeline-tick` es la evolucion de `/tareas/pipeline-diario`: en vez de
un unico HTTP larguisimo (que el proxy de Render corta a los ~55s), **UN cron lo
dispara cada ~10 min**. Cada tick reclama el `pipeline_job` del dia (claim +
heartbeat), avanza las 16 fases dentro de su presupuesto de tiempo y guarda un
checkpoint en `pipeline_jobs.stages_json` — incluso vuelta a vuelta dentro de las
fases por lotes. El siguiente tick reanuda justo donde quedo.

Mismas fases y mismo orden que `pipeline-diario`. Diferencias: un scraper caido
NO tumba el dia (lo registra y sigue; de las caidas sostenidas ya avisa el vigia
`/tareas/salud-fuentes`), y si una fase por lotes queda bloqueada o al limite de
vueltas, **aborta ANTES del digest** y avisa al admin con la URL de reset.

`pipeline-diario` y los crons sueltos siguen intactos: conviven con el tick hasta
el cutover. La migracion `pipeline_jobs` ya esta aplicada en produccion.

## Fase 1 — Sombra (por defecto)

El tick arranca en **sombra** (`shadow=true` es el DEFAULT). En sombra ejecuta
toda la orquestacion pero **no llama a las fases outbound** (`enviar_digest`,
`enviar_resumen_free`, `mia_outbox`), **no escribe `scraper_runs`** (para no
contaminar el vigia de salud de fuentes) y sus `pipeline_runs` van con el stage
prefijado `shadow:*`. Sirve para validar la orquestacion corriendo en paralelo a
los crons reales, sin efectos hacia el usuario.

Cron de sombra en Render (cada 10 min en la ventana ~6:00–13:00 peninsular, que
es cuando se publican los boletines):

```cron
*/10 6-13 * * * curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-tick"
```

`BASE_URL` debe ser el dominio que responde de verdad a `/health` (el
`.onrender.com`, no un dominio custom sin DNS). `CRON_TOKEN` igual al del backend.

### Inspeccion

```bash
# Estado del job del dia (fases, vueltas, ticks, claim, status)
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-jobs?fecha=$(date +%F)"

# Ultimos jobs
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-jobs?limit=10"
```

Un dia de sombra sano termina con el job `shadow=true` en `status=completed`, las
fases outbound en `shadow_skipped` y sin avisos al admin.

### Reset tras abort/fail

Si el job termina en `aborted` (lote bloqueado) o `failed` (fase agoto
reintentos), reabrelo — limpia los flags de bloqueo y las vueltas — con:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-tick?fecha=YYYY-MM-DD&reset=true"
```

El propio aviso al admin incluye esta URL.

## Fase 2 — Cutover (decision del usuario)

Tras varios dias de sombra limpia (job completa, sin abortos, los `shadow:*`
`pipeline_runs` cuadran con lo que hizo `pipeline-diario`):

1. Poner `PIPELINE_TICK_SHADOW=false` en el servicio de la API **o** cambiar el
   cron a `.../pipeline-tick?shadow=false`. Ahora el tick SI envia y escribe
   `scraper_runs`.
2. Retirar los crons sueltos / `pipeline-diario` para que no se solapen envios.

El cutover es reversible: vuelve a `shadow=true` si algo no cuadra.

## Variables de entorno

Ver `.env.example` (seccion "Runner de pipeline con checkpoints"):

| Variable | Default | Que hace |
| --- | --- | --- |
| `PIPELINE_TICK_SHADOW` | `true` | Sombra on/off. `false` = cutover real. |
| `PIPELINE_TICK_BUDGET_MS` | `55000` | Presupuesto por tick (≈ timeout de proxy de Render). |
| `PIPELINE_TICK_STALE_MS` | `900000` | Antiguedad del heartbeat tras la que otro tick roba un claim colgado. |
| `PIPELINE_STAGE_MAX_ATTEMPTS` | `3` | Reintentos por fase antes de `failed` (el cron hace de backoff). |

Reutiliza tambien las compartidas con `pipeline-diario`: `PIPELINE_MAX_LOOPS`,
`PIPELINE_STEP_DELAY_MS`, `PIPELINE_HTTP_RETRIES`, `PIPELINE_INCLUDE_COMPLEMENTARY`,
`PIPELINE_INCLUDE_FEGA`, `PIPELINE_INTERNAL_BASE_URL`.
