// src/whatsapp.js
const qs = require('querystring');
const https = require('https');

// Credenciales UltraMsg desde .env
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;

/**
 * Carga los destinatarios desde la tabla "users".
 * Enviamos a todos los que tengan phone no vacío.
 */
async function obtenerDestinatariosParaAlerta(supabase) {
  const { data, error } = await supabase
    .from('users')
    .select('id, phone, subscription, preferences, created_at');

  if (error) {
    console.error('[WhatsApp] Error al obtener destinatarios:', error.message);
    throw new Error('Error consultando destinatarios en la BD');
  }

  if (!data || data.length === 0) {
    console.warn('[WhatsApp] No hay usuarios en la tabla "users"');
    return [];
  }

  const usuarios = data.filter((u) => u.phone && u.phone.trim() !== '');
  if (usuarios.length === 0) {
    console.warn(
      '[WhatsApp] No hay usuarios con teléfono válido en la tabla "users"'
    );
  }

  return usuarios;
}

/**
 * Llama a la API de UltraMsg para mandar un mensaje.
 * - resolve si statusCode === 200
 * - reject si statusCode !== 200 o hay error HTTP
 */
function enviarMensajeUltraMsg(telefono, cuerpo) {
  return new Promise((resolve, reject) => {
    const postData = qs.stringify({
      token: ULTRAMSG_TOKEN,
      to: telefono, // Ej: 346XXXXXXXX
      body: cuerpo,
    });

    const options = {
      method: 'POST',
      hostname: 'api.ultramsg.com',
      port: 443,
      path: `/${ULTRAMSG_INSTANCE_ID}/messages/chat`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        console.log(
          `[WhatsApp] UltraMsg respuesta (${telefono}, status ${res.statusCode}):`,
          body
        );

        if (res.statusCode === 200) {
          resolve({ status: res.statusCode, body });
        } else {
          reject(new Error(`UltraMsg devolvió ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error(
        `[WhatsApp] Error HTTP con UltraMsg (${telefono}):`,
        err
      );
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Envía el resumen PRO de una alerta a TODOS los usuarios (sistema de siempre).
 */
async function enviarWhatsAppResumen(alerta, supabase) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error(
      'Faltan ULTRAMSG_INSTANCE_ID o ULTRAMSG_TOKEN en las variables de entorno'
    );
  }

  if (!alerta || !alerta.resumen) {
    console.warn(
      '[WhatsApp] Se ha intentado enviar una alerta sin "resumen" definido'
    );
    return;
  }

  const resumen = String(alerta.resumen).trim();
  if (!resumen) {
    console.warn(
      `[WhatsApp] El resumen de la alerta ${alerta.id} está vacío. No se envía.`
    );
    return;
  }

  const destinatarios = await obtenerDestinatariosParaAlerta(supabase);
  if (!destinatarios.length) {
    console.warn(
      `[WhatsApp] No se enviará la alerta ${alerta.id} porque no hay destinatarios con teléfono`
    );
    return;
  }

  let enviados = 0;
  const errores = [];

  for (const user of destinatarios) {
    const telefono = String(user.phone || '').trim();
    if (!telefono) continue;

    console.log(
      `[WhatsApp] Enviando a ${telefono} (user id ${user.id || 'sin id'})`
    );

    try {
      await enviarMensajeUltraMsg(telefono, resumen);
      enviados++;
    } catch (err) {
      console.error(
        `[WhatsApp] Error enviando a ${telefono} (user ${user.id}):`,
        err.message
      );
      errores.push({ userId: user.id, telefono, error: err.message });
    }
  }

  if (enviados === 0) {
    throw new Error(
      `No se ha podido enviar la alerta ${alerta.id} a ningún destinatario`
    );
  }

  if (errores.length) {
    console.warn(
      `[WhatsApp] Fallos parciales al enviar alerta ${alerta.id}:`,
      errores
    );
  }
}

/**
 * Envía el mensaje FREE (ResumenFree) SOLO a usuarios con subscription = 'free'
 */
async function enviarWhatsAppFree(supabase, mensajeFree) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error(
      'Faltan ULTRAMSG_INSTANCE_ID o ULTRAMSG_TOKEN en las variables de entorno'
    );
  }

  if (!mensajeFree || !mensajeFree.trim()) {
    console.warn('[WhatsApp FREE] Mensaje FREE vacío, no se envía');
    return;
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, phone, subscription')
    .eq('subscription', 'free');

  if (error) {
    console.error('[WhatsApp FREE] Error BD usuarios FREE:', error.message);
    throw new Error('Error leyendo usuarios FREE');
  }

  const usuarios = (data || []).filter((u) => u.phone && u.phone.trim() !== '');
  if (!usuarios.length) {
    console.warn('[WhatsApp FREE] No hay usuarios FREE con teléfono');
    return;
  }

  console.log(
    `[WhatsApp FREE] Enviando resumen FREE a ${usuarios.length} usuarios`
  );

  const errores = [];
  let enviados = 0;

  for (const u of usuarios) {
    const telefono = String(u.phone || '').trim();
    if (!telefono) continue;

    try {
      await enviarMensajeUltraMsg(telefono, mensajeFree);
      enviados++;
    } catch (err) {
      console.error(
        `[WhatsApp FREE] Error enviando a ${telefono} (user ${u.id}):`,
        err.message
      );
      errores.push({ userId: u.id, telefono, error: err.message });
    }
  }

  console.log(
    `[WhatsApp FREE] Enviados ${enviados} mensajes FREE, errores:`,
    errores.length
  );
}

module.exports = {
  enviarWhatsAppResumen, // PRO
  enviarWhatsAppFree,    // FREE
};
