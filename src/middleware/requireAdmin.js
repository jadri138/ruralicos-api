// authMiddleWare.js
const jwt = require('jsonwebtoken');

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

// 🔓 Para cualquier usuario logeado
function requireAuth(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return;
  req.user = payload;
  next();
}

// 🔐 Solo admins
function requireAdmin(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return;

  if (payload.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes permisos' });
  }

  req.admin = payload;
  next();
}

// 🏢 Solo personal de cooperativa (panel partner).
// El token lleva organization_id; todo lo que cuelgue de aqui se filtra por esa org.
// Un admin de Ruralicos que impersona recibe tambien role 'org' (con impersonated_by).
function requireOrg(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return;

  if (payload.role !== 'org') {
    return res.status(403).json({ error: 'No tienes permisos' });
  }

  const organizationId = Number(payload.organization_id);
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
    return res.status(403).json({ error: 'Token sin organizacion valida' });
  }

  req.org = {
    staffId: payload.sub,
    organizationId,
    memberRole: payload.member_role || 'viewer',
    impersonatedBy: payload.impersonated_by || null,
  };
  next();
}

module.exports = { requireAuth, requireAdmin, requireOrg };
