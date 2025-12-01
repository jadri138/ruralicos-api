const { checkCronToken } = require('./utils/checkCronToken');


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
    let { phone, name, email, preferences } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    // Normalizar teléfono
phone = String(phone).trim();
let soloDigitos = phone.replace(/\D/g, '');

// Si el usuario pone solo el número español (9 dígitos), añadimos 34 delante
if (soloDigitos.length === 9) {
  soloDigitos = '34' + soloDigitos;
}

const LONGITUD_TELEFONO = 11; // 34 + 9 dígitos
if (soloDigitos.length !== LONGITUD_TELEFONO) {
  return res.status(400).json({
    error: 'introduce un numero de teléfono válido'
  });
}

const telefonoNormalizado = soloDigitos;

    // Normalizar nombre y email
    if (name) name = String(name).trim();
    if (email) {
      email = String(email).trim().toLowerCase();
      if (email === '') email = null;
    } else {
      email = null;
    }

    // Asegurar que preferences es un objeto
    if (!preferences || typeof preferences !== 'object') {
      preferences = {};
    }

    try {
      // 1) Comprobar si ya existe ese teléfono
      const { data: existingPhone, error: phoneError } = await supabase
        .from('users')
        .select('id')
        .eq('phone', telefonoNormalizado)
        .maybeSingle();

      if (phoneError) {
        console.error('Error comprobando teléfono existente:', phoneError);
        return res.status(500).json({ error: 'Error comprobando teléfono' });
      }

      if (existingPhone) {
        return res.status(400).json({ error: 'Este número ya está registrado' });
      }

      // 2) Comprobar si ya existe ese email (si lo han puesto)
      if (email) {
        const { data: existingEmail, error: emailError } = await supabase
          .from('users')
          .select('id')
          .eq('email', email)
          .maybeSingle();

        if (emailError) {
          console.error('Error comprobando email existente:', emailError);
          return res.status(500).json({ error: 'Error comprobando email' });
        }

        if (existingEmail) {
          return res.status(400).json({ error: 'Este email ya está registrado' });
        }
      }

      // 3) Insertar usuario
      const { data, error } = await supabase
        .from('users')
        .insert([
          {
            phone: telefonoNormalizado,
            name: name || null,
            email,               // puede ser null o el email normalizado
            preferences,
            subscription: 'pro'
          }
        ])
        .select();

      if (error) {
        // Por si se escapara algún duplicado
        if (error.code === '23505') {
          return res.status(400).json({
            error: 'Ya existe un usuario con estos datos'
          });
        }

        console.error('Error registrando usuario:', error);
        return res.status(500).json({ error: 'Error registrando usuario' });
      }

      // 4) Devolver usuario registrado
      res.json({ success: true, user: data[0] });

      // 5) Registrar acción en logs (no afecta a la respuesta)
      await supabase.from('logs').insert([
        { action: 'register', details: `phone: ${telefonoNormalizado}` }
      ]);

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
