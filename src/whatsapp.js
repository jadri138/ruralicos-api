// src/whatsapp.js
const qs = require('querystring');
const https = require('https');

// Credenciales UltraMsg desde .env
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;

/**
 * Qué usuarios reciben la alerta.
 * AHORA: todos los activos con teléfono.
 * FUTURO: aquí filtras por edad, hectáreas, tipo_actividad, región, etc.
 */
async function obtenerDestinatariosParaAlerta(alerta, supabase) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select(
        'id, nombre, telefono, activo, edad, region, tipo_actividad, hectareas'
      )
      .eq('activo', true);

    if (error) {
      console.error('[WhatsApp] Error cargando destinatarios:', error.message);
      return [];
    }

    return (data || []).filter((u) => !!u.telefono);
  } catch (err) {
    console.error(
      '[WhatsApp] Error inesperado en obtenerDestinatariosParaAlerta:',
      err
    );
    return [];
  }
}

/**
 * Llama a la API de UltraMsg para mandar un mensaje.
 */
function enviarMensajeUltraMsg(telefono, cuerpo) {
  return new Promise((resolve) => {
    const postData = qs.stringify({
      token: ULTRAMSG_TOKEN,
      to: telefono, // Ej: 34XXXXXXXXX
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

    const req = https.request(options, function (res) {
      const chunks = [];

      res.on('data', function (chunk) {
        chunks.push(chunk);
      });

      res.on('end', function () {
        const body = Buffer.concat(chunks).toString();
        console.log(
          `[WhatsApp] Respuesta UltraMsg ${telefono} (status ${res.statusCode}):`,
          body
        );
        resolve({ statusCode: res.statusCode, body });
      });
    });

    req.on('error', (err) => {
      console.error(`[WhatsApp] Error HTTP con UltraMsg (${telefono}):`, err);
      resolve({ statusCode: 500, body: String(err) });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Envía el resumen de una alerta por WhatsApp.
 * (NO decide qué alertas, solo manda la que le pasas).
 */
async function enviarWhatsAppResumen(alerta, supabase) {
  try {
    if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
      console.warn(
        '[WhatsApp] Faltan ULTRAMSG_INSTANCE_ID o ULTRAMSG_TOKEN. No se envían mensajes.'
      );
      return;
    }

    if (!alerta || !alerta.resumen) return;

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

      await enviarMensajeUltraMsg(telefono, resumen);
    }
  } catch (err) {
    console.error('[WhatsApp] Error general en enviarWhatsAppResumen:', err);
  }
}

module.exports = {
  enviarWhatsAppResumen,
};
