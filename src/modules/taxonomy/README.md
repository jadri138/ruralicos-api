# Taxonomía HTTP

Expone la taxonomía rural común para autocompletado y normalización de texto.

## Endpoints

- `GET /taxonomy/suggest`: sugiere valores canónicos para una consulta.
- `POST /taxonomy/parse`: extrae sectores, subsectores o tipos desde texto.

Las fuentes reales de alias y normalización viven en `shared/taxonomyRegistry.js`, `shared/sectorTaxonomy.js`, `shared/preferenceCanonical.js` y `aprendizaje/taxonomiaRuralicos.js`.

## Reglas

- Devolver identificadores canónicos estables además de etiquetas humanas.
- Mantener compatibilidad con alias históricos.
- No inferir geografía desde la taxonomía sectorial.
- Un término ambiguo puede devolver baja confianza o varias opciones.
- Registro, preferencias, clasificación y selección deben interpretar el mismo valor de la misma forma.

Al añadir un término, comprobar parseo, sugerencias, preferencias existentes y matching. Pruebas: `taxonomiaRuralicos.test.js`, `taxonomyRegistry.test.js` y `preferenceCanonical.test.js`.
