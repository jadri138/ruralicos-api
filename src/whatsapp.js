// src/whatsapp.js
const qs = require('querystring');
const https = require('https');

// Credenciales UltraMsg desde .env
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;

/* ============================================================
   FUNCIÓN BASE: Enviar mensaje con UltraMSG
============================================================ */
function enviarMensajeUltraMsg(telefono, cuerpo) {
  return new Promise((resolve, reject) => {
    const postData = qs.stringify({
      token: ULTRAMSG_TOKEN,
      to: telefono,
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
          `[WhatsApp] UltraMsg ${telefono} (status ${res.statusCode}):`,
          body
        );

        if (res.statusCode === 200) resolve({ status: res.statusCode, body });
        else reject(new Error(`UltraMsg ${res.statusCode}: ${body}`));
      });
    });

    req.on('error', (err) => {
      console.error(`[WhatsApp] Error envío a ${telefono}:`, err);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/* ============================================================
   FUNCIÓN: Obtener usuarios desde Supabase
============================================================ */
async function obtenerDestinatariosParaAlerta(supabase) {
  const { data, error } = await supabase
    .from('users')
    .select('id, phone, subscription');

  if (error) {
    console.error('[WhatsApp] Error BD usuarios:', error.message);
    throw new Error('Error leyendo usuarios');
  }

  return (data || []).filter((u) => !!u.phone);
}

/* ============================================================
   1) ENVÍO PRO (mensaje individual por alerta)
============================================================ */
async function enviarWhatsAppResumen(alerta, supabase) {
  if (!alerta || !alerta.resumen) {
    console.warn('[WhatsApp] Alerta sin resumen PRO');
    return;
  }

  const resumen = String(alerta.resumen).trim();
  const usuarios = await obtenerDestinatariosParaAlerta(supabase);

  console.log(
    `[WhatsApp PRO] Enviando alerta ${alerta.id} a ${usuarios.length} usuarios`
  );

  for (const user of usuarios) {
    try {
      await enviarMensajeUltraMsg(user.phone, resumen);
    } catch (e) {
      console.error(`[WhatsApp PRO] Error a ${user.phone}:`, e.message);
    }
  }
}

/* ============================================================
   2) ENVÍO FREE (un solo mensaje para todos los FREE)
============================================================ */
async function enviarWhatsAppFree(supabase, mensajeFree) {
  if (!mensajeFree) {
    console.error('[WhatsApp FREE] No hay mensaje FREE');
    return;
  }

  // Solo usuarios FREE
  const { data: usuarios, error } = await supabase
    .from('users')
    .select('id, phone, subscription')
    .eq('subscription', 'free');

  if (error) {
    console.error('[WhatsApp FREE] Error BD usuarios:', error.message);
    throw new Error('Error leyendo usuarios FREE');
  }

  const lista = usuarios.filter((u) => !!u.phone);

  console.log(
    `[WhatsApp FREE] Enviando resumen FREE a ${lista.length} usuarios FREE`
  );

  for (const u of lista) {
    try {
      await enviarMensajeUltraMsg(u.phone, mensajeFree);
    } catch (e) {
      console.error(`[WhatsApp FREE] Error a ${u.phone}:`, e.message);
    }
  }
}

/* ============================================================
   EXPORTS
============================================================ */
module.exports = {
  enviarWhatsAppResumen, // PRO
  enviarWhatsAppFree,    // FREE
};
