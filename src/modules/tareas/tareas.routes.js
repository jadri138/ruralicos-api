// src/routes/tareas.js
const { checkCronToken } = require('../../middleware/cronToken');
const { enviarWhatsAppAdmin, enviarDigestPro } = require('../../platform/whatsapp');
const { getFechaMadridISO } = require('../../shared/fechaMadrid');
const { evaluarRespuestaScraper } = require('../boletines/scraperRunQuality');
const { cotejarListadosOficiales } = require('../../services/officialListMatcher');
const {
  cargarOutboxPendiente,
  procesarOutboxItemMIA,
  generarOutboxHealthMIA,
} = require('../mia/outbox');

const SCRAPE_PATHS_DEFAULT = [
  '/scrape-boe-oficial',
  '/scrape-boa-oficial',
  '/scrape-bocan-oficial',
  '/scrape-bocant-oficial',
  '/scrape-bocm-oficial',
  '/scrape-bocyl-oficial',
  '/scrape-boib-oficial',
  '/scrape-boja-oficial',
  '/scrape-bon-oficial',
  '/scrape-bopa-oficial',
  '/scrape-bopv-oficial',
  '/scrape-bor-oficial',
  '/scrape-borm-oficial',
  '/scrape-docm-oficial',
  '/scrape-doe-oficial',
  '/scrape-dog',
  '/scrape-dogc',
  '/scrape-dogv',
  '/scrape-bome-oficial',
  '/scrape-bocce-oficial',
  '/scrape-botha-oficial',
  '/scrape-bog-oficial',
  '/scrape-bopz-oficial',
  '/scrape-boph-oficial',
  '/scrape-bopt-oficial',
];

const COMPLEMENTARY_SCRAPE_PATHS_DEFAULT = [];

const FEGA_SCRAPE_PATH = '/scrape-fega-beneficiarios';

const SCRAPER_FUENTES = {
  '/scrape-boe-oficial': 'BOE',
  '/scrape-boa-oficial': 'BOA',
  '/scrape-bocan-oficial': 'BOCAN',
  '/scrape-bocant-oficial': 'BOCANT',
  '/scrape-bocm-oficial': 'BOCM',
  '/scrape-bocyl-oficial': 'BOCYL',
  '/scrape-boib-oficial': 'BOIB',
  '/scrape-boja-oficial': 'BOJA',
  '/scrape-bon-oficial': 'BON',
  '/scrape-bopa-oficial': 'BOPA',
  '/scrape-bopv-oficial': 'BOPV',
  '/scrape-botha-oficial': 'BOTHA',
  '/scrape-bog-oficial': 'BOG',
  '/scrape-bopz-oficial': 'BOPZ',
  '/scrape-boph-oficial': 'BOPH',
  '/scrape-bopt-oficial': 'BOPT',
  '/scrape-bor-oficial': 'BOR',
  '/scrape-borm-oficial': 'BORM',
  '/scrape-docm-oficial': 'DOCM',
  '/scrape-doe-oficial': 'DOE',
  '/scrape-dog': 'DOG',
  '/scrape-dogc': 'DOGC',
  '/scrape-dogv': 'DOGV',
  '/scrape-bome-oficial': 'BOME',
  '/scrape-bocce-oficial': 'BOCCE',
  [FEGA_SCRAPE_PATH]: 'FEGA',
};

function getBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
}

function getScrapePaths() {
  return (process.env.PIPELINE_SCRAPE_PATHS || SCRAPE_PATHS_DEFAULT.join(','))
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

function getComplementaryScrapePaths() {
  return (process.env.COMPLEMENTARY_SCRAPE_PATHS || COMPLEMENTARY_SCRAPE_PATHS_DEFAULT.join(','))
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'on'].includes(String(value).trim().toLowerCase());
}

function uniquePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean)));
}

function getAllowedScraperPaths() {
  return uniquePaths([
    ...SCRAPE_PATHS_DEFAULT,
    ...COMPLEMENTARY_SCRAPE_PATHS_DEFAULT,
    ...getScrapePaths(),
    ...getComplementaryScrapePaths(),
    FEGA_SCRAPE_PATH,
  ]);
}

function getPipelineScrapePaths(options = {}) {
  const {
    incluirComplementarios = true,
    incluirFega = false,
  } = options;

  const paths = [...getScrapePaths()];
  if (incluirComplementarios) paths.push(...getComplementaryScrapePaths());
  if (incluirFega) paths.push(FEGA_SCRAPE_PATH);

  return uniquePaths(paths);
}

function appendQuery(baseUrl, path, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }

  const suffix = query.toString();
  return suffix ? `${baseUrl}${path}${path.includes('?') ? '&' : '?'}${suffix}` : `${baseUrl}${path}`;
}

function buildCronFetchOptions(token, method = 'GET', extra = {}) {
  return {
    ...extra,
    method,
    headers: {
      ...(extra.headers || {}),
      'x-cron-token': token,
    },
  };
}

function buildScrapeUrl(baseUrl, path, fechaISO) {
  const fecha = path.startsWith('/scrape-boe-')
    ? fechaISO.replace(/-/g, '')
    : fechaISO;
  return appendQuery(baseUrl, path, { fecha });
}

function buildComplementaryScrapeUrl(baseUrl, path, fechaISO, options = {}) {
  if (path === '/scrape-fega-beneficiarios') {
    return appendQuery(baseUrl, path, {
      ejercicio: options.ejercicio || null,
      enviar: options.enviarFega ? 'true' : null,
      detectar: options.detectar === false ? 'false' : null,
    });
  }

  return buildScrapeUrl(baseUrl, path, fechaISO);
}

function obtenerFuenteScraper(path) {
  return SCRAPER_FUENTES[path] || path.replace(/^\/scrape-/, '').replace(/-oficial$/, '').toUpperCase();
}

function numeroBody(body, keys) {
  for (const key of keys) {
    const value = Number(body?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

async function readResponseBody(response) {
  const raw = await response.text();
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

async function guardarScraperRun(supabase, run) {
  const { error } = await supabase.from('scraper_runs').insert([run]);
  if (error) {
    console.warn('[scraper_runs] No se pudo guardar ejecucion:', error.message);
  }
}

async function guardarPipelineRun(supabase, run) {
  const { error } = await supabase.from('pipeline_runs').insert([run]);
  if (error) {
    console.warn('[pipeline_runs] No se pudo guardar ejecucion:', error.message);
  }
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

        const result = await procesarOutboxItemMIA(supabase, item, enviarDigestPro);
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

  app.get('/tareas/scrapers-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const baseUrl = getBaseUrl();
    const token = process.env.CRON_TOKEN;
    const scrapePaths = getScrapePaths();
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();

    async function hit(path) {
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

    const baseUrl = getBaseUrl();
    const token = process.env.CRON_TOKEN;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();

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

    const baseUrl = getBaseUrl();
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

  app.get('/tareas/pipeline-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const baseUrl = getBaseUrl();
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
