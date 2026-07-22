// src/routes/tareas.js
const { checkCronToken } = require('../../middleware/cronToken');
const { enviarWhatsAppAdmin, enviarDigestPro } = require('../../platform/whatsapp');
const { getFechaMadridISO } = require('../../shared/fechaMadrid');
const { getInternalBaseUrl } = require('../../shared/internalBaseUrl');
const { evaluarRespuestaScraper } = require('../boletines/scraperRunQuality');
const { evaluarSaludFuentes, construirMensajeFuentesCaidas } = require('../boletines/fuentesHealth');
const { omitirScraperSiCapturado } = require('../boletines/scraperSkip');
const { cotejarListadosOficiales } = require('../../services/officialListMatcher');
const { purgarPorRetencion } = require('../../services/retencionDatos');
const {
  cargarOutboxPendiente,
  procesarOutboxItemMIA,
  generarOutboxHealthMIA,
  marcarOutboxFailed,
  getMaxAttempts,
} = require('../mia/outbox');
const {
  digestIdDeOutboxItem,
  filtrarDigestsPorAutoridadFinal,
  procesarResultadoDigestOutbox,
} = require('../digest/digestOutbox');

const {
  FEGA_SCRAPE_PATH,
  getScrapePaths,
  getComplementaryScrapePaths,
  boolValue,
  pipelineDiarioJubilado,
  getAllowedScraperPaths,
  getPipelineScrapePaths,
  appendQuery,
  buildCronFetchOptions,
  buildScrapeUrl,
  buildComplementaryScrapeUrl,
  obtenerFuenteScraper,
  numeroBody,
  readResponseBody,
  isRetryableStatus,
  isRetryableError,
  guardarScraperRun,
  guardarPipelineRun,
} = require('./tareas.helpers');
const { ejecutarPipelineTick, consultarPipelineJobs } = require('./pipelineRunner');

function getBaseUrl(req) {
  return getInternalBaseUrl(req);
}

