function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return value || null;
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

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  const texto = String(value || '').trim().toLowerCase();
  if (['true', '1', 'yes', 'si'].includes(texto)) return true;
  if (['false', '0', 'no', ''].includes(texto)) return false;
  return Boolean(value);
}

function extraerUltraMsg(body = {}) {
  const data = asObject(body.data);
  const message = asObject(body.message);
  const dataMessage = asObject(data.message);

  const eventType = firstString([
    body.event_type,
    body.eventType,
    body.type,
    data.event_type,
    data.eventType,
    data.type,
    message.event_type,
    message.eventType,
  ]);

  const fromMe = parseBoolean(
    body.fromMe ??
    body.from_me ??
    data.fromMe ??
    data.from_me ??
    message.fromMe ??
    message.from_me ??
    dataMessage.fromMe ??
    dataMessage.from_me
  );

  const telefonoRaw = firstString([
    body.from,
    body.From,
    body.author,
    body.phone,
    data.from,
    data.author,
    data.phone,
    data.sender,
    message.from,
    message.author,
    message.phone,
    dataMessage.from,
    dataMessage.author,
    dataMessage.phone,
  ]);

  const texto = firstString([
    body.body,
    body.Body,
    body.text,
    data.body,
    data.text,
    message.body,
    message.text,
    dataMessage.body,
    dataMessage.text,
  ]);

  return {
    data,
    eventType,
    fromMe,
    telefono: telefonoRaw.replace('@c.us', '').replace(/\D/g, ''),
    texto,
  };
}

function esEventoMensajeUltraMsg(eventType) {
  const tipo = String(eventType || '').trim().toLowerCase();
  if (!tipo) return true;
  return [
    'message',
    'messages',
    'message_received',
    'message_created',
    'message_create',
    'message_new',
    'chat',
  ].includes(tipo);
}

module.exports = {
  extraerUltraMsg,
  esEventoMensajeUltraMsg,
  parseBoolean,
  parseMaybeJson,
};
