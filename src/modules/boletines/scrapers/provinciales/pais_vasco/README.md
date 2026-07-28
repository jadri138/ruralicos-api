# Provinciales del País Vasco

## BOTHA — Álava

Implementado en `botha/scraper.js` y montado en `/scrape-botha-oficial` (con alias histórico `/scrape-botha`). Lee el sumario oficial, normaliza IDs y descarga detalle cuando procede.

## BOG — Gipuzkoa

Implementado en `bog/scraper.js` y montado en `/scrape-bog-oficial`. Puede usar una fecha concreta, analiza el sumario diario y conserva el contexto si falla el detalle.

## BOB — Bizkaia

Pendiente. Solo existe el marcador `bob/.gitkeep`; no hay scraper ni ruta. No añadir `/scrape-bob-oficial` a configuración hasta implementar pruebas y registro.

## Operación

BOTHA y BOG no se ejecutan por el mero hecho de estar montados. Deben figurar en `COMPLEMENTARY_SCRAPE_PATHS` si se quieren dentro del flujo complementario.

La documentación anterior que consideraba BOG completamente pendiente estaba desactualizada; el código actual sí contiene scraper y ruta, aunque el catálogo `manifest.js` aún lo etiqueta como pendiente.
