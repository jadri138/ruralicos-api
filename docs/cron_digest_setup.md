# Cron setup recomendado (Ruralicos digest)

Este documento define un orden estable para pasar de alertas sueltas a digest diario por usuario.

## Variables necesarias

- `BASE_URL` (ej. `https://tu-api.onrender.com`)
- `CRON_TOKEN` (debe coincidir con el del backend)

> El backend valida token en query string (`?token=...`).  
> Referencia: `src/utils/checkCronToken.js`.

## Pipeline PRO (digest por usuario)

Ejemplo de comandos (GET):

```bash
curl -fsS "$BASE_URL/alertas/clasificar?token=$CRON_TOKEN"
curl -fsS "$BASE_URL/alertas/resumir?token=$CRON_TOKEN"
curl -fsS "$BASE_URL/alertas/revisar?token=$CRON_TOKEN"
curl -fsS "$BASE_URL/alertas/preparar-digest?token=$CRON_TOKEN"
curl -fsS "$BASE_URL/alertas/enviar-digest?token=$CRON_TOKEN"
```

## Pipeline FREE (resumen genérico)

```bash
curl -fsS "$BASE_URL/alertas/generar-resumen-free?token=$CRON_TOKEN"
curl -fsS "$BASE_URL/alertas/enviar-resumen-free?token=$CRON_TOKEN"
```

## Horario recomendado (UTC)

```cron
# PRO pipeline
0 6 * * *   curl -fsS "$BASE_URL/alertas/clasificar?token=$CRON_TOKEN"
20 6 * * *  curl -fsS "$BASE_URL/alertas/resumir?token=$CRON_TOKEN"
40 6 * * *  curl -fsS "$BASE_URL/alertas/revisar?token=$CRON_TOKEN"
30 7 * * *  curl -fsS "$BASE_URL/alertas/preparar-digest?token=$CRON_TOKEN"
0 8 * * *   curl -fsS "$BASE_URL/alertas/enviar-digest?token=$CRON_TOKEN"

# FREE pipeline
30 8 * * *  curl -fsS "$BASE_URL/alertas/generar-resumen-free?token=$CRON_TOKEN"
45 8 * * *  curl -fsS "$BASE_URL/alertas/enviar-resumen-free?token=$CRON_TOKEN"
```

## Opción recomendada en Render: Workflow/Job único

Si no quieres lanzar muchos crons, usa un solo Workflow Job diario con:

```bash
npm run workflow:digest
```

Variables del job:

- `BASE_URL=https://tu-api.onrender.com`
- `CRON_TOKEN=...`
- opcional `MAX_LOOPS=40`
- opcional `STEP_DELAY_MS=800`

Este script repite automáticamente `clasificar/resumir/revisar` hasta que devuelven
`procesadas=0`, y después ejecuta los pasos de digest/free una vez.

## Reintentos recomendados

- Si `clasificar/resumir/revisar` falla, reintentar 1 vez a los 10 minutos.
- Si `preparar-digest` falla, reintentar 1 vez antes de `enviar-digest`.
- Si `enviar-digest` falla parcialmente, puedes relanzar la misma ruta:
  solo enviará registros con `enviado=false`.

## Nota de migración

- Mantener desactivado el flujo legacy por alerta individual (`/alertas/enviar-whatsapp`)
  mientras `DIGEST_ONLY_MODE=true`.
