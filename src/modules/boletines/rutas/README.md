# Rutas de boletines

Endpoints protegidos que ejecutan un scraper y pasan sus documentos por el procesador común.

## Convención

Las rutas siguen normalmente `/scrape-<fuente>-oficial` y aceptan `?fecha=YYYY-MM-DD` cuando la fuente permite histórico. Requieren `CRON_TOKEN`.

Muchas fuentes usan `shared/registrarBoletinRuta.js`, que unifica:

- autorización;
- normalización de fecha;
- ejecución del scraper;
- respuesta de “sin publicación”;
- inserción y contadores;
- manejo de error.

## Mapa

| Grupo | Endpoints |
| --- | --- |
| Estatal/autonómico | `/scrape-boe-oficial`, `/scrape-boa-oficial`, `/scrape-bocyl-oficial`, `/scrape-boja-oficial`, `/scrape-doe-oficial`, `/scrape-docm-oficial`, `/scrape-borm-oficial`, `/scrape-dogc-oficial`, `/scrape-dogv-oficial`, `/scrape-dog-oficial`, `/scrape-bon-oficial`, `/scrape-bor-oficial`, `/scrape-bopa-oficial`, `/scrape-bocm-oficial`, `/scrape-bocan-oficial`, `/scrape-boib-oficial`, `/scrape-bocant-oficial`, `/scrape-bopv-oficial`, `/scrape-bome-oficial`, `/scrape-bocce-oficial` |
| Aragón provincial | `/scrape-bopz-oficial`, `/scrape-boph-oficial`, `/scrape-bopt-oficial` |
| País Vasco provincial | `/scrape-botha-oficial` (y alias `/scrape-botha`), `/scrape-bog-oficial` |
| Complementaria | `/scrape-fega-beneficiarios` |

El inventario generado por `npm run rutas:inventario` es la referencia exacta si cambia un path.

## Respuesta común

Incluye `success`, fecha, documentos detectados/insertables, nuevas, duplicadas, errores, saltadas por filtro y mensaje. Algunas fuentes añaden diagnóstico, por ejemplo BOPZ distingue `success`, `no_publication`, `partial_recovery`, `timeout`, `portal_down` y `parse_error`.

## Reglas

- No crear rutas sin token.
- Un portal caído no debe responder como “sin publicación”.
- No devolver éxito si falló todo el parseo.
- Mantener compatibilidad solo cuando exista un consumidor real.
- Registrar una ruta nueva en `src/routes.js` y en la tarea diaria si debe ejecutarse automáticamente.
