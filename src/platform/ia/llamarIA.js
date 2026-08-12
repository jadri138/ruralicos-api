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

const { OPENAI_MODELS, defaultReasoningForModel } = require('./modelPolicy');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function numeroEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function pricingForModel(pricing, model) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return null;
  const models = pricing.models && typeof pricing.models === 'object' ? pricing.models : pricing;
  const selected = models[model] || (
    Object.prototype.hasOwnProperty.call(pricing, 'input_per_million') ? pricing : null
  );
  return selected && typeof selected === 'object' && !Array.isArray(selected) ? selected : null;
}

function deriveUsageCost({ model, usage, pricing } = {}) {
  const rates = pricingForModel(pricing, model);
  if (!rates || !usage || typeof usage !== 'object') return null;
  const currency = String(rates.currency || '').trim().toUpperCase();
  const inputRate = Number(rates.input_per_million);
  const cachedRate = Number(rates.cached_input_per_million);
  const outputRate = Number(rates.output_per_million);
  const inputTokens = Number(usage.input_tokens);
  const outputTokens = Number(usage.output_tokens);
  const cachedInputTokens = Math.max(0, Math.min(
    Number.isFinite(inputTokens) ? inputTokens : 0,
    Number(usage.cached_input_tokens) || 0
  ));
  if (!currency
    || !Number.isFinite(inputTokens)
    || !Number.isFinite(outputTokens)
    || !Number.isFinite(inputRate)
    || !Number.isFinite(outputRate)
    || inputRate < 0
    || outputRate < 0
    || (cachedInputTokens > 0 && (!Number.isFinite(cachedRate) || cachedRate < 0))) {
    return null;
  }
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const amount = (
    (uncachedInputTokens * inputRate)
    + (cachedInputTokens * (cachedInputTokens > 0 ? cachedRate : 0))
    + (outputTokens * outputRate)
  ) / 1_000_000;
  return {
    amount: Number(amount.toFixed(8)),
    currency,
    estimated: true,
    basis: {
      model,
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      output_tokens: outputTokens,
      input_per_million: inputRate,
      cached_input_per_million: cachedInputTokens > 0 ? cachedRate : null,
      output_per_million: outputRate,
    },
  };
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
async function llamarIA(prompt, instructions, model = OPENAI_MODELS.economy, options = {}) {
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
  } else {
    const defaultReasoning = defaultReasoningForModel(model);
    // Reserva el presupuesto de salida al JSON o texto visible en vez de
    // aceptar el razonamiento medio que algunos modelos usan por omision.
    if (defaultReasoning) body.reasoning = defaultReasoning;
  }

  const fetchImpl = options?.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options?.timeoutMs) || numeroEnv('IA_TIMEOUT_MS', 90000, 5000, 600000);
  const retries = Number.isFinite(Number(options?.retries))
    ? Math.max(0, Math.min(5, Number(options.retries)))
    : numeroEnv('IA_HTTP_RETRIES', 2, 0, 5);
  const retryDelayMs = Number(options?.retryDelayMs) || numeroEnv('IA_HTTP_RETRY_DELAY_MS', 2000, 100, 60000);
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;
  let lastResponseMeta = null;
  const accumulatedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
    cached_input_tokens: 0,
  };
  let hasUsage = false;

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
    const responseUsage = {
      input_tokens: aiJson?.usage?.input_tokens ?? null,
      output_tokens: aiJson?.usage?.output_tokens ?? null,
      total_tokens: aiJson?.usage?.total_tokens ?? null,
      reasoning_tokens: aiJson?.usage?.output_tokens_details?.reasoning_tokens ?? null,
      cached_input_tokens: aiJson?.usage?.input_tokens_details?.cached_tokens ?? null,
    };
    for (const [key, value] of Object.entries(responseUsage)) {
      if (value !== null && Number.isFinite(Number(value))) {
        accumulatedUsage[key] += Number(value);
        hasUsage = true;
      }
    }
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

    if (options?.skipAudit !== true) registrarIARun({
      task,
      model,
      status: 'ok',
      http_status: aiRes.status,
      attempts: attempt,
      duration_ms: Date.now() - startedAt,
      input_tokens: hasUsage ? accumulatedUsage.input_tokens : null,
      output_tokens: hasUsage ? accumulatedUsage.output_tokens : null,
      total_tokens: hasUsage ? accumulatedUsage.total_tokens : null,
      reasoning_tokens: hasUsage ? accumulatedUsage.reasoning_tokens : null,
      response_id: aiJson?.id ?? null,
      response_status: aiJson?.status ?? null,
      incomplete_reason: aiJson?.incomplete_details?.reason ?? null,
      error_msg: null,
    });

    if (options?.returnMetadata === true) {
      const usage = hasUsage ? { ...accumulatedUsage } : null;
      return {
        text: contenido,
        metadata: {
          model,
          response_id: aiJson?.id ?? null,
          response_status: aiJson?.status ?? null,
          attempts: attempt,
          duration_ms: Date.now() - startedAt,
          usage,
          cost: deriveUsageCost({ model, usage, pricing: options?.pricing }),
        },
      };
    }

    return contenido;
  }

  if (options?.skipAudit !== true) registrarIARun({
    task,
    model,
    status: 'error',
    http_status: lastResponseMeta?.httpStatus ?? lastError?.status ?? null,
    attempts: attempt,
    duration_ms: Date.now() - startedAt,
    input_tokens: hasUsage ? accumulatedUsage.input_tokens : null,
    output_tokens: hasUsage ? accumulatedUsage.output_tokens : null,
    total_tokens: hasUsage ? accumulatedUsage.total_tokens : null,
    reasoning_tokens: hasUsage ? accumulatedUsage.reasoning_tokens : null,
    response_id: lastResponseMeta?.responseId ?? null,
    response_status: lastResponseMeta?.responseStatus ?? null,
    incomplete_reason: lastResponseMeta?.incompleteReason ?? null,
    error_msg: String(lastError?.message || 'error desconocido').slice(0, 800),
  });

  if (lastError && options?.returnMetadata === true) {
    lastError.metadata = {
      model,
      response_id: lastResponseMeta?.responseId ?? null,
      response_status: lastResponseMeta?.responseStatus ?? null,
      attempts: attempt,
      duration_ms: Date.now() - startedAt,
      usage: hasUsage ? { ...accumulatedUsage } : null,
      cost: deriveUsageCost({
        model,
        usage: hasUsage ? accumulatedUsage : null,
        pricing: options?.pricing,
      }),
    };
  }

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
  __testing: {
    esReintentableIA,
    extraerTextoRespuesta,
    extraerPrimerJSON,
    deriveUsageCost,
  },
};
