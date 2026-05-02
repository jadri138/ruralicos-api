function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extraerTextoEntrante(body = {}) {
  return (
    body.body ||
    body.Body ||
    body.text ||
    body.message ||
    body.data?.body ||
    body.data?.text ||
    body.data?.message ||
    body.data?.message?.body ||
    ''
  );
}

function extraerTelefonoEntrante(body = {}) {
  const raw =
    body.from ||
    body.From ||
    body.author ||
    body.phone ||
    body.data?.from ||
    body.data?.author ||
    body.data?.phone ||
    body.data?.sender ||
    '';

  return String(raw || '').replace(/\D/g, '');
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

  return votos;
}

module.exports = {
  extraerTextoEntrante,
  extraerTelefonoEntrante,
  parsearVotosDigest,
};
