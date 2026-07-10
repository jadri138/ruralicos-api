// src/server.js
//
// Entrypoint de ejecución: construye la app (src/app.js) y la pone a escuchar.
// Mantener el arranque separado de la construcción permite cargar la app en
// tests y herramientas (p. ej. scripts/inventario_rutas.js) sin abrir un puerto.

require('dotenv').config();

const { asegurarEntorno } = require('./config/env');
const { inicializarSentry, sentryActivo, capturarExcepcion, vaciarSentry } = require('./platform/sentry');

// Fail-fast: en producción, variables críticas ausentes detienen el arranque
// con un mensaje claro en vez de fallar a las 6:00 con el pipeline a medias.
asegurarEntorno();

// Captura de errores (opcional, solo con SENTRY_DSN). Se registran handlers de
// proceso SOLO si Sentry esta activo, preservando la semantica de crash por
// defecto de Node: se captura, se vacia el buffer y el proceso muere igual
// (Render lo reinicia); sin DSN no cambia nada.
if (inicializarSentry() && sentryActivo()) {
  process.on('uncaughtException', async (err) => {
    console.error('[fatal] uncaughtException:', err);
    capturarExcepcion(err, { origen: 'uncaughtException' });
    await vaciarSentry();
    process.exit(1);
  });
  process.on('unhandledRejection', async (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[fatal] unhandledRejection:', err);
    capturarExcepcion(err, { origen: 'unhandledRejection' });
    await vaciarSentry();
    process.exit(1);
  });
}

const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La API de Ruralicos está lista en el puerto ${PORT}!!`);
});
