# Cómo contribuir a ruralicos-api

Guía breve para que el código se mantenga limpio y predecible. Para entender la
arquitectura primero, lee **[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)**.

## Antes de empezar

```bash
npm install
cp .env.example .env   # rellena las variables
npm run test:local     # debe estar en verde
npm run check:core     # invariantes de negocio, también en verde
```

## Dónde va cada cosa

- **¿Un endpoint nuevo?** En el `*.routes.js` del módulo de su dominio
  (`src/modules/<dominio>/`). Si su lógica es grande, ponla en un `*.service.js`
  y deja el handler delgado.
- **¿Una utilidad pura** (sin dominio: fechas, strings, parseo)? → `src/shared/`.
- **¿Un cliente de un servicio externo** (Supabase, WhatsApp, OpenAI, HTTP)? → `src/platform/`.
- **¿Lógica de negocio usada por varios módulos?** → `src/services/`.
- **¿Aprendizaje por reglas/score o conversación del agente?** Respeta la
  frontera `aprendizaje/` ↔ `mia/` (ver ARQUITECTURA.md). En la duda, pregunta
  antes de mezclarlos.
- Registra el módulo nuevo en `src/routes.js` (no en `app.js`).

## Convenciones

- **Idioma**: el dominio se nombra en **español** (alertas, boletines, digest…).
  Mantén la coherencia; no renombres en masa.
- **Patrón de ruta**: cada módulo exporta `(app, supabase) => { ... }`. La
  dependencia de Supabase se inyecta, no se importa dentro del handler salvo
  necesidad.
- **Rutas protegidas**: usa `requireAdmin` (panel) o `cronToken` (cron) desde
  `src/middleware/`.
- **CommonJS** (`require`/`module.exports`), Node `>=20.18.1`.
- **No cambies URLs** sin querer: usa `node scripts/inventario_rutas.js` para
  comparar el inventario de endpoints antes y después de un cambio estructural.

## Antes de abrir un PR

1. `npm run test:local` y `npm run check:core` en verde.
2. Si tocaste estructura, el inventario de rutas no debe cambiar de forma no
   intencionada.
3. Añade o ajusta tests si cambiaste comportamiento.
4. Mensaje de commit claro y enfocado.
