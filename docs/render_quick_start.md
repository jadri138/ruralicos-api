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
- `PUBLIC_BASE_URL=https://TU-SERVICIO.onrender.com`

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

## Checklist final

- [ ] Esquema operativo aplicado en Supabase.
- [ ] `CRON_TOKEN` configurado en la API y en el Cron Job.
- [ ] `PUBLIC_BASE_URL` configurado en la API.
- [ ] Cron Job en Render con `curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-diario"`.
- [ ] Si activas FEGA con envios individuales, comprobar antes identidad legal en `users` y `official_list_matches`.
