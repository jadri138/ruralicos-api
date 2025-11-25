require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { supabase } = require('./supabaseClient');
const enviarWhatsapp = require('./whatsapp');

// Rutas
const usersRoutes = require('./routes/users');
const alertasRoutes = require('./routes/alertas');
const alertasFreeRoutes = require('./routes/alertasFree');
const boeRoutes = require('./routes/boe');
const tareasRoutes = require('./routes/tareas');

const app = express();

// Para leer JSON del body
app.use(express.json());

// 👇 NUEVO: servir la carpeta "public" como web estática
app.use(express.static('public'));

// Activamos rutas de la API
usersRoutes(app, supabase);
alertasRoutes(app, supabase, enviarWhatsapp);
alertasFreeRoutes(app, supabase, enviarWhatsapp);
boeRoutes(app, supabase);
tareasRoutes(app, supabase);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La API de Ruralicos está lista en el puerto ${PORT}!!`);
});
