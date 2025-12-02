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
  app.post('/first-login', async (req, res) => {
    try {
      const { phone } = req.body;

      if (!phone) {
        return res.status(400).json({ error: 'Falta el teléfono' });
      }

      const { data, error } = await supabase
        .from('users')
        .select('id, email, phone, password_hash')
        .eq('phone', phone)
        .limit(1);

      if (error) {
        console.error('Error consultando users en first-login:', error.message);
        return res.status(500).json({ error: 'Error interno' });
      }

      const user = data && data[0];

      if (!user) {
        return res.status(404).json({ error: 'No hay ningún usuario con ese teléfono' });
      }

      if (user.password_hash) {
        return res
          .status(400)
          .json({ error: 'Este usuario ya tiene contraseña, usa el login normal' });
      }

      // Token temporal para que pueda crear contraseña
      const token = jwt.sign(
        {
          sub: user.id,
          email: user.email,
          phone: user.phone,
          role: 'user',
        },
        process.env.JWT_SECRET,
        { expiresIn: '30m' } // 30 minutos
      );

      res.json({ token });
    } catch (err) {
      console.error('Error en /first-login:', err);
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
