// src/platform/whatsapp/client.js
//
// Infraestructura de WhatsApp: cliente HTTP de UltraMsg, registro de logs en
// Supabase y helpers de telefono. Sin casos de uso de negocio (esos van en
// mensajes.js).

const qs = require('querystring');
const https = require('https');
const { supabase } = require('../supabase');

const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;

function parsePhoneList(value) {
  return String(value || '')
    .split(/[,\s;]+/g)
    .map((phone) => phone.trim())
    .filter(Boolean);
}

function getAdminAlertPhones(env = process.env) {
  return Array.from(new Set([
    ...parsePhoneList(env.ADMIN_ALERT_PHONE),
    ...parsePhoneList(env.ADMIN_ALERT_PHONES),
  ]));
}

function maskPhone(phone) {
  const value = String(phone || '').trim();
  return value ? `****${value.slice(-4)}` : null;
}

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

module.exports = {
  parsePhoneList,
  getAdminAlertPhones,
  maskPhone,
  enviarMensajeUltraMsg,
  guardarLogWhatsApp,
  norm,
  ULTRAMSG_INSTANCE_ID,
  ULTRAMSG_TOKEN,
};
