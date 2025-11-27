// routes/auth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = (app, supabase) => {
  // LOGIN ADMIN
  app.post('/admin/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Faltan credenciales' });
      }

      const { data: admins, error } = await supabase
        .from('admin_users')
        .select('id, username, password_hash')
        .eq('username', username)
        .limit(1);

      if (error) {
        console.error('Error consultando admin_users:', error.message);
        return res.status(500).json({ error: 'Error interno' });
      }

      const admin = admins && admins[0];

      if (!admin) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const ok = await bcrypt.compare(password, admin.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const token = jwt.sign(
        {
          sub: admin.id,
          username: admin.username,
          role: 'admin',
        },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
      );

      res.json({ token });
    } catch (err) {
      console.error('Error en /admin/login:', err);
      res.status(500).json({ error: 'Error interno en login' });
    }
  });
};
