# Scrapers estatales complementarios

## FEGA

`fega/scraper.js` descarga y normaliza listados de beneficiarios. `fega/fegaCache.js` evita repetir trabajo cuando la fuente y el ejercicio no cambian.

Buenas prácticas:

- identificar ejercicio y versión de la fuente;
- separar caché de resultado definitivo;
- no asumir que compartir nombre significa ser la misma persona/entidad;
- conservar criterios de coincidencia;
- ejecutar cotejo sin envío durante validaciones;
- tratar cambios de formato como error visible.

La ruta y los interruptores de envío están documentados en `rutas/estatales/README.md`.
