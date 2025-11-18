// src/whatsapp.js
const qs = require('querystring');
const https = require('https');

// Credenciales UltraMsg desde .env
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;

/**
 * Carga los usuarios que deben recibir la alerta.
 * AHORA: todos los activos con teléfono.
 */
async function obtenerDestinatariosParaAlerta(alerta, supabase) {
  const { data, error } = await supabase
    .from('users')
    .select(
      'id, nombre, telefono, activo, edad, region, tipo_actividad, hectareas'
    )
    .eq('activo', true);

  if (error) {
    console.error('[WhatsApp] Error cargando destinatarios:', error.message);
    throw new Error('Error leyendo destinatarios de la BD');
  }

  return (data || []).filter((u) => !!u.telefono);
}

/**
 * Llama a la API de UltraMsg para mandar un mensaje.
 * DEVUELVE una promesa que:
 *  - se resuelve si statusCode === 200
 *  - se rechaza si statusCode !== 200 o hay error HTTP
 */
function enviarMensajeUltraMsg(telefono, cuerpo) {
  return new Promise((resolve, reject) => {
    const postData = qs.stringify({
      token: ULTRAMSG_TOKEN,
      to: telefono, // Ej: 34XXXXXXXXX (asegúrate de incluir el prefijo 34)
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
 * Envía el resumen de una alerta por WhatsApp a todos los usuarios activos.
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

  const destinatarios = await obtenerDestinatariosParaAlerta(alerta, supabase);

  if (!destinatarios.length) {
    console.log(
      `[WhatsApp] No hay destinatarios activos para la alerta ${alerta.id}.`
    );
    return;
  }

  console.log(
    `[WhatsApp] Enviando alerta ${alerta.id} a ${destinatarios.length} destinatarios...`
  );

  for (const user of destinatarios) {
    const telefono = String(user.telefono || '').trim();
    if (!telefono) continue;

    console.log(
      `[WhatsApp] Enviando a ${telefono} (usuario ${user.id || 'sin id'})`
    );

    // Si falla UltraMsg, esto lanza error y lo capturará /alertas/enviar-whatsapp
    await enviarMensajeUltraMsg(telefono, resumen);
  }
}

module.exports = {
  enviarWhatsAppResumen,
};
