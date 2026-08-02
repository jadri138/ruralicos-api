# Tareas y pipeline

Orquestador de trabajos programados. Coordina las fases sin duplicar la lógica propia de scrapers, alertas, digest o MIA.

## Archivos

| Archivo | Función |
| --- | --- |
| `tareas.routes.js` | Endpoints de cron, salud y operaciones |
| `tareas.helpers.js` | Registro y utilidades de ejecución |

## Endpoints principales

| Endpoint | Uso |
| --- | --- |
| `/tareas/salud-fuentes` | Estado agregado de fuentes |
| `/tareas/scrapers-diario` | Ingesta principal |
| `/tareas/scraper` | Una fuente concreta |
| `/tareas/complementarios-diario` | Provinciales y complementarias |
| `/tareas/cotejar-listados-oficiales` | Coincidencias con listados |
| `/tareas/hold-evidence-recovery` | Relee por lotes evidencia ya almacenada para `HOLD_FOR_EVIDENCE` |
| `/tareas/mia-outbox` | Drena por lotes la única cola de comunicaciones |
| `/tareas/whatsapp-reconcile` | Concilia por ID de proveedor estados sin ACK terminal |

## Ejecución de producción

Render ejecuta una vez al día:

```bash
node scripts/run_digest_workflow.js
```

El script llama a los endpoints de cada fase en orden y no avanza al digest si
clasificación, resumen, revisión o la fase de recuperación fallan de forma
sistémica. Una alerta concreta que no puede recuperar evidencia queda aislada
con backoff y estado terminal; no bloquea a las demás.

`/tareas/hold-evidence-recovery` acepta como máximo 50 filas y 4 trabajos
simultáneos (25 y 2 por defecto). Consulta solo fichas `PENDING`/`FAILED` cuyo
`recovery_next_at` ya venció, usa `alertas` y `raw_documents` guardados y nunca
descarga documentos. Tras tres estrategias, tres ausencias de material o tres
fallos de carga deja `EXHAUSTED`. No programes esta ruta como cron separado: el
workflow diario ya la ejecuta antes de preparar los digests. La respuesta indica
`processed` y `has_more`; el workflow repite lotes hasta recibir uno corto o
alcanzar `HOLD_RECOVERY_MAX_LOOPS`. Si queda cola, se retoma de forma idempotente
al día siguiente sin bloquear el resto del flujo.

Solo se encolan carencias globales de la ficha que pueden reconstruirse desde el
material guardado. Una indisponibilidad del LLM, su presupuesto o un desacuerdo
de segunda opinión son esperas personales o técnicas y nunca modifican la ficha
compartida de la alerta.

Después de preparar el contenido, el mismo script encola digest y FREE, drena
`mia_outbox` y ejecuta una conciliación. No programes esos endpoints por
separado: crearían otro orquestador operativo. `/tareas/pipeline-tick` y
`pipeline_jobs` son legado de diagnóstico, no cron de producción.

`/tareas/mia-outbox` y `/tareas/whatsapp-reconcile` aceptan `dry_run=true` para
inspección sin enviar ni contactar al proveedor, respectivamente. La
conciliación no reenvía mensajes aceptados; solo consulta el estado asociado al
`provider_message_id`.

## Reglas operativas

- Todo endpoint de trabajo valida `CRON_TOKEN`.
- Una fase debe ser idempotente o detectar que ya terminó.
- Los errores parciales se registran; no se esconden detrás de un `ok`.
- Reintentar con límite y dejar un estado terminal claro.

Pruebas: `scraperRunQuality`, `fuentesHealth`, `miaOutbox`,
`whatsappDelivery` y `runDigestWorkflow`.
