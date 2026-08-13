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
} = require('../mia/outbox');
const { digestIdDeOutboxItem } = require('../digest/digestOutbox');
const { processDueEvidenceRecovery } = require('../digest/decisionEvidenceRecovery');
const { conciliarEntregasUltraMsg } = require('../delivery/deliveryService');
const { runAutomatedShadowV2Batch } = require('../alertas/shadow-v2/automation');

const {
  FEGA_SCRAPE_PATH,
  getScrapePaths,
  getComplementaryScrapePaths,
  boolValue,
  getAllowedScraperPaths,
  buildCronFetchOptions,
  buildScrapeUrl,
  buildComplementaryScrapeUrl,
  obtenerFuenteScraper,
  numeroBody,
  readResponseBody,
  guardarScraperRun,
} = require('./tareas.helpers');

function getBaseUrl(req) {
  return getInternalBaseUrl(req);
}

module.exports = function tareasRoutes(app, supabase) {
  app.post('/tareas/shadow-v2', async (req, res) => {
    if (!checkCronToken(req, res)) return;
    if (!boolValue(process.env.RUN_SHADOW_V2, true)) {
      return res.status(503).json({ success: false, disabled: true, error: 'shadow-v2 automatico desactivado' });
    }

    try {
      const workflowDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || req.body?.fecha || '')
        ? String(req.query.fecha || req.body?.fecha)
        : getFechaMadridISO();
      const value = (name, fallback) => req.query[name] ?? req.body?.[name] ?? fallback;
      const result = await runAutomatedShadowV2Batch({
        supabase,
        workflowDate,
        limitOverrides: {
          maxAlerts: value('max_alerts', 25),
          maxUsers: value('max_users', 10),
          maxCandidatesPerUser: value('max_candidates', 30),
          maxTotalCalls: value('max_calls', 25),
          maxOfficialCharsPerAlert: value('max_official_chars', 30000),
          maxPersonalPromptChars: value('max_personal_prompt_chars', 60000),
          maxSelected: value('max_selected', 5),
        },
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error('Error en /tareas/shadow-v2', err.message);
      return res.status(500).json({ success: false, error: 'No se pudo ejecutar el lote shadow-v2' });
    }
  });

  app.post('/tareas/hold-evidence-recovery', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || req.body?.limit || 25)));
      const concurrency = Math.max(1, Math.min(4, Number(req.query.concurrency || req.body?.concurrency || 2)));
      const result = await processDueEvidenceRecovery({ supabase, limit, concurrency });
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error('Error en /tareas/hold-evidence-recovery', err.message);
      return res.status(500).json({ success: false, error: 'No se pudo recuperar la evidencia pendiente' });
    }
  });

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
          aceptados: 0,
          entregados: 0,
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
            delivery_status: item.delivery_status,
            attempts: item.attempts || 0,
          });
          continue;
        }

        const digestId = digestIdDeOutboxItem(item);
        const result = await procesarOutboxItemMIA(supabase, item, enviarDigestPro);

        if (digestId && result.status === 'provider_accepted' && digestDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, digestDelayMs));
        }

        resultados.push(result);
      }

      const fallidos = resultados.filter((item) => item.ok === false);
      const health = await generarOutboxHealthMIA(supabase, { hours: 72, limit: 1000 });

      return res.status(200).json({
        success: fallidos.length === 0,
        dry_run: dryRun,
        available: true,
        procesados: resultados.length,
        aceptados: resultados.filter((item) => item.status === 'provider_accepted').length,
        entregados: resultados.filter((item) => ['DELIVERED', 'READ'].includes(item.delivery_status)).length,
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

  app.post('/tareas/whatsapp-reconcile', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || req.body?.limit || 50)));
      const dryRun = String(req.query.dry_run ?? req.body?.dry_run ?? 'false').toLowerCase() === 'true';
      const result = await conciliarEntregasUltraMsg(supabase, { limit, dryRun });
      const status = result.ok === false && result.available !== false ? 207 : result.available === false ? 503 : 200;
      return res.status(status).json(result);
    } catch (err) {
      console.error('Error en /tareas/whatsapp-reconcile', err.message);
      return res.status(500).json({ ok: false, error: 'No se pudo conciliar la entrega de WhatsApp' });
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
};
