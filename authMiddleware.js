// authMiddleware.js
const jwt = require('jsonwebtoken');

// Función auxiliar para sacar el token del header
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
    return payload; // { id, email, role, ... }
  } catch (err) {
    console.error('Error verificando JWT:', err.message);
    res.status(401).json({ error: 'Token inválido o caducado' });
    return null;
  }
}

// CUALQUIER USUARIO LOGEADO
function requireAuth(req, res, next) {
  const payload = verifyToken(req, res);
  if (!payload) return; // ya ha respondido con error

  req.user = payload; // aquí colgamos los datos del usuario normal
  next();
}

// SOLO ADMIN
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
