// src/routes/userAuth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../authMiddleware');

module.exports = (app, supabase) => {
  /**
   * 1) REGISTRO NORMAL: POST /register
   *    email + phone + password => crea usuario nuevo con password hasheada
   */
  app.post('/register', async (req, res) => {
    try {
      const { email, phone, name, password } = req.body;

      if (!email || !phone || !password) {
        return res
          .status(400)
          .json({ error: 'Faltan email, teléfono o contraseña' });
      }

      // Comprobar si ya existe un usuario con ese email o teléfono
      const { data: existing, error: checkError } = await supabase
        .from('users')
        .select('id')
        .or(`email.eq.${email},phone.eq.${phone}`)
        .limit(1);

      if (checkError) {
        console.error('Error comprobando usuario existente:', checkError.message);
        return res.status(500).json({ error: 'Error interno' });
      }

      if (existing && existing.length > 0) {
        return res.status(400).json({ error: 'Ya existe un usuario con ese email o teléfono' });
      }

      // Hashear contraseña
      const password_hash = await bcrypt.hash(password, 10);

      const { data, error } = await supabase
        .from('users')
        .insert([
          {
            email,
            phone,
            name: name || null,
            password_hash,
            preferences: {},   // por defecto vacío
            subscription: null,
          },
        ])
        .select('id, email, phone')
        .single();

      if (error) {
        console.error('Error creando usuario:', error.message);
        return res.status(500).json({ error: 'Error creando usuario' });
      }

      // Crear token automáticamente al registrarse
      const token = jwt.sign(
        {
          sub: data.id,
          email: data.email,
          phone: data.phone,
          role: 'user',
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({ token });
    } catch (err) {
      console.error('Error en /register:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  /**
   * 2) LOGIN NORMAL: POST /login
   *    email + password => token
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

      if (!user || !user.password_hash) {
        // No existe o aún no tiene contraseña
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
   * 3) PRIMER ACCESO PARA LOS ANTIGUOS: POST /first-login
   *    Solo teléfono. Solo funciona si password_hash es NULL.
   *    Se usa para que puedan entrar y luego crear contraseña.
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
          .json({ error: 'Este usuario ya tiene contraseña, usa /login normal' });
      }

      // Crear un token temporal para que pueda crear contraseña
      const token = jwt.sign(
        {
          sub: user.id,
          email: user.email,
          phone: user.phone,
          role: 'user',
        },
        process.env.JWT_SECRET,
        { expiresIn: '30m' } // por ejemplo 30 minutos
      );

      res.json({ token });
    } catch (err) {
      console.error('Error en /first-login:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  /**
   * 4) CREAR / CAMBIAR CONTRASEÑA: POST /set-password
   *    Requiere estar autenticado (token).
   *    Sirve tanto para los antiguos (sin contraseña) como para cambiarla.
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
