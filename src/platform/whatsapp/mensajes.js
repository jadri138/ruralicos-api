// src/platform/whatsapp/mensajes.js
//
// Casos de uso de WhatsApp (verificacion, registro, digest, alertas, broadcast,
// reset de contrasena, mensajes admin). Usa la infraestructura de client.js.

const {
  getAdminAlertPhones,
  maskPhone,
  enviarMensajeUltraMsg,
  guardarLogWhatsApp,
  ULTRAMSG_INSTANCE_ID,
  ULTRAMSG_TOKEN,
} = require('./client');

async function enviarWhatsAppRegistro(telefono, mensajeTexto) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('Faltan credenciales UltraMsg');
  }

  if (!telefono || !telefono.trim()) {
    console.warn('[REGISTRO] Usuario sin teléfono, no se manda WhatsApp');
    return;
  }

  const mensaje =
    mensajeTexto ||
    '¡Bienvenido a Ruralicos! ✅ Tu registro se ha completado correctamente.';

  try {
    await enviarMensajeUltraMsg(telefono.trim(), mensaje);

    await guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'sent',
      message_type: 'registro',
      error_msg: null,
    });

    console.log('[REGISTRO] WhatsApp enviado a', maskPhone(telefono));
  } catch (err) {
    console.error('[REGISTRO] Error enviando WhatsApp:', err.message);

    await guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'failed',
      message_type: 'registro',
      error_msg: err.message,
    });
  }
}

/**
 * ENVÍA UN MENSAJE A TODOS LOS USUARIOS (PRO y FREE)
 */

async function enviarWhatsAppTodos(supabase, mensaje) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('Faltan credenciales UltraMsg');
  }
  if (!mensaje?.trim()) {
    console.warn('Mensaje vacío → no se envía');
    return { total: 0, enviados: 0, fallidos: 0, errores: [] };
  }

  const { data: users, error } = await supabase
    .from('users')
    .select('id, phone')
    .not('phone', 'is', null)
    .neq('phone', '')
    .or('phone_verified.is.null,phone_verified.eq.true');

  if (error) {
    console.error('Error consultando usuarios:', error.message);
    throw error;
  }

  if (!users || users.length === 0) {
    console.warn('No hay usuarios con teléfono → no se envía');
    return { total: 0, enviados: 0, fallidos: 0, errores: [] };
  }

  console.log(`Enviando mensaje a ${users.length} usuarios...`);
  const resultado = {
    total: users.length,
    enviados: 0,
    fallidos: 0,
    errores: [],
  };

  for (const user of users) {
    const telefono = user.phone.trim();
    try {
      await enviarMensajeUltraMsg(telefono, mensaje);
      resultado.enviados++;
    } catch (err) {
      resultado.fallidos++;
      resultado.errores.push({
        user_id: user.id,
        phone: telefono ? `****${telefono.slice(-4)}` : null,
        error: err.message,
      });
      console.error(`Error enviando a ${maskPhone(telefono)}:`, err.message);
    }
  }

  console.log(`Mensaje enviado a todos los usuarios. OK=${resultado.enviados} FAIL=${resultado.fallidos}`);
  return resultado;
}

async function enviarWhatsAppVerificacion(telefono, codigo) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('Faltan credenciales UltraMsg');
  }

  if (!telefono || !telefono.trim()) {
    console.warn('[VERIFICACION] Usuario sin teléfono, no se manda WhatsApp');
    return;
  }

  const mensaje =
    `Hola 👋, gracias por registrarte en Ruralicos.\n` +
    `Tu código de verificación es: *${codigo}*.\n` +
    `Úsalo en la web para confirmar tu número. ` +
    `Caduca en 15 minutos. 🌾`;

  try {
    await enviarMensajeUltraMsg(telefono.trim(), mensaje);

    await guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'sent',
      message_type: 'verificacion',
      error_msg: null,
    });

    console.log('[VERIFICACION] WhatsApp enviado a', maskPhone(telefono));
  } catch (err) {
    console.error('[VERIFICACION] Error enviando WhatsApp:', err.message);

    await guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'failed',
      message_type: 'verificacion',
      error_msg: err.message,
    });
  }
}


/**
 * ENVÍA EL DIGEST DIARIO PERSONALIZADO → USUARIOS CORRAL / AGRICULTOR / COOPERATIVA
 *
 * A diferencia del resumen gratuito, este mensaje ya llega personalizado:
 *   - Recibe directamente el teléfono y el mensaje ya preparado por digest.js
 *   - No hace queries a Supabase ni aplica filtros (ya los aplicó preparar-digest)
 *   - El delay entre mensajes lo gestiona enviar-digest, no esta función
 */

