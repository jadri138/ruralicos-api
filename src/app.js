// src/app.js
//
// Construcción de la aplicación Express: middleware de seguridad (helmet, CORS,
// rate-limit), parseo de body, ficheros estáticos, endpoints públicos básicos
// (/health, /stats, /admin/send-broadcast) y montaje de todas las rutas de la API.
//
// Este módulo SOLO construye y exporta la app. El arranque del servidor
// (app.listen) vive en src/server.js para mantener separado el "qué es la app"
// del "cómo se ejecuta" (facilita tests e introspección — ver scripts/inventario_rutas.js).

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { supabase } = require('./platform/supabase');
const { enviarWhatsAppTodos } = require('./platform/whatsapp');
const { getFechaMadridISO } = require('./shared/fechaMadrid');
const { hasCronToken } = require('./middleware/cronToken');
const { requireAdmin } = require('./middleware/requireAdmin');


// Rutas
const usersRoutes = require('./modules/usuarios/usuarios.routes');
const alertasRoutes = require('./modules/alertas/alertas.routes');
const alertasFreeRoutes = require('./modules/alertas/alertasFree.routes');
const boeRoutes = require('./modules/boletines/rutas/boe');
const boaRoutes = require('./modules/boletines/rutas/boa');
const tareasRoutes = require('./routes/tareas');
const authRoutes = require('./modules/usuarios/auth.routes');
const adminRoutes = require('./routes/admin');
const preferencesRoutes = require('./modules/usuarios/preferences.routes');
const taxonomyRoutes = require('./routes/taxonomy');
const userAuthRoutes = require('./modules/usuarios/userAuth.routes');
const revisarAlertasRoutes = require("./modules/alertas/revisarAlertas.routes");
const bocylRoutes = require('./modules/boletines/rutas/bocyl');
const bojaRoutes = require('./modules/boletines/rutas/boja');
const doeRoutes = require('./modules/boletines/rutas/doe');
const docmRoutes = require('./modules/boletines/rutas/docm');
const bormRoutes = require('./modules/boletines/rutas/borm');
const digestRoutes = require('./routes/digest');
const deduplicarRoutes = require('./modules/alertas/deduplicar.routes');
const feedbackRoutes = require('./modules/feedback/feedback.routes');
const dogcRoutes       = require('./modules/boletines/rutas/dogc');
const dogvRoutes       = require('./modules/boletines/rutas/dogv');
const dogRoutes        = require('./modules/boletines/rutas/dog');
const bonRoutes        = require('./modules/boletines/rutas/bon');
const borRoutes        = require('./modules/boletines/rutas/bor');
const bopaRoutes       = require('./modules/boletines/rutas/bopa');
const bocmRoutes       = require('./modules/boletines/rutas/bocm');
const bocanRoutes      = require('./modules/boletines/rutas/bocan');
const boibRoutes       = require('./modules/boletines/rutas/boib');
const bocantRoutes     = require('./modules/boletines/rutas/bocant');
const bopvRoutes       = require('./modules/boletines/rutas/bopv');
const bomeRoutes       = require('./modules/boletines/rutas/bome');
const bocceRoutes      = require('./modules/boletines/rutas/bocce');
const embeddingsRoutes = require('./routes/embeddings');
const cerebroRoutes    = require('./modules/aprendizaje/cerebro.routes');
const clicksRoutes     = require('./modules/feedback/clicks.routes');
const bothaRoutes      = require('./modules/boletines/rutas/provinciales/pais_vasco/botha');
const bogRoutes        = require('./modules/boletines/rutas/provinciales/pais_vasco/bog');
const bopAragonRoutes  = require('./modules/boletines/rutas/provinciales/aragon/bopAragon');
const fegaRoutes       = require('./modules/boletines/rutas/estatales/fega');



const app = express();
app.set('trust proxy', 1);

/* ---------------------------------------------------
   PROTECCIONES DE SEGURIDAD
--------------------------------------------------- */

// Seguridad HTTP
app.use(helmet());

