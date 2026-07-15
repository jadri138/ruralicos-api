// src/platform/ia/llamarIA.js
//
// Centraliza las llamadas a OpenAI Responses API y el parseo de JSON.
// Compartido por alertas, digest, cerebro, feedbackParser y MIA.
//
// Robustez (jul-2026): timeout con abort, reintentos con backoff para errores
// transitorios (red, 408/429/5xx) y auditoria de coste/latencia en la tabla
// ia_runs (best effort: si la tabla o supabase no estan disponibles, la llamada
// funciona igual). Configurable por entorno:
//   IA_TIMEOUT_MS (90000) · IA_HTTP_RETRIES (2) · IA_HTTP_RETRY_DELAY_MS (2000)
//   IA_RUNS_LOG (true)

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

function numeroEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Errores transitorios que merecen reintento. Un 429 por cuota agotada
// (insufficient_quota) NO es transitorio: reintentar solo quema tiempo.
function esReintentableIA({ status = null, body = '', errorMessage = '' } = {}) {
  if (/insufficient_quota|exceeded your current quota/i.test(String(body || ''))) return false;
  if (status !== null) return [408, 429, 500, 502, 503, 504].includes(Number(status));
  return /fetch failed|network|aborted|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|terminated/i
    .test(String(errorMessage || ''));
}

// Auditoria best-effort en ia_runs: nunca bloquea ni rompe la llamada.
// Se silencia el error de "tabla no existe" para no inundar logs durante la
// ventana entre deploy del codigo y aplicacion de la migracion.
function registrarIARun(run) {
  if ((process.env.IA_RUNS_LOG || 'true').toLowerCase() !== 'true') return;

  try {
    const { supabase } = require('../supabase');
    supabase
      .from('ia_runs')
      .insert([run])
      .then(
        ({ error }) => {
          if (error && !['42P01', 'PGRST205'].includes(error.code)) {
            console.warn('[ia_runs] No se pudo registrar llamada IA:', error.message);
          }
        },
        (err) => console.warn('[ia_runs] No se pudo registrar llamada IA:', err.message)
      );
  } catch {
    // Sin supabase configurado (tests locales): se omite la auditoria.
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

  const task = String(options?.task || 'generic').slice(0, 80);
  const body = { model, input: prompt, instructions };
  if (options?.textFormat) body.text = { format: options.textFormat };
  if (options?.maxOutputTokens) body.max_output_tokens = options.maxOutputTokens;
  if (options?.reasoning) {
    body.reasoning = options.reasoning;
  } else if (model === 'gpt-5-nano') {
    // Estas tareas estructuradas no necesitan razonamiento medio. Reducirlo
    // evita agotar max_output_tokens antes de producir el JSON visible.
    body.reasoning = {
      effort: String(process.env.IA_GPT5_NANO_REASONING_EFFORT || 'minimal'),
    };
  }

  const fetchImpl = options?.fetchImpl || _fetch;
  const timeoutMs = Number(options?.timeoutMs) || numeroEnv('IA_TIMEOUT_MS', 90000, 5000, 600000);
  const retries = Number.isFinite(Number(options?.retries))
    ? Math.max(0, Math.min(5, Number(options.retries)))
    : numeroEnv('IA_HTTP_RETRIES', 2, 0, 5);
  const retryDelayMs = Number(options?.retryDelayMs) || numeroEnv('IA_HTTP_RETRY_DELAY_MS', 2000, 100, 60000);
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;
  let lastResponseMeta = null;

  while (attempt <= retries) {
    attempt += 1;

    let aiRes;
    try {
      aiRes = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = new Error(`Error de red llamando a OpenAI: ${err.message}`);
      if (attempt <= retries && esReintentableIA({ errorMessage: err.message })) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      break;
    }

    if (!aiRes.ok) {
      const text = await aiRes.text();
      lastError = new Error(`Error OpenAI ${aiRes.status}: ${text}`);
      lastError.status = aiRes.status;
      if (attempt <= retries && esReintentableIA({ status: aiRes.status, body: text })) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      break;
    }

    const aiJson = await aiRes.json();
    lastResponseMeta = {
      httpStatus: aiRes.status,
      responseId: aiJson?.id ?? null,
      responseStatus: aiJson?.status ?? null,
      incompleteReason: aiJson?.incomplete_details?.reason ?? null,
      inputTokens: aiJson?.usage?.input_tokens ?? null,
      outputTokens: aiJson?.usage?.output_tokens ?? null,
      reasoningTokens: aiJson?.usage?.output_tokens_details?.reasoning_tokens ?? null,
      totalTokens: aiJson?.usage?.total_tokens ?? null,
    };

    if (aiJson?.status === 'incomplete') {
      const reason = lastResponseMeta.incompleteReason || 'sin_motivo';
      lastError = new Error(
        `Respuesta OpenAI incompleta: ${reason}` +
        (lastResponseMeta.responseId ? ` (response_id=${lastResponseMeta.responseId})` : '')
      );
      lastError.status = aiRes.status;

      if (reason === 'max_output_tokens' && attempt <= retries) {
        const currentMax = Number(body.max_output_tokens || 0);
        body.max_output_tokens = Math.min(
          32000,
          Math.max(4000, currentMax ? currentMax * 2 : 8000)
        );
        await sleep(retryDelayMs * attempt);
        continue;
      }
      break;
    }

    const contenido = extraerTextoRespuesta(aiJson);

    if (!contenido) {
      lastError = new Error(
        'La IA no devolvio texto' +
        (lastResponseMeta.responseStatus ? ` (status=${lastResponseMeta.responseStatus})` : '') +
        (lastResponseMeta.responseId ? ` (response_id=${lastResponseMeta.responseId})` : '')
      );
      lastError.status = aiRes.status;
      if (attempt <= retries) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      break;
    }

    registrarIARun({
      task,
      model,
      status: 'ok',
      http_status: aiRes.status,
      attempts: attempt,
      duration_ms: Date.now() - startedAt,
      input_tokens: aiJson?.usage?.input_tokens ?? null,
      output_tokens: aiJson?.usage?.output_tokens ?? null,
      total_tokens: aiJson?.usage?.total_tokens ?? null,
      reasoning_tokens: aiJson?.usage?.output_tokens_details?.reasoning_tokens ?? null,
      response_id: aiJson?.id ?? null,
      response_status: aiJson?.status ?? null,
      incomplete_reason: aiJson?.incomplete_details?.reason ?? null,
      error_msg: null,
    });

    return contenido;
  }

  registrarIARun({
    task,
    model,
    status: 'error',
    http_status: lastResponseMeta?.httpStatus ?? lastError?.status ?? null,
    attempts: attempt,
    duration_ms: Date.now() - startedAt,
    input_tokens: lastResponseMeta?.inputTokens ?? null,
    output_tokens: lastResponseMeta?.outputTokens ?? null,
    total_tokens: lastResponseMeta?.totalTokens ?? null,
    reasoning_tokens: lastResponseMeta?.reasoningTokens ?? null,
    response_id: lastResponseMeta?.responseId ?? null,
    response_status: lastResponseMeta?.responseStatus ?? null,
    incomplete_reason: lastResponseMeta?.incompleteReason ?? null,
    error_msg: String(lastError?.message || 'error desconocido').slice(0, 800),
  });

  throw lastError || new Error('Error desconocido llamando a OpenAI');
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

module.exports = {
  llamarIA,
  parsearJSON,
  __testing: { esReintentableIA, extraerTextoRespuesta, extraerPrimerJSON },
};
