require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { supabase } = require('./supabaseClient');
const { enviarWhatsAppTodos } = require('./whatsapp');


// Rutas
const usersRoutes = require('./routes/users');
const alertasRoutes = require('./routes/alertas');
const alertasFreeRoutes = require('./routes/alertasFree');
const boeRoutes = require('./routes/boe');
const boaRoutes = require('./routes/boa');
const tareasRoutes = require('./routes/tareas');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const preferencesRoutes = require('./routes/preferences');
const userAuthRoutes = require('./routes/userAuth');
const revisarAlertasRoutes = require("./routes/revisarAlertas");
const bocylRoutes = require('./routes/bocyl');
const bojaRoutes = require('./routes/boja');
const doeRoutes = require('./routes/doe');
const docmRoutes = require('./routes/docm');
const bormRoutes = require('./routes/borm');
const digestRoutes = require('./routes/digest');
const deduplicarRoutes = require('./routes/deduplicar');
const dogcRoutes       = require('./routes/dogc');
const dogvRoutes       = require('./routes/dogv');
const dogRoutes        = require('./routes/dog');
const bonRoutes        = require('./routes/bon');
const borRoutes        = require('./routes/bor');
const bopaRoutes       = require('./routes/bopa');
const bocmRoutes       = require('./routes/bocm');
const bocanRoutes      = require('./routes/bocan');
const boibRoutes       = require('./routes/boib');
const bocantRoutes     = require('./routes/bocant');
const bopvRoutes       = require('./routes/bopv');
const bomeRoutes       = require('./routes/bome');
const bocceRoutes      = require('./routes/bocce');



const app = express();

/* ---------------------------------------------------
   PROTECCIONES DE SEGURIDAD
--------------------------------------------------- */

// Leer JSON del body (solo una vez)
app.use(express.json());

// Seguridad HTTP
app.use(helmet());

// CORS: solo permitir orígenes seguros
const allowedOrigins = [
  'https://ruralicos.es',
  'https://www.ruralicos.es',
  'http://localhost:3000',
  'http://localhost:5173',
  'https://ruralicos-panel.onrender.com',

];

app.use(
  cors({
    origin: (origin, callback) => {
      // Peticiones internas o herramientas tipo Postman (sin origin)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origen no permitido por CORS'), false);
    },
  })
);

// Limitador de peticiones por IP (anti ataques fuerza bruta)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,                //bajar para ser más estricto
});

app.use(limiter);

// Servir archivos estáticos de la carpeta "public"
app.use(express.static('public'));


/* ---------------------------------------------------
   MENSAJES GENERALES
--------------------------------------------------- */

app.post('/admin/send-broadcast', async (req, res) => {
  try {
    const mensaje =
      req.body?.mensaje ||
        'Ya esta operativo de nuevo el panel personal\n\nAccede aquí 👉 https://ruralicos.es/login \n\nSentimos las molestias. Podeis responder a este whatsapp si en algun momento teneis alguna duda o para dar vuestra opinión.\n\n Muchas Gracias!';

    await enviarWhatsAppTodos(supabase, mensaje);
    res.json({ ok: true, mensajeEnviado: mensaje });
  } catch (err) {
    console.error('Error en /admin/send-broadcast:', err);
    res.status(500).json({ error: 'Error enviando mensajes' });
  }
});


/* ---------------------------------------------------
   ACTIVAR RUTAS
--------------------------------------------------- */

usersRoutes(app, supabase);
alertasRoutes(app, supabase);
alertasFreeRoutes(app, supabase);
boeRoutes(app, supabase);
boaRoutes(app, supabase);
tareasRoutes(app, supabase);
authRoutes(app, supabase);
adminRoutes(app, supabase);
preferencesRoutes(app, supabase);
userAuthRoutes(app, supabase);
revisarAlertasRoutes(app, supabase);
bocylRoutes(app, supabase);
bojaRoutes(app, supabase);
doeRoutes(app, supabase);
docmRoutes(app, supabase);
bormRoutes(app, supabase);
digestRoutes(app, supabase);
deduplicarRoutes(app, supabase);
dogcRoutes(app, supabase);
dogvRoutes(app, supabase);
dogRoutes(app, supabase);
bonRoutes(app, supabase);
borRoutes(app, supabase);
bopaRoutes(app, supabase);
bocmRoutes(app, supabase);
bocanRoutes(app, supabase);
boibRoutes(app, supabase);
bocantRoutes(app, supabase);
bopvRoutes(app, supabase);
bomeRoutes(app, supabase);
bocceRoutes(app, supabase);



/* ---------------------------------------------------
   INICIAR SERVIDOR
--------------------------------------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La API de Ruralicos está lista en el puerto ${PORT}!!`);
});
