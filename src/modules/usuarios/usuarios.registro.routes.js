// src/modules/usuarios/usuarios.registro.routes.js
//
// Alta publica de usuarios: registro, verificacion de telefono y reset de contrasena.
// Contexto compartido en usuarios.context.js.

const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { checkCronToken, hasCronToken } = require('../../middleware/cronToken');
const { normalizePhone, isPhoneValid, LONGITUD_TELEFONO } = require('../../shared/phoneNormalizer');
const { enviarWhatsAppVerificacion, enviarWhatsAppRegistro, enviarWhatsAppResetPassword } = require('../../platform/whatsapp');
const { requireAuth, requireAdmin } = require('../../middleware/requireAdmin');
const { getPlan, validarPreferencias, truncarPreferencias } = require('../../config/planes');
const { extraerPreferenciasBody, prepararPreferenciasExtra } = require('../../shared/preferenciasRequest');
const { normalizarPreferenciasUsuario } = require('../../shared/preferenceCanonical');
const { actualizarPerfilUsuarioMIASafe } = require('../aprendizaje/miaProfile');
const { notificarCambioPlan } = require('../../services/planChangeNotifier');
const { validarPassword } = require('../../shared/passwordPolicy');
const { maskPhone } = require('../../shared/pii');
const { validarBody, escalarCorto } = require('../../middleware/validate');
const { bumpTokenVersion } = require('../../middleware/credentialVersion');
const {
  storeVerificationCodeOrLegacy,
  verifyStoredCodeOrLegacy,
} = require('./verificationCodes');

// Validacion de borde (tipos y tamanos); presencia y formato siguen en cada
// handler para conservar sus mensajes. Los objetos son loose: el resto de
// campos (preferences, etc.) pasan tal cual.
const campoTelefono = escalarCorto(32, 'telefono');
const campoCodigo = escalarCorto(16, 'codigo');
const campoPassword = escalarCorto(200, 'contrasena');
const bodyRegistro = {
  phone: campoTelefono,
  password: campoPassword,
  name: escalarCorto(200, 'nombre'),
  first_name: escalarCorto(120, 'nombre'),
  firstName: escalarCorto(120, 'nombre'),
  last_name_1: escalarCorto(120, 'apellido'),
  lastName1: escalarCorto(120, 'apellido'),
  last_name_2: escalarCorto(120, 'apellido'),
  lastName2: escalarCorto(120, 'apellido'),
  email: escalarCorto(320, 'email'),
  subscription: escalarCorto(40, 'plan'),
  preferencias_extra: escalarCorto(4000, 'preferencias_extra'),
  preferenciasExtra: escalarCorto(4000, 'preferencias_extra'),
};

