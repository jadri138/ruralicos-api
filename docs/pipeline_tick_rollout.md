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

Cron de sombra en Render (cada 10 min). **Render corre los crons en UTC**, asi
que la ventana se pone en UTC: `6-14` cubre la franja de publicacion de boletines
(~8:00–15:00 peninsular en verano) **con margen para que, si un tick muere, el
siguiente lo recupere dentro de la ventana** (ver heartbeat rancio abajo):

```cron
*/10 6-14 * * * curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-tick"
```

`BASE_URL` debe ser el dominio que responde de verdad a `/health` (el
`.onrender.com`, no un dominio custom sin DNS). `CRON_TOKEN` igual al del backend
**y presente en el env del propio servicio de cron** (si falta, el tick responde
403 y la sombra no arranca nunca).

### Resiliencia de un tick (por que no se cuelga)

Cada request HTTP del tick lleva un **timeout duro** (`PIPELINE_HTTP_TIMEOUT_MS`,
20s): una fuente que acepta la conexion y no responde se corta, se registra como
error y el dia sigue — no cuelga el tick ni provoca que Render lo mate sin
checkpoint. Ademas, el tick reserva `PIPELINE_TICK_RESERVE_MS` de presupuesto para
no arrancar una request que no quepa entera antes del deadline, y hace un
**checkpoint inicial** nada mas reclamar el job (sella `current_stage` antes de la
primera fase). Si aun asi un tick muere sin liberar el claim, el siguiente lo roba
cuando el heartbeat pasa de rancio (`PIPELINE_TICK_STALE_MS`, 5 min < intervalo del
cron), o se fuerza con `?reset=true` (que ahora tambien reabre un `running`
colgado, no solo failed/aborted).

### Preflight de la base URL interna

Antes de crear o reclamar el job, el tick comprueba que `baseUrl/health` responde
(timeout `PIPELINE_PREFLIGHT_TIMEOUT_MS`, 5s). Si no responde, el tick devuelve
**503 `preflight_failed`** con el motivo y NO toca el job. Esto convierte en error
visible el fallo que atasco la sombra el 2026-07-07/08: un `BASE_URL` de cron que
aceptaba la conexion y nunca respondia dejaba el primer self-fetch colgado para
siempre, con el job huerfano en `running` y `stages_json` vacio.

Recomendado ademas: fijar `PIPELINE_INTERNAL_BASE_URL=https://<servicio>.onrender.com`
en el env del servicio API. Con ella los self-fetch dejan de depender del Host
de la peticion del cron (y por tanto del `BASE_URL` que use cada cron).

### Verificar que el deploy lleva el fix

El sintoma de un deploy VIEJO (pre `0e1177e`) es inconfundible: el job del dia
acumula `ticks` pero `current_stage` sigue `null` y `stages_json` vacio `{}`.
Con el codigo nuevo, el PRIMER tick sella `current_stage='scrapers'` nada mas
reclamar (checkpoint inicial). Si tras un tick `current_stage` sigue null,
Render no esta corriendo `main`: hace falta redeploy manual (o revisar por que
fallo el auto-deploy).

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

**Interlock automatico:** con `PIPELINE_TICK_SHADOW=false` en el env del
servicio, `/tareas/pipeline-diario` responde **410 jubilado** y no ejecuta nada
— aunque el cron viejo siga configurado, no puede duplicar envios. En emergencia
(runner caido y hay que sacar el dia con el monolito) se reactiva puntualmente
con `.../pipeline-diario?force_legacy=true`.

El cutover es reversible: vuelve a `shadow=true` si algo no cuadra (eso tambien
reactiva `pipeline-diario`).

## Variables de entorno

Ver `.env.example` (seccion "Runner de pipeline con checkpoints"):

| Variable | Default | Que hace |
| --- | --- | --- |
| `PIPELINE_TICK_SHADOW` | `true` | Sombra on/off. `false` = cutover real. |
| `PIPELINE_TICK_BUDGET_MS` | `55000` | Presupuesto por tick (≈ timeout de proxy de Render). |
| `PIPELINE_HTTP_TIMEOUT_MS` | `20000` | Timeout duro por request HTTP del tick (evita cuelgues). |
| `PIPELINE_TICK_RESERVE_MS` | `0` | Reserva de presupuesto: no arranca una request que no quepa antes del deadline. Ponlo `= PIPELINE_HTTP_TIMEOUT_MS`. |
| `PIPELINE_TICK_STALE_MS` | `300000` | Antiguedad del heartbeat tras la que otro tick roba un claim colgado (y umbral de reset sobre `running`). < intervalo del cron. |
| `PIPELINE_PREFLIGHT_TIMEOUT_MS` | `5000` | Timeout del preflight `baseUrl/health` antes de reclamar el job. |
| `PIPELINE_STAGE_MAX_ATTEMPTS` | `3` | Reintentos por fase antes de `failed` (el cron hace de backoff). |

Reutiliza tambien las compartidas con `pipeline-diario`: `PIPELINE_MAX_LOOPS`,
`PIPELINE_STEP_DELAY_MS`, `PIPELINE_HTTP_RETRIES`, `PIPELINE_INCLUDE_COMPLEMENTARY`,
`PIPELINE_INCLUDE_FEGA`, `PIPELINE_INTERNAL_BASE_URL`.
