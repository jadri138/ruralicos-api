# Scrapers

Un scraper conoce el portal oficial y devuelve documentos normalizados. No escribe directamente el digest, no elige usuarios y no debe depender de una respuesta concreta de IA.

## Fuentes

Cada boletín autonómico tiene su carpeta (`BOCAN`, `BOCANT`, `BOCCE`, `BOCM`, `BOCYL`, `BOIB`, `BOJA`, `BOME`, `BON`, `BOPA`, `BOPV`, `BOR`, `BORM`, `DOCM`, `DOE`, `DOG`, `DOGC`, `DOGV`). BOA conserva su extractor PDF en `boa/`. BOE se procesa desde su ruta específica.

Subcarpetas:

- [`provinciales/`](provinciales/): Aragón, País Vasco y preparación de Canarias.
- [`estatales/fega/`](estatales/fega/): listados FEGA y caché.
- [`shared/`](shared/): filtro rural y detección de páginas de error.

## Requisitos de calidad

- Timeout finito y número limitado de reintentos.
- User-Agent identificable y frecuencia razonable.
- URL oficial absoluta.
- Fecha ISO `YYYY-MM-DD`.
- Dedupe estable por ID/URL oficial.
- Distinción entre no publicación, portal caído y parseo roto.
- Recuperación parcial visible cuando falta contenido.
- Texto limitado y limpio.
- Fixtures y pruebas que no dependan de internet.

## Cuando cambia un portal

1. Guardar una muestra mínima del nuevo HTML/PDF como fixture si su licencia/privacidad lo permite.
2. Actualizar el parser, no ocultar el error con un array vacío.
3. Ejecutar la prueba focalizada.
4. Hacer un `dry-run`/fecha concreta.
5. Revisar `scraper_runs`, documentos, duplicados y calidad antes de devolverlo al pipeline.
