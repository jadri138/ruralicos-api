# Fuentes complementarias

Las fuentes complementarias forman parte del único workflow diario:

```bash
node scripts/run_digest_workflow.js
```

No programes un segundo cron ni llames a `/tareas/pipeline-tick`. El workflow
ejecuta `/tareas/scrapers-diario`, que ya incorpora las fuentes principales y
complementarias configuradas.

## Configuración

`COMPLEMENTARY_SCRAPE_PATHS` permite ampliar los endpoints complementarios. Si
no se define, se conserva el valor seguro configurado por la aplicación.

Ejemplo:

```text
COMPLEMENTARY_SCRAPE_PATHS=/scrape-botha-oficial,/scrape-nuevo-bop-oficial
```

FEGA se integra en el mismo workflow mediante:

```text
PIPELINE_INCLUDE_FEGA=true
FEGA_EJERCICIO=2024
FEGA_ENVIAR_MATCHES=false
```

## Ejecución manual de diagnóstico

Estas rutas permiten comprobar una fase aislada. No son crons adicionales:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/complementarios-diario"
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/complementarios-diario?fega=true&ejercicio=2024&enviar_fega=false"
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/cotejar-listados-oficiales?fecha=2026-05-13&enviar=false"
```

Usa `enviar_fega=false` durante diagnóstico. Antes de cualquier envío nominal,
comprueba las columnas de identidad legal en `users` y la tabla
`official_list_matches` mediante las migraciones vigentes.

Configuración del único cron: [`cron_digest_setup.md`](cron_digest_setup.md).
