# Procesamiento común de rutas

Evita que cada fuente implemente su propia versión de seguridad, filtro e inserción.

## Archivos

| Archivo | Función |
| --- | --- |
| `registrarBoletinRuta.js` | Factoría de endpoint, fecha, ejecución y respuesta |
| `procesarBoletinPreclasificado.js` | Persiste captura bruta y respeta la decisión del scraper |
| `procesarConFiltroRural.js` | Aplica el filtro común cuando el scraper no preclasifica |
| `insertarAlertasBoletin.js` | Normaliza e inserta alertas evitando duplicados |

## Invariantes

- Se registra el documento antes o junto a su decisión.
- `review` se conserva; no equivale a descarte.
- El mismo documento oficial no crea alertas repetidas al reejecutar.
- Los contadores de respuesta coinciden con lo persistido.
- Fuente, región, URL y fecha no se pierden en la transformación.
- Los errores parciales se cuentan y explican.

Cambiar estas piezas afecta muchas fuentes. Ejecutar `registrarBoletinRuta`, `procesarBoletinPreclasificado`, `procesarConFiltroRural`, `insertarAlertasBoletin`, `rawDocuments` y `check:core`.
