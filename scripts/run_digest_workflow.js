#!/usr/bin/env node
/**
 * Puente compatible para el cron historico de Render.
 *
 * Por defecto llama repetidamente a /tareas/pipeline-tick hasta que el job con
 * checkpoints termina. Así el comando antiguo sigue funcionando sin ejecutar
 * un segundo pipeline independiente. El flujo legacy queda disponible solo
 * para un rescate manual y explícito.
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
 *   PREPARAR_DIGEST_MAX_LOOPS=200
 *   STEP_DELAY_MS=800
 *   HTTP_RETRIES=3
 *   HTTP_RETRY_DELAY_MS=5000
 *   PIPELINE_DRIVER_MAX_TICKS=60
 *   PIPELINE_DRIVER_DELAY_MS=1000
 *   PIPELINE_DRIVER_BUDGET_MS=50000
 *   ALLOW_LEGACY_DIGEST_WORKFLOW=true  (fuerza el flujo antiguo; solo rescate)
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
const PREPARAR_DIGEST_MAX_LOOPS = Number(process.env.PREPARAR_DIGEST_MAX_LOOPS || 200);
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || 800);
const HTTP_RETRIES = Number(process.env.HTTP_RETRIES || 3);
const HTTP_RETRY_DELAY_MS = Number(process.env.HTTP_RETRY_DELAY_MS || 5000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 65000);
const PIPELINE_DRIVER_MAX_TICKS = Number(process.env.PIPELINE_DRIVER_MAX_TICKS || 60);
const PIPELINE_DRIVER_DELAY_MS = Number(process.env.PIPELINE_DRIVER_DELAY_MS || 1000);
const PIPELINE_DRIVER_BUDGET_MS = Number(process.env.PIPELINE_DRIVER_BUDGET_MS || 50000);
const ALLOW_LEGACY_DIGEST_WORKFLOW = parseBool(
  process.env.ALLOW_LEGACY_DIGEST_WORKFLOW,
  false
);
const BATCH_METRIC_KEYS = [
  'digests_generados',
  'rescates_generados',
  'usuarios_sin_alertas',
  'usuarios_sin_telefono',
  'saltados',
  'fallback_local',
];

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

async function hit(path, { method = 'GET', maxRetries = HTTP_RETRIES } = {}) {
  const url = `${BASE_URL}${path}`;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'x-cron-token': CRON_TOKEN },
        signal: controller.signal,
      });
      const body = await readResponseBody(res);

      if (!res.ok) {
        const err = new Error(`[${res.status}] ${method} ${path} -> ${JSON.stringify(body)}`);
        err.status = res.status;
        err.retryable = isRetryableStatus(res.status) &&
          body?.retryable !== false &&
          !/429|quota|exceeded your current quota/i.test(JSON.stringify(body || {}));
        throw err;
      }

      return body;
    } catch (rawError) {
      const err = rawError?.name === 'AbortError'
        ? Object.assign(new Error(`${method} ${path}: timeout tras ${HTTP_TIMEOUT_MS}ms`), {
          retryable: true,
        })
        : rawError;
      const canRetry = attempt <= maxRetries && isRetryableError(err);
      if (!canRetry) throw err;

      const delay = HTTP_RETRY_DELAY_MS * attempt;
      console.warn(`[http] ${method} ${path} fallo transitorio (${err.message}). Reintento ${attempt}/${maxRetries} en ${delay}ms`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function runBatchedStep(name, path, options = {}, maxLoops = MAX_LOOPS) {
  let loops = 0;
  let total = 0;
  let totalProgress = 0;
  let lastBody = null;
  const metrics = Object.fromEntries(BATCH_METRIC_KEYS.map((key) => [key, 0]));

  while (loops < maxLoops) {
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
    for (const key of BATCH_METRIC_KEYS) {
      const value = Number(body?.[key]);
      if (Number.isFinite(value)) metrics[key] += value;
    }

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

  if (loops === maxLoops) {
    throw new Error(
      `[${name}] alcanzo MAX_LOOPS=${maxLoops}. No se prepara digest incompleto. ` +
      `Total candidatas=${total}, actualizaciones=${totalProgress}. Ultima respuesta: ${JSON.stringify(lastBody)}`
    );
  }

  return { loops, total, totalProgress, metrics };
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

async function mainPipelineDriver() {
  console.log('Iniciando pipeline reanudable desde el comando cron compatible...', {
    baseUrl: BASE_URL,
    fecha: FECHA || 'hoy Madrid',
    maxTicks: PIPELINE_DRIVER_MAX_TICKS,
  });

  const path = appendQuery('/tareas/pipeline-tick', {
    fecha: FECHA,
    budget_ms: PIPELINE_DRIVER_BUDGET_MS,
    complementarios: RUN_SCRAPERS,
    enviar_listados: RUN_OFFICIAL_LISTS,
  });

  for (let tickNumber = 1; tickNumber <= PIPELINE_DRIVER_MAX_TICKS; tickNumber++) {
    const body = await hit(path);
    const tick = body?.tick || 'respuesta_desconocida';
    const jobStatus = body?.job?.status || null;
    const currentStage = body?.job?.current_stage || null;
    console.log(`[pipeline-driver] tick ${tickNumber}: ${tick}`, {
      jobStatus,
      currentStage,
    });

    if (tick === 'completed' || (tick === 'noop_terminal' && jobStatus === 'completed')) {
      console.log('Pipeline diario completado con checkpoints', {
        ticks_driver: tickNumber,
        job_id: body?.job?.id || null,
      });
      return;
    }
    if (['failed', 'aborted', 'preflight_failed'].includes(tick)) {
      throw new Error(
        `pipeline ${tick} en ${currentStage || 'fase desconocida'}: ${body?.error || 'revisa pipeline_jobs'}`
      );
    }
    if (tick === 'noop_terminal') {
      throw new Error(`pipeline ya estaba en estado terminal ${jobStatus || 'desconocido'}`);
    }
    await sleep(PIPELINE_DRIVER_DELAY_MS);
  }

  throw new Error(
    `pipeline no termino tras ${PIPELINE_DRIVER_MAX_TICKS} ticks; queda reanudable y no se ejecutara un flujo paralelo`
  );
}

async function mainLegacy() {
  console.warn('Ejecutando workflow LEGACY de rescate sin checkpoints.');
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
  const prepararDigest = await runBatchedStep(
    'preparar-digest',
    conFecha('/alertas/preparar-digest'),
    {},
    PREPARAR_DIGEST_MAX_LOOPS
  );
  const digestsPreparados = Number(prepararDigest.metrics.digests_generados || 0);
  const rescatesPreparados = Number(prepararDigest.metrics.rescates_generados || 0);
  if (prepararDigest.totalProgress > 0 && digestsPreparados + rescatesPreparados === 0) {
    console.warn('[digest-silence] Se evaluaron usuarios pero no se creo ningun digest', {
      usuarios_evaluados: prepararDigest.totalProgress,
      ...prepararDigest.metrics,
    });
  }
  const enviarDigest = await runSingleStep('enviar-digest', conFecha('/alertas/enviar-digest'));
  const miaCicloPostDigest = await runOptionalStep('mia-ciclo-post-digest', '/cerebro/ciclo-diario?explorar=true&dryRunExploracion=false&limit=100&maxLoops=1');

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
    prepararDigest: {
      usuarios_evaluados: prepararDigest?.totalProgress ?? null,
      ...prepararDigest.metrics,
    },
    enviarDigest: enviarDigest?.enviados ?? null,
    miaCicloPostDigest: miaCicloPostDigest?.ok ?? null,
    generarFree: generarFree?.procesadas ?? null,
    enviarFree: enviarFree?.success ?? enviarFree?.ok ?? null,
  });
}

(ALLOW_LEGACY_DIGEST_WORKFLOW ? mainLegacy() : mainPipelineDriver()).catch((err) => {
  console.error('Error en workflow:', err.message);
  process.exit(1);
});
