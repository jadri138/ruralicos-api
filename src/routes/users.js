// src/routes/users.js

module.exports = function usersRoutes(app, supabase) {
  
  // Ruta de prueba
  app.get('/', (req, res) => {
    res.json({ message: 'La API de Ruralicos esta vivaa!! 🚜' });
  });

  // Registrar usuario
  app.post('/register', async (req, res) => {
    let { phone } = req.body;

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
        error: 'introduce un numero de teléfono válido'
      });
    }

    // Aquí ya usamos solo los dígitos normalizados para guardar
    const telefonoNormalizado = soloDigitos;

    // Insertar usuario
    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          phone: telefonoNormalizado,
          preferences: {},      // jsonb vacío
          subscription: 'free'  // plan por defecto
        }
      ])
      .select();

    if (error) {
      // Si es un duplicado (ya existe ese número)
      if (error.code === '23505') {
        return res.status(400).json({
          error: 'Este número ya está registrado'
        });
      }

      return res.status(500).json({ error: error.message });
    }

    // Devolver usuario registrado
    res.json({ success: true, user: data[0] });

    // Registrar acción en logs (esto no afecta a la respuesta)
    await supabase.from('logs').insert([
      { action: 'register', details: `phone: ${telefonoNormalizado}` }
    ]);
  });

  // ================================
  // OBTENER PREFERENCIAS (GET)
  // ================================
  app.get('/users/:id/preferences', async (req, res) => {
    const userId = req.params.id;

    const { data, error } = await supabase
      .from('users')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ preferences: data.preferences });
  });

  // ================================
  // GUARDAR PREFERENCIAS (SOLO PRO)
  // ================================
  app.put('/users/:id/preferences', async (req, res) => {
    const userId = req.params.id;

    // 1) Comprobar si el usuario es PRO
    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('subscription')
      .eq('id', userId)
      .single();

    if (errUser || !user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // ❌ Si es free → no puede editar preferencias
    if (user.subscription !== 'pro') {
      return res.status(403).json({
        error: 'Solo los usuarios PRO pueden guardar preferencias.'
      });
    }

    // 2) Si es PRO → guardamos lo que envía el front
    const newPreferences = req.body;

    const { data, error } = await supabase
      .from('users')
      .update({ preferences: newPreferences })
      .eq('id', userId)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Error guardando preferencias' });
    }

    res.json({ preferences: data.preferences });
  });

  // ================================
  // SUBIR A PRO
  // ================================
  app.post('/users/:id/upgrade-to-pro', async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('users')
      .update({ subscription: 'pro' })
      .eq('id', id)
      .single();

    if (error) {
      return res.status(500).json({ error: 'No se ha podido pasar a PRO' });
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
