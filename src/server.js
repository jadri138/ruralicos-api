// src/server.js
//
// Entrypoint de ejecución: construye la app (src/app.js) y la pone a escuchar.
// Mantener el arranque separado de la construcción permite cargar la app en
// tests y herramientas (p. ej. scripts/inventario_rutas.js) sin abrir un puerto.

require('dotenv').config();

const { asegurarEntorno } = require('./config/env');

// Fail-fast: en producción, variables críticas ausentes detienen el arranque
// con un mensaje claro en vez de fallar a las 6:00 con el pipeline a medias.
asegurarEntorno();

const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La API de Ruralicos está lista en el puerto ${PORT}!!`);
});
