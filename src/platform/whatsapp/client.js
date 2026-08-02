// src/platform/whatsapp/client.js
//
// Infraestructura de WhatsApp: cliente HTTP de UltraMsg, registro de logs en
// Supabase y helpers de telefono. Sin casos de uso de negocio (esos van en
// mensajes.js).

const qs = require('querystring');
const https = require('https');
const { supabase } = require('../supabase');
const { maskPhone } = require('../../shared/pii');
const { clasificarFalloUltraMsg } = require('./errorClassification');

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

function extraerProviderMessageId(json = {}) {
  return String(
    json?.id ||
    json?.messageId ||
    json?.message_id ||
    json?.data?.id ||
    json?.data?.messageId ||
    json?.data?.message_id ||
    ''
  ).trim() || null;
}

function normalizarProviderStatusRespuesta(json = {}) {
  const explicit = json?.ack || json?.status || json?.data?.ack || json?.data?.status;
  if (explicit) return String(explicit).trim().toLowerCase();
  return json?.sent === false ? 'failed' : 'pending';
}

function crearErrorUltraMsg(message, details = {}) {
  const classification = clasificarFalloUltraMsg({
    httpStatus: details.httpStatus,
    code: details.code,
    message,
    sent: details.sent,
  });
  const error = new Error(message);
  error.name = 'UltraMsgError';
  error.provider = 'ultramsg';
  error.httpStatus = details.httpStatus ?? null;
  error.providerCode = classification.code;
  error.retryable = details.retryable ?? classification.retryable;
  error.permanent = details.permanent ?? classification.permanent;
  error.ambiguous = details.ambiguous ?? classification.ambiguous;
  error.providerResponse = details.providerResponse || null;
  return error;
}

function normalizarRespuestaUltraMsg(json = {}, httpStatus = 200, context = {}) {
  return {
    status: httpStatus,
    body: json,
    accepted: true,
    provider: 'ultramsg',
    providerMessageId: extraerProviderMessageId(json),
    providerStatus: normalizarProviderStatusRespuesta(json),
    idempotencyKey: context.idempotencyKey || null,
  };
}

function enviarMensajeUltraMsg(telefono, cuerpo, context = {}) {
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

        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }

        if (res.statusCode !== 200) {
          const providerMessage = json?.error?.message || json?.error || json?.message || '';
          return reject(crearErrorUltraMsg(
            `UltraMsg error HTTP ${res.statusCode}${providerMessage ? `: ${String(providerMessage).slice(0, 240)}` : ''}`,
            {
              httpStatus: res.statusCode,
              code: json?.error?.code || json?.code || `http_${res.statusCode}`,
              providerResponse: summarizeUltraMsgResponse(body),
            }
          ));
        }

        try {
          if (!json) throw new Error('invalid_json');

          if (json.error) {
            const providerMessage = json.error?.message || json.error;
            return reject(crearErrorUltraMsg(`UltraMsg error logico: ${providerMessage}`, {
              httpStatus: res.statusCode,
              code: json.error?.code || json.code || 'provider_error',
              sent: json.sent,
              providerResponse: summarizeUltraMsgResponse(body),
            }));
          }

          if (json.sent === false) {
            return reject(crearErrorUltraMsg('UltraMsg: mensaje no aceptado (sent=false)', {
              httpStatus: res.statusCode,
              code: json.code || 'sent_false',
              sent: false,
              providerResponse: summarizeUltraMsgResponse(body),
            }));
          }

          return resolve(normalizarRespuestaUltraMsg(json, res.statusCode, context));
        } catch {
          return reject(crearErrorUltraMsg('UltraMsg devolvio respuesta no JSON', {
            httpStatus: res.statusCode,
            code: 'invalid_json_response',
            // Hubo respuesta HTTP 200, pero no podemos demostrar si el
            // proveedor creó el mensaje. Se bloquea para revisión y nunca se
            // reenvía a ciegas.
            ambiguous: true,
            permanent: false,
            retryable: false,
            providerResponse: summarizeUltraMsgResponse(body),
          }));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[UltraMsg] Error de conexion a ${maskPhone(telefono)}:`, err.message);
      reject(err?.name === 'UltraMsgError' ? err : crearErrorUltraMsg(
        `UltraMsg error de conexion: ${err.message}`,
        { code: err.code || 'connection_error' }
      ));
    });

    req.setTimeout(ULTRAMSG_TIMEOUT_MS, () => {
      req.destroy(new Error(`UltraMsg timeout tras ${ULTRAMSG_TIMEOUT_MS}ms`));
    });

    req.write(postData);
    req.end();
  });
}

async function guardarLogWhatsApp({
  phone,
  status,
  message_type,
  error_msg,
  provider_message_id = null,
  provider_status = null,
  delivery_status = null,
  outbox_id = null,
  digest_id = null,
  user_id = null,
  idempotency_key = null,
  message_version = null,
  provider = 'ultramsg',
  accepted_at = null,
  sent_to_whatsapp_at = null,
  delivered_at = null,
  read_at = null,
  failed_at = null,
  provider_error_code = null,
  provider_error_reason = null,
}) {
  console.log('[LOG WHATSAPP] Voy a guardar log', {
    phone: maskPhone(phone),
    status,
    message_type,
    error_msg,
  });

  try {
    const row = {
      phone,
      status,
      message_type,
      error_msg,
      provider_message_id,
      provider_status,
      delivery_status,
      outbox_id,
      digest_id,
      user_id,
      idempotency_key,
      message_version,
      provider,
      accepted_at,
      sent_to_whatsapp_at,
      delivered_at,
      read_at,
      failed_at,
      provider_error_code,
      provider_error_reason,
    };

    if (idempotency_key) {
      const { data: existing, error: updateError } = await supabase
        .from('whatsapp_logs')
        .update(row)
        .eq('idempotency_key', idempotency_key)
        .select('id')
        .maybeSingle();
      if (updateError) throw updateError;
      if (existing?.id) return { ok: true, id: existing.id, updated: true };
    }

    const { data, error } = await supabase.from('whatsapp_logs').insert([row]).select('id').maybeSingle();

    console.log('[LOG WHATSAPP] Resultado insert:', { ok: !error, error: error?.message || null });

    if (error?.code === '23505' && idempotency_key) {
      const { data: existing, error: retryError } = await supabase
        .from('whatsapp_logs')
        .update(row)
        .eq('idempotency_key', idempotency_key)
        .select('id')
        .maybeSingle();
      if (retryError) throw retryError;
      return { ok: true, id: existing?.id || null, updated: true };
    }
    if (error) {
      console.error('[LOG WHATSAPP] Error guardando log:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id || null, updated: false };
  } catch (e) {
    console.error('[LOG WHATSAPP] Error inesperado:', e.message);
    return { ok: false, error: e.message };
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
  extraerProviderMessageId,
  normalizarProviderStatusRespuesta,
  normalizarRespuestaUltraMsg,
  clasificarFalloUltraMsg,
  crearErrorUltraMsg,
  enviarMensajeUltraMsg,
  guardarLogWhatsApp,
  norm,
  ULTRAMSG_INSTANCE_ID,
  ULTRAMSG_TOKEN,
};
