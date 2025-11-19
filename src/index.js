// src/index.js
require('dotenv').config();

const express = require('express');
const { supabase } = require('./supabaseClient');

// Importamos las funciones de rutas
const usersRoutes = require('./routes/users');
const alertasRoutes = require('./routes/alertas');
const boeRoutes = require('./routes/boe');
const tareasRoutes = require('./routes/tareas');

const app = express();
app.use(express.json());

// Activamos las rutas pasando app y supabase
usersRoutes(app, supabase);
alertasRoutes(app, supabase);
boeRoutes(app, supabase);
tareasRoutes(app, supabase);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La API de Ruralicos está lista en el puerto ${PORT}!!`);
});
