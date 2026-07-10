// src/routes/userAuth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../../middleware/requireAdmin');
const { bumpTokenVersion } = require('../../middleware/credentialVersion');
const { validarBody, escalarCorto } = require('../../middleware/validate');
const { normalizePhone, LONGITUD_TELEFONO } = require('../../shared/phoneNormalizer');
const { validarPassword } = require('../../shared/passwordPolicy');

// Validacion de borde (tipos y tamanos); la presencia/formato la decide el handler.
const bodyLogin = { phone: escalarCorto(32, 'telefono'), password: escalarCorto(200, 'contrasena') };
const bodyPhone = { phone: escalarCorto(32, 'telefono') };
const bodyPassword = { password: escalarCorto(200, 'contrasena') };

module.exports = (app, supabase) => {
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Prueba de nuevo en unos minutos.' },
  });

  /**
   * LOGIN POR TELÉFONO: POST /login-phone
   * body: { phone, password } => { token }
   */
  app.post('/login-phone', loginLimiter, validarBody(bodyLogin), async (req, res) => {
    try {
      let { phone, password } = req.body || {};
      if (!phone || !password) {
        return res.status(400).json({ error: 'Faltan teléfono o contraseña' });
      }

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length !== LONGITUD_TELEFONO) {
        return res.status(400).json({ error: 'Teléfono no válido' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone, password_hash, phone_verified, token_version')
        .eq('phone', normalizedPhone)
        .maybeSingle();

      if (error) {
        console.error('login-phone users select error:', error.message);
        return res.status(500).json({ error: 'Error interno' });
      }

      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
      }

      const ok = await bcrypt.compare(String(password), user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
      }

      if (user.phone_verified === false) {
        return res.status(403).json({
          error: 'Telefono pendiente de verificacion. Pide un codigo nuevo y confirma tu WhatsApp.',
          code: 'phone_unverified',
          phone: user.phone,
        });
      }

      const token = jwt.sign(
        { sub: user.id, phone: user.phone, role: 'user', tv: Number(user.token_version || 0) },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.json({ token });
    } catch (err) {
      console.error('Error en /login-phone:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  /**
   * LEGACY - PRIMER ACCESO: POST /first-login
   * body: { phone } => { token }
   * Solo si el usuario existe y NO tiene password_hash (null/empty).
   * Desactivado por defecto: usar recuperacion de contrasena.
   */
  app.post('/first-login', loginLimiter, validarBody(bodyPhone), async (req, res) => {
    try {
      const legacyFirstLoginEnabled = String(process.env.ENABLE_LEGACY_FIRST_LOGIN || 'false').toLowerCase() === 'true';
      if (!legacyFirstLoginEnabled) {
        return res.status(410).json({
          error: 'Primer acceso legacy desactivado. Usa recuperar contrasena.',
        });
      }

      let { phone } = req.body || {};
      if (!phone) return res.status(400).json({ error: 'Falta el teléfono' });

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length !== LONGITUD_TELEFONO) {
        return res.status(400).json({ error: 'Teléfono no válido' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone, password_hash')
        .eq('phone', normalizedPhone)
        .maybeSingle();

      if (error) return res.status(500).json({ error: 'Error interno' });
      if (!user) {
        return res.status(401).json({ error: 'No se pudo iniciar el primer acceso' });
      }

      // Si ya tiene contraseña, no es "primer acceso"
      if (user.password_hash) {
        return res.status(401).json({ error: 'No se pudo iniciar el primer acceso' });
      }

      const token = jwt.sign(
        { sub: user.id, phone: user.phone, firstLogin: true },
        process.env.JWT_SECRET,
        { expiresIn: '30m' }
      );

      return res.json({ token });
    } catch (err) {
      console.error('Error en /first-login:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  /**
   * CREAR / CAMBIAR CONTRASEÑA: POST /set-password
   * header: Authorization: Bearer <token>
   * body: { password } => { ok: true }
   */
  app.post('/set-password', requireAuth, validarBody(bodyPassword), async (req, res) => {
    try {
      const { password } = req.body || {};
      if (!password) return res.status(400).json({ error: 'Falta la nueva contraseña' });

      const pass = String(password).trim();
      const passwordValidation = validarPassword(pass);
      if (!passwordValidation.ok) {
        return res.status(400).json({
          error: passwordValidation.error,
          code: 'password_policy',
          requirements: passwordValidation.requirements,
        });
      }

      const userId = req.user.sub;
      const password_hash = await bcrypt.hash(pass, 10);

      const { error } = await supabase
        .from('users')
        .update({ password_hash })
        .eq('id', userId);

      if (error) {
        console.error('set-password update error:', error.message);
        return res.status(500).json({ error: 'Error guardando contraseña' });
      }

      // Revoca todas las sesiones anteriores (version de credencial) y emite
      // un token fresco para que ESTA sesion siga viva tras el cambio.
      const nuevaVersion = await bumpTokenVersion(supabase, 'user', userId);
      let token = null;
      if (req.user.role === 'user' && nuevaVersion !== null) {
        token = jwt.sign(
          { sub: userId, phone: req.user.phone, role: 'user', tv: nuevaVersion },
          process.env.JWT_SECRET,
          { expiresIn: '7d' }
        );
      }

      return res.json({ ok: true, ...(token ? { token } : {}) });
    } catch (err) {
      console.error('Error en /set-password:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });
};
