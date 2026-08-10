# decision-v2 en sombra

`decision-v2` evalua conjuntamente, por usuario, todas las alertas ingeridas del
dia. Solo aplica antes del LLM filtros objetivos de URL oficial, territorio,
duplicado de publicacion, historial usuario-alerta y exclusiones explicitas.
`estado_ia`, scores, embeddings, taxonomia, sectores inferidos y resumenes nunca
reducen el universo.

El LLM es la unica autoridad semantica. Su contrato exige que cada candidata
aparezca exactamente una vez como `include` o `exclude`, con motivo y evidencia.
Solo se permite un reintento para corregir un contrato tecnicamente invalido; un
fallo posterior termina en `ERROR` sin seleccion alternativa.

## Activacion local o en un entorno controlado

La fase esta apagada por defecto en ambos lados:

```text
# API
DECISION_V2_SHADOW_ENABLED=true
DECISION_V2_MODEL=gpt-5
DECISION_V2_SHADOW_BATCH_SIZE=1

# proceso que ejecuta scripts/run_digest_workflow.js
RUN_DECISION_V2_SHADOW=true
DECISION_V2_SHADOW_MAX_LOOPS=200
```

Opcionalmente, `DECISION_V2_MAX_OFFICIAL_INPUT_CHARS` controla el presupuesto
total de fragmentos oficiales sin eliminar candidatas. No actives estas
variables ni apliques la migracion en produccion sin una decision operativa
explicita.

La ejecucion diaria normal sigue siendo unica:

```powershell
node scripts/run_digest_workflow.js
```

El script genera un `workflow_run_key` por ejecucion y llama por lotes a
`POST /alertas/decision-v2-shadow`. Un reintento HTTP con la misma clave no
duplica usuarios; una nueva ejecucion genera nuevos `shadow_run_id` y conserva
el historico comparable.

## Persistencia y consulta

La migracion crea exclusivamente:

- `shadow_digest_runs`: perfil, universo, prompt exacto, entrada, respuestas,
  uso, error y `mensaje_preview`.
- `shadow_candidate_decisions`: una fila por alerta examinada, con snapshot,
  filtros objetivos, decision, prioridad, motivo y evidencia.
- `shadow_digest_items`: incluidas en orden final y bloque exacto renderizado.

Ejemplos de consulta desde una sesion interna con `service_role`:

```sql
select shadow_run_id, workflow_date, user_id, status, model,
       counts_json, error_code, mensaje_preview
from public.shadow_digest_runs
where workflow_date = date '2026-08-10'
order by created_at, user_id;

select r.shadow_run_id, r.user_id, d.alert_id, d.input_position,
       d.decision_source, d.decision, d.priority, d.reason, d.evidence,
       d.alert_snapshot, d.objective_filters
from public.shadow_digest_runs r
join public.shadow_candidate_decisions d using (shadow_run_id)
where r.workflow_date = date '2026-08-10'
order by r.user_id, d.input_position;

select shadow_run_id, user_id, alert_id, final_position, rendered_block
from public.shadow_digest_items
where workflow_date = date '2026-08-10'
order by user_id, shadow_run_id, final_position;
```

RLS esta habilitado y `public`, `anon` y `authenticated` no tienen permisos.
Solo `service_role` puede consultar o escribir estas tablas.

## Garantia de no envio

La ruta shadow no crea `digests`, `digest_items`, enlaces de tracking, clicks,
outbox, logs de WhatsApp ni llamadas al proveedor. El mensaje se produce con
una funcion pura extraida del compositor vigente, conserva el orden del LLM y
se guarda completo. Un fallo sistemico de la fase se registra en el workflow y
no impide que el motor de produccion continue.

## Pruebas dirigidas

```powershell
node tests/decisionV2.test.js
node tests/decisionV2Corpus.test.js
node tests/decisionV2Shadow.test.js
node tests/decisionV2Migration.test.js
node tests/decisionV2Workflow.test.js
```

