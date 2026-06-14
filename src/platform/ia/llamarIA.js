// src/platform/ia/llamarIA.js
//
// Centraliza las llamadas a OpenAI Responses API y el parseo de JSON.
// Compartido por alertas.js, digest.js, alertasFree.js y revisarAlertas.js.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ─────────────────────────────────────────────
// fetch compatible con Node 18+ y versiones anteriores
// ─────────────────────────────────────────────
let _fetch;
if (typeof globalThis.fetch === 'function') {
  _fetch = globalThis.fetch.bind(globalThis);
} else {
  try {
    _fetch = require('node-fetch');
  } catch {
    throw new Error('No hay fetch disponible. Actualiza a Node 18+ o instala node-fetch v2.');
  }
}

// ─────────────────────────────────────────────
// Helper: llamar a OpenAI Responses API
// ─────────────────────────────────────────────
async function llamarIA(prompt, instructions, model = 'gpt-4o-mini', options = {}) {
  if (!OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY en variables de entorno');

  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('Modelo OpenAI invalido');
  }

  const body = { model, input: prompt, instructions };
  if (options?.textFormat) body.text = { format: options.textFormat };
  if (options?.maxOutputTokens) body.max_output_tokens = options.maxOutputTokens;
  if (options?.reasoning) body.reasoning = options.reasoning;

  const aiRes = await _fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!aiRes.ok) {
    const text = await aiRes.text();
    throw new Error(`Error OpenAI ${aiRes.status}: ${text}`);
  }

  const aiJson = await aiRes.json();

  const contenido = extraerTextoRespuesta(aiJson);

  if (!contenido) throw new Error('La IA no devolvió texto');
  return contenido;
}

function extraerTextoRespuesta(aiJson) {
  if (typeof aiJson?.output_text === 'string' && aiJson.output_text.trim()) {
    return aiJson.output_text.trim();
  }

  if (!Array.isArray(aiJson?.output)) return '';

  for (const item of aiJson.output) {
    if (!item || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (typeof c?.text === 'string' && c.text.trim()) return c.text.trim();
      if (typeof c?.text?.value === 'string' && c.text.value.trim()) return c.text.value.trim();
      if (typeof c?.value === 'string' && c.value.trim()) return c.value.trim();
    }
  }

  return '';
}

// ─────────────────────────────────────────────
// Helper: parsear JSON de la IA (limpia fences de markdown)
// ─────────────────────────────────────────────
function parsearJSON(texto) {
  if (texto && typeof texto === 'object') return texto;
  if (typeof texto !== 'string') {
    throw new Error('No se puede parsear JSON: la respuesta no es texto');
  }

  const limpio = texto.replace(/```json|```/gi, '').trim();

  try {
    return JSON.parse(limpio);
  } catch (err) {
    const fragmento = extraerPrimerJSON(limpio);
    if (!fragmento) throw err;
    return JSON.parse(fragmento);
  }
}

function extraerPrimerJSON(texto) {
  const inicio = texto.search(/[\[{]/);
  if (inicio < 0) return null;

  const apertura = texto[inicio];
  const cierre = apertura === '{' ? '}' : ']';
  let profundidad = 0;
  let enString = false;
  let escape = false;

  for (let i = inicio; i < texto.length; i++) {
    const char = texto[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      enString = !enString;
      continue;
    }
    if (enString) continue;

    if (char === apertura) profundidad++;
    if (char === cierre) profundidad--;

    if (profundidad === 0) {
      return texto.slice(inicio, i + 1);
    }
  }

  return null;
}

module.exports = { llamarIA, parsearJSON };
