# Boletines

Este directorio contiene los extractores de diarios y boletines oficiales.

## Estructura

Los scrapers autonómicos existentes se mantienen en sus carpetas actuales para no
romper imports ya desplegados:

- `BOE`, `BOJA`, `BOCYL`, `DOGC`, etc.

Los boletines nuevos deben entrar con esta estructura:

```text
src/boletines/
  estatales/
    <codigo_fuente>/
      scraper.js
  provinciales/
    <comunidad>/
      <codigo_boletin>/
        scraper.js
        README.md
```

Las rutas nuevas deben seguir la misma jerarquía:

```text
src/routes/
  boletines/
    provinciales/
      <comunidad>/
        <codigo_boletin>.js
```

## Convenciones

- `codigo_boletin`: minúsculas y estable, por ejemplo `botha`, `bob`,
  `bog`, `bop_las_palmas`.
- `fuente`: mayúsculas y única en base de datos, por ejemplo `BOTHA`, `BOB`.
- Endpoint: `/scrape-<codigo>-oficial`, por ejemplo `/scrape-botha-oficial`.
- Cada scraper debe devolver documentos normalizados con:
  `titulo`, `url`, `fecha`, `texto`, y cuando exista `organismo`, `seccion`,
  `boletin`, `urlPdf`, `urlHtml`, `idOficial`.
- La ruta es responsable de deduplicar por `url` e insertar en `alertas`.
- El pipeline diario decide qué endpoints ejecuta desde `src/routes/tareas.js`.

## Prioridad Provincial

Primera tanda:

1. País Vasco: `BOTHA` (Álava), `BOB` (Bizkaia), `BOG` (Gipuzkoa).
2. Canarias: `BOP_LAS_PALMAS`, `BOP_SANTA_CRUZ_TENERIFE`.

Después:

- Comunitat Valenciana: Alicante, Castellón, Valencia.
- Galicia: A Coruña, Lugo, Ourense, Pontevedra.
- Andalucía: Almería, Cádiz, Córdoba, Granada, Huelva, Jaén, Málaga, Sevilla.
- Castilla y León: Ávila, Burgos, León, Palencia, Salamanca, Segovia, Soria,
  Valladolid, Zamora.
