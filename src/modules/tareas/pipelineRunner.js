// src/modules/tareas/pipelineRunner.js
//
// C1: runner de pipeline con checkpoints (sustituye al HTTP-larguisimo de
// /tareas/pipeline-diario y a los crons sueltos por endpoint).
//
// Modelo: UN cron dispara /tareas/pipeline-tick cada ~10 min. Cada tick
// reclama el pipeline_job del dia (claim + heartbeat), avanza fases dentro de
// su presupuesto de tiempo (budgetMs, pensado para el timeout de proxy de
// Render) y guarda checkpoint en pipeline_jobs.stages_json — incluso vuelta a
// vuelta dentro de las fases por lotes. El siguiente tick reanuda donde quedo.
//
// Sombra (shadow=true): ejecuta toda la maquinaria PERO no llama a las fases
// que envian WhatsApp (outbound), no escribe scraper_runs (para no contaminar
// el vigia de salud de fuentes) y registra sus pipeline_runs con el stage
// prefijado 'shadow:'. Pensada para correr en paralelo a los crons reales y
// validar la orquestacion antes del cutover.

const { getFechaMadridISO } = require('../../shared/fechaMadrid');
const { enviarWhatsAppAdmin } = require('../../platform/whatsapp');
const { evaluarRespuestaScraper } = require('../boletines/scraperRunQuality');
const { omitirScraperSiCapturado } = require('../boletines/scraperSkip');
const {
  getPipelineScrapePaths,
  appendQuery,
  buildCronFetchOptions,
  buildComplementaryScrapeUrl,
  obtenerFuenteScraper,
  numeroBody,
  readResponseBody,
  isRetryableStatus,
  isRetryableError,
  guardarScraperRun,
  guardarPipelineRun,
} = require('./tareas.helpers');
const { crearPipelineJobsStore, nuevoTickId, JOB_STATUS_TERMINAL } = require('./pipelineJobs');

const STAGE_PENDING = 'pending';
const STAGE_COMPLETED = 'completed';
const STAGE_FAILED = 'failed';
const STAGE_SKIPPED = 'skipped';
const STAGE_SHADOW_SKIPPED = 'shadow_skipped';
const STAGE_ABORTED = 'aborted';

// Mismo orden y semantica que /tareas/pipeline-diario.
function construirStagesPipeline(opciones = {}) {
  const enviarListados = Boolean(opciones.enviar_listados);
  const limitListados = Number(opciones.limit_listados || 500);

  return [
    { name: 'scrapers', type: 'scrapers' },
    {
      name: 'cotejar_listados_oficiales',
      type: 'simple',
      optional: true,
      path: `/tareas/cotejar-listados-oficiales?enviar=${enviarListados ? 'true' : 'false'}&limit=${encodeURIComponent(limitListados)}`,
    },
    { name: 'reparar_pendientes_ia', type: 'simple', path: '/alertas/reparar-pendientes-ia', method: 'POST' },
    { name: 'clasificar', type: 'batched', path: '/alertas/clasificar', abortaSiLimitado: true },
    { name: 'resumir', type: 'batched', path: '/alertas/resumir', abortaSiLimitado: true },
    { name: 'revisar', type: 'batched', path: '/alertas/revisar', abortaSiLimitado: true },
    { name: 'deduplicar', type: 'simple', path: '/alertas/deduplicar' },
    { name: 'mia_embeddings_inicializar', type: 'simple', optional: true, path: '/cerebro/embeddings/inicializar?limit=100&maxLoops=10' },
    { name: 'mia_ciclo_pre_digest', type: 'simple', optional: true, path: '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1' },
    { name: 'preparar_digest', type: 'batched', path: '/alertas/preparar-digest', abortaSiLimitado: true },
    { name: 'enviar_digest', type: 'simple', path: '/alertas/enviar-digest', outbound: true },
    { name: 'mia_ciclo_post_digest', type: 'simple', optional: true, path: '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1' },
    { name: 'mia_outbox', type: 'simple', optional: true, path: '/tareas/mia-outbox?limit=50', outbound: true },
    { name: 'generar_resumen_free', type: 'simple', path: '/alertas/generar-resumen-free' },
    { name: 'enviar_resumen_free', type: 'simple', path: '/alertas/enviar-resumen-free', outbound: true },
    { name: 'estado_pipeline_final', type: 'simple', path: '/alertas/estado-pipeline' },
  ];
}

