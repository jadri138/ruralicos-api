# Render: configuracion rapida

La opcion mas simple es un unico Cron Job que llame al pipeline completo de la
API.

## Cron Job recomendado

Comando:

```bash
curl -fsS "$BASE_URL/tareas/pipeline-diario?token=$CRON_TOKEN"
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

- [ ] `docs/supabase_digest_schema.sql` ejecutado en Supabase.
- [ ] `CRON_TOKEN` configurado en la API y en el Cron Job.
- [ ] `PUBLIC_BASE_URL` configurado en la API.
- [ ] Cron Job en Render con `curl -fsS "$BASE_URL/tareas/pipeline-diario?token=$CRON_TOKEN"`.
- [ ] Si activas FEGA con envios individuales, ejecutar antes `docs/user_legal_identity_schema.sql` y `docs/official_list_matches_schema.sql`.
