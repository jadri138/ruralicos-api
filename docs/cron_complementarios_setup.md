# Fuentes complementarias

Las fuentes complementarias ya no necesitan un cron diario separado. El pipeline
principal las ejecuta antes de la IA y del digest:

```text
GET /tareas/pipeline-diario?token=CRON_TOKEN
```

Por defecto se incluyen los endpoints definidos en `COMPLEMENTARY_SCRAPE_PATHS`.
Si no se define, usa:

```text
/scrape-botha-oficial
```

Para sumar boletines provinciales:

```text
COMPLEMENTARY_SCRAPE_PATHS=/scrape-botha-oficial,/scrape-nuevo-bop-oficial
```

## FEGA

FEGA se integra en el mismo pipeline cuando se activa:

```text
PIPELINE_INCLUDE_FEGA=true
FEGA_EJERCICIO=2024
FEGA_ENVIAR_MATCHES=false
```

Tambien puede lanzarse puntualmente:

```text
GET /tareas/pipeline-diario?token=CRON_TOKEN&fega=true&ejercicio=2024
```

El endpoint antiguo queda como herramienta manual:

```text
GET /tareas/complementarios-diario?token=CRON_TOKEN
GET /tareas/complementarios-diario?token=CRON_TOKEN&fega=true&ejercicio=2024&enviar_fega=true
```

Antes de activar envios individuales hay que comprobar que existen en Supabase
las columnas de identidad legal en `users` y la tabla `official_list_matches`.
Ya no se mantienen SQL sueltos en `docs`; usa la migracion operativa vigente.

Tambien se puede lanzar solo el cotejo nominal sobre alertas ya guardadas:

```text
GET /tareas/cotejar-listados-oficiales?token=CRON_TOKEN&fecha=2026-05-13&enviar=false
```

Este cotejo revisa las alertas del dia que parezcan listados nominativos con
beneficiarios, solicitantes, adjudicatarios, titulares o concesiones, y guarda
coincidencias contra el `legal_name` del usuario.
