// src/routes/userAuth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../../authMiddleware');

function normalizePhone(input) {
  let digits = String(input || '').trim().replace(/\D/g, '');
  if (digits.length === 9) digits = '34' + digits; // ES por defecto
  return digits;
}

module.exports = (app, supabase) => {
  /**
   * LOGIN POR TELÉFONO: POST /login-phone
   * body: { phone, password } => { token }
   */
  app.post('/login-phone', async (req, res) => {
    try {
      let { phone, password } = req.body || {};
      if (!phone || !password) {
        return res.status(400).json({ error: 'Faltan teléfono o contraseña' });
      }

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length !== 11) {
        return res.status(400).json({ error: 'Teléfono no válido' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone, password_hash')
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

      const token = jwt.sign(
        { sub: user.id, phone: user.phone, role: 'user' },
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
   * PRIMER ACCESO: POST /first-login
   * body: { phone } => { token }
   * Solo si el usuario existe y NO tiene password_hash (null/empty).
   */
  app.post('/first-login', async (req, res) => {
    try {
      let { phone } = req.body || {};
      if (!phone) return res.status(400).json({ error: 'Falta el teléfono' });

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length !== 11) {
        return res.status(400).json({ error: 'Teléfono no válido' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone, password_hash')
        .eq('phone', normalizedPhone)
        .maybeSingle();

      if (error) return res.status(500).json({ error: 'Error interno' });
      if (!user) {
        return res.status(404).json({ error: 'No existe ningún usuario con ese teléfono' });
      }

      // Si ya tiene contraseña, no es "primer acceso"
      if (user.password_hash) {
        return res.status(409).json({ error: 'Este usuario ya tiene contraseña. Inicia sesión.' });
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
  app.post('/set-password', requireAuth, async (req, res) => {
    try {
      const { password } = req.body || {};
      if (!password) return res.status(400).json({ error: 'Falta la nueva contraseña' });

      const pass = String(password).trim();
      if (pass.length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
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

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error en /set-password:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });
};
