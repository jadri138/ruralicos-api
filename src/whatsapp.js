// src/whatsapp.js
const qs = require('querystring');
const https = require('https');

// Credenciales UltraMsg desde .env
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;

/**
 * Llama a la API de UltraMsg para mandar un mensaje.
 */
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
          `[UltraMsg → ${telefono}] Status: ${res.statusCode} | Respuesta: ${body}`
        );

        if (res.statusCode === 200) {
          resolve({ status: 200, body });
        } else {
          reject(new Error(`UltraMsg error ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[UltraMsg] Error de conexión a ${telefono}:`, err.message);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * ENVÍA ALERTA INDIVIDUAL → SOLO A USUARIOS PRO
 */
async function enviarWhatsAppResumen(alerta, supabase) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('Faltan ULTRAMSG_INSTANCE_ID o ULTRAMSG_TOKEN en .env');
  }

  if (!alerta?.resumen?.trim() || alerta.resumen === 'NO IMPORTA') {
    console.log(
      `[PRO] Alerta ${alerta.id} → sin resumen válido o marcada como NO IMPORTA → no se envía`
    );
    return;
  }

  const resumen = alerta.resumen.trim();

  // SOLO usuarios PRO con teléfono válido
  const { data: usuariosPro, error } = await supabase
  .from('users')
  .select('id, phone, preferencias')
  .eq('subscription', 'pro')
  .not('phone', 'is', null)
  .neq('phone', '');


  if (error) {
    console.error('[PRO] Error consultando usuarios PRO:', error.message);
    throw error;
  }

  if (!usuariosPro || usuariosPro.length === 0) {
    console.log('[PRO] No hay usuarios PRO con teléfono → no se envía nada');
    return;
  }

  console.log(
    `[PRO] Enviando alerta ${alerta.id} a ${usuariosPro.length} usuarios PRO...`
  );

  let enviados = 0;
  const errores = [];

 for (const user of usuariosPro) {
  const telefono = user.phone.trim();
  const prefs = user.preferencias || {};

  // Preferencias del usuario
  const provinciasUser  = prefs.provincias  || [];
  const sectoresUser    = prefs.sectores    || [];
  const subsectoresUser = prefs.subsectores || [];
  const tiposUser       = prefs.tipos_alerta || {};

  // Etiquetas de la alerta
  const provinciasA  = alerta.provincias  || [];
  const sectoresA    = alerta.sectores    || [];
  const subsectoresA = alerta.subsectores || [];
  const tiposA       = alerta.tipos_alerta || [];

  const intersecta = (a, b) => a.some((x) => b.includes(x));

  // ==== REGLAS DE ENVÍO ====

  // 1. FILTRO PROVINCIA
  const okProvincia =
    provinciasUser.length === 0 ||
    provinciasA.length === 0 ||
    intersecta(provinciasUser, provinciasA);

  if (!okProvincia) continue; // no enviar a este usuario

  // 2. FILTRO SECTOR
  const okSector =
    sectoresUser.length === 0 ||
    sectoresA.length === 0 ||
    intersecta(sectoresUser, sectoresA);

  if (!okSector) continue;

  // (SUBSECTOR ya NO es obligatorio — solo informativo)

  // 3. FILTRO TIPO DE ALERTA
  const okTipo = tiposA.some((tipo) => tiposUser[tipo] === true);
  const tiposVacios = Object.keys(tiposUser).length === 0;

  if (!okTipo && !tiposVacios) continue;

  // ==== SI PASA TODOS LOS FILTROS, SE ENVÍA ====
  try {
    await enviarMensajeUltraMsg(telefono, resumen);
    enviados++;
  } catch (err) {
    errores.push({ userId: user.id, telefono, error: err.message });
  }
}

  // ❌ Eliminado: NO se vuelve a marcar whatsapp_enviado aquí.
  // alertas.js se encarga de esto correctamente.

  console.log(
    `[PRO] Alerta ${alerta.id} enviada correctamente a ${enviados} usuarios PRO`
  );
  if (errores.length > 0) {
    console.warn(`[PRO] Hubo ${errores.length} errores parciales`);
  }
}

/**
 * ENVÍA RESUMEN DIARIO → SOLO USUARIOS FREE
 */
async function enviarWhatsAppFree(supabase, mensajeFree) {
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('Faltan credenciales UltraMsg');
  }

  if (!mensajeFree?.trim()) {
    console.warn('[FREE] Mensaje FREE vacío → no se envía');
    return;
  }

  const { data: usuariosFree, error } = await supabase
    .from('users')
    .select('id, phone')
    .eq('subscription', 'free')
    .not('phone', 'is', null)
    .neq('phone', '');

  if (error) {
    console.error('[FREE] Error consultando usuarios FREE:', error.message);
    throw error;
  }

  if (!usuariosFree || usuariosFree.length === 0) {
    console.warn('[FREE] No hay usuarios FREE con teléfono → no se envía');
    return;
  }

  console.log(
    `[FREE] Enviando resumen diario a ${usuariosFree.length} usuarios FREE...`
  );

  let enviados = 0;
  const errores = [];

  for (const user of usuariosFree) {
    try {
      await enviarMensajeUltraMsg(user.phone.trim(), mensajeFree);
      enviados++;
    } catch (err) {
      console.error(`[FREE] Error enviando a ${user.phone}:`, err.message);
      errores.push({ userId: user.id, error: err.message });
    }
  }

  console.log(
    `[FREE] Resumen diario enviado a ${enviados}/${usuariosFree.length} usuarios FREE`
  );
  if (errores.length > 0) console.warn(`[FREE] ${errores.length} errores`);
}

module.exports = {
  enviarWhatsAppResumen, // Solo PRO
  enviarWhatsAppFree, // Solo FREE
};
