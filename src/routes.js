// src/routes.js
//
// Registro central de todas las rutas de la API. Cada modulo expone una funcion
// `(app, supabase) => { ... }` que registra sus endpoints sobre la app Express.
// app.js solo construye la app y delega aqui el montaje de rutas.
//
// El ORDEN importa en un caso: clicksRoutes debe ir antes que usuarios para que
// la ruta raiz de tracking (`/?a=token`) no la capture otra ruta.

// ── Engagement / tracking (debe registrarse primero) ──
const clicksRoutes = require('./modules/feedback/clicks.routes');
const feedbackRoutes = require('./modules/feedback/feedback.routes');

// ── Usuarios y autenticacion ──
const usersRoutes = require('./modules/usuarios/usuarios.routes');
const authRoutes = require('./modules/usuarios/auth.routes');
const userAuthRoutes = require('./modules/usuarios/userAuth.routes');
const preferencesRoutes = require('./modules/usuarios/preferences.routes');

// ── Alertas ──
const alertasRoutes = require('./modules/alertas/alertas.routes');
const alertasFreeRoutes = require('./modules/alertas/alertasFree.routes');
const revisarAlertasRoutes = require('./modules/alertas/revisarAlertas.routes');
const deduplicarRoutes = require('./modules/alertas/deduplicar.routes');

// ── Digest ──
const digestRoutes = require('./modules/digest/digest.routes');

// ── Boletines oficiales (un scraper-route por fuente) ──
const boeRoutes = require('./modules/boletines/rutas/boe');
const boaRoutes = require('./modules/boletines/rutas/boa');
const bocylRoutes = require('./modules/boletines/rutas/bocyl');
const bojaRoutes = require('./modules/boletines/rutas/boja');
const doeRoutes = require('./modules/boletines/rutas/doe');
const docmRoutes = require('./modules/boletines/rutas/docm');
const bormRoutes = require('./modules/boletines/rutas/borm');
const dogcRoutes = require('./modules/boletines/rutas/dogc');
const dogvRoutes = require('./modules/boletines/rutas/dogv');
const dogRoutes = require('./modules/boletines/rutas/dog');
const bonRoutes = require('./modules/boletines/rutas/bon');
const borRoutes = require('./modules/boletines/rutas/bor');
const bopaRoutes = require('./modules/boletines/rutas/bopa');
const bocmRoutes = require('./modules/boletines/rutas/bocm');
const bocanRoutes = require('./modules/boletines/rutas/bocan');
const boibRoutes = require('./modules/boletines/rutas/boib');
const bocantRoutes = require('./modules/boletines/rutas/bocant');
const bopvRoutes = require('./modules/boletines/rutas/bopv');
const bomeRoutes = require('./modules/boletines/rutas/bome');
const bocceRoutes = require('./modules/boletines/rutas/bocce');
const bothaRoutes = require('./modules/boletines/rutas/provinciales/pais_vasco/botha');
const bogRoutes = require('./modules/boletines/rutas/provinciales/pais_vasco/bog');
const bopAragonRoutes = require('./modules/boletines/rutas/provinciales/aragon/bopAragon');
const fegaRoutes = require('./modules/boletines/rutas/estatales/fega');

// ── Operaciones, IA y administracion ──
const tareasRoutes = require('./modules/tareas/tareas.routes');
const taxonomyRoutes = require('./modules/taxonomy/taxonomy.routes');
const embeddingsRoutes = require('./modules/embeddings/embeddings.routes');
const cerebroRoutes = require('./modules/aprendizaje/cerebro.routes');
const adminRoutes = require('./modules/admin/admin.routes');

// IMPORTANTE: se conserva el orden de registro original del monolito index.js
// para no alterar la resolucion de rutas (algunas comparten prefijo y Express
// resuelve por orden de registro).
module.exports = function registrarRutas(app, supabase) {
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
};
