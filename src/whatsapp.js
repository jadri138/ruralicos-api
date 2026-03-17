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

        try {
          const json = JSON.parse(body);

          if (json.error) {
            return reject(new Error(`UltraMsg error lógico: ${json.error}`));
          }

          if (json.sent === false) {
            return reject(new Error('UltraMsg: mensaje no enviado (sent=false)'));
          }

          return resolve({ status: 200, body: json });
        } catch (e) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Helper: normaliza un string para comparaciones (sin tildes, minúsculas, trim)
// ─────────────────────────────────────────────────────────────────────────────
function norm(str) {
  return str
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * ENVÍA ALERTA INDIVIDUAL → SOLO A USUARIOS PRO (CON FILTROS)
 *
 * Lógica de filtros:
 *   - Si el usuario tiene el array VACÍO en cualquier campo → sin filtro, recibe todo
 *   - Si la alerta tiene provincias VACÍO → es nacional, llega a todos
 *   - Si la alerta tiene sectores/subsectores VACÍO → genérica, llega a todos
 *   - "mixto" en el usuario acepta alertas de agricultura o ganadería (y viceversa)
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

  // 1) Obtener usuarios PRO con teléfono
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
    `[PRO] Enviando alerta ${alerta.id} a ${usuariosPro.length} usuarios PRO (con filtros).`
  );

  let enviados = 0;
  const errores = [];

  // Comprueba si dos arrays tienen al menos un elemento en común (ya normalizados)
  const intersecta = (a, b) => a.some((x) => b.includes(x));

  // Normalizar etiquetas de la alerta una sola vez (fuera del bucle de usuarios)
  const provinciasANorm  = Array.isArray(alerta.provincias)
    ? alerta.provincias.map(norm)
    : [];
  const sectoresANorm    = Array.isArray(alerta.sectores)
    ? alerta.sectores.map(norm)
    : [];
  // FIX 2: subsectores de la alerta también normalizados
  const subsectoresANorm = Array.isArray(alerta.subsectores)
    ? alerta.subsectores.map(norm)
    : [];
  const tiposANorm       = Array.isArray(alerta.tipos_alerta)
    ? alerta.tipos_alerta.map((t) => (t ? norm(t) : '')).filter(Boolean)
    : [];

  for (const user of usuariosPro) {
    const telefono = (user.phone || '').trim();
    if (!telefono) continue;

    const prefs = user.preferences || {};

    // Preferencias del usuario normalizadas
    const provinciasUserNorm  = Array.isArray(prefs.provincias)
      ? prefs.provincias.map(norm)
      : [];
    const sectoresUserNorm    = Array.isArray(prefs.sectores)
      ? prefs.sectores.map(norm)
      : [];
    // FIX 2: subsectores del usuario también normalizados
    const subsectoresUserNorm = Array.isArray(prefs.subsectores)
      ? prefs.subsectores.map(norm)
      : [];
    const tiposUser           = prefs.tipos_alerta || {};

    // ==== 1. FILTRO PROVINCIA ====
    // [] en usuario → sin filtro (recibe todo)
    // [] en alerta  → nacional (llega a todos)
    // FIX 1: antes faltaba el caso provinciasANorm.length === 0
    const okProvincia =
      provinciasUserNorm.length === 0 ||
      provinciasANorm.length === 0 ||
      intersecta(provinciasUserNorm, provinciasANorm);

    if (!okProvincia) continue;

    // ==== 2. FILTRO SECTOR ====
    // "mixto" en usuario acepta agricultura y ganadería
    // FIX 3: "mixto" en alerta también acepta usuarios de agricultura/ganadería
    const tieneMixtoUser  = sectoresUserNorm.includes('mixto');
    const tieneMixtoAlerta = sectoresANorm.includes('mixto');

    const okSector =
      sectoresUserNorm.length === 0 ||
      sectoresANorm.length === 0 ||
      intersecta(sectoresUserNorm, sectoresANorm) ||
      (tieneMixtoUser  && intersecta(['agricultura', 'ganaderia'], sectoresANorm)) ||
      (tieneMixtoAlerta && intersecta(['agricultura', 'ganaderia'], sectoresUserNorm));

    if (!okSector) continue;

    // ==== 3. FILTRO SUBSECTOR ====
    // FIX 2: ahora ambos arrays están normalizados, la comparación es case-insensitive
    const okSubsector =
      subsectoresUserNorm.length === 0 ||
      subsectoresANorm.length === 0 ||
      intersecta(subsectoresUserNorm, subsectoresANorm);

    if (!okSubsector) continue;

    // ==== 4. FILTRO TIPO DE ALERTA ====
    // Solo filtra si AMBOS tienen tipos definidos
    const tiposUserActivos = Object.entries(tiposUser)
      .filter(([_, v]) => v === true)
      .map(([k]) => norm(k));

    const hayTiposUsuario = tiposUserActivos.length > 0;
    const hayTiposAlerta  = tiposANorm.length > 0;

    let okTipo = true;
    if (hayTiposUsuario && hayTiposAlerta) {
      okTipo = tiposANorm.some((t) => tiposUserActivos.includes(t));
    }

    if (!okTipo) continue;

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
      console.error('[WHATSAPP PRO] Error enviando a', telefono, err.message);
      errores.push({ userId: user.id, telefono, error: err.message });

      await guardarLogWhatsApp({
        phone: telefono,
        status: 'failed',
        message_type: 'alerta_pro',
        error_msg: err.message,
      });
    }
  }

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

      await guardarLogWhatsApp({
        phone: telefono,
        status: 'sent',
        message_type: 'alerta_free',
        error_msg: null,
      });
    } catch (err) {
      console.error(`[FREE] Error enviando a ${telefono}:`, err.message);
      errores.push({ userId: user.id, error: err.message });

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
    } catch (err) {
      console.error(`Error enviando a ${telefono}:`, err.message);
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
  enviarWhatsAppFree,   // Solo FREE
  enviarWhatsAppTodos,
  enviarWhatsAppRegistro,
  enviarWhatsAppVerificacion,
};