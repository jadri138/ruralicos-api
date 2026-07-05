#!/usr/bin/env node
/**
 * Ejecuta el pipeline diario completo de Ruralicos con reintentos por lotes.
 *
 * Uso:
 *   BASE_URL="https://tu-api.onrender.com" CRON_TOKEN="xxx" node scripts/run_digest_workflow.js
 *
 * Variables opcionales:
 *   FECHA=2026-07-05
 *   RUN_SCRAPERS=true
 *   RUN_OFFICIAL_LISTS=true
 *   RUN_REPAIR=true
 *   MAX_LOOPS=40
 *   STEP_DELAY_MS=800
 *   HTTP_RETRIES=3
 *   HTTP_RETRY_DELAY_MS=5000
 */

require('dotenv').config();

const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const CRON_TOKEN = process.env.CRON_TOKEN || '';
const FECHA = /^\d{4}-\d{2}-\d{2}$/.test(process.env.FECHA || '')
  ? process.env.FECHA
  : '';
const RUN_SCRAPERS = parseBool(process.env.RUN_SCRAPERS, true);
const RUN_OFFICIAL_LISTS = parseBool(process.env.RUN_OFFICIAL_LISTS, true);
const RUN_REPAIR = parseBool(process.env.RUN_REPAIR, true);
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

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'on'].includes(String(value).trim().toLowerCase());
}

function appendQuery(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }

  const suffix = query.toString();
  return suffix ? `${path}${path.includes('?') ? '&' : '?'}${suffix}` : path;
}

function conFecha(path) {
  return FECHA ? appendQuery(path, { fecha: FECHA }) : path;
}

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

async function hit(path, { method = 'GET' } = {}) {
  const url = `${BASE_URL}${path}`;

  for (let attempt = 1; attempt <= HTTP_RETRIES + 1; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'x-cron-token': CRON_TOKEN },
      });
      const body = await readResponseBody(res);

      if (!res.ok) {
        const err = new Error(`[${res.status}] ${method} ${path} -> ${JSON.stringify(body)}`);
        err.status = res.status;
        err.retryable = isRetryableStatus(res.status) &&
          !/429|quota|exceeded your current quota/i.test(JSON.stringify(body || {}));
        throw err;
      }

      return body;
    } catch (err) {
      const canRetry = attempt <= HTTP_RETRIES && isRetryableError(err);
      if (!canRetry) throw err;

      const delay = HTTP_RETRY_DELAY_MS * attempt;
      console.warn(`[http] ${method} ${path} fallo transitorio (${err.message}). Reintento ${attempt}/${HTTP_RETRIES} en ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function runBatchedStep(name, path, options = {}) {
  let loops = 0;
  let total = 0;
  let totalProgress = 0;
  let lastBody = null;

  while (loops < MAX_LOOPS) {
    loops++;
    const body = await hit(path, options);
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

async function runSingleStep(name, path, options = {}) {
  const body = await hit(path, options);
  console.log(`[${name}]`, body);
  return body;
}

async function runOptionalStep(name, path, options = {}) {
  try {
    return await runSingleStep(name, path, options);
  } catch (err) {
    console.warn(`[${name}] fase opcional omitida: ${err.message}`);
    return { ok: false, optional: true, skipped: true, error: err.message };
  }
}

async function main() {
  console.log('Iniciando workflow diario completo...', {
    baseUrl: BASE_URL,
    fecha: FECHA || 'hoy Madrid',
    runScrapers: RUN_SCRAPERS,
    runOfficialLists: RUN_OFFICIAL_LISTS,
    runRepair: RUN_REPAIR,
  });

  const scrapers = RUN_SCRAPERS
    ? await runSingleStep('scrapers-diario', conFecha('/tareas/scrapers-diario'))
    : { skipped: true };
  const cotejoListados = RUN_OFFICIAL_LISTS
    ? await runOptionalStep('cotejar-listados-oficiales', conFecha('/tareas/cotejar-listados-oficiales?enviar=false'))
    : { skipped: true };
  const repararPendientes = RUN_REPAIR
    ? await runSingleStep('reparar-pendientes-ia', conFecha('/alertas/reparar-pendientes-ia'), { method: 'POST' })
    : { skipped: true };

  const clasificar = await runBatchedStep('clasificar', '/alertas/clasificar');
  const resumir = await runBatchedStep('resumir', '/alertas/resumir');
  const revisar = await runBatchedStep('revisar', '/alertas/revisar');

  const deduplicar = await runSingleStep('deduplicar', conFecha('/alertas/deduplicar'));
  const miaEmbeddings = await runOptionalStep('mia-embeddings', '/cerebro/embeddings/inicializar?limit=100&maxLoops=10');
  const miaCicloPreDigest = await runOptionalStep('mia-ciclo-pre-digest', '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1');
  const prepararDigest = await runBatchedStep('preparar-digest', conFecha('/alertas/preparar-digest'));
  const enviarDigest = await runSingleStep('enviar-digest', conFecha('/alertas/enviar-digest'));
  const miaCicloPostDigest = await runOptionalStep('mia-ciclo-post-digest', '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1');

  const generarFree = await runSingleStep('generar-resumen-free', conFecha('/alertas/generar-resumen-free'));
  const enviarFree = await runSingleStep('enviar-resumen-free', conFecha('/alertas/enviar-resumen-free'));

  console.log('Workflow completado', {
    scrapers: scrapers?.success ?? scrapers?.skipped ?? null,
    cotejoListados: cotejoListados?.success ?? cotejoListados?.skipped ?? null,
    repararPendientes: repararPendientes?.success ?? repararPendientes?.skipped ?? null,
    clasificar,
    resumir,
    revisar,
    deduplicar: deduplicar?.deduplicadas ?? null,
    miaEmbeddings: miaEmbeddings?.ok ?? null,
    miaCicloPreDigest: miaCicloPreDigest?.ok ?? null,
    prepararDigest: prepararDigest?.totalProgress ?? null,
    enviarDigest: enviarDigest?.enviados ?? null,
    miaCicloPostDigest: miaCicloPostDigest?.ok ?? null,
    generarFree: generarFree?.procesadas ?? null,
    enviarFree: enviarFree?.ok ?? null,
  });
}

main().catch((err) => {
  console.error('Error en workflow:', err.message);
  process.exit(1);
});
