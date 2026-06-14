// src/server.js
//
// Entrypoint de ejecución: construye la app (src/app.js) y la pone a escuchar.
// Mantener el arranque separado de la construcción permite cargar la app en
// tests y herramientas (p. ej. scripts/inventario_rutas.js) sin abrir un puerto.

const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La API de Ruralicos está lista en el puerto ${PORT}!!`);
});
