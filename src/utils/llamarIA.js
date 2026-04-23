// src/utils/llamarIA.js
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
async function llamarIA(prompt, instructions, model = 'gpt-4o-mini') {
  if (!OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY en variables de entorno');

  const aiRes = await _fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: prompt, instructions }),
  });

  if (!aiRes.ok) {
    const text = await aiRes.text();
    throw new Error(`Error OpenAI ${aiRes.status}: ${text}`);
  }

  const aiJson = await aiRes.json();

  let contenido = '';
  if (typeof aiJson.output_text === 'string' && aiJson.output_text.trim()) {
    contenido = aiJson.output_text.trim();
  } else if (Array.isArray(aiJson.output)) {
    outer: for (const item of aiJson.output) {
      if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (typeof c?.text === 'string' && c.text.trim()) { contenido = c.text.trim(); break outer; }
        if (typeof c?.text?.value === 'string' && c.text.value.trim()) { contenido = c.text.value.trim(); break outer; }
        if (typeof c?.value === 'string' && c.value.trim()) { contenido = c.value.trim(); break outer; }
      }
    }
  }

  if (!contenido) throw new Error('La IA no devolvió texto');
  return contenido;
}

// ─────────────────────────────────────────────
// Helper: parsear JSON de la IA (limpia fences de markdown)
// ─────────────────────────────────────────────
function parsearJSON(texto) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  return JSON.parse(limpio);
}

module.exports = { llamarIA, parsearJSON };
