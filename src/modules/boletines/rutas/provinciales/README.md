# Rutas provinciales

Endpoints de boletines provinciales. Tienen mayor riesgo de ruido individual, por lo que conservan la captura bruta y aplican prefiltro antes del motor de alertas.

## Activas en código

| Territorio | Fuentes | Endpoints |
| --- | --- | --- |
| Aragón | BOPZ, BOPH, BOPT | `/scrape-bopz-oficial`, `/scrape-boph-oficial`, `/scrape-bopt-oficial` |
| País Vasco | BOTHA, BOG | `/scrape-botha-oficial`, `/scrape-bog-oficial` |

Canarias y BOB mantienen carpetas de preparación, pero no tienen endpoints funcionales.

La tarea complementaria lee `COMPLEMENTARY_SCRAPE_PATHS`; su valor por defecto está vacío. Que exista la ruta no significa que se ejecute automáticamente. Configurar solo endpoints implementados y probados.

## Particularidad

Los anuncios municipales, licencias, sanciones o expedientes de una persona pueden contener vocabulario agrario sin tener interés general. El prefiltro provincial y el motor de selección aplican controles adicionales, pero todo descarte debe ser explicable.
