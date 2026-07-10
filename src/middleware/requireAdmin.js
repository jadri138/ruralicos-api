// authMiddleWare.js
const jwt = require('jsonwebtoken');
const { verificarVersionCredencial } = require('./credentialVersion');

// Cliente supabase para la comprobacion de version de credencial. Require
// perezoso: los tests importan modulos de rutas sin SUPABASE_URL y el
// singleton lanza si faltan las variables; en ese caso la comprobacion de
// version queda desactivada (los handlers de test se invocan sin middleware).
let supabaseParaVersion;
function getSupabaseParaVersion() {
  if (supabaseParaVersion === undefined) {
    try {
      supabaseParaVersion = require('../platform/supabase').supabase;
    } catch {
      supabaseParaVersion = null;
    }
  }
  return supabaseParaVersion;
}

// Saca el token del header Authorization: Bearer xxx
function getTokenFromHeader(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

// Verifica el token y devuelve el payload o responde con error
function verifyToken(req, res) {
  const token = getTokenFromHeader(req);
  if (!token) {
    res.status(401).json({ error: 'Token requerido' });
    return null;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload; // { sub, email, role, ... }
  } catch (err) {
    console.error('Error verificando JWT:', err.message);
    res.status(401).json({ error: 'Token inválido o caducado' });
    return null;
  }
}

// Revocacion por version de credencial (tv en el JWT vs token_version en BD).
// Devuelve true si la sesion sigue viva; si no, responde 401 y devuelve false.
// Fail-open ante errores inesperados: un blip no desconecta a los usuarios.
async function versionCredencialViva(payload, res) {
  const supabase = getSupabaseParaVersion();
  if (!supabase) return true;

  try {
    const check = await verificarVersionCredencial(supabase, payload);
    if (!check.ok) {
      res.status(401).json({ error: 'Sesión caducada. Vuelve a iniciar sesión.', code: check.motivo });
      return false;
    }
  } catch (err) {
    console.warn('[auth] comprobacion de version de credencial fallida (se permite):', err.message);
  }
  return true;
}

// 🔓 Para cualquier usuario logeado
async function requireAuth(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return;
  if (!(await versionCredencialViva(payload, res))) return;
  req.user = payload;
  next();
}

// 🔐 Solo admins
async function requireAdmin(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return;

  if (payload.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes permisos' });
  }

  if (!(await versionCredencialViva(payload, res))) return;
  req.admin = payload;
  next();
}

// 🏢 Solo personal de cooperativa (panel partner).
// El token lleva organization_id; todo lo que cuelgue de aqui se filtra por esa org.
// Un admin de Ruralicos que impersona recibe tambien role 'org' (con impersonated_by).
async function requireOrg(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return;

  if (payload.role !== 'org') {
    return res.status(403).json({ error: 'No tienes permisos' });
  }

  const organizationId = Number(payload.organization_id);
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
    return res.status(403).json({ error: 'Token sin organizacion valida' });
  }

  if (!(await versionCredencialViva(payload, res))) return;

  req.org = {
    staffId: payload.sub,
    organizationId,
    memberRole: payload.member_role || 'viewer',
    impersonatedBy: payload.impersonated_by || null,
  };
  next();
}

module.exports = { requireAuth, requireAdmin, requireOrg };
