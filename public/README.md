# Sitio público estático

Archivos servidos directamente por Express mediante `express.static("public")`.

## Contenido

- `index.html`: página pública.
- `assets/`, `images/`: recursos visuales y estilos compilados.
- `actualidades/`: páginas de contenido público.
- `robots.txt` y `sitemap.xml`: rastreo e indexación.

## Reglas

- No guardar datos privados, tokens ni configuración del backend.
- Los nombres y URLs son públicos y cacheables.
- Mantener enlaces absolutos/canónicos coherentes con el dominio.
- Actualizar `sitemap.xml` al añadir páginas indexables.
- Comprimir imágenes y comprobar accesibilidad.
- Evitar rutas que colisionen con endpoints de Express.

Los paneles React no se sirven desde esta carpeta; se despliegan como proyectos separados.
