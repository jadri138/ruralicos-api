require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { supabase } = require('./supabaseClient');
const enviarWhatsapp = require('./whatsapp');
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
alertasRoutes(app, supabase, enviarWhatsapp,);
alertasFreeRoutes(app, supabase, enviarWhatsapp,);
boeRoutes(app, supabase);
boaRoutes(app, supabase);
tareasRoutes(app, supabase);
authRoutes(app, supabase);
adminRoutes(app, supabase);
preferencesRoutes(app, supabase);
userAuthRoutes(app, supabase);


/* ---------------------------------------------------
   INICIAR SERVIDOR
--------------------------------------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La API de Ruralicos está lista en el puerto ${PORT}!!`);
});
