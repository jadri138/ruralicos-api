// src/platform/whatsapp/client.js
//
// Infraestructura de WhatsApp: cliente HTTP de UltraMsg, registro de logs en
// Supabase y helpers de telefono. Sin casos de uso de negocio (esos van en
// mensajes.js).

const qs = require('querystring');
const https = require('https');
const { supabase } = require('../supabase');
const { maskPhone } = require('../../shared/pii');

const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;
const ULTRAMSG_TIMEOUT_MS = Math.max(3000, Math.min(60000, Number(process.env.ULTRAMSG_TIMEOUT_MS || 15000)));

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

function summarizeUltraMsgResponse(body) {
  try {
    const json = JSON.parse(String(body || ''));
    return {
      sent: json.sent ?? null,
      id: json.id || json.messageId || json.message_id || null,
      error: json.error || null,
    };
  } catch {
    return { raw_preview: String(body || '').replace(/\s+/g, ' ').slice(0, 120) };
  }
}

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
        console.log('[UltraMsg] Respuesta', {
          to: maskPhone(telefono),
          status: res.statusCode,
          response: summarizeUltraMsgResponse(body),
        });

        if (res.statusCode !== 200) {
          return reject(new Error(`UltraMsg error HTTP ${res.statusCode}`));
        }

        try {
          const json = JSON.parse(body);

          if (json.error) {
            return reject(new Error(`UltraMsg error logico: ${json.error}`));
          }

          if (json.sent === false) {
            return reject(new Error('UltraMsg: mensaje no enviado (sent=false)'));
          }

          return resolve({ status: 200, body: json });
        } catch {
          return reject(new Error('UltraMsg devolvio respuesta no JSON'));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[UltraMsg] Error de conexion a ${maskPhone(telefono)}:`, err.message);
      reject(err);
    });

    req.setTimeout(ULTRAMSG_TIMEOUT_MS, () => {
      req.destroy(new Error(`UltraMsg timeout tras ${ULTRAMSG_TIMEOUT_MS}ms`));
    });

    req.write(postData);
    req.end();
  });
}

async function guardarLogWhatsApp({ phone, status, message_type, error_msg }) {
  console.log('[LOG WHATSAPP] Voy a guardar log', {
    phone: maskPhone(phone),
    status,
    message_type,
    error_msg,
  });

  try {
    const { error } = await supabase.from('whatsapp_logs').insert([
      {
        phone,
        status,
        message_type,
        error_msg,
      },
    ]);

    console.log('[LOG WHATSAPP] Resultado insert:', { ok: !error, error: error?.message || null });

    if (error) {
      console.error('[LOG WHATSAPP] Error guardando log:', error.message);
    }
  } catch (e) {
    console.error('[LOG WHATSAPP] Error inesperado:', e.message);
  }
}

function norm(str) {
  return str
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

module.exports = {
  parsePhoneList,
  getAdminAlertPhones,
  maskPhone,
  summarizeUltraMsgResponse,
  enviarMensajeUltraMsg,
  guardarLogWhatsApp,
  norm,
  ULTRAMSG_INSTANCE_ID,
  ULTRAMSG_TOKEN,
};
