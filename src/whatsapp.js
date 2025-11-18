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
    console.error('[WhatsApp] Error cargando destinatarios:', error.message);
    throw new Error('Error leyendo destinatarios de la BD');
  }

  const usuarios = (data || []).filter((u) => !!u.phone);

  if (!usuarios.length) {
    throw new Error('No hay usuarios con teléfono en la tabla users');
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

      res.on('data', (chunk) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        console.log(
          `[WhatsApp] Respuesta UltraMsg ${telefono} (status ${res.statusCode}):`,
          body
        );

        if (res.statusCode === 200) {
          resolve({ statusCode: res.statusCode, body });
        } else {
          reject(
            new Error(
              `UltraMsg devolvió ${res.statusCode}: ${body || 'sin cuerpo'}`
            )
          );
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
 * Envía el resumen de una alerta por WhatsApp a todos los usuarios de la tabla "users".
 */
async function enviarWhatsAppResumen(alerta, supabase) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error(
      'Faltan ULTRAMSG_INSTANCE_ID o ULTRAMSG_TOKEN en las variables de entorno'
    );
  }

  if (!alerta || !alerta.resumen) {
    console.warn(
      '[WhatsApp] Alerta sin resumen, no se envía nada. ID:',
      alerta && alerta.id
    );
    return;
  }

  const resumen = String(alerta.resumen || '').trim();

  console.log(
    `[WhatsApp] Preparando envío para alerta ${alerta.id}: "${alerta.titulo}"`
  );

  const destinatarios = await obtenerDestinatariosParaAlerta(supabase);

  console.log(
    `[WhatsApp] Enviando alerta ${alerta.id} a ${destinatarios.length} usuarios de la tabla users...`
  );

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

module.exports = {
  enviarWhatsAppResumen,
};
