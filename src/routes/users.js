// src/routes/users.js
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { checkCronToken } = require('../utils/checkCronToken');
const { normalizePhone, isPhoneValid, LONGITUD_TELEFONO } = require('../utils/phoneNormalizer');
const { enviarWhatsAppVerificacion, enviarWhatsAppRegistro } = require('../whatsapp');
const { requireAuth, requireAdmin } = require('../../authMiddleware');
const { getPlan, validarPreferencias, truncarPreferencias } = require('../config/planes');
const { extraerPreferenciasBody, prepararPreferenciasExtra } = require('../utils/preferenciasRequest');
const { actualizarPerfilUsuarioMIASafe } = require('../brain/miaProfile');

module.exports = function usersRoutes(app, supabase) {
  const accountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Prueba de nuevo en unos minutos.' },
  });

  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados registros desde esta conexion. Prueba mas tarde.' },
  });

  function getPlanKey(subscription) {
    const key = String(subscription || 'corral').trim().toLowerCase();
    return ['corral', 'agricultor', 'cooperativa'].includes(key) ? key : 'corral';
  }

  function getMemoryCapabilities(subscription) {
    const plan = getPlanKey(subscription);

    return {
      plan,
      learning_active: plan === 'agricultor' || plan === 'cooperativa',
      detail_access: plan === 'cooperativa',
      manage_access: plan === 'cooperativa',
    };
  }

  function limpiarCampoNombre(value, max = 80) {
    const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
    return cleaned ? cleaned.slice(0, max) : null;
  }

  function construirNombreLegal({ firstName, lastName1, lastName2, fallbackName }) {
    const partes = [firstName, lastName1, lastName2]
      .map((value) => limpiarCampoNombre(value))
      .filter(Boolean);
    if (partes.length === 3) return partes.join(' ');
    return limpiarCampoNombre(fallbackName, 180);
  }

  function summarizeMemory(memories = []) {
    return memories.reduce((acc, memory) => {
      acc[memory.tipo] = (acc[memory.tipo] || 0) + 1;
      return acc;
    }, {});
  }

  function isMissingTableError(error) {
    return error && ['42P01', '42703', 'PGRST205'].includes(error.code);
  }

  async function resetMiaProfile(userId) {
    const { error } = await supabase
      .from('users')
      .update({
        perfil_embedding: null,
        perfil_version: 0,
        perfil_actualizado_at: null,
        contexto_narrativo: null,
      })
      .eq('id', userId);

    if (error) {
      console.warn(`[memoria] No se pudo reiniciar perfil MIA user ${userId}:`, error.message);
    }
  }

  async function deleteUserRows(table, userId) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('user_id', userId);

    if (error && !isMissingTableError(error)) throw error;
  }

  async function selectUserRows(table, columns, userId, options = {}) {
    let query = supabase
      .from(table)
      .select(columns)
      .eq('user_id', userId);

    if (options.order) {
      query = query.order(options.order, { ascending: false });
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;
    if (error && isMissingTableError(error)) return [];
    if (error) throw error;
    return data || [];
  }

  function requireAdminOrCron(req, res, next) {
    if ((process.env.REQUIRE_ADMIN_FOR_USER_ADMIN_ROUTES || 'true').toLowerCase() !== 'true') {
      return next();
    }
    if (req.query.token && process.env.CRON_TOKEN && req.query.token === process.env.CRON_TOKEN) {
      return next();
    }
    return requireAdmin(req, res, next);
  }

  function requireOwnerPhoneOrAdminOrCron(req, res, next) {
    if (req.query.token && process.env.CRON_TOKEN && req.query.token === process.env.CRON_TOKEN) {
      return next();
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      return requireAuth(req, res, () => {
        const phoneNormalizado = normalizePhone(req.body?.phone || req.query?.phone);
        if (req.user?.role === 'admin' || String(req.user?.phone || '') === phoneNormalizado) {
          return next();
        }
        return res.status(403).json({ error: 'No tienes permisos para este telefono' });
      });
    }

    return requireAdmin(req, res, next);
  }

  function generarCodigoVerificacion() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  function nuevaCaducidadVerificacion() {
    return new Date(Date.now() + 15 * 60 * 1000).toISOString();
  }

  function codigoVerificacionCaducado(fechaCaducidad) {
    if (!fechaCaducidad) return true;
    return new Date(fechaCaducidad) < new Date();
  }

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
      .select('id, phone, subscription, preferences, preferencias_extra')
      .order('id', { ascending: true });

    if (error) {
      console.error('Error listando usuarios:', error);
      return res.status(500).json({ error: 'Error obteniendo usuarios' });
    }

    res.json({ users: data });
  });

  // --------------------------------------------------
  // MI CUENTA — devuelve datos del usuario logueado
  // --------------------------------------------------
  app.get('/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const { data, error } = await supabase
        .from('users')
        .select('phone, name, first_name, last_name_1, last_name_2, legal_name, email, subscription, phone_verified')
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
  app.post('/register', registerLimiter, async (req, res) => {
    let {
      phone,
      name,
      first_name,
      firstName,
      last_name_1,
      lastName1,
      last_name_2,
      lastName2,
      email,
      password,
      subscription,
      preferences,
      preferencias_extra,
      preferenciasExtra
    } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    // Validar contraseña (mínimo 6 caracteres)
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Normalizar teléfono
    const telefonoNormalizado = normalizePhone(phone);
    if (!isPhoneValid(telefonoNormalizado)) {
      return res.status(400).json({ error: 'introduce un numero de teléfono válido' });
    }

    // Normalizar identidad legal y email. Se usa para detectar al usuario en listados oficiales.
    const firstNameClean = limpiarCampoNombre(first_name ?? firstName);
    const lastName1Clean = limpiarCampoNombre(last_name_1 ?? lastName1);
    const lastName2Clean = limpiarCampoNombre(last_name_2 ?? lastName2);
    const legalName = construirNombreLegal({
      firstName: firstNameClean,
      lastName1: lastName1Clean,
      lastName2: lastName2Clean,
      fallbackName: name,
    });

    if (!firstNameClean || !lastName1Clean || !lastName2Clean) {
      return res.status(400).json({ error: 'Indica nombre, primer apellido y segundo apellido' });
    }

    name = legalName;
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

    const PLANES_REGISTRO = ['corral', 'agricultor', 'cooperativa'];
    const subscriptionNormalizada = PLANES_REGISTRO.includes(String(subscription || '').toLowerCase())
      ? String(subscription).toLowerCase()
      : 'corral';

    // Campo libre opcional para contexto personal del usuario
    // Acepta snake_case, camelCase o dentro de preferences por compatibilidad.
    const rawPreferenciasExtra =
      typeof preferencias_extra === 'string' ? preferencias_extra
        : typeof preferenciasExtra === 'string' ? preferenciasExtra
          : typeof preferences.preferencias_extra === 'string' ? preferences.preferencias_extra
            : null;

    const preferenciasExtraLimpia = typeof rawPreferenciasExtra === 'string'
      ? rawPreferenciasExtra.trim().slice(0, 1000)
      : null;

    const validacionRegistro = validarPreferencias(subscriptionNormalizada, preferences);
    if (!validacionRegistro.ok) {
      const planRegistro = getPlan(subscriptionNormalizada);
      return res.status(400).json({
        error: 'Límites del plan superados',
        detalles: validacionRegistro.errores,
        plan: planRegistro.nombre,
        limites: planRegistro.limites,
      });
    }

    // Código 6 dígitos + caducidad 15 minutos
    const codigoVerificacion = generarCodigoVerificacion();
    const verificacionCaducaEn = nuevaCaducidadVerificacion();

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
            name: legalName || null,
            first_name: firstNameClean,
            last_name_1: lastName1Clean,
            last_name_2: lastName2Clean,
            legal_name: legalName,
            email,               // puede ser null o el email normalizado
            preferences,
            preferencias_extra: preferenciasExtraLimpia || null,
            subscription: subscriptionNormalizada,
            password_hash: passwordHash,
            phone_verified: false,
            phone_verification_code: codigoVerificacion,
            phone_verification_expires_at: verificacionCaducaEn
          }
        ])
        .select('id, phone, name, first_name, last_name_1, last_name_2, legal_name, email, subscription, preferences, preferencias_extra, phone_verified');

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

      // 8) Crear perfil MIA inicial sin bloquear el registro.
      actualizarPerfilUsuarioMIASafe(supabase, user.id).then((resultado) => {
        if (!resultado.ok) {
          console.warn('[mia:register] Perfil inicial pendiente:', resultado);
        }
      });

    } catch (err) {
      console.error('Error inesperado en /register:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // --------------------------------------------------
  // VERIFICAR TELÉFONO CON CÓDIGO
  // --------------------------------------------------
  app.post('/verify-phone', accountLimiter, async (req, res) => {
    let { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: 'Faltan teléfono o código' });
    }

    const telefonoNormalizado = normalizePhone(phone);
    if (!isPhoneValid(telefonoNormalizado)) {
      return res.status(400).json({ error: 'Número de teléfono no válido' });
    }

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
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      if (user.phone_verified) {
        return res.json({ success: true, message: 'Teléfono ya verificado' });
      }

      if (user.phone_verification_code !== String(code).trim()) {
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      if (user.phone_verification_expires_at) {
        const ahora = new Date();
        const caduca = new Date(user.phone_verification_expires_at);
        if (caduca < ahora) {
          return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
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
  app.post('/password-reset', accountLimiter, async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    // Normalizar teléfono (igual que /register)
    const telefonoNormalizado = normalizePhone(phone);
    if (!isPhoneValid(telefonoNormalizado)) {
      return res.status(400).json({ error: 'introduce un numero de teléfono válido' });
    }

    // Código 6 dígitos + caducidad 15 minutos (igual que /register)
    const codigoReset = generarCodigoVerificacion();
    const caducaEn = nuevaCaducidadVerificacion();

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
  app.post('/password-reset/verify', accountLimiter, async (req, res) => {
    let { phone, code, password } = req.body;

    if (!phone || !code || !password) {
      return res.status(400).json({ error: 'Faltan teléfono, código o contraseña' });
    }

    // Validar contraseña (mínimo 6)
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Normalizar teléfono
    const telefonoNormalizado = normalizePhone(phone);
    if (!isPhoneValid(telefonoNormalizado)) {
      return res.status(400).json({ error: 'Número de teléfono no válido' });
    }

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
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      // 2) Validar código
      if (String(user.phone_verification_code || '') !== String(code).trim()) {
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      // 3) Validar caducidad
      if (user.phone_verification_expires_at) {
        const ahora = new Date();
        const caduca = new Date(user.phone_verification_expires_at);
        if (caduca < ahora) {
          return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
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
  // CAMBIAR PLAN USANDO TELÉFONO (admin)
  // Body: { phone, plan } donde plan es uno de: corral, agricultor, cooperativa, free
  // --------------------------------------------------
  app.post('/users/cambiar-plan', requireAdminOrCron, async (req, res) => {
    let { phone, plan } = req.body;

    if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

    const PLANES_VALIDOS = ['free', 'corral', 'agricultor', 'cooperativa'];
    if (!plan || !PLANES_VALIDOS.includes(plan)) {
      return res.status(400).json({
        error: `Plan inválido. Opciones: ${PLANES_VALIDOS.join(', ')}`,
      });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('users')
      .update({ subscription: plan })
      .eq('phone', soloDigitos)
      .select('id, phone, subscription')
      .single();

    if (error || !data) {
      console.error('Error cambiando plan:', error);
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    console.log(`[admin] Plan de ${soloDigitos} cambiado a '${plan}'`);
    res.json({ success: true, user: data });
  });

  // Legacy — se mantienen por compatibilidad con integraciones existentes
  app.post('/users/upgrade-to-pro', requireAdminOrCron, async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });
    phone = String(phone).trim().replace(/\D/g, '');
    const { data, error } = await supabase
      .from('users').update({ subscription: 'cooperativa' }).eq('phone', phone).select('id, phone, subscription').single();
    if (error || !data) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ success: true, user: data });
  });

  app.post('/users/downgrade-to-free', requireAdminOrCron, async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });
    phone = String(phone).trim().replace(/\D/g, '');
    const { data, error } = await supabase
      .from('users').update({ subscription: 'corral' }).eq('phone', phone).select('id, phone, subscription').single();
    if (error || !data) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ success: true, user: data });
  });

  // ELIMINACION DE USUARIO
  app.delete('/users/:id', requireAdminOrCron, async (req, res) => {
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
  app.post('/users/get-preferences', requireOwnerPhoneOrAdminOrCron, async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('users')
        .select('phone, subscription, preferences, preferencias_extra')
      .eq('phone', soloDigitos)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ user: data });
  });

  // --------------------------------------------------
  // GUARDAR PREFERENCIAS USANDO TELÉFONO
  // Ruta legacy — la validación de límites por plan está en preferences.js
  // --------------------------------------------------
  app.put('/users/preferences', requireOwnerPhoneOrAdminOrCron, async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('subscription')
      .eq('phone', soloDigitos)
      .single();

    if (errUser || !user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const plan = getPlan(user.subscription);

    // Solo planes con digest pueden guardar preferencias personalizadas
    if (!plan.digest) {
      return res.status(403).json({
        error: `El plan ${plan.nombre} no permite preferencias personalizadas.`,
      });
    }

    const { preferences: prefs, rawExtra, extraEnviado } = extraerPreferenciasBody(req.body);

    const validacion = validarPreferencias(user.subscription, prefs);
    if (!validacion.ok) {
      return res.status(400).json({
        error: 'Limites del plan superados',
        detalles: validacion.errores,
        plan: plan.nombre,
        limites: plan.limites,
      });
    }

    const updateData = { preferences: prefs };

    if (extraEnviado) {
      const extra = prepararPreferenciasExtra(rawExtra);
      if (!extra.ok) return res.status(400).json({ error: extra.error });
      updateData.preferencias_extra = extra.valor;
    }

    const { error } = await supabase
      .from('users')
      .update(updateData)
      .eq('phone', soloDigitos);

    if (error) {
      console.error('Error guardando preferencias:', error);
      return res.status(500).json({ error: 'Error guardando preferencias' });
    }

    res.json({
      ok: true,
      preferences: prefs,
      preferencias_extra: updateData.preferencias_extra ?? null,
      plan: plan.nombre,
    });
  });

  // --------------------------------------------------
  // ACTUALIZAR MIS DATOS (Email y Teléfono)
  // PUT /me -> permite al usuario logueado editar su perfil
  // --------------------------------------------------
  app.put('/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      let {
        email,
        phone,
        first_name,
        firstName,
        last_name_1,
        lastName1,
        last_name_2,
        lastName2,
      } = req.body;

      // Objeto con los campos a actualizar
      const updates = {};
      let codigoVerificacion = null;
      let telefonoParaVerificar = null;

      const { data: userActual, error: userActualError } = await supabase
        .from('users')
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, phone_verified, phone_verification_expires_at')
        .eq('id', userId)
        .single();

      if (userActualError || !userActual) {
        console.error('Error leyendo usuario actual en PUT /me:', userActualError?.message);
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      
      if (email !== undefined) {
        const emailNormalizado = email === '' ? null : String(email).trim().toLowerCase();

        if (emailNormalizado) {
          const { data: emailExistente, error: emailError } = await supabase
            .from('users')
            .select('id')
            .eq('email', emailNormalizado)
            .neq('id', userId)
            .maybeSingle();

          if (emailError) {
            console.error('Error comprobando email en PUT /me:', emailError.message);
            return res.status(500).json({ error: 'Error comprobando email' });
          }

          if (emailExistente) {
            return res.status(400).json({ error: 'Este email ya esta registrado' });
          }
        }

        updates.email = emailNormalizado;
      }

      const hayIdentidadEnBody =
        first_name !== undefined ||
        firstName !== undefined ||
        last_name_1 !== undefined ||
        lastName1 !== undefined ||
        last_name_2 !== undefined ||
        lastName2 !== undefined;

      if (hayIdentidadEnBody) {
        const firstNameClean = limpiarCampoNombre(first_name ?? firstName ?? userActual.first_name);
        const lastName1Clean = limpiarCampoNombre(last_name_1 ?? lastName1 ?? userActual.last_name_1);
        const lastName2Clean = limpiarCampoNombre(last_name_2 ?? lastName2 ?? userActual.last_name_2);

        if (!firstNameClean || !lastName1Clean || !lastName2Clean) {
          return res.status(400).json({ error: 'Indica nombre, primer apellido y segundo apellido' });
        }

        const legalName = construirNombreLegal({
          firstName: firstNameClean,
          lastName1: lastName1Clean,
          lastName2: lastName2Clean,
          fallbackName: userActual.name,
        });

        updates.first_name = firstNameClean;
        updates.last_name_1 = lastName1Clean;
        updates.last_name_2 = lastName2Clean;
        updates.legal_name = legalName;
        updates.name = legalName;
      }
      
      if (phone !== undefined) {
        const telefonoNormalizado = normalizePhone(phone);
        if (!isPhoneValid(telefonoNormalizado)) {
          return res.status(400).json({ error: 'NÃºmero de telÃ©fono no vÃ¡lido' });
        }
        const telefonoCambia = telefonoNormalizado !== String(userActual.phone || '');

        if (telefonoCambia) {
          const { data: phoneExistente, error: phoneError } = await supabase
            .from('users')
            .select('id')
            .eq('phone', telefonoNormalizado)
            .neq('id', userId)
            .maybeSingle();

          if (phoneError) {
            console.error('Error comprobando telefono en PUT /me:', phoneError.message);
            return res.status(500).json({ error: 'Error comprobando telefono' });
          }

          if (phoneExistente) {
            return res.status(400).json({ error: 'Este numero ya esta registrado' });
          }
        }

        updates.phone = telefonoNormalizado;

        if (
          telefonoCambia ||
          (userActual.phone_verified === false && codigoVerificacionCaducado(userActual.phone_verification_expires_at))
        ) {
          codigoVerificacion = generarCodigoVerificacion();
          telefonoParaVerificar = telefonoNormalizado;
          updates.phone_verified = false;
          updates.phone_verification_code = codigoVerificacion;
          updates.phone_verification_expires_at = nuevaCaducidadVerificacion();
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.json({
          ok: true,
          user: userActual,
          phone_verification_required: false,
        });
      }

      const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', userId)
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, phone_verified')
        .single();

      if (error) {
        console.error('Error actualizando usuario:', error.message);
        return res.status(500).json({ error: 'Error al actualizar los datos' });
      }

      res.json({
        ok: true,
        user: data,
        phone_verification_required: Boolean(codigoVerificacion),
        verification_phone: telefonoParaVerificar,
      });

      if (codigoVerificacion && telefonoParaVerificar) {
        enviarWhatsAppVerificacion(telefonoParaVerificar, codigoVerificacion).catch((err) => {
          console.error('Error enviando WhatsApp de verificacion por cambio de telefono:', err.message);
        });
      }
    } catch (err) {
      console.error('Error en PUT /me:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  // --------------------------------------------------
  // VERIFICAR MI TELEFONO DESDE CUENTA
  // --------------------------------------------------
  app.post('/me/verify-phone', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const code = String(req.body?.code || '').trim();

      if (!code) {
        return res.status(400).json({ error: 'Falta el codigo' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, phone_verified, phone_verification_code, phone_verification_expires_at')
        .eq('id', userId)
        .single();

      if (error || !user) {
        console.error('Error buscando usuario en /me/verify-phone:', error?.message);
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      if (user.phone_verified) {
        return res.json({
          ok: true,
          message: 'Telefono ya verificado',
          user: {
            id: user.id,
            name: user.name,
            first_name: user.first_name,
            last_name_1: user.last_name_1,
            last_name_2: user.last_name_2,
            legal_name: user.legal_name,
            phone: user.phone,
            email: user.email,
            subscription: user.subscription,
            phone_verified: true,
          },
        });
      }

      if (String(user.phone_verification_code || '') !== code) {
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      if (codigoVerificacionCaducado(user.phone_verification_expires_at)) {
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      const { data, error: updateError } = await supabase
        .from('users')
        .update({
          phone_verified: true,
          phone_verification_code: null,
          phone_verification_expires_at: null,
        })
        .eq('id', userId)
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, phone_verified')
        .single();

      if (updateError) {
        console.error('Error verificando telefono en /me/verify-phone:', updateError.message);
        return res.status(500).json({ error: 'Error confirmando verificacion' });
      }

      return res.json({
        ok: true,
        message: 'Telefono verificado correctamente',
        user: data,
      });
    } catch (err) {
      console.error('Error en /me/verify-phone:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // --------------------------------------------------
  // CAMBIAR MI PLAN
  // PUT /me/plan -> permite al usuario logueado cambiar su plan
  // --------------------------------------------------
  app.put('/me/plan', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const plan = String(req.body?.plan || '').trim().toLowerCase();
      const PLANES_USUARIO = ['corral', 'agricultor', 'cooperativa'];

      if (!PLANES_USUARIO.includes(plan)) {
        return res.status(400).json({
          error: `Plan invalido. Opciones: ${PLANES_USUARIO.join(', ')}`,
        });
      }

      const { data: userActual, error: userError } = await supabase
        .from('users')
        .select('subscription, preferences')
        .eq('id', userId)
        .single();

      if (userError || !userActual) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const preferencesActuales =
        userActual.preferences && typeof userActual.preferences === 'object'
          ? userActual.preferences
          : {};
      const preferencesAjustadas = truncarPreferencias(plan, preferencesActuales);
      const seAjustaronPreferencias =
        JSON.stringify(preferencesAjustadas) !== JSON.stringify(preferencesActuales);

      const { data, error } = await supabase
        .from('users')
        .update({
          subscription: plan,
          preferences: preferencesAjustadas,
        })
        .eq('id', userId)
        .select('id, phone, email, subscription, preferences, preferencias_extra')
        .single();

      if (error) {
        console.error('Error cambiando plan de /me:', error.message);
        return res.status(500).json({ error: 'No se pudo cambiar el plan' });
      }

      const planConfig = getPlan(plan);

      return res.json({
        ok: true,
        user: data,
        preferences: data.preferences || {},
        preferencias_extra: data.preferencias_extra || null,
        preferences_ajustadas: seAjustaronPreferencias,
        plan: {
          nombre: planConfig.nombre,
          limites: planConfig.limites,
          campo_libre: planConfig.campo_libre,
          acceso_anticipado: planConfig.acceso_anticipado,
          fuentes_permitidas: planConfig.fuentes_permitidas,
        },
      });
    } catch (err) {
      console.error('Error en PUT /me/plan:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // --------------------------------------------------
  // EXPORTAR MIS DATOS
  // GET /me/export -> descarga estructurada de datos de cuenta
  // --------------------------------------------------
  app.get('/me/export', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const userColumns =
        'id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, preferences, preferencias_extra, created_at, perfil_version, perfil_actualizado_at, contexto_narrativo, ultima_interaccion_at';

      let { data: user, error: userError } = await supabase
        .from('users')
        .select(userColumns)
        .eq('id', userId)
        .single();

      if (userError && /perfil_|contexto_narrativo|ultima_interaccion_at/i.test(userError.message || '')) {
        const fallback = await supabase
          .from('users')
          .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, preferences, preferencias_extra, created_at')
          .eq('id', userId)
          .single();

        user = fallback.data;
        userError = fallback.error;
      }

      if (userError || !user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const [
        digests,
        memories,
        feedback,
        interestProfile,
        clicks,
        conversations,
        explorations,
        officialMatches,
      ] = await Promise.all([
        selectUserRows('digests', 'id, fecha, mensaje, alerta_ids, enviado, enviado_at, created_at', userId, { order: 'created_at', limit: 300 }),
        selectUserRows('user_memory', 'id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at', userId, { order: 'created_at', limit: 1000 }),
        selectUserRows('alerta_feedback', 'id, digest_id, alerta_id, item_numero, valor, raw_text, created_at, updated_at', userId, { order: 'created_at', limit: 1000 }),
        selectUserRows('user_interest_profile', 'id, tag, score, positivos, negativos, updated_at', userId, { order: 'updated_at', limit: 1000 }),
        selectUserRows('alerta_clicks', 'id, digest_id, alerta_id, url_destino, created_at', userId, { order: 'created_at', limit: 1000 }),
        selectUserRows('user_conversations', 'id, tipo, estado, digest_id, abierta_at, cerrada_at, expira_at', userId, { order: 'abierta_at', limit: 300 }),
        selectUserRows('exploration_log', 'id, digest_id, alerta_id, tipo_exploracion, motivo, resultado, procesado, created_at', userId, { order: 'created_at', limit: 300 }),
        selectUserRows('official_list_matches', 'id, alerta_id, fuente, contexto, listado_titulo, persona_detectada, linea, url_fuente, enviado, enviado_at, created_at', userId, { order: 'created_at', limit: 300 }),
      ]);

      return res.json({
        generated_at: new Date().toISOString(),
        user,
        digests,
        memory: memories,
        feedback,
        interest_profile: interestProfile,
        clicks,
        conversations,
        explorations,
        official_list_matches: officialMatches,
      });
    } catch (err) {
      console.error('Error en GET /me/export:', err);
      return res.status(500).json({ error: 'No se pudo exportar la cuenta' });
    }
  });

  // --------------------------------------------------
  // MI MEMORIA MIA
  // GET /me/memory -> resumen de memoria y detalle segun plan
  // --------------------------------------------------
  app.get('/me/memory', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, subscription, perfil_embedding, perfil_version, perfil_actualizado_at, contexto_narrativo, ultima_interaccion_at')
        .eq('id', userId)
        .single();

      if (userError || !user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const capabilities = getMemoryCapabilities(user.subscription);

      const { data: memories, error: memoriesError } = await supabase
        .from('user_memory')
        .select('id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(capabilities.detail_access ? 200 : 50);

      if (memoriesError && !isMissingTableError(memoriesError)) {
        console.error('Error en GET /me/memory:', memoriesError.message);
        return res.status(500).json({ error: 'Error consultando memoria' });
      }

      const memoryList = memories || [];

      return res.json({
        capabilities,
        profile: {
          has_profile: Boolean(user.perfil_embedding),
          version: user.perfil_version || 0,
          updated_at: user.perfil_actualizado_at || null,
          last_interaction_at: user.ultima_interaccion_at || null,
          narrative_context: capabilities.detail_access ? user.contexto_narrativo || null : null,
        },
        memory: {
          total: memoryList.length,
          by_type: summarizeMemory(memoryList),
          pending_profile: memoryList.filter((memory) => memory.incorporado_a_embedding === false).length,
          latest: capabilities.detail_access ? memoryList.slice(0, 50) : [],
        },
      });
    } catch (err) {
      console.error('Error en GET /me/memory:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // --------------------------------------------------
  // BORRAR UNA MEMORIA
  // DELETE /me/memory/:id -> solo Cooperativa
  // --------------------------------------------------
  app.delete('/me/memory/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const memoryId = Number(req.params.id);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: 'Memoria no valida' });
      }

      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, subscription')
        .eq('id', userId)
        .single();

      if (userError || !user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const capabilities = getMemoryCapabilities(user.subscription);
      if (!capabilities.manage_access) {
        return res.status(403).json({ error: 'Tu plan no permite gestionar memoria avanzada' });
      }

      const { data, error } = await supabase
        .from('user_memory')
        .delete()
        .eq('id', memoryId)
        .eq('user_id', userId)
        .select('id')
        .maybeSingle();

      if (error) {
        console.error('Error borrando memoria:', error.message);
        return res.status(500).json({ error: 'No se pudo borrar la memoria' });
      }

      if (!data) return res.status(404).json({ error: 'Memoria no encontrada' });

      await resetMiaProfile(userId);
      actualizarPerfilUsuarioMIASafe(supabase, userId).catch((err) => {
        console.warn('[memoria] Recalculo no bloqueante fallido:', err.message);
      });

      return res.json({ ok: true, deleted_id: memoryId });
    } catch (err) {
      console.error('Error en DELETE /me/memory/:id:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // --------------------------------------------------
  // BORRAR TODA LA MEMORIA
  // DELETE /me/memory -> solo Cooperativa
  // --------------------------------------------------
  app.delete('/me/memory', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, subscription')
        .eq('id', userId)
        .single();

      if (userError || !user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const capabilities = getMemoryCapabilities(user.subscription);
      if (!capabilities.manage_access) {
        return res.status(403).json({ error: 'Tu plan no permite reiniciar memoria avanzada' });
      }

      await deleteUserRows('user_memory', userId);
      await deleteUserRows('user_interest_profile', userId);
      await deleteUserRows('alerta_feedback', userId);
      await deleteUserRows('exploration_log', userId);
      await deleteUserRows('user_conversations', userId);
      await resetMiaProfile(userId);

      return res.json({ ok: true, message: 'Memoria reiniciada' });
    } catch (err) {
      console.error('Error en DELETE /me/memory:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // --------------------------------------------------
  // ELIMINAR MI CUENTA
  // DELETE /me -> permite al usuario logueado borrar su cuenta
  // --------------------------------------------------
  app.delete('/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const relatedTables = [
        'preferences',
        'alertas_vistas',
        'digests',
        'alerta_feedback',
        'user_interest_profile',
        'user_memory',
        'user_conversations',
        'alerta_click_links',
        'alerta_clicks',
        'exploration_log',
      ];

      for (const table of relatedTables) {
        const { error } = await supabase
          .from(table)
          .delete()
          .eq('user_id', userId);

        const missingTable =
          error && ['42P01', '42703', 'PGRST205'].includes(error.code);

        if (error && !missingTable) {
          console.warn(`delete /me: no se pudo limpiar ${table}:`, error.message);
        }
      }

      const { data, error } = await supabase
        .from('users')
        .delete()
        .eq('id', userId)
        .select('id')
        .maybeSingle();

      if (error) {
        console.error('Error eliminando /me:', error.message);
        return res.status(500).json({ error: 'No se pudo eliminar la cuenta' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      return res.json({ ok: true, message: 'Cuenta eliminada correctamente' });
    } catch (err) {
      console.error('Error en DELETE /me:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // --------------------------------------------------
  // MIS ALERTAS — historial real preparado para el usuario
  // --------------------------------------------------
  app.get('/me/alertas', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const limit = Math.min(Number(req.query.limit || 12) || 12, 50);

      const { data: digests, error: digestsError } = await supabase
        .from('digests')
        .select('id, fecha, mensaje, alerta_ids, enviado, enviado_at, created_at, error_msg')
        .eq('user_id', userId)
        .order('fecha', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit);

      if (digestsError) {
        console.error('Error en GET /me/alertas digests:', digestsError.message);
        return res.status(500).json({ error: 'Error consultando alertas' });
      }

      const alertaIds = [
        ...new Set(
          (digests || [])
            .flatMap((digest) => Array.isArray(digest.alerta_ids) ? digest.alerta_ids : [])
            .map((id) => Number(id))
            .filter(Boolean)
        ),
      ];

      let alertasPorId = {};

      if (alertaIds.length > 0) {
        const { data: alertas, error: alertasError } = await supabase
          .from('alertas')
          .select('id, titulo, resumen, resumen_final, url, fecha, region, fuente, provincias, sectores, subsectores, tipos_alerta, estado_ia, created_at')
          .in('id', alertaIds);

        if (alertasError) {
          console.error('Error en GET /me/alertas alertas:', alertasError.message);
          return res.status(500).json({ error: 'Error consultando alertas' });
        }

        alertasPorId = Object.fromEntries((alertas || []).map((alerta) => [Number(alerta.id), alerta]));
      }

      const digestsConAlertas = (digests || []).map((digest) => {
        const ids = Array.isArray(digest.alerta_ids)
          ? digest.alerta_ids.map((id) => Number(id)).filter(Boolean)
          : [];

        return {
          ...digest,
          alertas: ids.map((id) => alertasPorId[id]).filter(Boolean),
        };
      });

      const totalAlertas = digestsConAlertas.reduce(
        (total, digest) => total + digest.alertas.length,
        0
      );

      return res.json({
        digests: digestsConAlertas,
        resumen: {
          digests: digestsConAlertas.length,
          alertas: totalAlertas,
          ultimo_digest: digestsConAlertas[0] || null,
        },
      });
    } catch (err) {
      console.error('Error en GET /me/alertas:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });
};
