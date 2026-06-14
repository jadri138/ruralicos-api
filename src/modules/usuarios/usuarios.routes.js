// src/modules/usuarios/usuarios.routes.js
//
// Punto de entrada de las rutas de usuarios. Crea el contexto compartido una vez
// y registra las sub-rutas por responsabilidad.

const { crearContextoUsuarios, USER_OWNED_TABLES, isSupabaseAuthUuid } = require('./usuarios.context');
const registrarGestion = require('./usuarios.gestion.routes');
const registrarRegistro = require('./usuarios.registro.routes');
const registrarCuenta = require('./usuarios.cuenta.routes');

module.exports = function usersRoutes(app, supabase) {
  const ctx = crearContextoUsuarios(supabase);
  registrarGestion(app, supabase, ctx);
  registrarRegistro(app, supabase, ctx);
  registrarCuenta(app, supabase, ctx);
};

module.exports.__testing = { USER_OWNED_TABLES, isSupabaseAuthUuid };
