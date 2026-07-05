# Render: configuracion rapida

La opcion mas simple es un unico Cron Job que llame al pipeline completo de la
API.

## Cron Job recomendado

Comando:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-diario"
```

Variables del cron:

- `BASE_URL=https://TU-SERVICIO.onrender.com`
- `CRON_TOKEN=tu_token`

Frecuencia recomendada:

- 1 vez al dia. Ejemplo UTC: `0 6 * * *`

## Variables en la API

Minimas:

- `CRON_TOKEN=tu_token`
- `PUBLIC_BASE_URL=https://TU-SERVICIO.onrender.com` o tu dominio publico si ya resuelve DNS
- Opcional: `PIPELINE_INTERNAL_BASE_URL=https://TU-SERVICIO.onrender.com`

`PUBLIC_BASE_URL` se usa para enlaces publicos. Las llamadas internas del
pipeline usan por defecto el host real de la peticion; si quieres fijarlas de
forma explicita en Render, usa `PIPELINE_INTERNAL_BASE_URL`. No apuntes el cron
ni la URL interna a un dominio custom hasta verificar que `/health` responde.

Para boletines provinciales complementarios:

```text
COMPLEMENTARY_SCRAPE_PATHS=/scrape-botha-oficial,/scrape-nuevo-bop-oficial
```

Para FEGA dentro del mismo pipeline:

```text
PIPELINE_INCLUDE_FEGA=true
FEGA_EJERCICIO=2024
FEGA_ENVIAR_MATCHES=false
```

## Vigía de fuentes caídas (recomendado)

Un segundo Cron Job diario que avisa por WhatsApp al admin si alguna fuente
lleva 2+ días con el 100% de sus ejecuciones en error:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/salud-fuentes"
```

Parámetros opcionales: `?dias=7` (ventana revisada), `?min_dias=2` (racha
mínima para avisar), `?enviar=false` (solo diagnóstico, sin WhatsApp).
Requiere `ADMIN_ALERT_PHONE` (o `ADMIN_ALERT_PHONES`) configurado.

## Checklist final

- [ ] Esquema operativo aplicado en Supabase.
- [ ] `CRON_TOKEN` configurado en la API y en el Cron Job.
- [ ] `PUBLIC_BASE_URL` configurado en la API.
- [ ] Si usas dominio custom, `https://tu-dominio/health` responde; si no, usa el dominio `.onrender.com`.
- [ ] Cron Job en Render con `curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-diario"`.
- [ ] Si activas FEGA con envios individuales, comprobar antes identidad legal en `users` y `official_list_matches`.
