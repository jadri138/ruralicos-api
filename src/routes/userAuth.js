// src/routes/userAuth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../../authMiddleware');



module.exports = (app, supabase) => {
  /**
   * LOGIN NORMAL: POST /login
   * email + password => token
   */
  app.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Faltan email o contraseña' });
      }

      const { data, error } = await supabase
        .from('users')
        .select('id, email, password_hash')
        .eq('email', email)
        .limit(1);

      if (error) {
        console.error('Error consultando users:', error.message);
        return res.status(500).json({ error: 'Error interno' });
      }

      const user = data && data[0];

      // No existe o aún no tiene contraseña
      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
      }

      const token = jwt.sign(
        {
          sub: user.id,
          email: user.email,
          role: 'user',
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({ token });
    } catch (err) {
      console.error('Error en /login usuario:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  /**
   * PRIMER ACCESO PARA ANTIGUOS: POST /first-login
   * Solo teléfono. Solo si password_hash es NULL.
   */
  /**
 * LOGIN POR TELÉFONO: POST /login-phone
 * phone + password => token
 */

app.post('/login-phone', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'Faltan teléfono o contraseña' });
    }
    const normalizedPhone = String(phone).trim().replace(/\D/g, '');
    const { data, error } = await supabase
      .from('users')
      .select('id, phone, password_hash')
      .eq('phone', normalizedPhone)
      .limit(1);
    if (error) {
      return res.status(500).json({ error: 'Error interno' });
    }
    const user = data && data[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    const token = jwt.sign(
      { sub: user.id, phone: user.phone, role: 'user' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});


  /**
   * CREAR / CAMBIAR CONTRASEÑA: POST /set-password
   * Requiere estar autenticado (token de /first-login o /login).
   */
  app.post('/set-password', requireAuth, async (req, res) => {
    try {
      const { password } = req.body;

      if (!password) {
        return res.status(400).json({ error: 'Falta la nueva contraseña' });
      }

      const userId = req.user.sub;

      const password_hash = await bcrypt.hash(password, 10);

      const { error } = await supabase
        .from('users')
        .update({ password_hash })
        .eq('id', userId);

      if (error) {
        console.error('Error actualizando password_hash:', error.message);
        return res.status(500).json({ error: 'Error guardando contraseña' });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('Error en /set-password:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });
};
