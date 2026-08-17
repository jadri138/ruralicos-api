# Cron diario de Ruralicos

Producción usa un único Cron Job de Render con este comando:

```bash
node scripts/run_digest_workflow.js
```

No programes endpoints individuales como crons separados.

## Qué hace

El script ejecuta una vez, en este orden:

1. Scrapers principales.
2. Cotejo opcional con listados oficiales.
3. Reparación de alertas pendientes de IA.
4. Clasificación, resumen y revisión hasta vaciar sus lotes.
5. Deduplicación.
6. Embeddings y ciclo MIA opcionales.
7. Recuperación acotada de `HOLD_FOR_EVIDENCE` sobre material ya guardado.
8. Decisión de digests de pago según `DIGEST_ENGINE`:
   - `v1`: preparación y validación legacy usuario a usuario;
   - `v2`: ejecución completa de shadow-v2 y promoción fail-closed a tablas productivas.
9. Encolado de los digests aprobados por el motor elegido.
10. Generación y encolado del resumen gratuito.
11. Drenado de la única cola `mia_outbox`.
12. Conciliación de ACK pendientes con UltraMsg.
13. Selección opcional de preguntas solo para digest confirmados como entregados
    o leídos.
14. Segundo uso del mismo drenador únicamente si se encoló alguna pregunta.

Si una fase obligatoria falla o deja de avanzar, el comando termina con error y
no continúa hacia un digest incompleto. Las fases MIA y el cotejo de listados
son opcionales: registran su error y dejan continuar el envío principal.

La recuperación consulta como máximo 25 fichas vencidas y procesa 2 a la vez.
Usa exclusivamente `alertas` y `raw_documents` ya almacenados. Cada alerta
conserva sus intentos y backoff de forma independiente, por lo que una ficha
sin evidencia no bloquea el resto del día ni provoca descargas nuevas.

## Variables necesarias

- `BASE_URL=https://ruralicos-api.onrender.com`
- `CRON_TOKEN`, con el mismo valor que en la API

La API necesita además `PUBLIC_BASE_URL`, credenciales de Supabase, OpenAI y
UltraMsg según `.env.example`.

`DIGEST_ENGINE=v1` mantiene el comportamiento anterior y ejecuta shadow-v2 al
final como auditoría opcional. `DIGEST_ENGINE=v2` sustituye la preparación V1:
completa shadow-v2, revalida los items, los promueve con idempotencia y usa la
misma `mia_outbox`. No hay un segundo emisor. El runner local manual sigue
requiriendo `SHADOW_V2_ENABLED=true` y nunca promueve ni envía.

Opcionales:

- `DIGEST_ENGINE=v1` (`v2` activa el motor nuevo; volver a `v1` es el rollback)
- `FECHA=AAAA-MM-DD`, solo para un relanzamiento controlado.
- `RUN_SCRAPERS=true`
- `RUN_OFFICIAL_LISTS=true`
- `RUN_REPAIR=true`
- `HTTP_TIMEOUT_MS=900000` (15 minutos para fases que agrupan muchas fuentes)
- `HTTP_RETRIES=3`
- `MAX_LOOPS=40`
- `PREPARAR_DIGEST_MAX_LOOPS=200`
- `HOLD_RECOVERY_MAX_LOOPS=20`
- `ALERT_DECISION_HOLD_MAX_RETRIES=3`
- `ALERT_DECISION_HOLD_RETRY_PER_USER=2`
- `ALERT_DECISION_HOLD_RETRY_BASE_HOURS=24`
- `ALERT_DECISION_HOLD_RETRY_MAX_HOURS=96`
- `ALERT_DECISION_HOLD_RETRY_LEASE_MS=900000`
- `OUTBOX_MAX_LOOPS=50`

La API admite estos ajustes opcionales de decisión y entrega:

