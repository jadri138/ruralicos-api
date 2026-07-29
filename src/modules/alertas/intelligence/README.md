# Inteligencia y evidencia

Capa que convierte texto oficial en datos verificables. Su propósito no es escribir un resumen bonito, sino impedir que una afirmación sin respaldo llegue al usuario como un hecho.

## Archivos

| Archivo | Función |
| --- | --- |
| `factSheetSchema.js` | Contrato estructurado de la ficha |
| `factSheetBuilder.js` | Extrae hechos y fragmentos de respaldo |
| `factSheetValidator.js` | Comprueba formato, coherencia y evidencia |
| `factSheetStore.js` | Versiona y persiste fichas |
| `documentTrace.js` | Reconstruye documento, extracción y transformaciones |
| `documentRelation.js` | Relaciona correcciones, convocatorias, extractos y resoluciones |
| `criticalDoubleCheck.js` | Segunda comprobación para decisiones sensibles |
| `goldenDataset.js` | Casos estables para medir regresiones |

## Principios

- El documento oficial es la fuente de verdad.
- Cada dato importante debe apuntar a evidencia o marcarse como no verificado.
- Los resúmenes generados nunca prueban su propia taxonomía.
- Una etiqueta auxiliar sin evidencia se audita y se neutraliza; no rebaja por sí
  sola la veracidad de los hechos que sí están demostrados.
- No se inventan importes, plazos, beneficiarios ni ámbito.
- Una corrección posterior puede cambiar la interpretación del documento anterior.
- Fallar la validación retiene la alerta; no se rellena el hueco con una suposición.

`FACT_SHEET_BUILDER_VERSION` forma parte de la clave persistida. Hay que
incrementarla cuando cambian las reglas de extracción o validación: así una ficha
antigua no puede seguir decidiendo con criterios obsoletos.

## Ficha de hechos

La ficha separa:

- identificación y tipo;
- alcance territorial y sectorial;
- beneficiarios;
- acción requerida;
- fechas/plazos;
- importes u otras cifras;
- evidencia textual y documento de origen;
- incertidumbres y validación.

Documentación extensa: `docs/fact-sheet.md` y `docs/document-trace.md`.

## Pruebas

`factSheetBuilder`, `factSheetValidator`, `factSheetStore`, `documentTrace`, `documentRelation`, `criticalDoubleCheck`, `intelligenceGoldenDataset` y las pruebas de autoridad final.
