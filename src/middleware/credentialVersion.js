// src/middleware/credentialVersion.js
//
// Revocacion de sesiones por VERSION DE CREDENCIAL. Cada JWT lleva `tv`
// (token_version en el momento de firmarlo); en cada peticion autenticada se
// compara con la version actual en BD. Cambiar la contrasena (o un futuro
// "cerrar sesion en todos los dispositivos") incrementa la version y todos los
// tokens anteriores quedan invalidos al instante — sin cambiar el contrato de
// los frontends (no hay flujo de refresh que implementar).
//
// Compatibilidad: los tokens firmados ANTES de esta mejora no llevan `tv`; se
// tratan como version 0, que es el default de la columna, asi que el deploy no
// desconecta a nadie. La primera vez que un usuario cambie la contrasena, sus
// tokens viejos (sin tv o con tv anterior) caducan.
//
// Cache en memoria con TTL corto: la mayoria de peticiones no tocan BD para
// esta comprobacion; una revocacion tarda como maximo TTL_MS en propagarse
// (mismo proceso: inmediata, via invalidar()).

const TABLA_POR_ROLE = {
  user: 'users',
  org: 'organization_staff',
  admin: 'admin_users',
};

const TTL_MS = Number(process.env.CREDENTIAL_VERSION_CACHE_MS || 30000);

const cache = new Map(); // `${tabla}:${id}` -> { version, expiraEn }

function claveCache(tabla, id) {
  return `${tabla}:${id}`;
}

function invalidar(role, id) {
  const tabla = TABLA_POR_ROLE[role];
  if (tabla) cache.delete(claveCache(tabla, id));
}

// Lee la version vigente (con cache). Devuelve null si no se pudo leer.
async function versionVigente(supabase, tabla, id, ahora = () => Date.now()) {
  const clave = claveCache(tabla, id);
  const hit = cache.get(clave);
  if (hit && hit.expiraEn > ahora()) return hit.version;

  const { data, error } = await supabase
    .from(tabla)
    .select('token_version')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    // Fallo de BD: se permite pasar (fail-open) para que un blip transitorio
    // no desconecte a todo el mundo; queda avisado en el log.
    console.warn(`[credentialVersion] no se pudo leer ${tabla}.token_version:`, error.message);
    return null;
  }
  if (!data) return undefined; // fila inexistente: token de una cuenta borrada

  const version = Number(data.token_version || 0);
  cache.set(clave, { version, expiraEn: ahora() + TTL_MS });
  return version;
}

// Comprueba el payload de un JWT contra la version en BD.
// Devuelve { ok: true } o { ok: false, motivo }.
async function verificarVersionCredencial(supabase, payload, { ahora } = {}) {
  const tabla = TABLA_POR_ROLE[payload?.role];
  if (!tabla) return { ok: true }; // roles sin tabla (p.ej. firstLogin legacy)

  // Impersonacion de soporte: sub 'admin:X' sin fila de staff, token corto
  // (1h) emitido por un admin. No aplica version de staff.
  if (payload.role === 'org' && payload.impersonated_by) return { ok: true };

  const id = Number(payload.sub);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: true };

  const vigente = await versionVigente(supabase, tabla, id, ahora);
  if (vigente === null) return { ok: true }; // fail-open ante error de BD
  if (vigente === undefined) return { ok: false, motivo: 'cuenta_inexistente' };

  const tokenVersion = Number(payload.tv || 0);
  if (tokenVersion !== vigente) return { ok: false, motivo: 'sesion_revocada' };

  return { ok: true };
}

// Incrementa la version (revoca todas las sesiones) y devuelve la nueva.
// Best-effort: si falla, devuelve null y lo deja en el log (no rompe el flujo
// del cambio de contrasena, que es lo prioritario).
async function bumpTokenVersion(supabase, role, id) {
  const tabla = TABLA_POR_ROLE[role];
  if (!tabla) return null;

  const { data: fila, error: readError } = await supabase
    .from(tabla)
    .select('token_version')
    .eq('id', id)
    .maybeSingle();
  if (readError || !fila) {
    if (readError) console.warn(`[credentialVersion] bump: no se pudo leer ${tabla}:`, readError.message);
    return null;
  }

  const nueva = Number(fila.token_version || 0) + 1;
  const { error: updError } = await supabase
    .from(tabla)
    .update({ token_version: nueva })
    .eq('id', id);
  if (updError) {
    console.warn(`[credentialVersion] bump: no se pudo actualizar ${tabla}:`, updError.message);
    return null;
  }

  invalidar(role, id);
  return nueva;
}

module.exports = {
  TABLA_POR_ROLE,
  verificarVersionCredencial,
  bumpTokenVersion,
  invalidar,
  __cache: cache,
};
