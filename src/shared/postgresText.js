// Protege los textos antes de enviarlos a Postgres/PostgREST.
// JSON puede representar NUL y sustitutos UTF-16 aislados, pero PostgreSQL no
// los acepta como texto UTF-8 valido. Una sola cadena dañada no debe bloquear
// el lote completo de alertas.

function sanitizarTextoPostgres(value, { preservarSaltos = true } = {}) {
  const texto = String(value ?? '');
  let limpio = '';

  for (let index = 0; index < texto.length; index++) {
    const code = texto.charCodeAt(index);

    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = texto.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        limpio += texto[index] + texto[index + 1];
        index++;
      } else {
        limpio += '\uFFFD';
      }
      continue;
    }

    if (code >= 0xDC00 && code <= 0xDFFF) {
      limpio += '\uFFFD';
      continue;
    }

    const esSaltoPermitido = preservarSaltos && (code === 0x09 || code === 0x0A || code === 0x0D);
    if ((code >= 0x00 && code <= 0x1F && !esSaltoPermitido) || (code >= 0x7F && code <= 0x9F)) {
      limpio += ' ';
      continue;
    }

    limpio += texto[index];
  }

  return limpio;
}

function recortarUnicodeSeguro(value, max) {
  const texto = String(value ?? '');
  if (!Number.isFinite(max) || max < 0 || texto.length <= max) return texto;

  let recortado = texto.slice(0, max);
  const ultimo = recortado.charCodeAt(recortado.length - 1);
  if (ultimo >= 0xD800 && ultimo <= 0xDBFF) recortado = recortado.slice(0, -1);
  return recortado;
}

function sanitizarValorPostgres(value) {
  if (typeof value === 'string') return sanitizarTextoPostgres(value);
  if (Array.isArray(value)) return value.map(sanitizarValorPostgres);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, sanitizarValorPostgres(nestedValue)])
  );
}

module.exports = {
  sanitizarTextoPostgres,
  recortarUnicodeSeguro,
  sanitizarValorPostgres,
};