// Ejecutor HTTP contra la propia API (mismos reintentos que pipeline-diario).
function crearEjecutorHttp({
  baseUrl,
  token,
  fecha,
  opciones = {},
  httpRetries = Number(process.env.PIPELINE_HTTP_RETRIES || 3),
  httpRetryDelayMs = Number(process.env.PIPELINE_HTTP_RETRY_DELAY_MS || 5000),
  httpTimeoutMs = Number(process.env.PIPELINE_HTTP_TIMEOUT_MS || 20000),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const scrapePaths = getPipelineScrapePaths({
    incluirComplementarios: opciones.complementarios !== false,
    incluirFega: opciones.fega !== false,
  });

  function buildUrl(path) {
    if (scrapePaths.includes(path)) {
      return buildComplementaryScrapeUrl(baseUrl, path, fecha, {
        ejercicio: opciones.ejercicio_fega || null,
        enviarFega: Boolean(opciones.enviar_fega),
      });
    }
    return appendQuery(baseUrl, path, { fecha });
  }

  return async function ejecutar(path, method = 'GET') {
    const url = buildUrl(path);

    for (let attempt = 1; attempt <= httpRetries + 1; attempt++) {
      // Timeout duro por request: sin esto, una fuente que acepta la conexion y
      // no responde cuelga el tick indefinidamente y Render lo mata a los ~55s
      // ANTES de que se escriba ningun checkpoint (job huerfano en 'running').
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
      try {
        const response = await fetch(url, buildCronFetchOptions(token, method, { signal: controller.signal }));
        const body = await readResponseBody(response);

        if (!response.ok) {
          const err = new Error(`${path} devolvio ${response.status}: ${JSON.stringify(body)}`);
          err.status = response.status;
          err.body = body;
          err.retryable = isRetryableStatus(response.status) &&
            !/429|quota|exceeded your current quota/i.test(JSON.stringify(body || {}));
          throw err;
        }

        return { path, status: response.status, body };
      } catch (rawErr) {
        // Un corte por timeout llega como AbortError: lo normalizamos a un error
        // claro y NO reintentable en el mismo tick (reintentar 3x20s reventaria
        // el presupuesto). La fase de scrapers lo captura y sigue; las demas lo
        // reintentan en el SIGUIENTE tick (la cadencia del cron hace de backoff).
        const err = (rawErr && (rawErr.name === 'AbortError' || controller.signal.aborted))
          ? Object.assign(new Error(`${path}: timeout tras ${httpTimeoutMs}ms`), { retryable: false, timeout: true })
          : rawErr;

        const canRetry = attempt <= httpRetries && isRetryableError(err);
        if (!canRetry) throw err;

        const delay = httpRetryDelayMs * attempt;
        console.warn(`[pipeline-tick] ${path} fallo transitorio (${err.message}). Reintento ${attempt}/${httpRetries} en ${delay}ms`);
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
    return null; // inalcanzable
  };
}

// Preflight: comprueba que la base URL interna responde a /health antes de
// tocar el job. Un host que acepta la conexion y nunca responde (p.ej. dominio
// custom sin origen detras) colgaba el primer self-fetch del tick sin dejar
// rastro; con esto el fallo de configuracion es inmediato y visible en la
// respuesta del cron, y el job del dia ni se crea ni se reclama.
async function verificarBaseUrlInterna(baseUrl, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  if (!baseUrl) return { ok: false, error: 'base URL interna vacia' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `/health devolvio ${response.status}` };
    return { ok: true };
  } catch (err) {
    const motivo = err?.name === 'AbortError' || controller.signal.aborted
      ? `sin respuesta tras ${timeoutMs}ms`
      : String(err?.message || err);
    return { ok: false, error: `no responde: ${motivo}` };
  } finally {
    clearTimeout(timer);
  }
}

function progresoBody(body) {
  return Number(
    body?.actualizadas ??
    body?.aprobadas ??
    ((Number(body?.clasificadas ?? body?.clasificados ?? 0) + Number(body?.descartadas ?? 0)) || 0)
  );
}

function resumenStages(stagesState) {
  const resumen = {};
  for (const [name, state] of Object.entries(stagesState || {})) {
    resumen[name] = {
      status: state.status,
      attempts: state.attempts || 0,
      ...(state.loops !== undefined ? { loops: state.loops, total: state.total } : {}),
      ...(state.fallidos ? { fallidos: state.fallidos } : {}),
    };
  }
  return resumen;
}

async function ejecutarPipelineTick(supabase, opcionesTick = {}) {
  const {
    fecha = getFechaMadridISO(),
    kind = 'daily',
    shadow = false,
    reset = false,
    force = false,
    budgetMs = Number(process.env.PIPELINE_TICK_BUDGET_MS || 55000),
    // Reserva de presupuesto: no se arranca una request nueva si no cabe entera
    // antes del deadline. Asi ninguna llamada rebasa el timeout de proxy de
    // Render (~55s). En prod se pone = PIPELINE_HTTP_TIMEOUT_MS; 0 = comportamiento
    // antiguo (los tests inyectan reloj y no lo necesitan).
    reservaMs = Number(process.env.PIPELINE_TICK_RESERVE_MS || 0),
    httpTimeoutMs = Number(process.env.PIPELINE_HTTP_TIMEOUT_MS || 20000),
    staleMs = Number(process.env.PIPELINE_TICK_STALE_MS || 5 * 60 * 1000),
    maxAttempts = Number(process.env.PIPELINE_STAGE_MAX_ATTEMPTS || 3),
    maxLoops = Number(process.env.PIPELINE_MAX_LOOPS || 40),
    stepDelayMs = Number(process.env.PIPELINE_STEP_DELAY_MS || 800),
    baseUrl = '',
    token = process.env.CRON_TOKEN,
    jobOptions = {},
    preflightTimeoutMs = Number(process.env.PIPELINE_PREFLIGHT_TIMEOUT_MS || 5000),
    // Inyectables (tests)
    preflight = undefined,
    store: storeParam = null,
    ejecutar: ejecutarParam = null,
    avisarAdmin = enviarWhatsAppAdmin,
    guardarRunPipeline = guardarPipelineRun,
    guardarRunScraper = guardarScraperRun,
    omitirScraper = omitirScraperSiCapturado,
    evaluarScraper = evaluarRespuestaScraper,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ahora = () => Date.now(),
  } = opcionesTick;

  // Preflight de la base URL interna. Solo en modo real: los tests inyectan
  // `ejecutar` y no hacen self-fetch. Inyectable via opcionesTick.preflight.
  const comprobarBase = preflight !== undefined
    ? preflight
    : (ejecutarParam ? null : () => verificarBaseUrlInterna(baseUrl, { timeoutMs: preflightTimeoutMs }));
  if (comprobarBase) {
    const salud = await comprobarBase();
    if (!salud?.ok) {
      const motivo = `base URL interna no utilizable (${baseUrl || 'vacia'}): ${salud?.error || 'sin detalle'}`;
      console.error(`[pipeline-tick] preflight fallido: ${motivo}`);
      return { ok: false, tick: 'preflight_failed', fecha, shadow, error: motivo };
    }
  }

  const store = storeParam || crearPipelineJobsStore(supabase);
  const tickId = nuevoTickId();

  let job = await store.obtenerOCrear({ kind, fecha, shadow, options: jobOptions });

  // reset reabre un job para reintentar el dia. Ademas de los terminales
  // (failed/aborted), rescata un 'running' con el heartbeat rancio: un tick que
  // murio sin liberar el claim (p.ej. corte de Render a los 55s). No toca un
  // running vivo (heartbeat fresco) para no pisar un tick en marcha.
  const heartbeatMs = job.heartbeat_at ? new Date(job.heartbeat_at).getTime() : 0;
  const heartbeatRancio = !job.heartbeat_at || (ahora() - heartbeatMs) > staleMs;
  if (reset && (JOB_STATUS_TERMINAL.has(job.status) || (job.status === 'running' && heartbeatRancio))) {
    job = await store.reabrir({ jobId: job.id });
  }

  if (JOB_STATUS_TERMINAL.has(job.status)) {
    return {
      ok: true,
      tick: 'noop_terminal',
      fecha,
      shadow,
      job: { id: job.id, status: job.status, current_stage: job.current_stage, ticks: job.ticks },
      stages: resumenStages(job.stages_json),
    };
  }

  const claimed = await store.reclamar({ job, tickId, staleMs, now: new Date(ahora()) });
  if (!claimed) {
    return {
      ok: true,
      tick: 'already_running',
      fecha,
      shadow,
      job: { id: job.id, status: job.status, current_stage: job.current_stage, ticks: job.ticks },
    };
  }

  const opcionesJob = claimed.options_json || {};
  const stages = construirStagesPipeline(opcionesJob);
  const stagesState = { ...(claimed.stages_json || {}) };
  const deadline = ahora() + budgetMs;
  const ejecutar = ejecutarParam || crearEjecutorHttp({ baseUrl, token, fecha, opciones: opcionesJob, httpTimeoutMs, sleep });

  // Tras un reset, las fases failed/aborted vuelven a pending con el contador
  // de vueltas y los flags de bloqueo limpios (si no, re-abortarian al instante).
  if (reset) {
    for (const state of Object.values(stagesState)) {
      if (state.status === STAGE_FAILED || state.status === STAGE_ABORTED) {
        state.status = STAGE_PENDING;
        state.attempts = 0;
        state.loops = 0;
        delete state.bloqueado;
        delete state.cola_vacia;
        delete state.max_loops_alcanzado;
      }
    }
  }

  const nowISO = () => new Date(ahora()).toISOString();
  // Reserva: exige que quepa una request entera (reservaMs) antes del deadline.
  const quedaPresupuesto = () => ahora() + reservaMs < deadline;

  async function checkpoint(currentStage, extraPatch = {}) {
    await store.guardar({
      jobId: claimed.id,
      tickId,
      patch: { stages_json: stagesState, current_stage: currentStage, ...extraPatch },
    });
  }

  async function registrarRunStage(stageDef, state, status, extra = {}) {
    await guardarRunPipeline(supabase, {
      stage: shadow ? `shadow:${stageDef.name}` : stageDef.name,
      endpoint: stageDef.path || '/tareas/pipeline-tick',
      fecha_objetivo: fecha,
      started_at: state.started_at || nowISO(),
      finished_at: nowISO(),
      duration_ms: state.started_at ? ahora() - new Date(state.started_at).getTime() : 0,
      status,
      loops: state.loops ?? null,
      procesadas: state.total ?? numeroBody(state.resumen, ['procesadas', 'reparadas', 'deduplicadas', 'digests_generados', 'enviados']),
      error_msg: extra.error_msg || null,
      response_json: extra.response_json ?? state.resumen ?? null,
    });
  }

  async function avisarAdminPipeline(mensaje) {
    if (shadow) return { shadow: true, mensaje };
    return avisarAdmin(mensaje);
  }

  async function terminarJob(status, currentStage, errorMsg = null) {
    await store.guardar({
      jobId: claimed.id,
      tickId,
      patch: {
        stages_json: stagesState,
        current_stage: currentStage,
        status,
        error_msg: errorMsg,
        finished_at: nowISO(),
      },
    });
  }

  function respuesta(tick, extra = {}) {
    return {
      ok: !['aborted', 'failed'].includes(tick),
      tick,
      fecha,
      shadow,
      tick_id: tickId,
      job: { id: claimed.id, status: extra.jobStatus || 'running', current_stage: extra.currentStage || null, ticks: claimed.ticks },
      stages: resumenStages(stagesState),
      ...extra.body,
    };
  }

  // --- Ejecutores por tipo de fase -----------------------------------------

  async function ejecutarStageScrapers(stageDef, state) {
    state.done = state.done || {};
    state.fallidos = state.fallidos || 0;
    const paths = getPipelineScrapePaths({
      incluirComplementarios: opcionesJob.complementarios !== false,
      incluirFega: opcionesJob.fega !== false,
    });

    for (const path of paths) {
      if (state.done[path]) continue;
      if (!quedaPresupuesto()) return { pausa: 'budget' };

      const fuente = obtenerFuenteScraper(path);
      const startedAt = new Date(ahora());

      const omision = await omitirScraper(supabase, {
        path,
        fuente,
        fecha,
        force,
        guardarRun: shadow ? async () => {} : (db, run) => guardarRunScraper(db, run),
      });
      if (omision) {
        state.done[path] = { ok: true, omitido: true };
        await checkpoint(stageDef.name);
        continue;
      }

      try {
        const result = await ejecutar(path);
        const finishedAt = new Date(ahora());
        const quality = evaluarScraper({
          responseOk: true,
          httpStatus: result.status,
          body: result.body,
          fuente,
          endpoint: path,
        });

        if (!shadow) {
          await guardarRunScraper(supabase, {
            fuente,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: quality.severity,
            http_status: result.status,
            nuevas: numeroBody(result.body, ['nuevas']),
            duplicadas: numeroBody(result.body, ['duplicadas']),
            errores: numeroBody(result.body, ['errores']),
            relevantes: numeroBody(result.body, ['relevantes', 'documentos_insertables', 'totales', 'coincidencias']) || null,
            mensaje: result.body?.mensaje || null,
            error_msg: null,
            response_json: { ...(result.body && typeof result.body === 'object' ? result.body : { raw: result.body }), quality },
          });
        }

        const scraperOk = quality.severity !== 'error';
        state.done[path] = { ok: scraperOk, severity: quality.severity, nuevas: numeroBody(result.body, ['nuevas']) };
        if (!scraperOk) state.fallidos++;
      } catch (err) {
        // Un scraper caido no tumba el dia: se registra y se sigue (el vigia
        // de salud-fuentes es quien avisa de caidas sostenidas).
        if (!shadow) {
          await guardarRunScraper(supabase, {
            fuente,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: new Date(ahora()).toISOString(),
            duration_ms: ahora() - startedAt.getTime(),
            status: 'error',
            http_status: err.status || null,
            nuevas: 0,
            duplicadas: 0,
            errores: 1,
            relevantes: null,
            mensaje: null,
            error_msg: err.message,
            response_json: err.body || null,
          });
        }
        state.done[path] = { ok: false, error: String(err.message || '').slice(0, 300) };
        state.fallidos++;
      }

      await checkpoint(stageDef.name);
    }

    state.resumen = {
      total: paths.length,
      fallidos: state.fallidos,
      omitidos: Object.values(state.done).filter((d) => d.omitido).length,
    };
    return { pausa: null, warning: state.fallidos > 0 };
  }

  async function ejecutarStageBatched(stageDef, state) {
    state.loops = state.loops || 0;
    state.total = state.total || 0;
    state.total_progress = state.total_progress || 0;

    while (state.loops < maxLoops) {
      if (!quedaPresupuesto()) return { pausa: 'budget' };

      const result = await ejecutar(stageDef.path, stageDef.method || 'GET');
      const procesadas = Number(result.body?.procesadas ?? 0);
      const progress = progresoBody(result.body);

      state.loops++;
      state.total += procesadas;
      state.total_progress += progress;
      state.resumen = result.body;

      console.log(`[pipeline-tick] ${stageDef.name} vuelta ${state.loops}: procesadas=${procesadas}, actualizadas=${progress}`);

      if (procesadas === 0) {
        state.cola_vacia = true;
        break;
      }
      if (progress === 0) {
        state.bloqueado = true;
        break;
      }

      await checkpoint(stageDef.name);
      if (ahora() + stepDelayMs < deadline) await sleep(stepDelayMs);
    }

    state.max_loops_alcanzado = !state.cola_vacia && state.loops >= maxLoops;
    return { pausa: null, warning: state.max_loops_alcanzado || state.bloqueado };
  }

  async function ejecutarStageSimple(stageDef, state) {
    if (!quedaPresupuesto()) return { pausa: 'budget' };
    const result = await ejecutar(stageDef.path, stageDef.method || 'GET');
    state.resumen = result.body;
    return { pausa: null, warning: false };
  }

  // --- Bucle principal de fases --------------------------------------------

  try {
    // Checkpoint inicial: sella current_stage y renueva el heartbeat ANTES de la
    // primera fase. Si el proceso muere aqui (Render, deploy, OOM), el job queda
    // reanudable/observable en vez de huerfano en 'running' con current_stage
    // null (estado que ni el reset rescataba).
    const primeraPendiente = stages.find(
      (s) => ![STAGE_COMPLETED, STAGE_SKIPPED, STAGE_SHADOW_SKIPPED].includes((stagesState[s.name] || {}).status)
    );
    await checkpoint(primeraPendiente ? primeraPendiente.name : null);

    for (const stageDef of stages) {
      const state = stagesState[stageDef.name] || { status: STAGE_PENDING, attempts: 0 };
      stagesState[stageDef.name] = state;

      if ([STAGE_COMPLETED, STAGE_SKIPPED, STAGE_SHADOW_SKIPPED].includes(state.status)) continue;

      if (!quedaPresupuesto()) {
        await checkpoint(stageDef.name);
        return respuesta('budget_exhausted', { currentStage: stageDef.name });
      }

      if (shadow && stageDef.outbound) {
        state.status = STAGE_SHADOW_SKIPPED;
        state.finished_at = nowISO();
        await registrarRunStage(stageDef, state, 'ok', { response_json: { shadow_skipped: true } });
        await checkpoint(stageDef.name);
        continue;
      }

      if (!state.started_at) state.started_at = nowISO();
      state.status = 'running';

      try {
        let resultado;
        if (stageDef.type === 'scrapers') resultado = await ejecutarStageScrapers(stageDef, state);
        else if (stageDef.type === 'batched') resultado = await ejecutarStageBatched(stageDef, state);
        else resultado = await ejecutarStageSimple(stageDef, state);

        if (resultado.pausa === 'budget') {
          state.status = STAGE_PENDING; // se reanuda en el siguiente tick con el estado acumulado
          await checkpoint(stageDef.name);
          return respuesta('budget_exhausted', { currentStage: stageDef.name });
        }

        // Fase por lotes que se queda bloqueada o al limite: se corta ANTES
        // del digest para evitar un envio incompleto (mismo criterio que
        // pipeline-diario).
        if (stageDef.abortaSiLimitado && (state.bloqueado || state.max_loops_alcanzado)) {
          state.status = STAGE_ABORTED;
          state.finished_at = nowISO();
          const motivo = state.bloqueado ? 'lote bloqueado sin actualizaciones' : `limite de ${maxLoops} vueltas`;
          await registrarRunStage(stageDef, state, 'error', { error_msg: motivo });
          const aviso = await avisarAdminPipeline([
            '*Ruralicos: pipeline detenido*',
            '',
            `Fase: ${stageDef.name}`,
            `Motivo: ${motivo}`,
            `Procesadas en esta fase: ${state.total}`,
            `Actualizadas en esta fase: ${state.total_progress}`,
            '',
            'No se ha preparado ni enviado el digest para evitar un envio incompleto.',
            `Reanudar: /tareas/pipeline-tick?fecha=${fecha}&reset=true`,
          ].join('\n'));
          state.aviso_admin = aviso;
          await terminarJob('aborted', stageDef.name, motivo);
          return respuesta('aborted', { currentStage: stageDef.name, jobStatus: 'aborted' });
        }

        state.status = STAGE_COMPLETED;
        state.finished_at = nowISO();
        await registrarRunStage(stageDef, state, resultado.warning ? 'warning' : 'ok');
        await checkpoint(stageDef.name);
      } catch (err) {
        state.attempts = (state.attempts || 0) + 1;
        state.ultimo_error = String(err.message || '').slice(0, 500);

        if (stageDef.optional) {
          console.warn(`[pipeline-tick] Fase opcional ${stageDef.name} omitida:`, err.message);
          state.status = STAGE_SKIPPED;
          state.finished_at = nowISO();
          await registrarRunStage(stageDef, state, 'warning', { error_msg: `omitida: ${state.ultimo_error}` });
          await checkpoint(stageDef.name);
          continue;
        }

        if (state.attempts >= maxAttempts) {
          state.status = STAGE_FAILED;
          state.finished_at = nowISO();
          await registrarRunStage(stageDef, state, 'error', { error_msg: state.ultimo_error });
          const aviso = await avisarAdminPipeline([
            '*Ruralicos: pipeline fallido*',
            '',
            `Fase: ${stageDef.name}`,
            `Intentos: ${state.attempts}`,
            `Error: ${state.ultimo_error}`,
            '',
            `Reanudar: /tareas/pipeline-tick?fecha=${fecha}&reset=true`,
          ].join('\n'));
          state.aviso_admin = aviso;
          await terminarJob('failed', stageDef.name, state.ultimo_error);
          return respuesta('failed', { currentStage: stageDef.name, jobStatus: 'failed' });
        }

        // Reintento en el siguiente tick (la cadencia del cron hace de backoff).
        state.status = STAGE_PENDING;
        await checkpoint(stageDef.name);
        return respuesta('stage_retry_pending', { currentStage: stageDef.name });
      }
    }

    await terminarJob('completed', null);
    return respuesta('completed', { jobStatus: 'completed' });
  } finally {
    await store.liberar({ jobId: claimed.id, tickId });
  }
}

async function consultarPipelineJobs(supabase, { fecha = null, kind = null, limit = 20 } = {}) {
  const store = crearPipelineJobsStore(supabase);
  return store.listar({ fecha, kind, limit });
}

module.exports = {
  construirStagesPipeline,
  crearEjecutorHttp,
  ejecutarPipelineTick,
  consultarPipelineJobs,
  verificarBaseUrlInterna,
};
