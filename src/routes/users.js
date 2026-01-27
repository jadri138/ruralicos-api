const bcrypt = require('bcryptjs');
const { checkCronToken } = require('../utils/checkCronToken');
const { enviarWhatsAppVerificacion, enviarWhatsAppRegistro } = require('../whatsapp');

// ===== AÑADIDO (sin modificar lo anterior): auth middleware =====
const { requireAuth } = require('../../authMiddleware');

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
    if (!checkCronToken(req, res)) return;
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

  // ===== AÑADIDO (sin modificar lo anterior): MI CUENTA =====
  // GET /me -> devuelve phone/email/subscription reales usando JWT
  app.get('/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const { data, error } = await supabase
        .from('users')
        .select('phone, email, subscription')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('Error /me:', error);
        return res.status(500).json({ error: 'Error leyendo usuario' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      return res.json({ user: data });
    } catch (e) {
      console.error('Error interno /me:', e);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // --------------------------------------------------
  // REGISTRAR USUARIO (web + bot) + CÓDIGO VERIFICACIÓN + PASSWORD HASH
  // --------------------------------------------------
  app.post('/register', async (req, res) => {
    let { phone, name, email, password, preferences } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    // Validar contraseña (mínimo 6 caracteres)
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
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

    // Código 6 dígitos + caducidad 15 minutos
    const codigoVerificacion = Math.floor(100000 + Math.random() * 900000).toString();
    const verificacionCaducaEn = new Date(Date.now() + 15 * 60 * 1000).toISOString();

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

      // 🔐 3) Calcular hash de la contraseña
      const passwordHash = await bcrypt.hash(String(password), 10);

      // 4) Insertar usuario (con password_hash y verificación)
      const { data, error } = await supabase
        .from('users')
        .insert([
          {
            phone: telefonoNormalizado,
            name: name || null,
            email,               // puede ser null o el email normalizado
            preferences,
            subscription: 'pro',
            password_hash: passwordHash,
            phone_verified: false,
            phone_verification_code: codigoVerificacion,
            phone_verification_expires_at: verificacionCaducaEn
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

      const user = data[0];

      // 5) Respuesta al cliente
      res.json({ success: true, user });

      // 6) Enviar WhatsApp con CÓDIGO (no bloquea la respuesta)
      enviarWhatsAppVerificacion(telefonoNormalizado, codigoVerificacion).catch((err) => {
        console.error('Error enviando WhatsApp de verificación:', err.message);
      });

      // 7) Log
      await supabase.from('logs').insert([
        { action: 'register', details: `phone: ${telefonoNormalizado}` }
      ]);

    } catch (err) {
      console.error('Error inesperado en /register:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // --------------------------------------------------
  // VERIFICAR TELÉFONO CON CÓDIGO
  // --------------------------------------------------
  app.post('/verify-phone', async (req, res) => {
    let { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: 'Faltan teléfono o código' });
    }

    phone = String(phone).trim();
    let soloDigitos = phone.replace(/\D/g, '');
    if (soloDigitos.length === 9) {
      soloDigitos = '34' + soloDigitos;
    }

    const LONGITUD_TELEFONO = 11;
    if (soloDigitos.length !== LONGITUD_TELEFONO) {
      return res.status(400).json({ error: 'Número de teléfono no válido' });
    }

    const telefonoNormalizado = soloDigitos;

    try {
      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone_verified, phone_verification_code, phone_verification_expires_at')
        .eq('phone', telefonoNormalizado)
        .maybeSingle();

      if (error) {
        console.error('Error buscando usuario en verificación:', error);
        return res.status(500).json({ error: 'Error buscando usuario' });
      }

      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      if (user.phone_verified) {
        return res.json({ success: true, message: 'Teléfono ya verificado' });
      }

      if (user.phone_verification_code !== String(code).trim()) {
        return res.status(400).json({ error: 'Código incorrecto' });
      }

      if (user.phone_verification_expires_at) {
        const ahora = new Date();
        const caduca = new Date(user.phone_verification_expires_at);
        if (caduca < ahora) {
          return res.status(400).json({ error: 'Código caducado' });
        }
      }

      // Actualizar como verificado
      const { error: updateError } = await supabase
        .from('users')
        .update({
          phone_verified: true,
          phone_verification_code: null,
          phone_verification_expires_at: null,
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('Error actualizando usuario verificado:', updateError);
        return res.status(500).json({ error: 'Error confirmando verificación' });
      }

      // 🔔 AQUÍ mandamos el WhatsApp de bienvenida
      try {
        const mensajeBienvenida =
          '¡Bienvenido a Ruralicos! 🌾 Tu teléfono ha sido verificado correctamente. ' +
          'Desde hoy recibirás las alertas agrícolas y ganaderas adaptadas a tu perfil.';

        enviarWhatsAppRegistro(telefonoNormalizado, mensajeBienvenida).catch((err) => {
          console.error('Error enviando WhatsApp de bienvenida:', err.message);
        });
      } catch (err) {
        console.error('Error interno al enviar WhatsApp de bienvenida:', err);
      }

      // Respuesta al cliente
      res.json({ success: true, message: 'Teléfono verificado correctamente' });
    } catch (err) {
      console.error('Error inesperado en /verify-phone:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // --------------------------------------------------
  // RECUPERAR CONTRASEÑA: ENVIAR CÓDIGO POR WHATSAPP
  // POST /password-reset
  // --------------------------------------------------
  app.post('/password-reset', async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    // Normalizar teléfono (igual que /register)
    phone = String(phone).trim();
    let soloDigitos = phone.replace(/\D/g, '');
    if (soloDigitos.length === 9) soloDigitos = '34' + soloDigitos;

    const LONGITUD_TELEFONO = 11;
    if (soloDigitos.length !== LONGITUD_TELEFONO) {
      return res.status(400).json({ error: 'introduce un numero de teléfono válido' });
    }

    const telefonoNormalizado = soloDigitos;

    // Código 6 dígitos + caducidad 15 minutos (igual que /register)
    const codigoReset = Math.floor(100000 + Math.random() * 900000).toString();
    const caducaEn = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    try {
      // 1) Comprobar que existe el usuario
      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone')
        .eq('phone', telefonoNormalizado)
        .maybeSingle();

      if (error) {
        console.error('Error buscando usuario en password-reset:', error);
        return res.status(500).json({ error: 'Error interno' });
      }

      // Por seguridad, no decimos si existe o no. Respondemos success igual.
      // (pero internamente si no existe, no mandamos WhatsApp)
      if (!user) {
        return res.json({ success: true });
      }

      // 2) Guardar código y caducidad en el usuario (reutilizamos columnas existentes)
      const { error: updateError } = await supabase
        .from('users')
        .update({
          phone_verification_code: codigoReset,
          phone_verification_expires_at: caducaEn
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('Error guardando código reset:', updateError);
        return res.status(500).json({ error: 'Error guardando código' });
      }

      // 3) Responder rápido al cliente
      res.json({ success: true });

      // 4) Enviar WhatsApp (reutilizamos tu función actual)
      enviarWhatsAppVerificacion(telefonoNormalizado, codigoReset).catch((err) => {
        console.error('Error enviando WhatsApp reset:', err.message);
      });

      // 5) Log opcional
      await supabase.from('logs').insert([
        { action: 'password_reset_request', details: `phone: ${telefonoNormalizado}` }
      ]);

    } catch (err) {
      console.error('Error inesperado en /password-reset:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // --------------------------------------------------
  // RECUPERAR CONTRASEÑA: VERIFICAR CÓDIGO Y CAMBIAR PASSWORD
  // POST /password-reset/verify
  // --------------------------------------------------
  app.post('/password-reset/verify', async (req, res) => {
    let { phone, code, password } = req.body;

    if (!phone || !code || !password) {
      return res.status(400).json({ error: 'Faltan teléfono, código o contraseña' });
    }

    // Validar contraseña (mínimo 6)
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Normalizar teléfono
    phone = String(phone).trim();
    let soloDigitos = phone.replace(/\D/g, '');
    if (soloDigitos.length === 9) soloDigitos = '34' + soloDigitos;

    const LONGITUD_TELEFONO = 11;
    if (soloDigitos.length !== LONGITUD_TELEFONO) {
      return res.status(400).json({ error: 'Número de teléfono no válido' });
    }

    const telefonoNormalizado = soloDigitos;

    try {
      // 1) Buscar usuario con su código y caducidad
      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone_verification_code, phone_verification_expires_at')
        .eq('phone', telefonoNormalizado)
        .maybeSingle();

      if (error) {
        console.error('Error buscando usuario en password-reset/verify:', error);
        return res.status(500).json({ error: 'Error interno' });
      }

      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      // 2) Validar código
      if (String(user.phone_verification_code || '') !== String(code).trim()) {
        return res.status(400).json({ error: 'Código incorrecto' });
      }

      // 3) Validar caducidad
      if (user.phone_verification_expires_at) {
        const ahora = new Date();
        const caduca = new Date(user.phone_verification_expires_at);
        if (caduca < ahora) {
          return res.status(400).json({ error: 'Código caducado' });
        }
      }

      // 4) Hash y update password (igual que /set-password)
      const passwordHash = await bcrypt.hash(String(password), 10);

      const { error: updateError } = await supabase
        .from('users')
        .update({
          password_hash: passwordHash,
          phone_verification_code: null,
          phone_verification_expires_at: null
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('Error actualizando password_hash en reset:', updateError);
        return res.status(500).json({ error: 'Error cambiando contraseña' });
      }

      // 5) Log opcional
      await supabase.from('logs').insert([
        { action: 'password_reset_done', details: `phone: ${telefonoNormalizado}` }
      ]);

      return res.json({ success: true });

    } catch (err) {
      console.error('Error inesperado en /password-reset/verify:', err);
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

  // ELIMINACION DE USUARIO
  app.delete('/users/:id', async (req, res) => {
    const { id } = req.params;

    try {
      // 1. Eliminar de supabase.auth (requiere Service Role Key)
      const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(id);
      if (deleteAuthError) throw deleteAuthError;

      // 2. Eliminar de tabla 'users' y tablas relacionadas
      await supabase.from('preferences').delete().eq('user_id', id);
      await supabase.from('alertas_vistas').delete().eq('user_id', id);
      await supabase.from('users').delete().eq('id', id);

      res.status(200).json({ message: 'Cuenta eliminada correctamente' });
    } catch (err) {
      console.error('Error eliminando usuario:', err);
      res.status(500).json({ error: 'No se pudo eliminar la cuenta' });
    }
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