- `ALERT_DECISION_TOP_K=10`
- `ALERT_DECISION_JUDGE_MODEL=gpt-5-nano`
- `ALERT_DECISION_SECOND_OPINION_MODEL=gpt-5.6-luna`
- `IA_GPT5_NANO_REASONING_EFFORT=minimal`
- `IA_GPT56_LUNA_REASONING_EFFORT=low`
- `ALERT_DECISION_LLM_DAILY_CALL_LIMIT=<tope-positivo-antes-de-produccion>`
- `ALERT_DECISION_JUDGE_PRICING_JSON=<tarifas-explicitas-opcionales>`
- `ALERT_DECISION_PSEUDONYM_SALT=<secreto-largo-y-estable>`
- `ALERT_DECISION_MESSAGE_MAX_CHARS=3200`
- `ULTRAMSG_RECONCILE_ACCEPTED_MS=600000`
- `ULTRAMSG_RECONCILE_SENT_MS=1800000`
- `ULTRAMSG_RECONCILE_TIMEOUT_MS=15000`
- `RUN_DAILY_EXPLORATION=true`
- `MIA_MAX_PREGUNTAS_EXPLORACION_DIA=20`
- `MIA_EXPLORACION_COOLDOWN_DIAS=30`
- `DIGEST_MESSAGE_MODEL=gpt-5.6-luna`
- `MIA_GROUNDED_MODEL=gpt-5.6-luna`
- `CRITICAL_DOUBLE_CHECK_MODEL_A=gpt-5-nano`
- `CRITICAL_DOUBLE_CHECK_MODEL_B=gpt-5.6-luna`

`DIGEST_VIA_OUTBOX` está retirado: no existe un modo de envío síncrono para el
digest. No programes `/tareas/mia-outbox` ni `/tareas/whatsapp-reconcile` como
otro pipeline; el comando diario ya ejecuta ambas fases.

## Fuentes complementarias y FEGA

`/tareas/scrapers-diario` ya incluye las fuentes complementarias configuradas.
Para añadir endpoints:

```text
COMPLEMENTARY_SCRAPE_PATHS=/scrape-botha-oficial,/scrape-nuevo-bop-oficial
```

FEGA se controla con:

```text
PIPELINE_INCLUDE_FEGA=true
FEGA_EJERCICIO=2024
FEGA_ENVIAR_MATCHES=false
```

Mantén `FEGA_ENVIAR_MATCHES=false` durante diagnósticos.

## Horario

Programa una sola ejecución diaria después de la publicación habitual de los
boletines. No uses una frecuencia de diez minutos: cada ejecución recorre el
pipeline completo. Render expresa el horario del cron en UTC.

## Endpoints auxiliares

Sirven para diagnóstico o para ejecutar una fase concreta:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/scrapers-diario"
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/complementarios-diario"
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/cotejar-listados-oficiales?enviar=false"
```

Para saber por qué un usuario recibiría o no una alerta:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/alertas/diagnosticar-digest?user_id=123&fecha=AAAA-MM-DD"
```

La conciliación puede inspeccionarse sin contactar al proveedor:

```bash
curl -fsS -X POST -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/whatsapp-reconcile?dry_run=true&limit=50"
```

El webhook previsto para mensajes y ACK es
`POST /webhooks/ultramsg/feedback?token=<ULTRAMSG_WEBHOOK_TOKEN>`. Antes del
despliegue deben activarse en UltraMsg `webhook_message_received` y
`webhook_message_ack`; que aparezcan aquí no significa que la instancia real ya
esté configurada.

## Vigilancia y checklist

`/tareas/salud-fuentes?dias=7&min_dias=2` puede ejecutarse aparte: solo revisa
fuentes y avisa al administrador; no procesa alertas ni envía digests.

- El esquema de Supabase está aplicado.
- `BASE_URL/health` responde.
- `CRON_TOKEN` coincide en la API y en Render.
- Existe un único cron con `node scripts/run_digest_workflow.js`.
- `DIGEST_ENGINE` vale exactamente `v1` o `v2`.
- El webhook de UltraMsg conserva el ID de proveedor y llegan ACK de prueba.
- `PROVIDER_ACCEPTED` no se confunde con `DELIVERED`.
