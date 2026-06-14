const { extraerTextoEntrante, extraerTelefonoEntrante } = require('../aprendizaje/feedbackParser');
const { normalizePhone } = require('../../shared/phoneNormalizer');
const { extraerUltraMsg, esEventoMensajeUltraMsg } = require('../../shared/ultramsgParser');

const REASONS_REPLAY_SEGURO = new Set([
  'webhook_token_no_configurado',
  'error_interno',
  'webhook_error',
]);

const REASONS_NO_REPLAY = new Set([
  'mensaje_duplicado',
  'mensaje_propio',
  'canal_no_usuario',
  'event_type_no_procesable',
  'telefono_o_texto_vacio',
  'texto_vacio',
]);

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extraerReasonWebhookEvent(event = {}) {
  const result = parseJsonObject(event.result_json);
  return String(
    result.reason ||
    result.error_reason ||
    result.status_reason ||
    ''
  ).trim() || null;
}

function ocultarTelefono(phone) {
  const normalizado = normalizePhone(phone);
  if (!normalizado) return null;
  if (normalizado.length <= 6) return `${normalizado.slice(0, 2)}...`;
  return `${normalizado.slice(0, 4)}...${normalizado.slice(-3)}`;
}

function resumirTexto(texto, max = 220) {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
  if (limpio.length <= max) return limpio;
  return `${limpio.slice(0, Math.max(0, max - 3)).trim()}...`.slice(0, max);
}

function analizarWebhookEventParaReplay(event = {}, options = {}) {
  const includeRaw = options.includeRaw === true;
  const body = parseJsonObject(event.body_json);
  const result = parseJsonObject(event.result_json);
  const ultra = extraerUltraMsg(body);
  const texto = ultra.texto || extraerTextoEntrante(body);
  const telefono = normalizePhone(ultra.telefono || extraerTelefonoEntrante(body));
  const reason = extraerReasonWebhookEvent(event);
  const blockers = [];

  if (event.source && event.source !== 'ultramsg') blockers.push('source_no_ultramsg');
  if (event.processed) blockers.push('ya_procesado');
  if (!esEventoMensajeUltraMsg(ultra.eventType)) blockers.push('event_type_no_procesable');
  if (ultra.fromMe) blockers.push('mensaje_propio');
  if (ultra.senderKind && ultra.senderKind !== 'user') blockers.push('canal_no_usuario');
  if (!telefono || !texto) blockers.push('telefono_o_texto_vacio');
  if (reason && REASONS_NO_REPLAY.has(reason)) blockers.push(`reason_${reason}`);

  const reasonReplaySeguro = reason
    ? REASONS_REPLAY_SEGURO.has(reason)
    : Boolean(event.error_msg);

  const eligible = blockers.length === 0 && reasonReplaySeguro;
  const forceable = blockers.length === 0 && !eligible && !event.processed;

  return {
    id: event.id,
    created_at: event.created_at || null,
    source: event.source || null,
    processed: Boolean(event.processed),
    reason,
    error_msg: event.error_msg || null,
    event_type: ultra.eventType || null,
    message_id: ultra.messageId || null,
    chat_id: ultra.chatId || null,
    sender_kind: ultra.senderKind || null,
    phone: includeRaw ? telefono : undefined,
    phone_preview: ocultarTelefono(telefono),
    text: includeRaw ? String(texto || '') : undefined,
    text_preview: resumirTexto(texto),
    eligible,
    forceable,
    blockers,
    result_summary: {
      ok: result.ok ?? null,
      ignored: result.ignored ?? null,
      user_id: result.user_id ?? null,
      digest_id: result.digest_id ?? null,
      mia_inbound_id: result.mia_inbound_id ?? null,
      mia_decision_id: result.mia_decision_id ?? null,
    },
  };
}

function filtrarEventosReplay(events = [], options = {}) {
  const force = options.force === true;
  return events
    .map((event) => analizarWebhookEventParaReplay(event, options))
    .filter((candidate) => force ? (candidate.eligible || candidate.forceable) : candidate.eligible);
}

module.exports = {
  REASONS_REPLAY_SEGURO,
  analizarWebhookEventParaReplay,
  extraerReasonWebhookEvent,
  filtrarEventosReplay,
  ocultarTelefono,
  parseJsonObject,
  resumirTexto,
};
