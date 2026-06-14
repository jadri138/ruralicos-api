// src/utils/sanitizarPreferencias.js
//
// Valida que preferencias_extra no contenga prompt injection ni
// solicitudes de información interna (claves, rutas, código, BD...).
// Se aplica al guardar (preferences.js) como primera línea de defensa.

const PATRONES_PELIGROSOS = [
  // ── Prompt injection ──────────────────────────────────────────────
  /ignora[r]?\s+(las?\s+)?(instrucciones|reglas|formato|sistema)/i,
  /olvida[r]?\s+(las?\s+)?(instrucciones|reglas|todo)/i,
  /instrucciones\s+anteriores/i,
  /nuevo\s+(rol|sistema|prompt|comportamiento)/i,
  /act[úu]a\s+como(\s+si)?/i,
  /ahora\s+eres/i,
  /eres\s+ahora/i,
  /pretende\s+que/i,
  /system\s+prompt/i,
  /override\s+(las?\s+)?(instrucciones|sistema|reglas)/i,
  /jailbreak/i,
  /\bDAN\b/,
  /modo\s+(dios|developer|dev|sin\s+restricciones)/i,

  // ── Solicitudes de información sensible ───────────────────────────
  /api[_\s-]?key/i,
  /clave[_\s-]?(api|secreta?|privada?)/i,
  /contraseña/i,
  /password/i,
  /\btoken\b.*\b(secreto|acceso|bearer|auth)\b/i,
  /process\.env/i,
  /variables?\s+de\s+entorno/i,
  /\.env\b/,
  /c[oó]digo\s+fuente/i,
  /source\s+code/i,
  /ruta[s]?\s+(del\s+servidor|de\s+la\s+api|interna[s]?)/i,
  /\bendpoint[s]?\b/i,
  /\bsupabase\b/i,
  /\bopenai\b/i,
  /bearer\s+token/i,
  /secret[_\s]?key/i,

  // ── Marcadores de formato de modelos ──────────────────────────────
  /\[INST\]/i,
  /<\|im_start\|>/i,
  /###\s*(instruccion|system|user|assistant)/i,
  /<system>/i,

  // ── Ejecución de código ───────────────────────────────────────────
  /\brequire\s*\(/i,
  /process\.(env|exit|cwd|argv)/i,
  /eval\s*\(/i,
];

/**
 * Comprueba si el texto es seguro para usarse como preferencias_extra.
 * @param {string} texto
 * @returns {{ ok: boolean, error?: string }}
 */
function sanitizarPreferenciasExtra(texto) {
  if (!texto || typeof texto !== 'string') return { ok: true };

  for (const patron of PATRONES_PELIGROSOS) {
    if (patron.test(texto)) {
      return {
        ok: false,
        error:
          'Las preferencias contienen contenido no permitido. ' +
          'Solo puedes indicar qué tipo de alertas agrarias quieres recibir ' +
          'o cómo prefieres que se redacte tu resumen diario.',
      };
    }
  }

  return { ok: true };
}

module.exports = { sanitizarPreferenciasExtra };