module.exports = function tareasRoutes(app, supabase) {
  app.all('/tareas/mia-outbox', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || req.body?.limit || 50)));
      const dryRun = String(req.query.dry_run || req.body?.dry_run || 'false').toLowerCase() === 'true';
      const pendientes = await cargarOutboxPendiente(supabase, limit);

      if (!pendientes.available) {
        return res.json({
          success: true,
          available: false,
          reason: pendientes.reason || 'mia_outbox_no_disponible',
          procesados: 0,
          enviados: 0,
          fallidos: 0,
          resultados: [],
        });
      }

      if (!pendientes.ok) {
        return res.status(500).json({ success: false, error: pendientes.error || 'mia_outbox_error' });
      }

      const digestDelayMs = Math.max(0, Number(process.env.DIGEST_DELAY_MS || 3000));
      const resultados = [];
      for (const item of pendientes.items || []) {
        if (dryRun) {
          resultados.push({
            id: item.id,
            dry_run: true,
            status: item.status,
            attempts: item.attempts || 0,
            to_phone: item.to_phone,
            body_preview: String(item.body || '').slice(0, 240),
          });
          continue;
        }

        const digestId = digestIdDeOutboxItem(item);
        let result;
        if (digestId) {
          const finalAuthority = await filtrarDigestsPorAutoridadFinal(supabase, [{ id: digestId }]);
          const blocked = finalAuthority.bloqueados[0] || null;
          if (blocked) {
            await marcarOutboxFailed(supabase, item.id, blocked.reason, getMaxAttempts());
            result = {
              id: item.id,
              ok: false,
              status: 'failed',
              retryable: false,
              error: blocked.reason,
              final_send_gate_blocked: true,
            };
          }
        }
        if (!result) result = await procesarOutboxItemMIA(supabase, item, enviarDigestPro);

        // Items del digest diario (DIGEST_VIA_OUTBOX): reflejar el resultado en
        // digests/digest_attempts y espaciar los envios (delay anti-ban).
        if (digestId) {
          await procesarResultadoDigestOutbox(supabase, item, result);
          if (result.status === 'sent' && digestDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, digestDelayMs));
          }
        }

        resultados.push(result);
      }

      const fallidos = resultados.filter((item) => item.ok === false);
      const health = await generarOutboxHealthMIA(supabase, { hours: 72, limit: 1000 });

      return res.status(fallidos.length ? 207 : 200).json({
        success: fallidos.length === 0,
        dry_run: dryRun,
        available: true,
        procesados: resultados.length,
        enviados: resultados.filter((item) => item.status === 'sent').length,
        fallidos: fallidos.length,
        omitidos: resultados.filter((item) => item.skipped).length,
        resultados,
        health: {
          ok: health.ok,
          score: health.score,
          metrics: health.metrics,
          recovered_stuck: health.recovered_stuck || 0,
        },
      });
    } catch (err) {
      console.error('Error en /tareas/mia-outbox', err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Retencion de datos (cumplimiento): purga logs operativos segun la politica
  // de docs/CUMPLIMIENTO.md. Doble seguro: borra SOLO si RETENTION_ENABLED=true
  // en el env Y ?dry_run=false explicito; en cualquier otro caso solo informa.
  // Cron recomendado: semanal.
  app.all('/tareas/retencion-datos', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const habilitado = boolValue(process.env.RETENTION_ENABLED, false);
      const dryRunPedido = boolValue(req.query.dry_run ?? req.body?.dry_run, true);
      const dryRun = !habilitado || dryRunPedido;

      const resultado = await purgarPorRetencion(supabase, { dryRun });
      return res.json({ success: true, habilitado, ...resultado });
    } catch (err) {
      console.error('Error en /tareas/retencion-datos', err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Vigía de fuentes: detecta boletines con el 100% de ejecuciones en error
  // durante >= min_dias consecutivos y avisa al admin por WhatsApp.
  // Pensado para UN cron diario (no tiene dedupe propio de avisos).
  app.get('/tareas/salud-fuentes', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const dias = Math.max(2, Math.min(14, Number(req.query.dias || 7)));
      const minDiasCaida = Math.max(1, Math.min(7, Number(req.query.min_dias || 2)));
      const enviar = boolValue(req.query.enviar, true);
      const hoy = getFechaMadridISO();

      // Una consulta por día: mantiene cada respuesta muy por debajo del
      // límite de filas de PostgREST (25 fuentes x ~15 runs/día).
      const runs = [];
      for (let offset = 0; offset < dias; offset++) {
        const dia = new Date(`${hoy}T00:00:00Z`);
        dia.setUTCDate(dia.getUTCDate() - offset);
        const diaISO = dia.toISOString().slice(0, 10);
        const siguiente = new Date(dia);
        siguiente.setUTCDate(siguiente.getUTCDate() + 1);

        const { data, error } = await supabase
          .from('scraper_runs')
          .select('fuente, status, error_msg, started_at')
          .gte('started_at', `${diaISO}T00:00:00Z`)
          .lt('started_at', `${siguiente.toISOString().slice(0, 10)}T00:00:00Z`)
          .limit(1000);

        if (error) throw new Error(`scraper_runs (${diaISO}): ${error.message}`);
        for (const run of data || []) {
          runs.push({ ...run, dia: String(run.started_at || '').slice(0, 10) });
        }
      }

      const caidas = evaluarSaludFuentes(runs, { minDiasCaida });

      let aviso = { skipped: true, reason: caidas.length ? 'enviar=false' : 'sin_fuentes_caidas' };
      if (caidas.length && enviar) {
        aviso = await enviarWhatsAppAdmin(construirMensajeFuentesCaidas(caidas, { fecha: hoy }));
      }

      return res.json({
        success: true,
        fecha: hoy,
        dias_revisados: dias,
        min_dias_caida: minDiasCaida,
        runs_analizados: runs.length,
        fuentes_caidas: caidas,
        aviso,
      });
    } catch (err) {
      console.error('Error en /tareas/salud-fuentes', err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/tareas/scrapers-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const baseUrl = getBaseUrl(req);
    const token = process.env.CRON_TOKEN;
    const scrapePaths = getScrapePaths();
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();
    const force = boolValue(req.query.force, false);

    async function hit(path) {
      const omision = await omitirScraperSiCapturado(supabase, {
        path,
        fuente: obtenerFuenteScraper(path),
        fecha,
        force,
        guardarRun: guardarScraperRun,
      });
      if (omision) return omision;

      const startedAt = new Date();
      const url = buildScrapeUrl(baseUrl, path, fecha);
      const response = await fetch(url, buildCronFetchOptions(token));
      const finishedAt = new Date();

      const body = await readResponseBody(response);

      const result = {
        path,
        fuente: obtenerFuenteScraper(path),
        ok: response.ok,
        status: response.status,
        body,
      };
      const quality = evaluarRespuestaScraper({
        responseOk: response.ok,
        httpStatus: response.status,
        body,
        fuente: result.fuente,
        endpoint: path,
      });
      result.quality = quality;

      await guardarScraperRun(supabase, {
        fuente: result.fuente,
        endpoint: path,
        fecha_objetivo: fecha,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        status: quality.severity,
        http_status: response.status,
        nuevas: numeroBody(body, ['nuevas']),
        duplicadas: numeroBody(body, ['duplicadas']),
        errores: numeroBody(body, ['errores']),
        relevantes: numeroBody(body, ['relevantes', 'documentos_insertables', 'totales']) || null,
        mensaje: body?.mensaje || null,
        error_msg: response.ok ? null : (body?.error || `HTTP ${response.status}`),
        response_json: { ...(body && typeof body === 'object' ? body : { raw: body }), quality },
      });

      return result;
    }

    const resultados = [];
    for (const path of scrapePaths) {
      const result = await hit(path);
      resultados.push(result);

      if (!result.ok) {
        console.error(`[scrapers-diario] ${path} devolvio ${result.status}`, result.body);
      }
    }

    const fallidos = resultados.filter((result) => !result.ok);
    const advertencias = resultados.filter((result) => result.quality?.severity === 'warning');

    res.status(fallidos.length ? 207 : 200).json({
      success: fallidos.length === 0,
      fecha,
      mensaje: fallidos.length
        ? `Scrapers ejecutados con ${fallidos.length} fallo(s)`
        : advertencias.length
          ? `Scrapers diarios ejecutados con ${advertencias.length} advertencia(s) de calidad`
          : 'Scrapers diarios ejecutados correctamente',
      total: resultados.length,
      correctos: resultados.length - fallidos.length,
      fallidos: fallidos.length,
      advertencias: advertencias.length,
      resultados,
    });
  });

  app.get('/tareas/scraper', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const path = String(req.query.path || '').trim();
    const pathsPermitidos = getAllowedScraperPaths();
    if (!pathsPermitidos.includes(path)) {
      return res.status(400).json({ error: 'Scraper no permitido', permitidos: pathsPermitidos });
    }

    const baseUrl = getBaseUrl(req);
    const token = process.env.CRON_TOKEN;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();

    const omision = await omitirScraperSiCapturado(supabase, {
      path,
      fuente: obtenerFuenteScraper(path),
      fecha,
      force: boolValue(req.query.force, false),
      guardarRun: guardarScraperRun,
    });
    if (omision) return res.json(omision);

    const startedAt = new Date();
    const url = buildComplementaryScrapeUrl(baseUrl, path, fecha, {
      ejercicio: req.query.ejercicio || process.env.FEGA_EJERCICIO || null,
      enviarFega: String(req.query.enviar_fega || req.query.enviar || 'false').toLowerCase() === 'true',
    });
    const response = await fetch(url, buildCronFetchOptions(token));
    const finishedAt = new Date();

    const body = await readResponseBody(response);

    const result = {
      path,
      fuente: obtenerFuenteScraper(path),
      ok: response.ok,
      status: response.status,
      body,
    };
    const quality = evaluarRespuestaScraper({
      responseOk: response.ok,
      httpStatus: response.status,
      body,
      fuente: result.fuente,
      endpoint: path,
    });
    result.quality = quality;

    await guardarScraperRun(supabase, {
      fuente: result.fuente,
      endpoint: path,
      fecha_objetivo: fecha,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      status: quality.severity,
      http_status: response.status,
      nuevas: numeroBody(body, ['nuevas']),
      duplicadas: numeroBody(body, ['duplicadas']),
      errores: numeroBody(body, ['errores']),
      relevantes: numeroBody(body, ['relevantes', 'documentos_insertables', 'totales', 'coincidencias']) || null,
      mensaje: body?.mensaje || null,
      error_msg: response.ok ? null : (body?.error || `HTTP ${response.status}`),
      response_json: { ...(body && typeof body === 'object' ? body : { raw: body }), quality },
    });

    return res.status(response.ok && quality.severity === 'ok' ? 200 : 207).json(result);
  });

  app.get('/tareas/complementarios-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const baseUrl = getBaseUrl(req);
    const token = process.env.CRON_TOKEN;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();
    const incluirFega = String(req.query.fega || process.env.COMPLEMENTARY_INCLUDE_FEGA || 'false').toLowerCase() === 'true';
    const enviarFega = String(req.query.enviar_fega || process.env.FEGA_ENVIAR_MATCHES || 'false').toLowerCase() === 'true';
    const ejercicioFega = req.query.ejercicio || process.env.FEGA_EJERCICIO || null;
    const paths = getComplementaryScrapePaths();

    if (incluirFega && !paths.includes(FEGA_SCRAPE_PATH)) {
      paths.push(FEGA_SCRAPE_PATH);
    }

    async function hit(path) {
      const startedAt = new Date();
      const url = buildComplementaryScrapeUrl(baseUrl, path, fecha, {
        ejercicio: ejercicioFega,
        enviarFega,
      });
      const response = await fetch(url, buildCronFetchOptions(token));
      const finishedAt = new Date();
      const body = await readResponseBody(response);

      const result = {
        path,
        fuente: obtenerFuenteScraper(path),
        ok: response.ok,
        status: response.status,
        body,
      };
      const quality = evaluarRespuestaScraper({
        responseOk: response.ok,
        httpStatus: response.status,
        body,
        fuente: result.fuente,
        endpoint: path,
      });
      result.quality = quality;

      await guardarScraperRun(supabase, {
        fuente: result.fuente,
        endpoint: path,
        fecha_objetivo: fecha,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        status: quality.severity,
        http_status: response.status,
        nuevas: numeroBody(body, ['nuevas']),
        duplicadas: numeroBody(body, ['duplicadas']),
        errores: numeroBody(body, ['errores']),
        relevantes: numeroBody(body, ['relevantes', 'documentos_insertables', 'totales', 'coincidencias']) || null,
        mensaje: body?.mensaje || null,
        error_msg: response.ok ? null : (body?.error || `HTTP ${response.status}`),
        response_json: { ...(body && typeof body === 'object' ? body : { raw: body }), quality },
      });

      return result;
    }

    const resultados = [];
    for (const path of paths) {
      const result = await hit(path);
      resultados.push(result);

      if (!result.ok) {
        console.error(`[complementarios-diario] ${path} devolvio ${result.status}`, result.body);
      }
    }

    const cotejoListados = await cotejarListadosOficiales(supabase, {
      fecha,
      enviar: String(req.query.enviar_listados || process.env.OFFICIAL_LIST_SEND_MATCHES || 'false').toLowerCase() === 'true',
      limit: Number(req.query.limit_listados || process.env.OFFICIAL_LIST_MATCH_LIMIT || 500),
    });

    const fallidos = resultados.filter((result) => !result.ok);
    const advertencias = resultados.filter((result) => result.quality?.severity === 'warning');
    return res.status(fallidos.length ? 207 : 200).json({
      success: fallidos.length === 0,
      fecha,
      mensaje: fallidos.length
        ? `Boletines complementarios ejecutados con ${fallidos.length} fallo(s)`
        : advertencias.length
          ? `Boletines complementarios ejecutados con ${advertencias.length} advertencia(s) de calidad`
          : 'Boletines complementarios ejecutados correctamente',
      total: resultados.length,
      correctos: resultados.length - fallidos.length,
      fallidos: fallidos.length,
      advertencias: advertencias.length,
      fega: incluirFega ? { incluido: true, enviar: enviarFega, ejercicio: ejercicioFega } : { incluido: false },
      cotejoListados,
      resultados,
    });
  });

  app.get('/tareas/cotejar-listados-oficiales', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const enviar = String(req.query.enviar || process.env.OFFICIAL_LIST_SEND_MATCHES || 'false').toLowerCase() === 'true';
      const limit = Number(req.query.limit || process.env.OFFICIAL_LIST_MATCH_LIMIT || 500);
      const fuente = req.query.fuente ? String(req.query.fuente).trim() : null;

      const result = await cotejarListadosOficiales(supabase, { fecha, enviar, limit, fuente });
      return res.json(result);
    } catch (err) {
      console.error('Error en /tareas/cotejar-listados-oficiales', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // C1: runner de pipeline con checkpoints. UN cron dispara este tick cada
  // ~10 min; cada tick reclama el job del dia, avanza fases dentro de su
  // presupuesto (budget_ms) y el siguiente tick reanuda desde el checkpoint.
  // shadow=true (el DEFAULT, por seguridad durante el rollout) = sombra: no
  // envia WhatsApp ni escribe scraper_runs; pipeline_runs van como 'shadow:*'.
  // Cutover real: cron con ?shadow=false o PIPELINE_TICK_SHADOW=false.
  app.all('/tareas/pipeline-tick', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const shadow = boolValue(req.query.shadow, boolValue(process.env.PIPELINE_TICK_SHADOW, true));

      const resultado = await ejecutarPipelineTick(supabase, {
        fecha,
        shadow,
        reset: boolValue(req.query.reset, false),
        force: boolValue(req.query.force, false),
        budgetMs: Math.max(5000, Math.min(10 * 60 * 1000, Number(req.query.budget_ms || process.env.PIPELINE_TICK_BUDGET_MS || 50000))),
        baseUrl: getBaseUrl(req),
        token: process.env.CRON_TOKEN,
        jobOptions: {
          complementarios: boolValue(req.query.complementarios, boolValue(process.env.PIPELINE_INCLUDE_COMPLEMENTARY, true)),
          fega: boolValue(
            req.query.fega,
            boolValue(process.env.PIPELINE_INCLUDE_FEGA, boolValue(process.env.COMPLEMENTARY_INCLUDE_FEGA, true))
          ),
          enviar_fega: boolValue(req.query.enviar_fega, boolValue(process.env.FEGA_ENVIAR_MATCHES, false)),
          ejercicio_fega: req.query.ejercicio || process.env.FEGA_EJERCICIO || null,
          enviar_listados: boolValue(req.query.enviar_listados, boolValue(process.env.OFFICIAL_LIST_SEND_MATCHES, false)),
          limit_listados: Number(req.query.limit_listados || process.env.OFFICIAL_LIST_MATCH_LIMIT || 500),
        },
      });

      const httpStatus =
        resultado.tick === 'preflight_failed' ? 503 :
        resultado.tick === 'aborted' ? 409 :
        resultado.tick === 'failed' ? 500 : 200;
      return res.status(httpStatus).json(resultado);
    } catch (err) {
      console.error('Error en /tareas/pipeline-tick', err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Estado de los jobs del runner (para inspeccion manual/panel).
  app.get('/tareas/pipeline-jobs', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
        const pipelineJobs = await consultarPipelineJobs(supabase, {
        fecha: /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : null,
        kind: req.query.kind ? String(req.query.kind).trim() : null,
        limit: Math.max(1, Math.min(100, Number(req.query.limit || 20))),
      });
        return res.json({
          ok: true,
          total: pipelineJobs.jobs.length,
          jobs: pipelineJobs.jobs,
          metrics: pipelineJobs.metrics,
        });
    } catch (err) {
      console.error('Error en /tareas/pipeline-jobs', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/tareas/pipeline-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    // Interlock de cutover: con el tick en real este endpoint queda jubilado
    // (evita envios duplicados si el cron viejo sigue configurado en Render).
    if (pipelineDiarioJubilado(process.env, req.query)) {
      return res.status(410).json({
        success: false,
        error:
          'pipeline-diario jubilado: el pipeline corre en real via /tareas/pipeline-tick ' +
          '(PIPELINE_TICK_SHADOW=false). Reactivacion puntual de emergencia: ?force_legacy=true.',
      });
    }

    try {
      const baseUrl = getBaseUrl(req);
      const token = process.env.CRON_TOKEN;
      const maxLoops = Number(process.env.PIPELINE_MAX_LOOPS || 40);
      const stepDelayMs = Number(process.env.PIPELINE_STEP_DELAY_MS || 800);
      const httpRetries = Number(process.env.PIPELINE_HTTP_RETRIES || 3);
      const httpRetryDelayMs = Number(process.env.PIPELINE_HTTP_RETRY_DELAY_MS || 5000);
      const incluirComplementarios = boolValue(req.query.complementarios, boolValue(process.env.PIPELINE_INCLUDE_COMPLEMENTARY, true));
      const incluirFega = boolValue(
        req.query.fega,
        boolValue(process.env.PIPELINE_INCLUDE_FEGA, boolValue(process.env.COMPLEMENTARY_INCLUDE_FEGA, true))
      );
      const enviarFega = boolValue(req.query.enviar_fega, boolValue(process.env.FEGA_ENVIAR_MATCHES, false));
      const ejercicioFega = req.query.ejercicio || process.env.FEGA_EJERCICIO || null;
      const enviarListados = boolValue(req.query.enviar_listados, boolValue(process.env.OFFICIAL_LIST_SEND_MATCHES, false));
      const limitListados = Number(req.query.limit_listados || process.env.OFFICIAL_LIST_MATCH_LIMIT || 500);
      const scrapePaths = getPipelineScrapePaths({ incluirComplementarios, incluirFega });
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      function buildPipelineUrl(path) {
        if (scrapePaths.includes(path)) {
          return buildComplementaryScrapeUrl(baseUrl, path, fecha, {
            ejercicio: ejercicioFega,
            enviarFega,
          });
        }
        return appendQuery(baseUrl, path, { fecha });
      }

      async function hit(path, method = 'GET') {
        const url = buildPipelineUrl(path);

        for (let attempt = 1; attempt <= httpRetries + 1; attempt++) {
          try {
            const response = await fetch(url, buildCronFetchOptions(token, method));
            const body = await readResponseBody(response);

            if (!response.ok) {
              const err = new Error(`${path} devolvio ${response.status}: ${JSON.stringify(body)}`);
              err.status = response.status;
              err.body = body;
              err.retryable = isRetryableStatus(response.status) &&
                body?.retryable !== false &&
                !/429|quota|exceeded your current quota/i.test(JSON.stringify(body || {}));
              throw err;
            }

            return { path, status: response.status, body };
          } catch (err) {
            const canRetry = attempt <= httpRetries && isRetryableError(err);
            if (!canRetry) throw err;

            const delay = httpRetryDelayMs * attempt;
            console.warn(`[pipeline] ${path} fallo transitorio (${err.message}). Reintento ${attempt}/${httpRetries} en ${delay}ms`);
            await sleep(delay);
          }
        }
      }

      async function runSimpleStage(stage, path, method = 'GET') {
        const startedAt = new Date();
        try {
          const result = await hit(path, method);
          const finishedAt = new Date();
          await guardarPipelineRun(supabase, {
            stage,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: 'ok',
            procesadas: numeroBody(result.body, ['procesadas', 'reparadas', 'deduplicadas', 'digests_generados', 'enviados']),
            errores: Array.isArray(result.body?.errores) ? result.body.errores.length : numeroBody(result.body, ['errores']),
            response_json: result.body,
          });
          return result;
        } catch (err) {
          const finishedAt = new Date();
          await guardarPipelineRun(supabase, {
            stage,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: 'error',
            error_msg: err.message,
          });
          throw err;
        }
      }

      async function runOptionalStage(stage, path, method = 'GET') {
        try {
          return await runSimpleStage(stage, path, method);
        } catch (err) {
          console.warn(`[pipeline] Fase opcional ${stage} omitida:`, err.message);
          return {
            path,
            body: {
              success: true,
              optional: true,
              skipped: true,
              mensaje: `Fase opcional omitida: ${err.message}`,
            },
          };
        }
      }

      async function runScraperStage(path) {
        const startedAt = new Date();
        const fuente = obtenerFuenteScraper(path);

        const omision = await omitirScraperSiCapturado(supabase, {
          path,
          fuente,
          fecha,
          force: boolValue(req.query.force, false),
          guardarRun: guardarScraperRun,
        });
        if (omision) return { path, fuente, ok: true, body: omision.body, quality: omision.quality };

        try {
          const result = await hit(path);
          const finishedAt = new Date();
          const quality = evaluarRespuestaScraper({
            responseOk: true,
            httpStatus: result.status,
            body: result.body,
            fuente,
            endpoint: path,
          });

          await guardarScraperRun(supabase, {
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

          return { path, fuente, ok: quality.severity !== 'error', body: result.body, quality };
        } catch (err) {
          const finishedAt = new Date();

          await guardarScraperRun(supabase, {
            fuente,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
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

          throw err;
        }
      }

      async function runBatchedStep(name, path) {
        const startedAt = new Date();
        let loops = 0;
        let total = 0;
        let totalProgress = 0;
        let colaVacia = false;
        let bloqueado = false;
        const vueltas = [];

        try {
          while (loops < maxLoops) {
            loops++;
            const result = await hit(path);
            const procesadas = Number(result.body?.procesadas ?? 0);
            const progress = Number(
              result.body?.actualizadas ??
              result.body?.aprobadas ??
              ((Number(result.body?.clasificadas ?? result.body?.clasificados ?? 0) + Number(result.body?.descartadas ?? 0)) || 0)
            );
            total += procesadas;
            totalProgress += progress;
            vueltas.push(result.body);

            console.log(`[pipeline] ${name} vuelta ${loops}: procesadas=${procesadas}, actualizadas=${progress}`);

            if (procesadas === 0) {
              colaVacia = true;
              break;
            }
            if (progress === 0) {
              bloqueado = true;
              break;
            }
            await sleep(stepDelayMs);
          }

          const result = {
            loops,
            total,
            totalProgress,
            colaVacia,
            bloqueado,
            maxLoopsAlcanzado: !colaVacia && loops >= maxLoops,
            ultimaRespuesta: vueltas[vueltas.length - 1] || null,
          };
          const finishedAt = new Date();
          await guardarPipelineRun(supabase, {
            stage: name,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: result.maxLoopsAlcanzado || result.bloqueado ? 'warning' : 'ok',
            loops,
            procesadas: total,
            response_json: result,
          });
          return result;
        } catch (err) {
          const finishedAt = new Date();
          await guardarPipelineRun(supabase, {
            stage: name,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: 'error',
            loops,
            procesadas: total,
            error_msg: err.message,
            response_json: { vueltas },
          });
          throw err;
        }
      }

      async function abortIfLimited(stageName, result) {
        if (!result.maxLoopsAlcanzado && !result.bloqueado) return false;

        const estadoActual = await runSimpleStage('estado_pipeline_abort', '/alertas/estado-pipeline');
        const motivo = result.bloqueado
          ? 'lote bloqueado sin actualizaciones'
          : `limite de ${maxLoops} vueltas`;
        const avisoAdmin = await enviarWhatsAppAdmin(
          [
            '*Ruralicos: pipeline diario detenido*',
            '',
            `Fase: ${stageName}`,
            `Motivo: ${motivo}`,
            `Procesadas en esta fase: ${result.total}`,
            `Actualizadas en esta fase: ${result.totalProgress}`,
            '',
            'No se ha preparado ni enviado el digest para evitar un envio incompleto.',
          ].join('\n')
        );

        res.status(409).json({
          success: false,
          mensaje: `Pipeline detenido en ${stageName}: ${motivo}. No se prepara ni se envia el digest para evitar un envio incompleto.`,
          stageName,
          result,
          avisoAdmin,
          estadoActual: estadoActual.body,
        });
        return true;
      }

      const scrapers = [];
      for (const path of scrapePaths) {
        scrapers.push(await runScraperStage(path));
      }

      const cotejoPath = `/tareas/cotejar-listados-oficiales?enviar=${enviarListados ? 'true' : 'false'}&limit=${encodeURIComponent(limitListados)}`;
      const cotejoListados = await runOptionalStage(
        'cotejar_listados_oficiales',
        cotejoPath
      );
      const repararPendientes = await runSimpleStage('reparar_pendientes_ia', '/alertas/reparar-pendientes-ia', 'POST');
      const clasificar = await runBatchedStep('clasificar', '/alertas/clasificar');
      if (await abortIfLimited('clasificar', clasificar)) return;
      const resumir = await runBatchedStep('resumir', '/alertas/resumir');
      if (await abortIfLimited('resumir', resumir)) return;
      const revisar = await runBatchedStep('revisar', '/alertas/revisar');
      if (await abortIfLimited('revisar', revisar)) return;
      const deduplicar = await runSimpleStage('deduplicar', '/alertas/deduplicar');
      const miaEmbeddings = await runOptionalStage(
        'mia_embeddings_inicializar',
        '/cerebro/embeddings/inicializar?limit=100&maxLoops=10'
      );
      const miaCicloPreDigest = await runOptionalStage(
        'mia_ciclo_pre_digest',
        '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1'
      );
      const prepararDigest = await runBatchedStep('preparar_digest', '/alertas/preparar-digest');
      if (await abortIfLimited('preparar_digest', prepararDigest)) return;
      const enviarDigest = await runSimpleStage('enviar_digest', '/alertas/enviar-digest');
      const miaCicloPostDigest = await runOptionalStage(
        'mia_ciclo_post_digest',
        '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1'
      );
      const miaOutbox = await runOptionalStage(
        'mia_outbox',
        '/tareas/mia-outbox?limit=50'
      );
      const generarResumenFree = await runSimpleStage('generar_resumen_free', '/alertas/generar-resumen-free');
      const enviarResumenFree = await runSimpleStage('enviar_resumen_free', '/alertas/enviar-resumen-free');
      const estadoFinal = await runSimpleStage('estado_pipeline_final', '/alertas/estado-pipeline');

      res.json({
        success: true,
        mensaje: 'Pipeline diario ejecutado con fases IA por lotes hasta vaciar cola',
        fuentes: {
          complementarios: incluirComplementarios,
          fega: incluirFega ? { incluido: true, enviar: enviarFega, ejercicio: ejercicioFega } : { incluido: false },
        },
        scrapers,
        cotejoListados: cotejoListados.body,
        repararPendientes: repararPendientes.body,
        clasificar,
        resumir,
        revisar,
        deduplicar: deduplicar.body,
        miaEmbeddings: miaEmbeddings.body,
        miaCicloPreDigest: miaCicloPreDigest.body,
        prepararDigest,
        enviarDigest: enviarDigest.body,
        miaCicloPostDigest: miaCicloPostDigest.body,
        miaOutbox: miaOutbox.body,
        generarResumenFree: generarResumenFree.body,
        enviarResumenFree: enviarResumenFree.body,
        estadoFinal: estadoFinal.body,
      });
    } catch (err) {
      console.error('Error en /tareas/pipeline-diario', err);
      res.status(500).json({ error: err.message });
    }
  });
};
