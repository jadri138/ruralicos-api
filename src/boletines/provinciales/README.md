# Boletines Provinciales

Aquí van los boletines oficiales provinciales o territoriales que complementan
al boletín autonómico.

Los autonómicos ya cubiertos no se duplican aquí. Ejemplos:

- `BOPV` sigue en `src/boletines/BOPV`.
- `BOCAN` sigue en `src/boletines/BOCAN`.
- `BOTHA`, `BOB`, `BOG`, `BOP_LAS_PALMAS` y similares van aquí.

Cada carpeta debe incluir un `scraper.js` con funciones puras de extracción.
La ruta Express vive en `src/routes/boletines/provinciales/...`.

