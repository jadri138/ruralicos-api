const crypto = require('crypto');

const DELIVERY_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  APPROVED: 'APPROVED',
  QUEUED: 'QUEUED',
  PROVIDER_ACCEPTED: 'PROVIDER_ACCEPTED',
  SENT_TO_WHATSAPP: 'SENT_TO_WHATSAPP',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  UNDELIVERED: 'UNDELIVERED',
});

const FORWARD_ORDER = Object.freeze([
  DELIVERY_STATUS.DRAFT,
  DELIVERY_STATUS.APPROVED,
  DELIVERY_STATUS.QUEUED,
  DELIVERY_STATUS.PROVIDER_ACCEPTED,
  DELIVERY_STATUS.SENT_TO_WHATSAPP,
  DELIVERY_STATUS.DELIVERED,
  DELIVERY_STATUS.READ,
]);

const FORWARD_RANK = new Map(FORWARD_ORDER.map((status, index) => [status, index]));
const ACK_EVENT_TYPES = new Set([
  'ack',
  'message_ack',
  'message.ack',
  'message_status',
  'message.status',
  'delivery',
  'delivery_status',
  'read',
  'receipt',
]);

const SENSITIVE_KEYS = new Set([
  'authorization',
  'token',
  'api_token',
  'api_key',
  'apikey',
  'password',
  'phone',
  'from',
  'to',
  'author',
  'sender',
  'body',
  'text',
  'pushname',
  'name',
  'id',
  'message_id',
  'messageid',
  'idmessage',
  'chat_id',
  'chatid',
]);

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asObject(value) {
  const parsed = parseMaybeJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function firstValue(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function normalizarDeliveryStatus(value, fallback = DELIVERY_STATUS.QUEUED) {
  const normalized = String(value || '').trim().toUpperCase();
  return Object.values(DELIVERY_STATUS).includes(normalized) ? normalized : fallback;
}

function normalizarProviderStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    pending: 'pending',
    queued: 'pending',
    queue: 'pending',
    accepted: 'pending',
    server: 'server',
    sent: 'server',
    device: 'device',
    delivered: 'device',
    delivery_ack: 'device',
    read: 'read',
    viewed: 'read',
    seen: 'read',
    played: 'played',
    invalid: 'invalid',
    failed: 'failed',
    error: 'failed',
    unsent: 'unsent',
    undelivered: 'unsent',
  };
  return aliases[raw] || raw;
}

function deliveryStatusDesdeProveedor(providerStatus, currentStatus = DELIVERY_STATUS.QUEUED) {
  const provider = normalizarProviderStatus(providerStatus);
  if (provider === 'pending') return DELIVERY_STATUS.PROVIDER_ACCEPTED;
  if (provider === 'server') return DELIVERY_STATUS.SENT_TO_WHATSAPP;
  if (provider === 'device') return DELIVERY_STATUS.DELIVERED;
  if (provider === 'read' || provider === 'played') return DELIVERY_STATUS.READ;
  if (provider === 'invalid' || provider === 'failed') return DELIVERY_STATUS.FAILED;
  if (provider === 'unsent') {
    const current = normalizarDeliveryStatus(currentStatus);
    return FORWARD_RANK.get(current) >= FORWARD_RANK.get(DELIVERY_STATUS.SENT_TO_WHATSAPP)
      ? DELIVERY_STATUS.UNDELIVERED
      : DELIVERY_STATUS.FAILED;
  }
  return null;
}

function esEstadoAceptadoOSuperior(status) {
  const normalized = normalizarDeliveryStatus(status);
  const rank = FORWARD_RANK.get(normalized);
  return Number.isInteger(rank) && rank >= FORWARD_RANK.get(DELIVERY_STATUS.PROVIDER_ACCEPTED);
}

function puedeIntentarEnvio(status) {
  const normalized = normalizarDeliveryStatus(status);
  return [DELIVERY_STATUS.DRAFT, DELIVERY_STATUS.APPROVED, DELIVERY_STATUS.QUEUED].includes(normalized);
}

