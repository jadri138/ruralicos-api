#!/usr/bin/env node
/**
 * Ejecuta el pipeline diario completo de Ruralicos con reintentos por lotes.
 *
 * Uso:
 *   BASE_URL="https://tu-api.onrender.com" CRON_TOKEN="xxx" node scripts/run_digest_workflow.js
 *
 * Variables opcionales:
 *   MAX_LOOPS=40
 *   STEP_DELAY_MS=800
 *   HTTP_RETRIES=3
 *   HTTP_RETRY_DELAY_MS=5000
 */

const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const CRON_TOKEN = process.env.CRON_TOKEN || '';
const MAX_LOOPS = Number(process.env.MAX_LOOPS || 40);
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || 800);
const HTTP_RETRIES = Number(process.env.HTTP_RETRIES || 3);
const HTTP_RETRY_DELAY_MS = Number(process.env.HTTP_RETRY_DELAY_MS || 5000);

if (!BASE_URL) {
  console.error('Falta BASE_URL');
  process.exit(1);
}

if (!CRON_TOKEN) {
  console.error('Falta CRON_TOKEN');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readResponseBody(res) {
  const raw = await res.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.replace(/\s+/g, ' ').slice(0, 800) };
  }
}

function isRetryableStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableError(err) {
  return err?.retryable === true || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(err?.message || ''));
}

async function hit(path) {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(CRON_TOKEN)}`;

  for (let attempt = 1; attempt <= HTTP_RETRIES + 1; attempt++) {
    try {
      const res = await fetch(url, { method: 'GET' });
      const body = await readResponseBody(res);

      if (!res.ok) {
        const err = new Error(`[${res.status}] ${path} -> ${JSON.stringify(body)}`);
        err.status = res.status;
        err.retryable = isRetryableStatus(res.status);
        throw err;
      }

      return body;
    } catch (err) {
      const canRetry = attempt <= HTTP_RETRIES && isRetryableError(err);
      if (!canRetry) throw err;

      const delay = HTTP_RETRY_DELAY_MS * attempt;
      console.warn(`[http] ${path} fallo transitorio (${err.message}). Reintento ${attempt}/${HTTP_RETRIES} en ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function runBatchedStep(name, path) {
  let loops = 0;
  let total = 0;
  let totalProgress = 0;
  let lastBody = null;

  while (loops < MAX_LOOPS) {
    loops++;
    const body = await hit(path);
    const procesadas = Number(body?.procesadas ?? 0);
    const progress = Number(
      body?.actualizadas ??
      body?.aprobadas ??
      ((Number(body?.clasificadas ?? body?.clasificados ?? 0) + Number(body?.descartadas ?? 0)) || 0)
    );
    total += procesadas;
    totalProgress += progress;
    lastBody = body;

    console.log(`[${name}] vuelta ${loops}: procesadas=${procesadas}, actualizadas=${progress}`);

    if (procesadas === 0) break;
    if (progress === 0) {
      throw new Error(
        `[${name}] bloqueado: el endpoint devolvio ${procesadas} candidatas pero 0 actualizaciones. ` +
        `No se prepara digest incompleto. Ultima respuesta: ${JSON.stringify(body)}`
      );
    }
    await sleep(STEP_DELAY_MS);
  }

  if (loops === MAX_LOOPS) {
    throw new Error(
      `[${name}] alcanzo MAX_LOOPS=${MAX_LOOPS}. No se prepara digest incompleto. ` +
      `Total candidatas=${total}, actualizaciones=${totalProgress}. Ultima respuesta: ${JSON.stringify(lastBody)}`
    );
  }

  return { loops, total, totalProgress };
}

async function runSingleStep(name, path) {
  const body = await hit(path);
  console.log(`[${name}]`, body);
  return body;
}

async function runOptionalStep(name, path) {
  try {
    return await runSingleStep(name, path);
  } catch (err) {
    console.warn(`[${name}] fase opcional omitida: ${err.message}`);
    return { ok: false, optional: true, skipped: true, error: err.message };
  }
}

async function main() {
  console.log('▶ Iniciando workflow digest diario...');

  const clasificar = await runBatchedStep('clasificar', '/alertas/clasificar');
  const resumir = await runBatchedStep('resumir', '/alertas/resumir');
  const revisar = await runBatchedStep('revisar', '/alertas/revisar');

  const deduplicar = await runSingleStep('deduplicar', '/alertas/deduplicar');
  const miaEmbeddings = await runOptionalStep('mia-embeddings', '/cerebro/embeddings/inicializar?limit=100&maxLoops=10');
  const miaCicloPreDigest = await runOptionalStep('mia-ciclo-pre-digest', '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1');
  const prepararDigest = await runSingleStep('preparar-digest', '/alertas/preparar-digest');
  const enviarDigest = await runSingleStep('enviar-digest', '/alertas/enviar-digest');
  const miaCicloPostDigest = await runOptionalStep('mia-ciclo-post-digest', '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1');

  const generarFree = await runSingleStep('generar-resumen-free', '/alertas/generar-resumen-free');
  const enviarFree = await runSingleStep('enviar-resumen-free', '/alertas/enviar-resumen-free');

  console.log('✅ Workflow completado', {
    clasificar,
    resumir,
    revisar,
    deduplicar: deduplicar?.deduplicadas ?? null,
    miaEmbeddings: miaEmbeddings?.ok ?? null,
    miaCicloPreDigest: miaCicloPreDigest?.ok ?? null,
    prepararDigest: prepararDigest?.digests_generados ?? null,
    enviarDigest: enviarDigest?.enviados ?? null,
    miaCicloPostDigest: miaCicloPostDigest?.ok ?? null,
    generarFree: generarFree?.procesadas ?? null,
    enviarFree: enviarFree?.ok ?? null,
  });
}

main().catch((err) => {
  console.error('❌ Error en workflow:', err.message);
  process.exit(1);
});

