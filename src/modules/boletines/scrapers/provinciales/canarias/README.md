# Provinciales de Canarias

Preparación para:

- BOP de Las Palmas.
- BOP de Santa Cruz de Tenerife.

Actualmente solo existen carpetas marcador. No hay scraper, ruta, tests ni ejecución programada. El boletín autonómico BOCAN sí está implementado, pero es una fuente diferente y vive en `scrapers/BOCAN`.

Para activar una fuente provincial canaria hacen falta:

1. parser con fecha, ID, URL, organismo y texto;
2. diagnóstico de no publicación/error;
3. prefiltro provincial;
4. persistencia en raw documents;
5. ruta con cron token;
6. registro en `src/routes.js`;
7. pruebas y fixtures;
8. alta explícita en `COMPLEMENTARY_SCRAPE_PATHS`.
