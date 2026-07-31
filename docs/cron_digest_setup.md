# Cron diario de Ruralicos

Producción usa un único Cron Job de Render con este comando:

```bash
node scripts/run_digest_workflow.js
```

No programes `/tareas/pipeline-tick`: el sistema de claims, heartbeats y
recuperación quedó retirado después de provocar jobs atrapados en `scrapers`.

## Qué hace

El script ejecuta una vez, en este orden:

1. Scrapers principales.
2. Cotejo opcional con listados oficiales.
3. Reparación de alertas pendientes de IA.
4. Clasificación, resumen y revisión hasta vaciar sus lotes.
5. Deduplicación.
6. Embeddings y ciclo MIA opcionales.
7. Preparación y validación del digest usuario a usuario.
8. Envío de digests de pago.
9. Ciclo MIA posterior.
10. Generación y envío del resumen gratuito.

Si una fase obligatoria falla o deja de avanzar, el comando termina con error y
no continúa hacia un digest incompleto. Las fases MIA y el cotejo de listados
son opcionales: registran su error y dejan continuar el envío principal.

## Variables necesarias

- `BASE_URL=https://ruralicos-api.onrender.com`
- `CRON_TOKEN`, con el mismo valor que en la API

Opcionales:

- `FECHA=AAAA-MM-DD`, solo para un relanzamiento controlado.
- `RUN_SCRAPERS=true`
- `RUN_OFFICIAL_LISTS=true`
- `RUN_REPAIR=true`
- `HTTP_TIMEOUT_MS=900000` (15 minutos para fases que agrupan muchas fuentes)
- `HTTP_RETRIES=3`
- `MAX_LOOPS=40`
- `PREPARAR_DIGEST_MAX_LOOPS=200`

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

Mantén desactivado el envío individual legado (`/alertas/enviar-whatsapp`)
mientras `DIGEST_ONLY_MODE=true`.
