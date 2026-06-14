# modules/admin

Endpoints del **panel de administración** (`/admin/*`, protegidos con
`requireAdmin`). El monolito original se dividió por área para que sea navegable.

## Estructura

- `admin.routes.js` — agregador: registra las 5 sub-rutas.
- `admin.panel.routes.js` — dashboard, logs de WhatsApp, digests, auditoría.
- `admin.usuarios.routes.js` — usuarios y organizaciones (cooperativas).
- `admin.alertas.routes.js` — alertas y cotejo con listas oficiales.
- `admin.operaciones.routes.js` — estado de boletines, scrapers, pipeline, salud.
- `admin.mia.routes.js` — consola y trazabilidad del agente MIA (`/admin/mia/*`).
- `admin.helpers.js` — requires, constantes y helpers compartidos por todas.
- `auditLog.js` — registro de auditoría.

Al añadir un endpoint, colócalo en la sub-ruta de su área y reutiliza los
helpers de `admin.helpers.js`.
