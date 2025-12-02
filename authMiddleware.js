// src/authMiddleware.js
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
    return payload; // ej: { sub, name, role }
  } catch (err) {
    console.error('Error verificando JWT:', err.message);
    res.status(401).json({ error: 'Token inválido o caducado' });
    return null;
  }
}

// 🔓 Para cualquier usuario logeado (role da igual)
function requireAuth(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return; // ya se ha respondido con error

  req.user = payload;
  next();
}

// 🔐 Solo admins (igual que antes)
function requireAdmin(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return;

  if (payload.role !== 'admin') {
    return res.status(403).json({ error: 'No tienes permisos' });
  }

  req.admin = payload;
  next();
}

module.exports = { requireAuth, requireAdmin };
