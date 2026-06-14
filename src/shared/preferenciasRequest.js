const { sanitizarPreferenciasExtra } = require('./sanitizarPreferencias');

function extraerPreferenciasBody(body = {}) {
  const contenedorPrefs =
    body.preferences && typeof body.preferences === 'object' && !Array.isArray(body.preferences)
      ? body.preferences
      : body;

  const rawExtra =
    body.preferencias_extra ??
    body.preferenciasExtra ??
    contenedorPrefs.preferencias_extra ??
    contenedorPrefs.preferenciasExtra;

  const extraEnviado =
    Object.prototype.hasOwnProperty.call(body, 'preferencias_extra') ||
    Object.prototype.hasOwnProperty.call(body, 'preferenciasExtra') ||
    Object.prototype.hasOwnProperty.call(contenedorPrefs, 'preferencias_extra') ||
    Object.prototype.hasOwnProperty.call(contenedorPrefs, 'preferenciasExtra');

  const preferences = { ...contenedorPrefs };
  delete preferences.phone;
  delete preferences.preferences;
  delete preferences.preferencias_extra;
  delete preferences.preferenciasExtra;

  return { preferences, rawExtra, extraEnviado };
}

function prepararPreferenciasExtra(rawExtra) {
  const extraLimpio = typeof rawExtra === 'string'
    ? rawExtra.trim().slice(0, 1000)
    : null;

  if (extraLimpio) {
    const check = sanitizarPreferenciasExtra(extraLimpio);
    if (!check.ok) return { ok: false, error: check.error };
  }

  return { ok: true, valor: extraLimpio || null };
}

module.exports = { extraerPreferenciasBody, prepararPreferenciasExtra };