// CORS: solo permitir orígenes seguros
const allowedOrigins = [
  'https://ruralicos.es',
  'https://www.ruralicos.es',
  'https://app.ruralicos.es',
  'https://ruralicos-app.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'https://ruralicos-panel.onrender.com',
  ...String(process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
];

function isAllowedOrigin(origin) {
  if (allowedOrigins.includes(origin)) return true;
  return /^https:\/\/ruralicos-app(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(origin);
}

function timingSafeTokenEqual(expected, received) {
  const expectedText = String(expected || '').trim();
  const receivedText = String(received || '').trim();
  if (!expectedText || !receivedText) return false;

  const expectedBuffer = Buffer.from(expectedText);
  const receivedBuffer = Buffer.from(receivedText);
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function hasTrustedUltraMsgWebhookToken(req) {
  if (req.path !== '/webhooks/ultramsg/feedback') return false;

  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const received =
    req.query?.token ||
    req.headers['x-ruralicos-webhook-token'] ||
    req.headers['x-ultramsg-token'] ||
    bearerToken;

  return timingSafeTokenEqual(process.env.ULTRAMSG_WEBHOOK_TOKEN, received);
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Peticiones internas o herramientas tipo Postman (sin origin)
      if (!origin) return callback(null, true);

      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origen no permitido por CORS'), false);
    },
  })
);

app.get('/health', async (req, res) => {
  const checks = {
    api: true,
    fecha_madrid: getFechaMadridISO(),
    env: {
      SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      JWT_SECRET: Boolean(process.env.JWT_SECRET),
      CRON_TOKEN: Boolean(process.env.CRON_TOKEN),
      OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
      PUBLIC_BASE_URL: Boolean(process.env.PUBLIC_BASE_URL),
    },
    supabase: false,
  };

  try {
    const { error } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    checks.supabase = !error;
    if (error) checks.supabase_error = error.message;
  } catch (err) {
    checks.supabase_error = err.message;
  }

  const ok = checks.api && checks.supabase && Object.values(checks.env).every(Boolean);
  res.status(ok ? 200 : 503).json({ ok, checks });
});

// Limitador de peticiones por IP (anti ataques fuerza bruta)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,                //bajar para ser más estricto
  skip: (req) => {
    if (req.path === '/health') return true;
    if (hasTrustedUltraMsgWebhookToken(req)) return true;
    return hasCronToken(req);
  },
});

app.use(limiter);

// Leer JSON del body (solo una vez), despues de limitar peticiones.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Servir archivos estáticos de la carpeta "public"
app.use(express.static('public'));


/* ---------------------------------------------------
   STATS PÚBLICAS (sin auth, usadas por ruralicos.es)
--------------------------------------------------- */

app.get('/stats', async (req, res) => {
  try {
    const [{ count: totalUsers }, { count: totalAlertas }] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('alertas').select('id', { count: 'exact', head: true }),
    ]);
    // Redondeamos para no exponer cifras exactas
    const usuarios = Math.max(Math.floor((totalUsers || 0) / 10) * 10, 10);
    const alertas  = Math.max(Math.floor((totalAlertas || 0) / 100) * 100, 100);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ usuarios, alertas });
  } catch {
    res.json({ usuarios: 200, alertas: 7600 });
  }
});

/* ---------------------------------------------------
   MENSAJES GENERALES
--------------------------------------------------- */

app.post('/admin/send-broadcast', requireAdmin, async (req, res) => {
  try {
    const mensaje = String(req.body?.mensaje || '').trim();
    if (mensaje.length < 5) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }
    if (mensaje.length > 4000) {
      return res.status(400).json({ error: 'Mensaje demasiado largo' });
    }

    const resultado = await enviarWhatsAppTodos(supabase, mensaje);
    res.json({ ok: true, mensajeEnviado: mensaje, resultado });
  } catch (err) {
    console.error('Error en /admin/send-broadcast:', err);
    res.status(500).json({ error: 'Error enviando mensajes' });
  }
});


/* ---------------------------------------------------
   ACTIVAR RUTAS
--------------------------------------------------- */

clicksRoutes(app, supabase);
bothaRoutes(app, supabase);
bogRoutes(app, supabase);
bopAragonRoutes(app, supabase);
fegaRoutes(app, supabase);
usersRoutes(app, supabase);
alertasRoutes(app, supabase);
alertasFreeRoutes(app, supabase);
boeRoutes(app, supabase);
boaRoutes(app, supabase);
tareasRoutes(app, supabase);
authRoutes(app, supabase);
adminRoutes(app, supabase);
preferencesRoutes(app, supabase);
taxonomyRoutes(app);
userAuthRoutes(app, supabase);
revisarAlertasRoutes(app, supabase);
bocylRoutes(app, supabase);
bojaRoutes(app, supabase);
doeRoutes(app, supabase);
docmRoutes(app, supabase);
bormRoutes(app, supabase);
digestRoutes(app, supabase);
deduplicarRoutes(app, supabase);
feedbackRoutes(app, supabase);
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
embeddingsRoutes(app, supabase);
cerebroRoutes(app, supabase);


module.exports = app;
