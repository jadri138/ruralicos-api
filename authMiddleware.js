// authMiddleware.js
const jwt = require('jsonwebtoken');

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'No tienes permisos' });
    }

    req.admin = payload;
    next();
  } catch (err) {
    console.error('Error verificando JWT:', err.message);
    return res.status(401).json({ error: 'Token inválido o caducado' });
  }
}

module.exports = { requireAdmin };