module.exports = (app, supabase, ctx) => {
  const {
    accountLimiter,
    registerLimiter,
    getPlanKey,
    getMemoryCapabilities,
    limpiarCampoNombre,
    construirNombreLegal,
    summarizeMemory,
    resetMiaProfile,
    deleteUserRows,
    deleteUserOwnedRows,
    deleteSupabaseAuthUserIfPossible,
    selectUserRows,
    requireAdminOrCron,
    requireOwnerPhoneOrAdminOrCron,
    cambiarPlanUsuarioPorTelefono,
    generarCodigoVerificacion,
    nuevaCaducidadVerificacion,
    codigoVerificacionCaducado,
  } = ctx;


  // --------------------------------------------------
  // REGISTRAR USUARIO (web + bot) + CÓDIGO VERIFICACIÓN + PASSWORD HASH
  // --------------------------------------------------
  app.post('/register', registerLimiter, validarBody(bodyRegistro), async (req, res) => {
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

    // Validar contraseña con política mínima de seguridad
    const passwordValidation = validarPassword(password);
    if (!passwordValidation.ok) {
      return res.status(400).json({
        error: passwordValidation.error,
        code: 'password_policy',
        requirements: passwordValidation.requirements,
      });
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

    if (!firstNameClean || !lastName1Clean) {
      return res.status(400).json({ error: 'Indica nombre y primer apellido' });
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
    const rawPreferencesBody = preferences;

    const PLANES_REGISTRO = ['corral', 'agricultor', 'cooperativa'];
    const subscriptionNormalizada = PLANES_REGISTRO.includes(String(subscription || '').toLowerCase())
      ? String(subscription).toLowerCase()
      : 'corral';
    const planRegistro = getPlan(subscriptionNormalizada);

    // Campo libre opcional para contexto personal del usuario
    // Acepta snake_case, camelCase o dentro de preferences por compatibilidad.
    const rawPreferenciasExtra =
      typeof preferencias_extra === 'string' ? preferencias_extra
        : typeof preferenciasExtra === 'string' ? preferenciasExtra
          : typeof rawPreferencesBody.preferencias_extra === 'string' ? rawPreferencesBody.preferencias_extra
            : null;

    const extraRegistro = prepararPreferenciasExtra(rawPreferenciasExtra);
    if (!extraRegistro.ok) return res.status(400).json({ error: extraRegistro.error });
    const preferenciasExtraLimpia = extraRegistro.valor;

    preferences = normalizarPreferenciasUsuario(rawPreferencesBody);

    const validacionRegistro = validarPreferencias(subscriptionNormalizada, preferences);
    if (!validacionRegistro.ok) {
      return res.status(400).json({
        error: 'Límites del plan superados',
        detalles: validacionRegistro.errores,
        plan: planRegistro.nombre,
        limites: planRegistro.limites,
      });
    }

    if (preferenciasExtraLimpia && !planRegistro.campo_libre) {
      return res.status(403).json({
        error: `El plan ${planRegistro.nombre} no permite preferencias extra.`,
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
            preferencias_extra: planRegistro.campo_libre ? preferenciasExtraLimpia || null : null,
            subscription: subscriptionNormalizada,
            password_hash: passwordHash,
            phone_verified: false,
            phone_verification_code: null,
            phone_verification_expires_at: null
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

      await storeVerificationCodeOrLegacy(supabase, {
        userId: user.id,
        phone: telefonoNormalizado,
        purpose: 'phone_verification',
        code: codigoVerificacion,
        expiresAt: verificacionCaducaEn,
        markPhoneUnverified: true,
      });

      // 5) Respuesta al cliente
      res.json({ success: true, user });

      // 6) Enviar WhatsApp con CÓDIGO (no bloquea la respuesta)
      enviarWhatsAppVerificacion(telefonoNormalizado, codigoVerificacion).catch((err) => {
        console.error('Error enviando WhatsApp de verificación:', err.message);
      });

      // 7) Log
      await supabase.from('logs').insert([
        { action: 'register', details: `phone_masked: ${maskPhone(telefonoNormalizado)}` }
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
  app.post('/verify-phone', accountLimiter, validarBody({ phone: campoTelefono, code: campoCodigo }), async (req, res) => {
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

      const verification = await verifyStoredCodeOrLegacy(supabase, {
        user,
        phone: telefonoNormalizado,
        purpose: 'phone_verification',
        code,
      });

      if (!verification.ok) {
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
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
  // REENVIAR CODIGO DE VERIFICACION DE TELEFONO
  // POST /verify-phone/request
  // --------------------------------------------------
  app.post('/verify-phone/request', accountLimiter, validarBody({ phone: campoTelefono }), async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el telefono' });
    }

    const telefonoNormalizado = normalizePhone(phone);
    if (!isPhoneValid(telefonoNormalizado)) {
      return res.status(400).json({ error: 'Numero de telefono no valido' });
    }

    try {
      const { data: user, error } = await supabase
        .from('users')
        .select('id, phone_verified')
        .eq('phone', telefonoNormalizado)
        .maybeSingle();

      if (error) {
        console.error('Error buscando usuario en /verify-phone/request:', error.message);
        return res.status(500).json({ error: 'Error interno' });
      }

      if (!user) {
        return res.json({ success: true });
      }

      if (user.phone_verified === true) {
        return res.json({
          success: true,
          already_verified: true,
          message: 'Telefono ya verificado',
        });
      }

      const codigoVerificacion = generarCodigoVerificacion();
      const verificacionCaducaEn = nuevaCaducidadVerificacion();

      await storeVerificationCodeOrLegacy(supabase, {
        userId: user.id,
        phone: telefonoNormalizado,
        purpose: 'phone_verification',
        code: codigoVerificacion,
        expiresAt: verificacionCaducaEn,
        markPhoneUnverified: true,
      });

      res.json({ success: true });

      enviarWhatsAppVerificacion(telefonoNormalizado, codigoVerificacion).catch((err) => {
        console.error('Error reenviando WhatsApp de verificacion:', err.message);
      });
    } catch (err) {
      console.error('Error inesperado en /verify-phone/request:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  });


  // --------------------------------------------------
  // RECUPERAR CONTRASENA: ENVIAR CODIGO POR WHATSAPP
  // POST /password-reset
  // --------------------------------------------------
  app.post('/password-reset', accountLimiter, validarBody({ phone: campoTelefono }), async (req, res) => {
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

      // 2) Guardar código temporal hasheado (fallback legacy si la migración aún no existe)
      await storeVerificationCodeOrLegacy(supabase, {
        userId: user.id,
        phone: telefonoNormalizado,
        purpose: 'password_reset',
        code: codigoReset,
        expiresAt: caducaEn,
      });

      // 3) Responder rápido al cliente
      res.json({ success: true });

      // 4) Enviar WhatsApp (reutilizamos tu función actual)
      enviarWhatsAppResetPassword(telefonoNormalizado, codigoReset).catch((err) => {
        console.error('Error enviando WhatsApp reset:', err.message);
      });

      // 5) Log opcional
      await supabase.from('logs').insert([
        { action: 'password_reset_request', details: `phone_masked: ${maskPhone(telefonoNormalizado)}` }
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
  app.post('/password-reset/verify', accountLimiter, validarBody({ phone: campoTelefono, code: campoCodigo, password: campoPassword }), async (req, res) => {
    let { phone, code, password } = req.body;

    if (!phone || !code || !password) {
      return res.status(400).json({ error: 'Faltan teléfono, código o contraseña' });
    }

    // Validar contraseña con política mínima de seguridad
    const passwordValidation = validarPassword(password);
    if (!passwordValidation.ok) {
      return res.status(400).json({
        error: passwordValidation.error,
        code: 'password_policy',
        requirements: passwordValidation.requirements,
      });
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
      const verification = await verifyStoredCodeOrLegacy(supabase, {
        user,
        phone: telefonoNormalizado,
        purpose: 'password_reset',
        code,
      });

      if (!verification.ok) {
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      // 4) Hash y update password (igual que /set-password)
      const passwordHash = await bcrypt.hash(String(password), 10);

      const { error: updateError } = await supabase
        .from('users')
        .update({
          password_hash: passwordHash,
          phone_verified: true,
          phone_verification_code: null,
          phone_verification_expires_at: null
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('Error actualizando password_hash en reset:', updateError);
        return res.status(500).json({ error: 'Error cambiando contraseña' });
      }

      // Revoca todas las sesiones anteriores: quien resetea la contrasena
      // (p.ej. por robo de movil) deja fuera cualquier token viejo.
      await bumpTokenVersion(supabase, 'user', user.id);

      // 5) Log opcional
      await supabase.from('logs').insert([
        { action: 'password_reset_done', details: `phone_masked: ${maskPhone(telefonoNormalizado)}` }
      ]);

      return res.json({ success: true });

    } catch (err) {
      console.error('Error inesperado en /password-reset/verify:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

};
