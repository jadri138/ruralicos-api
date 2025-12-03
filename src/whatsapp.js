// src/whatsapp.js
const qs = require('querystring');
const https = require('https');
const { supabase } = require('./supabaseClient');


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

        if (res.statusCode !== 200) {
          return reject(new Error(`UltraMsg error HTTP ${res.statusCode}: ${body}`));
        }

        // Aquí comprobamos el JSON que devuelve UltraMsg
        try {
          const json = JSON.parse(body);

          // Muchos proveedores devuelven { sent: true, ... } o { error: "..." }
          if (json.error) {
            return reject(new Error(`UltraMsg error lógico: ${json.error}`));
          }

          if (json.sent === false) {
            return reject(new Error('UltraMsg: mensaje no enviado (sent=false)'));
          }

          // Si no hay error explícito, lo consideramos OK
          return resolve({ status: 200, body: json });
        } catch (e) {
          // Si no es JSON válido, al menos que quede claro
          return reject(
            new Error(`UltraMsg devolvió respuesta no JSON: ${body}`)
          );
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

async function guardarLogWhatsApp({ phone, status, message_type, error_msg }) {
  console.log('[LOG WHATSAPP] Voy a guardar log', {
    phone,
    status,
    message_type,
    error_msg,
  });

  try {
    const { data, error } = await supabase.from('whatsapp_logs').insert([
      {
        phone,
        status,
        message_type,
        error_msg,
      },
    ]);

    console.log('[LOG WHATSAPP] Resultado insert:', { data, error });

    if (error) {
      console.error('[LOG WHATSAPP] Error guardando log:', error.message);
    }
  } catch (e) {
    console.error('[LOG WHATSAPP] Error inesperado:', e.message);
  }
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
  .select('id, phone, preferences')
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
  const prefs = user.preferences || {};

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

  // 3. FILTRO SUBSECTOR (ahora SÍ obligatorio si el usuario los tiene definidos)
const okSubsector =
  subsectoresUser.length === 0 ||         // si el usuario no eligió subsector → recibe todos los subsectores de su sector
  subsectoresA.length === 0 ||            // si la alerta no especifica subsectores → es genérica
  intersecta(subsectoresUser, subsectoresA); // si ambos tienen valores → debe haber coincidencia

if (!okSubsector) continue;


  // 3. FILTRO TIPO DE ALERTA
  const okTipo = tiposA.some((tipo) => tiposUser[tipo] === true);
  const tiposVacios = Object.keys(tiposUser).length === 0;

  if (!okTipo && !tiposVacios) continue;

  // ==== SI PASA TODOS LOS FILTROS, SE ENVÍA ====
  try {
    await enviarMensajeUltraMsg(telefono, resumen);
    enviados++;
    console.log('[WHATSAPP PRO] ENVIADO A', telefono);

          await guardarLogWhatsApp({
        phone: telefono,
        status: 'sent',
        message_type: 'alerta_pro',
        error_msg: null,
      });

  } catch (err) {
    errores.push({ userId: user.id, telefono, error: err.message });
    await guardarLogWhatsApp({
  phone: telefono,
  status: 'failed',
  message_type: 'alerta_pro',
  error_msg: err.message,
});

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
    const telefono = user.phone.trim();

    try {
      await enviarMensajeUltraMsg(telefono, mensajeFree);
      enviados++;

      // ✅ Log de éxito
      await guardarLogWhatsApp({
        phone: telefono,
        status: 'sent',
        message_type: 'alerta_free',
        error_msg: null,
      });

    } catch (err) {
      console.error(`[FREE] Error enviando a ${telefono}:`, err.message);
      errores.push({ userId: user.id, error: err.message });

      // ✅ Log de error
      await guardarLogWhatsApp({
        phone: telefono,
        status: 'failed',
        message_type: 'alerta_free',
        error_msg: err.message,
      });
    }
  }


  console.log(
    `[FREE] Resumen diario enviado a ${enviados}/${usuariosFree.length} usuarios FREE`
  );
  if (errores.length > 0) console.warn(`[FREE] ${errores.length} errores`);
}

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

    console.log('[REGISTRO] WhatsApp enviado a', telefono);
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
    return;
  }

  // 1. Listar todos los usuarios con teléfono
  const { data: users, error } = await supabase
    .from('users')
    .select('id, phone')
    .not('phone', 'is', null)
    .neq('phone', '');

  if (error) {
    console.error('Error consultando usuarios:', error.message);
    throw error;
  }

  if (!users || users.length === 0) {
    console.warn('No hay usuarios con teléfono → no se envía');
    return;
  }

  console.log(`Enviando mensaje a ${users.length} usuarios...`);

  for (const user of users) {
    const telefono = user.phone.trim();
    try {
      await enviarMensajeUltraMsg(telefono, mensaje);
      // Opcional: guarda log de éxito llamando a guardarLogWhatsApp() si lo deseas
    } catch (err) {
      console.error(`Error enviando a ${telefono}:`, err.message);
      // Opcional: guarda log de error con guardarLogWhatsApp()
    }
  }

  console.log('Mensaje enviado a todos los usuarios.');
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

    console.log('[VERIFICACION] WhatsApp enviado a', telefono);
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


module.exports = {
  enviarWhatsAppResumen, // Solo PRO
  enviarWhatsAppFree, // Solo FREE
  enviarWhatsAppTodos,
  enviarWhatsAppRegistro, //mensaje a todos los numeros
};
