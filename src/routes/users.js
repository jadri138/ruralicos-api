// src/routes/users.js

module.exports = function usersRoutes(app, supabase) {
  
  // Ruta de prueba
  app.get('/', (req, res) => {
    res.json({ message: 'La API de Ruralicos esta vivaa!! 🚜' });
  });

    // Registrar usuario
  app.post('/register', async (req, res) => {
    let { phone, name, email } = req.body;   // 👈 añadimos name y email

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    // Normalizar: quitar espacios, guiones, +, etc.
    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    // 👉 Longitud exacta permitida (cámbiala si quieres otra)
    const LONGITUD_TELEFONO = 11; // ej: 34 + 9 dígitos

    if (soloDigitos.length !== LONGITUD_TELEFONO) {
      return res.status(400).json({
        error: `introduce un numero de teléfono válido`
      });
    }

    const telefonoNormalizado = soloDigitos;

    // Objeto a insertar
    const nuevoUsuario = {
      phone: telefonoNormalizado,
      preferences: {},
      subscription: 'free'
    };

    // Solo añadimos name/email si vienen
    if (name) nuevoUsuario.name = name;
    if (email) nuevoUsuario.email = email;

    const { data, error } = await supabase
      .from('users')
      .insert([nuevoUsuario])
      .select();

    if (error) {
      // Duplicado (teléfono o email)
      if (error.code === '23505') {
        return res.status(400).json({
          error: 'Este número o email ya está registrado'
        });
      }

      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, user: data[0] });

    await supabase.from('logs').insert([
      { action: 'register', details: `phone: ${telefonoNormalizado}` }
    ]);
  });

  // ================================
  // OBTENER PREFERENCIAS (GET)
  // ================================
  app.post('/users/get-preferences', async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('users')
      .select('preferences, subscription, name, email')
      .eq('phone', soloDigitos)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ user: data });
  });

  // ================================
  // GUARDAR PREFERENCIAS (SOLO PRO)
  // ================================
  app.put('/users/preferences', async (req, res) => {
    let { phone, ...prefs } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    // 1) Mirar usuario por teléfono
    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('subscription')
      .eq('phone', soloDigitos)
      .single();

    if (errUser || !user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (user.subscription !== 'pro') {
      return res.status(403).json({
        error: 'Solo los usuarios PRO pueden guardar preferencias.'
      });
    }

    // 2) Guardar preferencias
    const { data, error } = await supabase
      .from('users')
      .update({ preferences: prefs })
      .eq('phone', soloDigitos)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Error guardando preferencias' });
    }

    res.json({ preferences: data.preferences });
  });

  // ================================
  // SUBIR A PRO
  // ================================
  app.post('/users/upgrade-to-pro', async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('users')
      .update({ subscription: 'pro' })
      .eq('phone', soloDigitos)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ success: true, user: data });
  });


  // ================================
  // BAJAR A FREE (NO BORRA PREFERENCIAS)
  // ================================
  app.post('/users/:id/downgrade-to-free', async (req, res) => {
    const { id } = req.params;

    // NO tocamos preferences → se guardan para el futuro
    const { data, error } = await supabase
      .from('users')
      .update({ subscription: 'free' })
      .eq('id', id)
      .single();

    if (error) {
      return res.status(500).json({ error: 'No se ha podido pasar a FREE' });
    }

    res.json({ success: true, user: data });
  });

};
