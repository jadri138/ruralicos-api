require('dotenv').config();
const express = require('express');
const { supabase } = require('./supabaseClient');

const usersRoutes = require('./routes/users');
const alertasRoutes = require('./routes/alertas');
const boeRoutes = require('./routes/boe');

const app = express();
app.use(express.json());

// ACTIVAMOS LAS RUTAS
usersRoutes(app, supabase);
alertasRoutes(app, supabase);
boeRoutes(app, supabase);

app.listen(3000, () => console.log("La API de Ruralicos esta lista!!"));