function resolverTransicionEntrega(currentStatus, requestedStatus) {
  const current = normalizarDeliveryStatus(currentStatus);
  const requested = normalizarDeliveryStatus(requestedStatus, null);
  if (!requested) return { apply: false, status: current, reason: 'unknown_status' };
  if (requested === current) return { apply: false, status: current, reason: 'duplicate' };

  const currentRank = FORWARD_RANK.get(current);
  const requestedRank = FORWARD_RANK.get(requested);

  if (Number.isInteger(currentRank) && Number.isInteger(requestedRank)) {
    if (requestedRank > currentRank) return { apply: true, status: requested, reason: 'forward' };
    return { apply: false, status: current, reason: 'out_of_order' };
  }

  if ([DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(current)) {
    return { apply: false, status: current, reason: 'terminal_success' };
  }

  if ([DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(current)) {
    if ([DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(requested)) {
      return { apply: true, status: requested, reason: 'provider_recovery' };
    }
    return { apply: false, status: current, reason: 'terminal_failure' };
  }

  if (requested === DELIVERY_STATUS.FAILED) {
    return { apply: true, status: requested, reason: 'provider_failure' };
  }

  if (requested === DELIVERY_STATUS.UNDELIVERED) {
    const sentRank = FORWARD_RANK.get(DELIVERY_STATUS.SENT_TO_WHATSAPP);
    if (Number.isInteger(currentRank) && currentRank >= sentRank) {
      return { apply: true, status: requested, reason: 'provider_undelivered' };
    }
    return { apply: true, status: DELIVERY_STATUS.FAILED, reason: 'failed_before_whatsapp' };
  }

  return { apply: false, status: current, reason: 'invalid_transition' };
}

function esEventoAckUltraMsg(eventType, body = {}) {
  const type = String(eventType || '').trim().toLowerCase();
  if (ACK_EVENT_TYPES.has(type) || type.includes('ack') || type.includes('delivery')) return true;
  if (type === 'read' || type.endsWith('_read')) return true;

  const data = asObject(body.data);
  const explicit = firstValue([
    body.provider_status,
    body.delivery_status,
    body.message_status,
    data.provider_status,
    data.delivery_status,
    data.message_status,
  ]);
  return Boolean(explicit && firstValue([body.message_id, body.messageId, data.message_id, data.messageId]));
}

function isoTimestamp(value, fallback = new Date()) {
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value || '').trim())) {
    const numeric = Number(value);
    const millis = numeric < 100000000000 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const fallbackDate = fallback instanceof Date ? fallback : new Date(fallback);
  return fallbackDate.toISOString();
}

function sanitizarPayloadEntrega(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitizarPayloadEntrega(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, 500);
    return value ?? null;
  }

  const result = {};
  for (const [key, raw] of Object.entries(value).slice(0, 60)) {
    const normalizedKey = String(key).trim().toLowerCase();
    if (SENSITIVE_KEYS.has(normalizedKey) || normalizedKey.includes('token')) {
      result[key] = '[redacted]';
    } else {
      result[key] = sanitizarPayloadEntrega(parseMaybeJson(raw), depth + 1);
    }
  }
  return result;
}

function crearEventHash({ providerMessageId, providerStatus, eventType = 'message_ack', payload = null }) {
  const stableFallback = payload ? JSON.stringify(sanitizarPayloadEntrega(payload)) : '';
  return crypto
    .createHash('sha256')
    .update(['ultramsg', providerMessageId || stableFallback, providerStatus || 'unknown', eventType || 'unknown'].join('|'))
    .digest('hex');
}

function crearMessageVersion(body, prefix = 'message_v1') {
  const digest = crypto.createHash('sha256').update(String(body || '').trim()).digest('hex').slice(0, 20);
  return `${prefix}:${digest}`;
}

function crearIdempotencyKey({ source = 'message', sourceId = null, messageVersion, fallback = '' } = {}) {
  const stableSource = sourceId === null || sourceId === undefined || sourceId === ''
    ? crypto.createHash('sha256').update(String(fallback || '')).digest('hex').slice(0, 20)
    : String(sourceId);
  return `${String(source || 'message').trim().toLowerCase()}:${stableSource}:${String(messageVersion || 'v1')}`.slice(0, 240);
}

function parsearAckUltraMsg(body = {}, { now = new Date() } = {}) {
  const root = asObject(body);
  const data = asObject(root.data);
  const message = asObject(root.message);
  const dataMessage = asObject(data.message);
  const eventType = firstValue([
    root.event_type,
    root.eventType,
    root.event,
    root.type,
    data.event_type,
    data.eventType,
    data.event,
    message.event_type,
    message.eventType,
  ]).toLowerCase();

  if (!esEventoAckUltraMsg(eventType, root)) {
    return { isAck: false, eventType, reason: 'not_ack_event' };
  }

  const providerMessageId = firstValue([
    root.message_id,
    root.messageId,
    root.idMessage,
    root.id,
    data.message_id,
    data.messageId,
    data.idMessage,
    data.id,
    message.message_id,
    message.messageId,
    message.id,
    dataMessage.message_id,
    dataMessage.messageId,
    dataMessage.id,
  ]);
  const providerStatus = normalizarProviderStatus(firstValue([
    root.ack,
    root.provider_status,
    root.delivery_status,
    root.message_status,
    root.status,
    data.ack,
    data.provider_status,
    data.delivery_status,
    data.message_status,
    data.status,
    message.ack,
    message.status,
    dataMessage.ack,
    dataMessage.status,
  ]));
  const deliveryStatus = deliveryStatusDesdeProveedor(providerStatus);
  const eventAt = isoTimestamp(firstValue([
    root.event_at,
    root.timestamp,
    root.time,
    root.t,
    data.event_at,
    data.timestamp,
    data.time,
    message.timestamp,
    message.time,
  ]), now);
  const payloadJson = sanitizarPayloadEntrega(root);

  if (!providerMessageId) {
    return { isAck: true, valid: false, eventType, providerStatus, reason: 'provider_message_id_missing', payloadJson };
  }
  if (!deliveryStatus) {
    return {
      isAck: true,
      valid: false,
      eventType,
      providerMessageId,
      providerStatus,
      reason: 'provider_status_unknown',
      payloadJson,
    };
  }

  return {
    isAck: true,
    valid: true,
    eventType: eventType || 'message_ack',
    providerMessageId,
    providerStatus,
    deliveryStatus,
    eventAt,
    payloadJson,
    eventHash: crearEventHash({ providerMessageId, providerStatus, eventType: eventType || 'message_ack' }),
  };
}

module.exports = {
  DELIVERY_STATUS,
  FORWARD_ORDER,
  normalizarDeliveryStatus,
  normalizarProviderStatus,
  deliveryStatusDesdeProveedor,
  resolverTransicionEntrega,
  esEstadoAceptadoOSuperior,
  puedeIntentarEnvio,
  esEventoAckUltraMsg,
  parsearAckUltraMsg,
  sanitizarPayloadEntrega,
  crearEventHash,
  crearMessageVersion,
  crearIdempotencyKey,
  isoTimestamp,
};
