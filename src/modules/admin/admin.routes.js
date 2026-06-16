// src/modules/admin/admin.routes.js
//
// Punto de entrada de las rutas de administracion. Agrupa las sub-rutas por
// area para que el monolito original (2949 lineas) sea navegable. La logica
// auxiliar comun vive en admin.helpers.js.

const registrarAdminPanel = require('./admin.panel.routes');
const registrarAdminUsuarios = require('./admin.usuarios.routes');
const registrarAdminAlertas = require('./admin.alertas.routes');
const registrarAdminOperaciones = require('./admin.operaciones.routes');
const registrarAdminMia = require('./admin.mia.routes');
const registrarAdminCerebro = require('./admin.cerebro.routes');

module.exports = (app, supabase) => {
  registrarAdminPanel(app, supabase);
  registrarAdminUsuarios(app, supabase);
  registrarAdminAlertas(app, supabase);
  registrarAdminOperaciones(app, supabase);
  registrarAdminMia(app, supabase);
  registrarAdminCerebro(app, supabase);
};
