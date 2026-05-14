# Cron de boletines complementarios

Endpoint:

```text
GET /tareas/complementarios-diario?token=CRON_TOKEN
```

Por defecto ejecuta fuentes complementarias configuradas en `COMPLEMENTARY_SCRAPE_PATHS`.
Si no se define, usa:

```text
/scrape-botha-oficial
```

FEGA se puede incluir en el mismo cron cuando interese cruzar listados de beneficiarios. Usa la tabla general de coincidencias nominales, la misma que deben usar futuras fuentes donde aparezcan personas:

```text
GET /tareas/complementarios-diario?token=CRON_TOKEN&fega=true&ejercicio=2024&enviar_fega=true
```

Variables opcionales:

```text
COMPLEMENTARY_SCRAPE_PATHS=/scrape-botha-oficial
COMPLEMENTARY_INCLUDE_FEGA=true
FEGA_EJERCICIO=2024
FEGA_ENVIAR_MATCHES=true
OFFICIAL_LIST_SEND_MATCHES=false
OFFICIAL_LIST_MATCH_LIMIT=500
```

Antes de activar envios individuales hay que aplicar:

```text
docs/user_legal_identity_schema.sql
docs/official_list_matches_schema.sql
```

Tambien se puede lanzar solo el cotejo nominal sobre alertas ya guardadas:

```text
GET /tareas/cotejar-listados-oficiales?token=CRON_TOKEN&fecha=2026-05-13&enviar=false
```

Este cotejo revisa las alertas del dia que parezcan listados nominativos
con beneficiarios, solicitantes, adjudicatarios, titulares o concesiones,
y guarda coincidencias contra el `legal_name` del usuario.
