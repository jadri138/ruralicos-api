// src/routes/users.js

module.exports = function usersRoutes(app, supabase) {
  
  // Ruta de prueba
  app.get('/', (req, res) => {
    res.json({ message: 'La API de Ruralicos esta vivaa!! 🚜' });
  });

  // --------------------------------------------------
  // LISTAR USUARIOS (solo para depurar)
  // --------------------------------------------------
  app.get('/users', async (req, res) => {
    const { data, error } = await supabase
      .from('users')
      .select('id, phone, subscription, preferences')
      .order('id', { ascending: true });

    if (error) {
      console.error('Error listando usuarios:', error);
      return res.status(500).json({ error: 'Error obteniendo usuarios' });
    }

    res.json({ users: data });
  });

// --------------------------------------------------
// REGISTRAR USUARIO (web + bot)
// --------------------------------------------------
app.post('/register', async (req, res) => {
  let { phone, name, email } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Falta el número de teléfono' });
  }

  // Normalizar teléfono: quitar espacios, guiones, paréntesis, +, etc.
  phone = String(phone).trim();
  const digits = phone.replace(/\D/g, '');

  // Comprobación sencilla: mínimo 9 dígitos
  if (digits.length < 9) {
    return res.status(400).json({
      error: 'Introduce un número de teléfono válido (incluye el prefijo del país si es posible)',
    });
  }

  const phoneNormalized = digits;

  // Normalizar nombre y email (si vienen)
  if (name) name = String(name).trim();
  if (email) email = String(email).trim().toLowerCase();

  try {
    // 1) Comprobar si ya existe ese teléfono
    const { data: existing, error: existingError } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phoneNormalized)
      .maybeSingle();

    if (existingError) {
      console.error('Error comprobando usuario existente:', existingError);
      return res.status(500).json({ error: 'Error comprobando usuario' });
    }

    if (existing) {
      return res.status(400).json({
        error: 'Este número ya está registrado',
      });
    }

    // 2) Insertar usuario nuevo
    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          phone: phoneNormalized,
          name: name || null,
          email: email || null,
          preferences: {},      // jsonb vacío
          subscription: 'free', // plan por defecto
          // created_at lo rellena Supabase solo
        },
      ])
      .select()
      .single();

    if (error) {
      console.error('Error registrando usuario:', error);
      return res.status(500).json({ error: error.message });
    }

    // 3) Respuesta al frontend/bot
    return res.json({
      success: true,
      user: {
        id: data.id,
        phone: data.phone,
        name: data.name,
        email: data.email,
      },
    });

  } catch (err) {
    console.error('Error inesperado en /register:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

  // --------------------------------------------------
  // SUBIR A PRO USANDO TELÉFONO
  // --------------------------------------------------
  app.post('/users/upgrade-to-pro', async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    console.log('Upgrade PRO para phone:', soloDigitos);

    const { data, error } = await supabase
      .from('users')
      .update({ subscription: 'pro' })
      .eq('phone', soloDigitos)
      .single();

    if (error || !data) {
      console.error('Error upgrade-to-pro:', error);
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ success: true, user: data });
  });

  // --------------------------------------------------
  // BAJAR A FREE USANDO TELÉFONO (NO BORRA PREFERENCIAS)
  // --------------------------------------------------
  app.post('/users/downgrade-to-free', async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    console.log('Downgrade FREE para phone:', soloDigitos);

    const { data, error } = await supabase
      .from('users')
      .update({ subscription: 'free' })
      .eq('phone', soloDigitos)
      .single();

    if (error || !data) {
      console.error('Error downgrade-to-free:', error);
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ success: true, user: data });
  });

  // --------------------------------------------------
  // OBTENER PREFERENCIAS USANDO TELÉFONO
  // --------------------------------------------------
  app.post('/users/get-preferences', async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('users')
      .select('phone, subscription, preferences')
      .eq('phone', soloDigitos)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ user: data });
  });

  // --------------------------------------------------
  // GUARDAR PREFERENCIAS USANDO TELÉFONO (SOLO PRO)
  // --------------------------------------------------
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
      console.error('Error guardando preferencias:', error);
      return res.status(500).json({ error: 'Error guardando preferencias' });
    }

    res.json({ preferences: data.preferences });
  });

};
