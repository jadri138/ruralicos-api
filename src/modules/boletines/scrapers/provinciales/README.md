# Scrapers provinciales

Fuentes de ámbito provincial, donde es especialmente importante distinguir interés rural general de expedientes individuales.

## Estado real

| Fuente | Implementación | Ruta | Programación |
| --- | --- | --- | --- |
| BOPZ, BOPH, BOPT | `aragon/scraper.js` | Sí | Solo si se incluyen en `COMPLEMENTARY_SCRAPE_PATHS` |
| BOTHA | `pais_vasco/botha/scraper.js` | Sí | Igual |
| BOG | `pais_vasco/bog/scraper.js` | Sí | Igual |
| BOB | Marcador de carpeta | No | No activar |
| Las Palmas | Marcador de carpeta | No | No activar |
| Santa Cruz de Tenerife | Marcador de carpeta | No | No activar |

`manifest.js` es un catálogo preparatorio y actualmente no dirige la tarea complementaria; puede no reflejar por sí solo qué endpoint está montado. Para operación prevalecen `src/routes.js`, las rutas implementadas y `COMPLEMENTARY_SCRAPE_PATHS`.

## Filtro

`shared/provincialFilter.js` clasifica el contexto. Los scrapers devuelven también los descartados anotados para que `raw_documents` conserve el rastro.

## Aragón

Un único scraper contiene tres adaptadores:

- BOPZ Zaragoza: prueba los dos dominios oficiales dentro de un presupuesto
  único de 14 segundos (deja margen para persistir antes del timeout HTTP).
  Los domingos devuelve `no_publication` sin consultar el portal, ya que el
  BOPZ publica de lunes a sábado. Una caída de ambos dominios de lunes a
  sábado continúa siendo un error de cobertura y nunca se disfraza de día vacío.
  Distingue falta real de publicación, timeout, caída,
  cambio de HTML y recuperación parcial; además expone
  `source_coverage_complete=false` cuando no puede garantizar cobertura. Los
  límites pueden ajustarse con `BOPZ_TOTAL_BUDGET_MS`,
  `BOPZ_INDEX_TOTAL_BUDGET_MS`, `BOPZ_HTML_TIMEOUT_MS` y
  `BOPZ_HTML_ATTEMPTS`, siempre por debajo de `PIPELINE_HTTP_TIMEOUT_MS`.
- BOPH Huesca: navegación del portal y PDFs.
- BOPT Teruel: portal específico y extracción de documentos.

Pruebas: `bopAragonScraper.test.js`, `bopzResilience.test.js` y `ruralRoutePrefilter.test.js`.
