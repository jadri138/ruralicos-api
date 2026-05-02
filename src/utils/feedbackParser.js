function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extraerTextoEntrante(body = {}) {
  const data = parseMaybeJson(body.data) || body.data || {};
  const message = parseMaybeJson(body.message) || body.message || {};
  const dataMessage = parseMaybeJson(data.message) || data.message || {};

  return firstString([
    body.body,
    body.Body,
    body.text,
    body.message,
    message.body,
    message.text,
    data.body,
    data.text,
    data.message,
    dataMessage.body,
    dataMessage.text,
  ]);
}

function extraerTelefonoEntrante(body = {}) {
  const data = parseMaybeJson(body.data) || body.data || {};
  const message = parseMaybeJson(body.message) || body.message || {};
  const dataMessage = parseMaybeJson(data.message) || data.message || {};
  const raw =
    body.from ||
    body.From ||
    body.author ||
    body.phone ||
    message.from ||
    message.author ||
    message.phone ||
    data.from ||
    data.author ||
    data.phone ||
    data.sender ||
    dataMessage.from ||
    dataMessage.author ||
    dataMessage.phone ||
    '';

  return String(raw || '').replace(/\D/g, '');
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function parsearVotosDigest(texto) {
  const original = String(texto || '').trim();
  const normalizado = normalizarTexto(original)
    .replace(/[👍✅⭐️🌟💚]/g, '+')
    .replace(/[👎❌🛑]/g, '-');

  const votos = [];
  const vistos = new Set();

  function add(numero, valor) {
    const item = Number(numero);
    if (!Number.isInteger(item) || item < 1 || item > 20) return;
    const key = `${item}:${valor}`;
    if (vistos.has(key)) return;
    vistos.add(key);
    votos.push({ item, valor });
  }

  for (const match of normalizado.matchAll(/([+-])\s*(\d{1,2})/g)) {
    add(match[2], match[1] === '+' ? 1 : -1);
  }

  for (const match of normalizado.matchAll(/(\d{1,2})([+-])/g)) {
    add(match[1], match[2] === '+' ? 1 : -1);
  }

  for (const match of normalizado.matchAll(/\b(bien|buena|bueno|util|importante|me interesa|si)\s+((?:\d{1,2}[\s,;y]*)+)/g)) {
    for (const n of match[2].match(/\d{1,2}/g) || []) add(n, 1);
  }

  for (const match of normalizado.matchAll(/\b(mal|mala|malo|no util|no me interesa|irrelevante|no)\s+((?:\d{1,2}[\s,;y]*)+)/g)) {
    for (const n of match[2].match(/\d{1,2}/g) || []) add(n, -1);
  }

  for (const match of normalizado.matchAll(/\b(quitar|quita|borrar|borra|fuera|menos|no mandar|no enviar)\s+((?:\d{1,2}[\s,;y]*)+)/g)) {
    for (const n of match[2].match(/\d{1,2}/g) || []) add(n, -1);
  }

  if (votos.length === 0 && /^\s*\d{1,2}(\s*[,;y]\s*\d{1,2})*\s*$/.test(normalizado)) {
    for (const n of normalizado.match(/\d{1,2}/g) || []) add(n, 1);
  }

  return votos;
}

module.exports = {
  extraerTextoEntrante,
  extraerTelefonoEntrante,
  parsearVotosDigest,
};