async function enviarDigestPro(telefono, mensaje, context = {}) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('Faltan ULTRAMSG_INSTANCE_ID o ULTRAMSG_TOKEN en .env');
  }

  if (!telefono || !telefono.trim()) {
    throw new Error('enviarDigestPro: teléfono vacío');
  }

  if (!mensaje || !mensaje.trim()) {
    throw new Error('enviarDigestPro: mensaje vacío');
  }

  let providerResult;
  try {
    providerResult = await enviarMensajeUltraMsg(telefono.trim(), mensaje.trim(), {
      idempotencyKey: context.idempotencyKey || context.idempotency_key || null,
    });
  } catch (error) {
    guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'failed',
      message_type: context.messageType || context.message_type || 'digest_pro',
      error_msg: error.message,
      outbox_id: context.outboxId || context.outbox_id || null,
      digest_id: context.digestId || context.digest_id || null,
      user_id: context.userId || context.user_id || null,
      idempotency_key: context.idempotencyKey || context.idempotency_key || null,
      message_version: context.messageVersion || context.message_version || null,
      failed_at: new Date().toISOString(),
      provider_error_code: error.providerCode || error.code || 'provider_error',
      provider_error_reason: String(error.message || 'fallo_ultramsg').slice(0, 1000),
    }).catch((logError) => console.error('[digest] Error guardando fallo:', logError.message));
    throw error;
  }

  // Se espera al log para reducir la ventana entre la respuesta del proveedor
  // y la correlación del ACK. Si falla, el outbox aún conserva la aceptación.
  const logResult = await guardarLogWhatsApp({
    phone:        telefono.trim(),
    status:       'provider_accepted',
    message_type: context.messageType || context.message_type || 'digest_pro',
    error_msg:    null,
    provider_message_id: providerResult.providerMessageId,
    provider_status: providerResult.providerStatus,
    delivery_status: 'PROVIDER_ACCEPTED',
    outbox_id: context.outboxId || context.outbox_id || null,
    digest_id: context.digestId || context.digest_id || null,
    user_id: context.userId || context.user_id || null,
    idempotency_key: providerResult.idempotencyKey || context.idempotencyKey || context.idempotency_key || null,
    message_version: context.messageVersion || context.message_version || null,
    accepted_at: new Date().toISOString(),
  });
  if (!logResult.ok) console.error('[digest] Error guardando aceptacion:', logResult.error);

  return providerResult;
}

async function enviarWhatsAppDirecto(telefono, mensaje, messageType = 'directo') {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('Faltan ULTRAMSG_INSTANCE_ID o ULTRAMSG_TOKEN en .env');
  }

  if (!telefono || !telefono.trim()) {
    throw new Error('enviarWhatsAppDirecto: telefono vacio');
  }

  if (!mensaje || !mensaje.trim()) {
    throw new Error('enviarWhatsAppDirecto: mensaje vacio');
  }

  try {
    const providerResult = await enviarMensajeUltraMsg(telefono.trim(), mensaje.trim());
    await guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'provider_accepted',
      message_type: messageType,
      error_msg: null,
      provider_message_id: providerResult.providerMessageId,
      provider_status: providerResult.providerStatus,
      delivery_status: 'PROVIDER_ACCEPTED',
      accepted_at: new Date().toISOString(),
    });
    return providerResult;
  } catch (err) {
    await guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'failed',
      message_type: messageType,
      error_msg: err.message,
      failed_at: new Date().toISOString(),
      provider_error_code: err.providerCode || err.code || 'provider_error',
      provider_error_reason: String(err.message || 'fallo_ultramsg').slice(0, 1000),
    });
    throw err;
  }
}

async function enviarWhatsAppResetPassword(telefono, codigo) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('Faltan credenciales UltraMsg');
  }

  if (!telefono || !telefono.trim()) {
    console.warn('[PASSWORD RESET] Usuario sin telefono, no se manda WhatsApp');
    return;
  }

  const mensaje =
    `Ruralicos - recuperacion de acceso\n\n` +
    `Tu codigo para cambiar la contrasena es: *${codigo}*.\n` +
    `Caduca en 15 minutos. Si no lo has pedido tu, puedes ignorar este mensaje.`;

  try {
    await enviarMensajeUltraMsg(telefono.trim(), mensaje);

    await guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'sent',
      message_type: 'password_reset',
      error_msg: null,
    });

    console.log('[PASSWORD RESET] WhatsApp enviado a', maskPhone(telefono));
  } catch (err) {
    console.error('[PASSWORD RESET] Error enviando WhatsApp:', err.message);

    await guardarLogWhatsApp({
      phone: telefono.trim(),
      status: 'failed',
      message_type: 'password_reset',
      error_msg: err.message,
    });

    throw err;
  }
}

async function enviarWhatsAppAdmin(mensaje) {
  if (!mensaje || !mensaje.trim()) {
    console.warn('[ADMIN ALERT] Mensaje vacio, no se manda aviso');
    return { skipped: true, reason: 'empty_message' };
  }

  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    console.warn('[ADMIN ALERT] Faltan credenciales UltraMsg, no se manda aviso');
    return { skipped: true, reason: 'missing_ultramsg_credentials' };
  }

  const telefonos = new Set(getAdminAlertPhones());

  if (telefonos.size === 0) {
    console.warn('[ADMIN ALERT] No hay telefonos admin configurados, no se manda aviso');
    return { skipped: true, reason: 'missing_admin_alert_phones' };
  }

  let enviados = 0;
  const errores = [];

  for (const telefono of telefonos) {
    try {
      await enviarMensajeUltraMsg(telefono, mensaje.trim());
      enviados++;

      await guardarLogWhatsApp({
        phone: telefono,
        status: 'sent',
        message_type: 'admin_alert',
        error_msg: null,
      });
    } catch (err) {
      console.error(`[ADMIN ALERT] Error enviando aviso a ${maskPhone(telefono)}:`, err.message);
      errores.push({ phone: maskPhone(telefono), error: err.message });

      await guardarLogWhatsApp({
        phone: telefono,
        status: 'failed',
        message_type: 'admin_alert',
        error_msg: err.message,
      });
    }
  }

  return { recipients: telefonos.size, sent: enviados, failed: errores.length, errors: errores };
}

module.exports = {
  enviarWhatsAppRegistro,
  enviarWhatsAppTodos,
  enviarWhatsAppVerificacion,
  enviarDigestPro,
  enviarWhatsAppDirecto,
  enviarWhatsAppResetPassword,
  enviarWhatsAppAdmin,
};
